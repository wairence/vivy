import { Bar, CurvePoint, sampleCurve } from "./audio-data";

type Segment = SpotifyAudioAnalysis["segments"][number];

// Where a track's big moments are, and what the music does on the way into each one.
//
// Loudness alone cannot find a chorus. Three loudness-based detectors (section loudness, section
// loudness ranked, the loudness envelope at fine resolution) were the same evidence measured three
// ways, and scored 2 accurate hits out of 11 firings across six real tracks. A track that is loud
// from beginning to end has no loudness event at its chorus: modern mastering compresses dynamics
// on purpose, and no threshold recovers information that is not in the data.
//
// What distinguishes a chorus is that it comes back. That is a question about harmony and timbre,
// and `segments` carries both - pitches[12] and timbre[12]. The method is the standard one: build
// per-bar feature vectors, compare every bar with every other, find the structural boundaries with
// a checkerboard novelty kernel (Foote), then keep the boundaries that open a block which is both
// loud and repeated elsewhere in the track.

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

const FRAME_FALLBACK_SEC = 1.6; // when a track has no usable bar grid
const MIN_FRAMES = 24;
const KERNEL_BARS = 4; // checkerboard half-width, in frames: a boundary is judged over ~8 of them
const MIN_GAP_SEC = 12;
const MAX_MOMENTS = 5;
// how far the winning reading of a track's structure must beat the next one to be acted on
const CONFIDENCE_MARGIN = 2.5;
const MIN_OCCURRENCES = 3;
// in normalised energy units, where a whole track spans roughly 0.06..0.62
const MIN_GROWTH = -0.02;

type Frame = { t: number; duration: number; feature: number[]; brightness: number };

// Per-bar chroma and timbre, averaged from whatever segments overlap the bar. Bars when the tracker
// gives a usable grid, fixed windows otherwise - on music with no steady metre its bar lines are
// worse than an arbitrary ruler, and this only needs a consistent frame, not a musical one.
function buildFrames(segments: Segment[], bars: Bar[]): Frame[] {
	// Bars, not a fixed clock grid, which scored worse across the board. Structure lives in phrases,
	// so a kernel measured in bars asks the same musical question of a slow track and a fast one,
	// while a kernel measured in seconds asks a different one of each.
	//
	// Long bars are subdivided rather than accepted. Tracks with ~3s bars leave too few frames for a
	// whole song (49 and 57 in two labelled cases, both failed outright); halving those keeps the
	// grid musical while giving structure something to be found in.
	const spans: { t: number; duration: number }[] = [];
	const usableBars = bars.filter(b => b.duration > 0.2 && b.duration < 12);
	if (usableBars.length >= MIN_FRAMES) {
		for (const bar of usableBars) {
			const pieces = bar.duration > 2.2 ? 2 : 1;
			for (let k = 0; k < pieces; k++)
				spans.push({ t: bar.start + (bar.duration / pieces) * k, duration: bar.duration / pieces });
		}
	} else {
		const end = segments.length ? segments[segments.length - 1].start + segments[segments.length - 1].duration : 0;
		for (let t = 0; t + FRAME_FALLBACK_SEC <= end; t += FRAME_FALLBACK_SEC)
			spans.push({ t, duration: FRAME_FALLBACK_SEC });
	}

	const raw: { t: number; duration: number; feature: number[]; brightness: number }[] = [];
	let cursor = 0;
	for (const span of spans) {
		const end = span.t + span.duration;
		const chroma = new Array<number>(12).fill(0);
		const timbre = new Array<number>(4).fill(0);
		let weight = 0;
		while (cursor > 0 && segments[cursor - 1] && segments[cursor - 1].start + segments[cursor - 1].duration > span.t)
			cursor--;
		for (let i = cursor; i < segments.length; i++) {
			const seg = segments[i];
			if (seg.start >= end) break;
			const overlap = Math.min(end, seg.start + seg.duration) - Math.max(span.t, seg.start);
			if (overlap <= 0) continue;
			for (let k = 0; k < 12; k++) chroma[k] += (seg.pitches[k] || 0) * overlap;
			for (let k = 0; k < 4; k++) timbre[k] += (seg.timbre[k] || 0) * overlap;
			weight += overlap;
		}
		if (weight <= 0) continue;

		// chroma answers "what harmony", timbre "what instruments" - a chorus usually changes both,
		// and on a compressed master it changes them while changing loudness barely at all
		const feature: number[] = [];
		for (let k = 0; k < 12; k++) feature.push(chroma[k] / weight);
		for (let k = 1; k < 4; k++) feature.push(Math.max(-1, Math.min(1, timbre[k] / weight / 100)) * 0.7);
		let norm = 0;
		for (const v of feature) norm += v * v;
		norm = Math.sqrt(norm) || 1;
		raw.push({
			t: span.t,
			duration: span.duration,
			feature: feature.map(v => v / norm),
			// kept unnormalised: a chorus is usually the brighter, fuller-sounding part, and on a
			// track with no dynamics left that is the only thing separating it from a verse
			brightness: Math.max(-1, Math.min(1, timbre[1] / weight / 100))
		});
	}

	// Mean-centre before anything compares these. Every bar of a track in one key has a similar
	// chroma vector, so raw cosine similarity is high between a verse and a chorus as readily as
	// between two choruses, and every block collapses into a single group ("the chorus" then means
	// the whole song). Subtracting the track's own average leaves only how each bar departs from
	// that track, which is what actually differs between its parts. Synthetic data with
	// artificially distinct chords would not show this.
	if (raw.length === 0) return [];
	const dims = raw[0].feature.length;
	const mean = new Array<number>(dims).fill(0);
	for (const f of raw) for (let d = 0; d < dims; d++) mean[d] += f.feature[d] / raw.length;
	return raw.map(f => {
		const centred = f.feature.map((v, d) => v - mean[d]);
		let norm = 0;
		for (const v of centred) norm += v * v;
		norm = Math.sqrt(norm) || 1;
		return { t: f.t, duration: f.duration, feature: centred.map(v => v / norm), brightness: f.brightness };
	});
}

