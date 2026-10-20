import { Bar, CurvePoint, sampleCurve } from "./audio-data";

// Where a track's big moments are, and what the music does on the way into each one.

export type Moment = {
	/** when it lands, in seconds */
	t: number;
	/** how big, 0..1 */
	size: number;
	/** MEASURED length of the run-in, in seconds - not a constant. Some tracks build for eight
	 *  seconds, some cut to silence for one, some walk straight in with no preparation at all */
	leadSeconds: number;
	/** how far the music thins out before it, 0..1. High means follow the music down */
	dip: number;
	/** how much it climbs before it, 0..1. High means wind up rather than withdraw */
	build: number;
};

// a beat of this track, from the bar grid the analysis already sent. Four to a bar is the
// assumption the rest of the project makes too; with no bars at all, a moderate 120bpm
function beatOf(bars: Bar[]): number {
	const durations = bars.map(b => b.duration).filter(d => d > 0.2 && d < 8).sort((a, b) => a - b);
	return durations.length > 0 ? durations[durations.length >> 1] / 4 : 0.5;
}

// What the music does on the way in, measured per moment, because tracks differ: some build for
// eight seconds, some cut out entirely for one bar, some simply arrive. A fixed run-in gesture
// would be wrong on most of them.
function describeLeadIn(
	curve: CurvePoint[],
	t: number,
	beatSec: number
): { leadSeconds: number; dip: number; build: number } {
	// A one-second mean, not the curve itself. The loudness curve is a per-segment attack-decay
	// sawtooth, and every question below - how far down does it dip, how far up does it build, how
	// long has it been away from its usual level - asks about the shape of the music over seconds.
	// Asked of the raw curve they answer about the sawtooth instead: `highest` and `lowest` become
	// its ripple, a third of all moments measure `build` at the ceiling, and `leadSeconds` becomes
	// "when did the ripple last cross the baseline" (half of all moments across 89 dumps report the
	// shortest lead-in the clamp allows).
	const level = (at: number) => {
		let sum = 0;
		let n = 0;
		for (let d = -0.5; d <= 0.5; d += 0.1) {
			sum += sampleCurve(curve, Math.max(0, at + d));
			n++;
		}
		return sum / n;
	};
	// what this stretch of the track normally sits at, taken from before any preparation began
	let baseline = 0;
	let samples = 0;
	for (let s = 16; s >= 9; s -= 0.5) {
		baseline += level(t - s);
		samples++;
	}
	baseline = samples > 0 ? baseline / samples : level(t - 12);
	if (baseline < 1e-3) return { leadSeconds: 3, dip: 0, build: 0 };

	let lowest = Infinity;
	let highest = 0;
	let deviatingSince = 0;
	// A run-in may touch the track's normal level on its way in. The bar a track holds its breath in,
	// immediately before the drop, sits at about its usual level by definition, so a single normal
	// sample must not end the walk: it would reset the answer at the end, the raw value would come
	// back at 0.25s and the clamp would turn it into 1.2s (49% of moments across 89 dumps). For
	// those, the music is away from baseline for a median 53% of the eight seconds before, with the
	// earliest deviation 7.75s out.
	//
	// So only a sustained return ends it, and "sustained" is a beat of this track, like every other
	// time constant here. Measured over 345 moments: one beat takes the clamp share from 49% to 30%
	// and the median lead from 1.25s to 2.75s. Longer tolerances keep going - half a bar gives 16%
	// - but they push the same mass onto the ceiling instead, and 8s is the width of the window
	// rather than a measurement, so that trade buys nothing.
	const gapSamples = Math.max(2, Math.round(beatSec / 0.25));
	let normalRun = 0;
	for (let s = 8; s >= 0.25; s -= 0.25) {
		const y = level(t - s);
		lowest = Math.min(lowest, y);
		highest = Math.max(highest, y);
		// the run-in is the stretch, immediately before the moment, that does not look like the
		// track's normal level - however long that happens to be
		if (Math.abs(y - baseline) / baseline > 0.14) {
			deviatingSince = Math.max(deviatingSince, s);
			normalRun = 0;
		} else {
			normalRun++;
			if (normalRun >= gapSamples && deviatingSince > 0 && s < deviatingSince) deviatingSince = s;
		}
	}

	return {
		leadSeconds: Math.max(1.2, Math.min(8, deviatingSince || 2.5)),
		dip: Math.max(0, Math.min(1, (baseline - lowest) / baseline)),
		build: Math.max(0, Math.min(1, (highest - baseline) / baseline))
	};
}

