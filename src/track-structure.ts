import { Bar, CurvePoint, sampleCurve } from "./audio-data";

// Where a track's big moments are, and what the music does on the way into each one.

export type Moment = {
	/** when it lands, in seconds */
	t: number;
	/** how big, 0..1 */
	size: number;
	/** measured length of the run-in, in seconds */
	leadSeconds: number;
	/** how far the music thins out before it, 0..1. High means follow the music down */
	dip: number;
	/** how much it climbs before it, 0..1. High means wind up rather than withdraw */
	build: number;
};

// a beat of this track from the bar grid (four to a bar); 0.5 s with no bars
function beatOf(bars: Bar[]): number {
	const durations = bars.map(b => b.duration).filter(d => d > 0.2 && d < 8).sort((a, b) => a - b);
	return durations.length > 0 ? durations[durations.length >> 1] / 4 : 0.5;
}

// What the music does on the way in, measured per moment: tracks differ too much for a fixed gesture.
function describeLeadIn(
	curve: CurvePoint[],
	t: number,
	beatSec: number
): { leadSeconds: number; dip: number; build: number } {
	// One-second mean: the raw curve is a per-segment sawtooth, and its ripple would be measured instead of the music.
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
	// The held-breath bar before a drop sits at the usual level, so only a return lasting one beat of this track ends the run-in.
	const gapSamples = Math.max(2, Math.round(beatSec / 0.25));
	let normalRun = 0;
	for (let s = 8; s >= 0.25; s -= 0.25) {
		const y = level(t - s);
		lowest = Math.min(lowest, y);
		highest = Math.max(highest, y);
		// the run-in is the stretch before the moment that does not look like the normal level
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

// Finds the few places where this track's own loudness takes its largest sustained step up. Bounded by construction
// (best few steps, spaced, capped) rather than by a threshold; a track with no dynamics gets none.
const RISE_BEFORE_SEC = 4;
const RISE_AFTER_SEC = 3;
const RISE_GAP_SEC = 14;
const RISE_MAX = 5;
// share of the track's biggest step, and a floor of about 1.7 dB (22% in amplitude)
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
		// Proportional, so quiet and loud masters compare. The floored denominator stops the track's own start from winning.
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

	// Moves each pick to the steepest point of the one-second-mean curve: the scoring window peaks up to 3 s before the step.
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
		// Not snapped to the section boundary: it falls at or after the arrival and would make the drop late.
	}

	// Size: how much of the rise is still there ten seconds later. Separates a step from a bump, which the rise score cannot.
	const holdOf = (t: number) => {
		const before = mean(t - RISE_BEFORE_SEC, t - 0.4);
		return (mean(t + 4, t + 10) - before) / Math.max(before, median * 0.4);
	};
	const holds = picked.map(p => holdOf(p.t));
	const beatSec = beatOf(bars);
	// Size is against a fixed reference (a hold of 1 is full), not the track's best, or every track would get one full-size moment.

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