function similarity(a: Frame, b: Frame): number {
	let dot = 0;
	for (let k = 0; k < a.feature.length; k++) dot += a.feature[k] * b.feature[k];
	return dot;
}

// Foote's novelty: slide a checkerboard over the diagonal of the self-similarity matrix. It is high
// where the frames before a point resemble each other, the frames after resemble each other, and
// the two halves do not resemble each other - which is the definition of a boundary, and needs no
// reference to how loud anything is.
function noveltyCurve(frames: Frame[], ssm: Float32Array): number[] {
	const n = frames.length;
	const novelty = new Array<number>(n).fill(0);
	const k = KERNEL_BARS;
	for (let i = k; i < n - k; i++) {
		let same = 0;
		let cross = 0;
		for (let a = 1; a <= k; a++)
			for (let b = 1; b <= k; b++) {
				same += ssm[(i - a) * n + (i - b)] + ssm[(i + a - 1) * n + (i + b - 1)];
				cross += ssm[(i - a) * n + (i + b - 1)] * 2;
			}
		novelty[i] = (same - cross) / (2 * k * k);
	}
	return novelty;
}

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

// Turned off, deliberately.
//
// With this detector on, a chorus felt right on a track where it stays silent and wrong on both
// tracks where it fires. Whatever the anticipation adds is currently subtracting: the audio-driven
// response - section intensity, strike density, the drum accumulation - already gives a chorus its
// arrival without being told where one is.
//
// The labelled scoreboard cannot be trusted either: the labels for one track turned out to be the
// times the visualiser fired rather than the times a chorus happens, so its perfect 3/3 was the
// detector being scored against its own output. Nothing acts on this code until the labels are
// re-collected by ear.
const ENABLED = false;

