import { sampleCurve, segmentAt } from "../audio-data";
import { timbreBrightness } from "./effects";
import { currentEnergy, PresetFrame } from "./types";

// The moments themselves come from `findMoments` in track-structure.ts, which reads the loudness
// envelope rather than the section list. Deriving them from `sections` does not work on real
// tracks: a flat 2.5dB threshold never fires, scaling it to the track's dB range fires even less
// (one silent outro defines that range), and ranking the sections fires on the wrong moments,
// because section boundaries are a segmentation by timbre and are not where a chorus starts.
// fire this far before the boundary, to pay back three stacked lags: the eased chase, the frame,
// and the fact that a listener hears the downbeat's attack rather than its notional start.
// Knowing the future is what makes paying them back possible at all
const IMPACT_LEAD_SEC = 0.12;
// how far ahead to look for one. Beyond this it is not anticipation, it is just knowing the track
const IMPACT_HORIZON_SEC = 25;
// How long the run-in lasts is measured per moment, not fixed - see track-structure.ts. Tracks
// differ: some build for eight seconds, some cut out for one bar, some simply arrive. The last
// stretch of whatever that turns out to be is the wind-up, where a fill lives.
// The drop is an envelope, not a bang: the field gains speed through the approach, reaches its
// maximum at the drop, and the brightness swells into it instead of switching on. Both are shaped
// from `timeToImpact` directly, because a step in either is the one thing this project forbids. The
// moments are known for the whole track at load, so the envelope can be a function of time rather
// than a filter chasing a pulse - which also makes it frame-rate independent and peaking exactly
// where it is aimed.
// 3t^2-2t^3: zero slope at both ends, so nothing this shapes can start or stop abruptly
const smoothstep = (t: number) => {
	const u = Math.max(0, Math.min(1, t));
	return u * u * (3 - 2 * u);
};
// How long the acceleration before a drop lasts: as long as the music's own preparation, and no
// longer. A floor of 3.5s would override the measurement rather than use it, and `leadSeconds`
// reports the shortest lead-in it can for half of all moments across 89 dumps: the field would
// accelerate for three and a half seconds into music that had prepared for one.
const WINDUP_SPAN_MIN = 1.2;   // seconds of acceleration before the drop, at least
const WINDUP_SPAN_MAX = 7;     // and at most - a run-up longer than this stops reading as one
const WINDUP_HOLD = 1.9;       // speed stays up this long after the drop instead of dropping out
// Between tracks. A track change takes the analysis away for as long as the next one takes to
// load, and then hands over a different song at a different level. Without handling, the level
// follows a fallback sine up (0.45 -> 0.56 in half a second, louder than the song that had just
// ended), and on the frame the new analysis arrives it falls to 0.10 - every speed in the picture
// divided by four in one frame.
// the level the picture breathes out to while it waits, and how long it waits before deciding the
// track has no analysis at all and falling back to the pulse
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
	// The same loudness with the per-segment sawtooth taken out (a window a beat and a half wide,
	// centred on the playhead).
	//
	// `energy` is not a level. It is the loudness curve, and that curve is an attack-decay ramp per
	// segment: measured over 89 dumps it reverses direction 3.8 times a second and any half-second
	// of it spans 2.0x. Anything that sets a speed has to read this instead - speed wired to
	// `energy` accelerates and brakes several times a second, and the eye reads that as the
	// particles racing rather than as the music being loud. Taking the sawtooth out costs nothing
	// in dynamics: measured over the same dumps, verse-to-chorus speed stays 1.68x either way,
	// because smoothing keeps the mean and drops only the ripple.
	//
	// Brightness, line width and spawn rate may still read `energy` directly - a step in light is a
	// hit, a step in motion is a fault.
	loudness: number;
	// seconds until the next moment (see track-structure.ts), or null when there is none within the
	// horizon. With `lookAhead`, one of the two signals that look forward - everything else
	// describes now or the recent past
	timeToImpact: number | null;
	// 0..1, rising over the last few seconds before that boundary and released at it. Use it to pull
	// back - contract, dim, slow - so the boundary lands on something that had made room for it
	anticipation: number;
	// how far the music itself thins out on the way in, 0..1, and how much it climbs. Both measured
	// from this track rather than assumed. Read them to choose the gesture: follow the music down
	// when it drops out, wind up with it when it builds, and do very little when it just arrives
	runInDip: number;
	runInBuild: number;
	// 0..1 over the last part of the measured run-in, on top of `anticipation`. A run-up is not
	// more withdrawal, it is the opposite gesture inside it: a fill accelerates and thickens while
	// the mix is still held back. Drive speed and density from this and leave brightness to the
	// brace, so the picture winds up in the dark and the release is still the first thing that
	// actually lights
	windup: number;
	// swells into a moment and peaks on it, scaled by the moment's size. Bigger and rarer than
	// `pop`, which fires on every beat
	impact: number;
	// eased timbre[1] (spectral brightness), 0..1
	brightness: number;
	// how percussive the current segment's own attack is, 0..1 - from loudness_max_time (how long the
	// segment took to reach its peak): a fast rise (a drum hit, a pluck) reads as sharp, a slow swell
	// (a pad, a bowed note, a held vocal) reads as soft. Real per-segment data, not invented - updates
	// once per segment, eased between values so it doesn't snap
	attackSharpness: number;
	// a fast, short-lived pulse (same envelope shape as pop) that fires when the harmony actually
	// moves - the cosine distance between this segment's 12-band chroma and the previous segment's.
	// A held chord stays near zero; an actual chord change or key shift spikes it. Distinct from pop
	// (which fires on any beat/segment regardless of harmonic content)
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
		// A centred window, not a follower - and measured in beats of this track, not in seconds.
		//
		// A follower is by definition late by its own time constant: on one track the melody's speed
		// peaked 2.9s after the drop. The speeds read this, so everything the field does would arrive a
		// follower's worth behind the music.
		//
		// The lag is avoidable, and only here: the analysis is a timeline, so the loudness half a
		// second from now is already known. Averaging symmetrically about the playhead removes the
		// delay completely while smoothing the per-segment sawtooth exactly as before. This is the
		// same licence peak alignment uses, applied to a level instead of an event.
		//
		// A beat and a half wide, because a bar is where "how loud is this passage" stops being about
		// the passage - and a fraction of a beat is the same musical thing on a fast track and a slow
		// one, which a fixed 0.6s is not.
		if (audio) {
			const half = (audio.tempo > 40 ? 60 / audio.tempo : 0.5) * 0.75;
			let sum = 0;
			for (let k = -3; k <= 3; k++) sum += sampleCurve(audio.loudnessCurve, progressSec + (half * k) / 3);
			// a new track is joined over a second and a half, level and light together, from wherever
			// the picture was - never assigned (see Between tracks)
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
		// a segment boundary is a real timbral transition in the audio, not invented - a second,
		// faster-changing (~0.2-0.4s) reactive signal between beats, not just on them
		const segmentHit = segment !== null && segment.start !== lastSegmentStart;
		lastSegmentStart = segment ? segment.start : null;
		// real per-segment attack character and harmonic movement - both only update ON a segment
		// change (they describe the segment as a whole), eased the rest of the time so nothing snaps
		if (segmentHit && segment) {
			// loudness_max_time: how long the segment took to reach its peak. ~0s = percussive, ~0.25s+
			// = a slow swell - 0.25s chosen as the ceiling since Spotify's segments average well under 1s
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
		// everything about the boundary is evaluated slightly ahead of the clock, so the release
		// arrives with the downbeat instead of after it
		const lookAt = progressSec + IMPACT_LEAD_SEC;
		// The moments come from the loudness envelope, not from section boundaries - see findMoments.
		// There are at most a dozen per track, so a plain scan costs nothing.
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

		// The release, as a shape in time. Rises for IMPACT_RISE seconds into the moment so its peak
		// lands on the moment rather than starting there, then falls away over IMPACT_FALL. Both
		// halves are curves; there is no instant anywhere in it.
		const impactBefore =
			timeToImpact !== null && timeToImpact < IMPACT_RISE
				? smoothstep(1 - timeToImpact / IMPACT_RISE) * impactSize
				: 0;
		const impactAfter =
			sinceMoment !== null && sinceMoment >= 0 && sinceMoment < IMPACT_FALL
				? Math.pow(1 - sinceMoment / IMPACT_FALL, 1.6) * lastMomentSize
				: 0;
		impact = Math.max(impactBefore, impactAfter);

		// eased in both directions - the release at the boundary is fast but it is still a curve,
		// never a step. Squared-ish approach so the pull-back is barely there at
		// four seconds out and unmistakable in the last one
		const anticipationTarget =
			timeToImpact !== null && timeToImpact < leadSeconds
				? Math.pow(1 - timeToImpact / leadSeconds, 1.6) * impactSize
				: 0;
		anticipation +=
			(anticipationTarget - anticipation) * Math.min(1, (anticipationTarget > anticipation ? 3 : 9) * dt);

		// The acceleration. Spans most of the run-in rather than a third of it, and is shaped so it
		// builds gently at first and hardest in the last second - a run-up whose rate is constant
		// reads as the field simply moving faster, not as something being wound up. Peaks at the
		// moment, then holds and releases over WINDUP_HOLD, because falling to zero the instant the
		// drop lands would be a step, in the other channel.
		const windupSpan = Math.max(WINDUP_SPAN_MIN, Math.min(WINDUP_SPAN_MAX, leadSeconds));
		// Gated by how loud the music actually is on the way in.
		//
		// A wind-up that is a function of the time to the moment and the moment's size - the
		// destination - reads nothing about the present, and comes out inverted: over 311 run-ins,
		// r = -0.30 between the energy during a run-in and the speed the run-in reaches. A moment is
		// big in `findRises` precisely because the stretch before it was quiet (the rise is
		// proportional), so size correlates with silence, and speed follows size. The quietest
		// run-ins measured got 2.25x while the loudest got 1.22x: the field sprinting through
		// near-silence and crawling through a riser, exactly backwards.
		//
		// Speed reads as loudness. A viewer takes motion for energy, so accelerating through a quiet
		// passage says "loud" while the music says "quiet", and no tuning of the curve fixes a
		// statement that contradicts the sound. The run-up survives; its ceiling is the level of the
		// music carrying it.
		//
		// Measured over the approach, not the present frame. The wind-up peaks at the moment, where
		// the music is already loud, so gating on instantaneous energy leaves the two seconds
		// actually being looked at untouched (the correlation moves from -0.30 to -0.29). A
		// two-second follower still reflects the run-in at the instant the drop lands, which is the
		// question: how loud has it been on the way in, not how loud is it now.
		//
		// Relative to this track, not to a fixed 0.28. Quiet is a per-track word: the loudness curve
		// is normalised per track and its median sits around 0.35-0.46, so a fixed 0.28 is above the
		// whole distribution on some tracks and below it on others. Against the track's own typical
		// level it means the same thing on every track.
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
		// these describe the approaching moment, so they must be in place before it - eased only
		// enough not to step when one moment's description replaces another's
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
