import { sampleCurve, segmentAt } from "../audio-data";
import { timbreBrightness } from "./effects";
import { currentEnergy, PresetFrame } from "./types";

// Moments come from `findMoments` (track-structure.ts), not from the section list.
// Lead before the boundary: covers the eased chase, the frame and the audible attack.
const IMPACT_LEAD_SEC = 0.12;
// how far ahead to look for one. Beyond this it is not anticipation, it is just knowing the track
const IMPACT_HORIZON_SEC = 25;
// Drop envelopes are functions of `timeToImpact` (moments are known at load): frame-rate independent, peaking on the moment.
// 3t^2-2t^3: zero slope at both ends, so nothing this shapes can start or stop abruptly
const smoothstep = (t: number) => {
	const u = Math.max(0, Math.min(1, t));
	return u * u * (3 - 2 * u);
};
// Acceleration before a drop lasts as long as the music's own lead-in; no fixed floor.
const WINDUP_SPAN_MIN = 1.2;   // seconds of acceleration before the drop, at least
const WINDUP_SPAN_MAX = 7;     // and at most - a run-up longer than this stops reading as one
const WINDUP_HOLD = 1.9;       // speed stays up this long after the drop instead of dropping out
// Between tracks the level breathes out to GAP_REST; after GAP_HOLD seconds with no analysis the fallback pulse takes over.
const GAP_REST = 0.12;
const GAP_HOLD = 3;
// how long the level takes to come round to a new track's own, seconds
const JOIN_SECONDS = 1.5;
const IMPACT_RISE = 0.7;       // brightness swells for this long into the moment
const IMPACT_FALL = 1.8;       // and falls away over this long after it

// Shared plumbing for the presets: the Conductor turns a frame's audio analysis into eased signals.

export type Conductor = {
	dt: number;
	scale: number;
	energy: number;
	// loudness with the per-segment sawtooth removed (centred window, 1.5 beats). Speeds read this, never `energy`;
	// brightness, width and count may read `energy`.
	loudness: number;
	// seconds until the next moment (track-structure.ts), null beyond the horizon
	timeToImpact: number | null;
	// 0..1, rising over the last seconds before the moment and released at it; use to pull back
	anticipation: number;
	// 0..1: how far the music thins out into the moment, and how much it climbs (measured per track)
	runInDip: number;
	runInBuild: number;
	// 0..1 over the last part of the run-in: speed and density rise while brightness stays braced
	windup: number;
	// swells into a moment and peaks on it, scaled by its size; rarer than `pop`
	impact: number;
	// eased timbre[1] (spectral brightness), 0..1
	brightness: number;
	// 0..1, how percussive the current segment's attack is (from loudness_max_time); eased between segments
	attackSharpness: number;
	// short pulse when the harmony moves: cosine distance of 12-band chroma between consecutive segments
	harmonicShift: number;
};