// ---------------------------------------------------------------------------------------------
// What actually ships, while the chorus detector above stays off.
//
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

function findRises(curve: CurvePoint[], bars: Bar[]): Moment[] {
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

export function findMoments(segments: Segment[], bars: Bar[], curve: CurvePoint[]): Moment[] {
	if (!ENABLED) return findRises(curve, bars);
	const frames = buildFrames(segments, bars);
	if (frames.length < MIN_FRAMES || curve.length < 20) return [];

	const n = frames.length;
	const ssm = new Float32Array(n * n);
	for (let i = 0; i < n; i++)
		for (let j = i; j < n; j++) {
			const value = similarity(frames[i], frames[j]);
			ssm[i * n + j] = value;
			ssm[j * n + i] = value;
		}

	const novelty = noveltyCurve(frames, ssm);
	const maxNovelty = Math.max(...novelty, 1e-6);

	// how loud the ten seconds after a candidate are, as a rank within the track - the same
	// reasoning as everywhere else here, because decibels are a property of the mastering
	const loudnessAfter = frames.map(f => {
		let sum = 0;
		let count = 0;
		for (let s = 0; s < 10; s += 0.5) {
			sum += sampleCurve(curve, f.t + s);
			count++;
		}
		return sum / Math.max(1, count);
	});
	const loudOrder = loudnessAfter.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
	const loudRank = new Array<number>(n).fill(0);
	loudOrder.forEach((entry, position) => (loudRank[entry.i] = n > 1 ? position / (n - 1) : 0.5));

	// Boundaries alone are not the answer. Novelty is just as high where a chorus ends as where it
	// begins, so a boundary list contains every verse start too, which produces a spurious firing
	// for every real one. The question is not "where does something change" but "which of these
	// blocks is the chorus", and that is answered by grouping the blocks and looking at which
	// group repeats while being loud and bright.
	const boundaries: number[] = [];
	const noveltyFloor = maxNovelty * 0.25;
	for (let i = KERNEL_BARS; i < n - KERNEL_BARS; i++) {
		if (novelty[i] < noveltyFloor) continue;
		let isPeak = true;
		for (let k = -2; k <= 2; k++) if (k !== 0 && novelty[i + k] > novelty[i]) isPeak = false;
		if (!isPeak) continue;
		if (boundaries.length && frames[i].t - frames[boundaries[boundaries.length - 1]].t < 6) continue;
		boundaries.push(i);
	}
	if (boundaries.length < 3) return [];

	// each boundary opens a block that runs to the next one
	const blocks = boundaries.map((from, k) => {
		const to = k + 1 < boundaries.length ? boundaries[k + 1] : n;
		const signature = new Array<number>(frames[0].feature.length).fill(0);
		let brightness = 0;
		for (let i = from; i < to; i++) {
			for (let d = 0; d < signature.length; d++) signature[d] += frames[i].feature[d];
			brightness += frames[i].brightness;
		}
		const count = Math.max(1, to - from);
		let norm = 0;
		for (const v of signature) norm += v * v;
		norm = Math.sqrt(norm) || 1;
		return {
			from,
			t: frames[from].t,
			seconds: (to < n ? frames[to].t : frames[n - 1].t + frames[n - 1].duration) - frames[from].t,
			signature: signature.map(v => v / norm),
			brightness: brightness / count,
			loud: loudRank[from]
		};
	});

	// group blocks that sound like each other. A chorus is the group that comes back
	const groups: { members: number[]; signature: number[] }[] = [];
	for (let b = 0; b < blocks.length; b++) {
		let joined = false;
		for (const group of groups) {
			let dot = 0;
			for (let d = 0; d < group.signature.length; d++) dot += group.signature[d] * blocks[b].signature[d];
			if (dot > 0.55) {
				group.members.push(b);
				joined = true;
				break;
			}
		}
		if (!joined) groups.push({ members: [b], signature: blocks[b].signature });
	}

	// Loud, bright, repeated, and long enough to be a section rather than a fill. Brightness earns
	// its place on tracks with no dynamics left, where it is the only thing still telling a chorus
	// from a verse; requiring repetition is what keeps a one-off swell out.
	let chorus: { members: number[] } | null = null;
	let bestGroupScore = 0;
	let runnerUpScore = 0;
	for (const group of groups) {
		if (group.members.length < 2) continue;
		// a group holding most of the track is not a chorus, it is the track. This is the guard that
		// would have caught the collapse above from the outside, whatever caused it
		if (group.members.length > blocks.length * 0.45) continue;
		let loud = 0;
		let bright = 0;
		let seconds = 0;
		let first = Infinity;
		let last = 0;
		for (const b of group.members) {
			loud += blocks[b].loud;
			bright += blocks[b].brightness;
			seconds += blocks[b].seconds;
			first = Math.min(first, blocks[b].t);
			last = Math.max(last, blocks[b].t);
		}
		const count = group.members.length;
		// A chorus is spread through the song - it comes back much later, that is what makes it a
		// chorus. A group of neighbouring blocks is one section that got over-segmented, and gave
		// false answers such as three "choruses" inside a thirty-second stretch. Requiring the
		// members to span a real fraction of the track costs nothing and rules that out.
		const trackSeconds = Math.max(1, frames[n - 1].t - frames[0].t);
		const spread = (last - first) / trackSeconds;
		if (spread < 0.2) continue;
		const score =
			Math.min(4, count) *
			(0.3 + 0.7 * (loud / count)) *
			(0.45 + 0.55 * Math.max(0, bright / count + 0.5)) *
			(0.5 + spread) *
			(seconds / count >= 8 ? 1 : 0.45);
		if (score > bestGroupScore) {
			runnerUpScore = bestGroupScore;
			bestGroupScore = score;
			chorus = group;
		} else if (score > runnerUpScore) runnerUpScore = score;
	}
	// Nothing repeats convincingly: say nothing. A missed chorus is invisible, an invented one is a
	// visible malfunction.
	//
	// The margin test is the same idea applied to ambiguity rather than absence. When the best group
	// barely beats the next one, the track has not been understood - two candidate readings of its
	// structure scored alike and one was picked by a hair. Across eight labelled tracks, firing
	// anyway made roughly half of all firings wrong; staying quiet on those tracks costs
	// coverage and buys the thing that actually matters, which is that what does fire is right.
	if (!chorus) return [];
	// A reading with only two occurrences is as easily an intro and an outro as a chorus
	if (chorus.members.length < MIN_OCCURRENCES) return [];
	if (bestGroupScore < runnerUpScore * CONFIDENCE_MARGIN) return [];

	// A last veto: false firings look more intense than real ones and out of place. That is what a
	// gesture with no musical support looks like - at a real chorus the music grows alongside it and
	// the two merge, while at an invented one the visual is the only thing happening on screen.
	//
	// Loudness can never find a chorus, but it can still veto one. If the
	// ten seconds after a moment are no bigger than the ten before, nothing arrived there.
	const grew = (t: number) => {
		let before = 0;
		let after = 0;
		for (let s = 0.5; s <= 10; s += 0.5) {
			before += sampleCurve(curve, Math.max(0, t - s));
			after += sampleCurve(curve, t + s);
		}
		return (after - before) / 20;
	};

	const moments: Moment[] = [];
	for (const b of chorus.members.slice().sort((x, y) => blocks[x].t - blocks[y].t)) {
		const block = blocks[b];
		if (moments.length >= MAX_MOMENTS) break;
		if (moments.some(m => Math.abs(m.t - block.t) < MIN_GAP_SEC)) continue;
		if (grew(block.t) < MIN_GROWTH) continue;
		moments.push({ t: block.t, size: Math.min(1, 0.55 + block.loud * 0.45), ...describeLeadIn(curve, block.t, beatOf(bars)) });
	}
	return moments.sort((a, b) => a.t - b.t);
}