// This is not the loudness-based chorus detection that failed three times. It does not claim to
// find a chorus and it is not scored against one. It finds the handful of places where this
// track's own loudness takes its largest sustained step up, and calls those the moments worth a
// release. It asserts only what it measured - the music got noticeably bigger here - which is
// either true or false about the curve in front of it.
//
// It exists because the release needs moments to fire on. With the detector off, `impact` never
// fired on any of the twenty real tracks measured, and a hand-made online heuristic in its place
// fired 68 times in three and a half minutes on one track, twice within the same second more than
// once. Rate is the whole problem: a payoff that happens once a phrase is not a payoff, and no
// amount of tuning its amplitude fixes that.
//
// Bounded by construction rather than by a threshold: the best few steps in the track, spaced out,
// capped. A track with no dynamics gets none, which is the honest answer for a track with no
// dynamics.
const RISE_BEFORE_SEC = 4;
const RISE_AFTER_SEC = 3;
const RISE_GAP_SEC = 14;
const RISE_MAX = 5;
// relative to the track's own biggest step, and never below a step that is actually audible: a 22%
// jump in amplitude is about 1.7 dB
const RISE_SHARE = 0.4;
const RISE_FLOOR = 0.22;

export function findMoments(curve: CurvePoint[], bars: Bar[]): Moment[] {
	if (curve.length < 40) return [];
	const end = curve[curve.length - 1].t;
	if (end < 30) return [];
	const level = (t: number) => sampleCurve(curve, Math.max(0, t));
	const mean = (from: number, to: number) => {
		let sum = 0;
		let n = 0;
		for (let t = from; t <= to; t += 0.25) {
			sum += level(t);
			n++;
		}
		return n > 0 ? sum / n : 0;
	};

	// the track's own middle level, used as a floor under the denominator below
	const sorted = curve
		.map(p => p.y)
		.filter(y => Number.isFinite(y))
		.sort((a, b) => a - b);
	const median = sorted[sorted.length >> 1] || 0.1;

	const times: number[] = [];
	const rises: number[] = [];
	for (let t = 8; t <= end - RISE_AFTER_SEC - 1; t += 0.25) {
		const before = mean(t - RISE_BEFORE_SEC, t - 0.4);
		const after = mean(t + 0.4, t + RISE_AFTER_SEC);
		times.push(t);
		// Proportional, not absolute: a quiet track's own biggest moment is as much of an event to a
		// listener as a loud track's, and dB differences between masters say nothing about music.
		//
		// The denominator has a floor, or the largest rise in every track is the track starting:
		// coming up out of silence divides by nothing and wins by a mile. Without it, tracks put their
		// top moment in the first seconds with no dip in front of it, a release fired at the first bar
		// of the song.
		rises.push((after - before) / Math.max(before, median * 0.4));
	}
	const best = Math.max(0, ...rises);
	if (best < RISE_FLOOR) return [];
	const bar = Math.max(RISE_FLOOR, best * RISE_SHARE);

	// greedy, largest first, each one blocking a window around itself - so what survives is a set of
	// separated peaks rather than every sample along the flank of one
	const order = rises.map((rise, i) => ({ rise, i })).sort((a, b) => b.rise - a.rise);
	const picked: { t: number; rise: number }[] = [];
	for (const { rise, i } of order) {
		if (rise < bar) break;
		if (picked.length >= RISE_MAX) break;
		const t = times[i];
		if (picked.some(p => Math.abs(p.t - t) < RISE_GAP_SEC)) continue;
		picked.push({ t, rise });
	}

	// Where the level actually steps, not where the window that noticed it begins. `rises` compares
	// the four seconds before a time with the three after, so it peaks as soon as the rise enters
	// the trailing window - up to three seconds early. The moment then lands with the track's top
	// score while the loudness there is still flat, and the picture braces for four seconds and
	// flashes at nothing. The detector is right about the rise, only wrong about when.
	//
	// So each pick is refined to the steepest point of the second-scale curve near it. A one-second
	// mean either side, because the raw curve is a per-segment sawtooth and its own slope is noise.
	const smooth = (at: number) => mean(at - 0.5, at + 0.5);
	for (const p of picked) {
		let bestT = p.t;
		let bestSlope = -Infinity;
		for (let x = p.t - 1; x <= p.t + RISE_AFTER_SEC; x += 0.1) {
			const slope = smooth(x + 0.7) - smooth(x - 0.7);
			if (slope > bestSlope) {
				bestSlope = slope;
				bestT = x;
			}
		}
		p.t = bestT;
		// No snap to the section boundary: 40% of moments have a boundary within two seconds and 66%
		// of those have it later (median +0.53s). Moving the flash onto the boundary makes the drop
		// land late - the boundary is where Spotify's segmentation decides a new section begins,
		// which is at or after the arrival, while the picture has to fire on it. The curve's own
		// steepest point stays.
	}

	// How big a moment is: how much of it is still there ten seconds later.
	//
	// `rise` measures the momentary jump - three seconds against the four before - so a bump gets the
	// same score as a step. One track scored its best at 1.00 on a bump whose one-second mean goes
	// 0.42 -> 0.57 -> 0.38, a second and a half wide; another had the same shape. Measured over 356
	// moments, the bumps sit at 0.15 and 0.12 on this statistic while the genuine steps sit at 0.45
	// to 1.4. Nothing else separated them.
	//
	// So the spike still finds the candidates and the hold decides what they are worth. 7% of all
	// moments come out at or below zero - the music ends up quieter than it started - and those stop
	// being events at all.
	const holdOf = (t: number) => {
		const before = mean(t - RISE_BEFORE_SEC, t - 0.4);
		return (mean(t + 4, t + 10) - before) / Math.max(before, median * 0.4);
	};
	const holds = picked.map(p => holdOf(p.t));
	const beatSec = beatOf(bars);
	// Size is against a fixed reference, not against the track's own best. Dividing by the largest
	// rise in the track would give every track exactly one moment at full size, however flat it was.
	//
	// Measured over 84 dumps, the biggest sustained rise a track has spans 0.23 to 3.65 of the level
	// it came from - p05 0.39, median 1.01, p95 2.55. Full size means the music settles at twice what
	// it rose from. That is a hold of 1, which is also the median of the corpus - so half of all
	// tracks still reach the top and the flat ones stop inventing one.
	//
	// Fixing only the ceiling (`hold / Math.max(1, ...holds)`) is half of that: a track whose best
	// hold goes above 1 (48 of 91 tracks) would still scale all of its moments by its own best.
	// With the divisor pinned, 47 of 345 moments come out more than 0.15 smaller than the fixed
	// reference gives, worst 0.61.

	return picked
		.map((p, i) => {
			// onto the bar line if there is one within half a second: the loudness curve is sampled per
			// segment and lands a fraction late, and a release that arrives just after the downbeat
			// reads as a mistake in a way that one arriving just before it does not
			const near = bars.find(b => Math.abs(b.start - p.t) < 0.5);
			return {
				t: near ? near.start : p.t,
				size: Math.max(0, Math.min(1, holds[i])),
				...describeLeadIn(curve, p.t, beatSec)
			};
		})
		.sort((a, b) => a.t - b.t);
}