// All the eased gesture/audio state the presets need, updated once per frame.
// Call this only on frames that actually render - a paused frame must not advance any of it.
export function createConductor() {
	let lastTime: number | null = null;
	let brightness = 0;
	let lastSegmentStart: number | null = null;
	let anticipation = 0;
	let windup = 0;
	let runInDip = 0;
	let runInBuild = 0;
	let approachEnergy = 0.2;
	let loudness = 0.2;
	// the curve of the track last joined, how long there has been none, how far into a new one the
	// level has come (0..1), and the level it is coming from
	let joinedCurve: unknown = null;
	let gap = 0;
	let join = 1;
	let heldLevel = 0.2;
	let impact = 0;
	let lastMomentT: number | null = null;
	let lastMomentSize = 0;
	let lastLookAt = -1;
	let attackSharpness = 0;
	let attackSharpnessTarget = 0;
	let harmonicShift = 0;
	let harmonicShiftTarget = 0;
	let prevPitches: number[] | null = null;
	// this track's own middle loudness, worked out once when the analysis arrives
	let curveMedian = 0.4;
	let medianFor: unknown = null;

	return (frame: PresetFrame): Conductor => {
		const { width, height, progressSec, audio } = frame;

		const dt = lastTime !== null ? Math.max(0, Math.min(0.05, progressSec - lastTime)) : 0;
		lastTime = progressSec;
		const scale = Math.min(width, height);

		if (audio && audio.loudnessCurve !== medianFor) {
			medianFor = audio.loudnessCurve;
			const ys = audio.loudnessCurve.map(p => p.y).sort((a, b) => a - b);
			curveMedian = ys.length > 0 ? ys[ys.length >> 1] : 0.4;
		}
		let energy = currentEnergy(frame);
		// Centred window (1.5 beats of this track), not a follower: a follower lags by its time constant,
		// and the analysis is a timeline, so the future of the level is known.
		if (audio) {
			const half = (audio.tempo > 40 ? 60 / audio.tempo : 0.5) * 0.75;
			let sum = 0;
			for (let k = -3; k <= 3; k++) sum += sampleCurve(audio.loudnessCurve, progressSec + (half * k) / 3);
			// a new track is joined over JOIN_SECONDS from wherever the picture was
			if (audio.loudnessCurve !== joinedCurve) {
				joinedCurve = audio.loudnessCurve;
				join = 0;
				heldLevel = loudness;
			}
			gap = 0;
			join = Math.min(1, join + dt / JOIN_SECONDS);
			const k = smoothstep(join);
			loudness = heldLevel + (sum / 7 - heldLevel) * k;
			energy = heldLevel + (energy - heldLevel) * k;
		} else {
			joinedCurve = null;
			gap += dt;
			// waiting for the next track's analysis the picture breathes out; only a track that turns out
			// to have none at all gets the fallback pulse
			if (gap < GAP_HOLD) {
				loudness += (GAP_REST - loudness) * Math.min(1, 1.5 * dt);
				energy = loudness;
			} else loudness += (energy - loudness) * Math.min(1, 1.6 * dt);
		}
		// ~2s follower, for anything that has to describe the stretch just gone rather than this frame
		approachEnergy += (energy - approachEnergy) * Math.min(1, 0.5 * dt);
		const segment = audio ? segmentAt(audio.segments, progressSec) : null;
		// a segment boundary is a real timbral transition: a reactive signal between beats
		const segmentHit = segment !== null && segment.start !== lastSegmentStart;
		lastSegmentStart = segment ? segment.start : null;
		// real per-segment attack character and harmonic movement - both only update ON a segment
		// change (they describe the segment as a whole), eased the rest of the time so nothing snaps
		if (segmentHit && segment) {
			// loudness_max_time ~0 is percussive, 0.25 s or more a slow swell
			attackSharpnessTarget = Math.max(0, Math.min(1, 1 - segment.loudness_max_time / 0.25));
			if (prevPitches) {
				let dot = 0;
				let na = 0;
				let nb = 0;
				for (let i = 0; i < 12; i++) {
					dot += prevPitches[i] * segment.pitches[i];
					na += prevPitches[i] * prevPitches[i];
					nb += segment.pitches[i] * segment.pitches[i];
				}
				const cosSim = na > 1e-6 && nb > 1e-6 ? dot / Math.sqrt(na * nb) : 1;
				// a held chord's consecutive segments stay similar (cosSim near 1) - scaled up since a
				// real chord change rarely drops cosSim much below ~0.6-0.7 in practice
				harmonicShiftTarget = Math.min(1, Math.max(0, 1 - cosSim) * 2.5);
			}
			prevPitches = segment.pitches;
		}
		attackSharpness += (attackSharpnessTarget - attackSharpness) * Math.min(1, 6 * dt);
		harmonicShift += (harmonicShiftTarget - harmonicShift) * Math.min(1, (harmonicShiftTarget > harmonicShift ? 25 : 7) * dt);

		brightness += (Math.max(0, timbreBrightness(segment)) - brightness) * Math.min(1, 0.8 * dt);

		// ---- looking forward ---------------------------------------------------------------------
		// evaluated slightly ahead of the clock so the release arrives with the downbeat
		const lookAt = progressSec + IMPACT_LEAD_SEC;
		// a dozen moments at most per track, so a plain scan is fine
		const moments = audio?.moments ?? [];
		let timeToImpact: number | null = null;
		let impactSize = 0;
		let leadSeconds = 3;
		let dipTarget = 0;
		let buildTarget = 0;
		for (const moment of moments) {
			if (moment.t <= lookAt) continue;
			if (moment.t - lookAt <= IMPACT_HORIZON_SEC) {
				timeToImpact = moment.t - lookAt;
				impactSize = moment.size;
				leadSeconds = moment.leadSeconds;
				dipTarget = moment.dip;
				buildTarget = moment.build;
			}
			break;
		}

		// crossing one records it. Forwards only, so seeking backwards cannot set it off
		if (lastLookAt >= 0 && lookAt > lastLookAt)
			for (const moment of moments)
				if (moment.t > lastLookAt && moment.t <= lookAt) {
					lastMomentT = moment.t;
					lastMomentSize = moment.size;
					break;
				}
		lastLookAt = lookAt;
		const sinceMoment = lastMomentT === null ? null : lookAt - lastMomentT;

		// The release: rises into the moment so its peak lands on it, falls after; no instant in it.
		const impactBefore =
			timeToImpact !== null && timeToImpact < IMPACT_RISE
				? smoothstep(1 - timeToImpact / IMPACT_RISE) * impactSize
				: 0;
		const impactAfter =
			sinceMoment !== null && sinceMoment >= 0 && sinceMoment < IMPACT_FALL
				? Math.pow(1 - sinceMoment / IMPACT_FALL, 1.6) * lastMomentSize
				: 0;
		impact = Math.max(impactBefore, impactAfter);

		// eased both ways; barely there at four seconds out, clear in the last one
		const anticipationTarget =
			timeToImpact !== null && timeToImpact < leadSeconds
				? Math.pow(1 - timeToImpact / leadSeconds, 1.6) * impactSize
				: 0;
		anticipation +=
			(anticipationTarget - anticipation) * Math.min(1, (anticipationTarget > anticipation ? 3 : 9) * dt);

		// Acceleration: gentle at first, hardest in the last second, held for WINDUP_HOLD after the drop so it does not step down.
		const windupSpan = Math.max(WINDUP_SPAN_MIN, Math.min(WINDUP_SPAN_MAX, leadSeconds));
		// Gated by the loudness of the approach (2 s follower) relative to this track's median: ungated, wind-up follows moment
		// size, which correlates with silence, and the field races through quiet passages (docs/DATA.md 3.3).
		const windupAllowance = Math.min(1, approachEnergy / Math.max(0.08, curveMedian * 0.75));
		const windupBefore =
			timeToImpact !== null && timeToImpact < windupSpan
				? Math.pow(1 - timeToImpact / windupSpan, 1.25) * impactSize * windupAllowance
				: 0;
		const windupAfter =
			sinceMoment !== null && sinceMoment >= 0 && sinceMoment < WINDUP_HOLD
				? smoothstep(1 - sinceMoment / WINDUP_HOLD) * lastMomentSize
				: 0;
		windup = Math.max(windupBefore, windupAfter);
		// eased only enough not to step when one moment's description replaces another's
		runInDip += (dipTarget - runInDip) * Math.min(1, 4 * dt);
		runInBuild += (buildTarget - runInBuild) * Math.min(1, 4 * dt);

		const conducted: Conductor = {
			dt,
			scale,
			energy,
			loudness,
			timeToImpact,
			anticipation,
			windup,
			runInDip,
			runInBuild,
			impact,
			attackSharpness,
			harmonicShift,
			brightness,
		};
		lastConducted = conducted;
		return conducted;
	};
}

// The last frame's conductor, so the dev-build marker (B in the client) can record the signals at
// the moment it was pressed.
export let lastConducted: Conductor | null = null;
