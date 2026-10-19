import { nearestBarStart, sampleCurve, sectionIndexAt, segmentAt, timeSinceLastBeat } from "../audio-data";
import {
	createEnergyTrend,
	createRippleTracker,
	rippleGlowAt,
	rippleInfluence,
	shimmerPhase,
	shimmerTint,
	timbreBrightness
} from "./effects";
import { hitIndexAt } from "../rhythm";
import { currentEnergy, PresetFrame } from "./types";

type Segment = SpotifyAudioAnalysis["segments"][number];

// Where the moments themselves come from is `findImpacts` in audio-data.ts, which reads the
// loudness envelope rather than the section list. Three attempts at deriving them from `sections`
// failed on real tracks: a flat 2.5dB threshold never fired at all, scaling it to the track's dB
// range fired even less because one silent outro defines that range, and ranking the sections
// finally fired - on the wrong moments, because section boundaries are a segmentation by timbre
// and are simply not where a chorus starts.
// fire this far BEFORE the boundary. The visuals were reported as landing slightly late, and there
// are three lags stacked up: the eased chase, the frame, and the fact that a listener hears the
// downbeat's attack rather than its notional start. Knowing the future is what makes paying them
// back possible at all
const IMPACT_LEAD_SEC = 0.12;
// how far ahead to look for one. Beyond this it is not anticipation, it is just knowing the track
const IMPACT_HORIZON_SEC = 25;
// how long the brace lasts. Long enough to read as withdrawal, short enough not to be a mood
// How long the run-in lasts is MEASURED per moment, not fixed - see track-structure.ts. Tracks
// differ: some build for eight seconds, some cut out for one bar, some simply arrive. A constant
// dimmed through tracks that were already dimming and dimmed through tracks that were accelerating.
// The last stretch of whatever that turns out to be is the wind-up, where a fill lives.
// The drop, as an envelope rather than a bang. Reported, more than once and finally in full: "no
// run-up, no smoothness, just a dumb explosion" - the design has always been that the field GAINS
// speed through the approach, reaches its maximum AT the drop, and the brightness swells into it
// instead of switching on.
//
// What was there: `impact` was set to the moment's size on the frame the moment was crossed and
// eased at 25/s, which is full strength in about forty milliseconds. That is a step, and a step is
// the one thing this project forbids. The wind-up spanned 0.3 of the run-in - under a second on
// most tracks - and then fell to zero the instant the moment passed, which is a second step.
//
// What is here now: both are shaped from `timeToImpact` directly. The moments are known for the
// whole track at load, so the envelope can be a function of time rather than a filter chasing a
// pulse - which also means it is frame-rate independent and peaks exactly where it is aimed
// (DESIGN-RULES §5b, the rule the star already follows).
// 3t^2-2t^3: zero slope at both ends, so nothing this shapes can start or stop abruptly
const smoothstep = (t: number) => {
	const u = Math.max(0, Math.min(1, t));
	return u * u * (3 - 2 * u);
};
// How long the acceleration before a drop lasts: as long as the music's own preparation, and no
// longer. This used to floor at 3.5s, which overrode the measurement rather than using it - and
// `leadSeconds` reports the shortest lead-in it can for HALF of all moments across 89 dumps, so
// half the time the field accelerated for three and a half seconds into music that had prepared
// for one. Reported on Borderline at 0:19: a moment whose measured run-in is 1.2s and whose build
// is 0.17, given a 3.5s run-up through a passage quieter than the track's own median.
// the strength of the narrowest hit worth reporting, so a three-band hit is a real event and an
// eight-band one is the biggest thing the track has
const HIT_FLOOR = 0.6;
// how far a band agreement may sit from a segment start and still be that segment's hit. Two
// different measurements of the same onset do not agree to the millisecond
const HIT_MATCH = 0.06;
const WINDUP_SPAN_MIN = 1.2;   // seconds of acceleration before the drop, at least
const WINDUP_SPAN_MAX = 7;     // and at most - a run-up longer than this stops reading as one
const WINDUP_HOLD = 1.9;       // speed stays up this long after the drop instead of dropping out
// BETWEEN TRACKS. A track change takes the analysis away for as long as the next one takes to load,
// and then hands over a different song at a different level. Measured on Layers 3D before this
// existed: with no analysis the level followed a fallback sine UP (0.45 -> 0.56 in half a second,
// louder than the song that had just ended), and on the frame the new analysis arrived it fell to
// 0.10 - every speed in the picture divided by four in one frame.
// the level the picture breathes out to while it waits, and how long it waits before deciding the
// track has no analysis at all and falling back to the pulse
const GAP_REST = 0.12;
const GAP_HOLD = 3;
// how long the level takes to come round to a new track's own, seconds
const JOIN_SECONDS = 1.5;
const IMPACT_RISE = 0.7;       // brightness swells for this long INTO the moment
const IMPACT_FALL = 1.8;       // and falls away over this long after it

// Shared plumbing for the whole Flow Field family - all 7 variants build on the helpers here so the
// DJ-deck control surface behaves identically across every one and only the *look* (and each
// preset's own field-generation math/blend style) differs between them.

// shortest-path blend between two angles. Every gesture bends the field's own angle with this
// instead of handing a particle a competing direction vector - a separate "vector to the cursor"
// fighting for a share of the motion is what makes particles clot into a blob at the cursor.
export function lerpAngle(a: number, b: number, t: number): number {
	const diff = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
	return a + diff * Math.max(0, Math.min(1, t));
}

export type Conductor = {
	dt: number;
	scale: number;
	energy: number;
	// The same loudness with the per-segment sawtooth taken out (~0.6s follower).
	//
	// `energy` is NOT a level. It is the loudness curve, and that curve is an attack-decay ramp per
	// SEGMENT: measured over 89 dumps it reverses direction 3.8 times a second and any half-second
	// of it spans 2.0x. Anything that sets a SPEED has to read this instead - speed wired to
	// `energy` accelerates and brakes several times a second, and the eye reads that as the
	// particles racing rather than as the music being loud. Taking the sawtooth out costs nothing
	// in dynamics: measured over the same dumps, verse-to-chorus speed stays 1.68x either way,
	// because a follower keeps the mean and drops only the ripple.
	//
	// Brightness, line width and spawn rate may still read `energy` directly - a step in light is a
	// hit, a step in motion is a fault (DESIGN-RULES §1).
	loudness: number;
	// loudness-driven accumulator: fast attack, slow release, nudged by beats where they exist
	momentum: number;
	// smoothed brightness/line-width driver - audio only, never gestures
	glow: number;
	// a fast, short-lived spike on an actual beat (or a smaller one on a segment change) - momentum's
	// slow release is deliberate for the ambient mood, but on its own it smears consecutive hits into
	// one continuous blur. This is the crisp "you can see the beat" layer on top of it: ~30ms attack,
	// ~120ms decay, so distinct hits stay visually distinct
	pop: number;
	// how strong the last beat was METRICALLY, not how loud: 1 on a beat that starts a bar, ~0.45 on
	// one that does not. From `bars`, which the analysis has always sent and which this project spent
	// its whole life discarding. Note this is a property of the beat, not a continuous signal - it
	// holds its value until the next beat rather than easing
	beatStrength: number;
	// seconds until the next section that is meaningfully louder than this one, or null when there
	// is no such thing coming. THE ONLY SIGNAL IN THE PROJECT THAT LOOKS FORWARD - everything else
	// describes now or the recent past. ARCHITECTURE §1 claims the motion can anticipate rather than
	// react; until this existed, nothing did
	timeToImpact: number | null;
	// 0..1, rising over the last few seconds before that boundary and released at it. Use it to pull
	// back - contract, dim, slow - so the boundary lands on something that had made room for it
	anticipation: number;
	// how far the music itself thins out on the way in, 0..1, and how much it climbs. Both measured
	// from this track rather than assumed. Read them to choose the GESTURE: follow the music down
	// when it drops out, wind up with it when it builds, and do very little when it just arrives
	runInDip: number;
	runInBuild: number;
	// 0..1 over the last part of the measured run-in, on top of `anticipation`. A run-up is not
	// more withdrawal, it is the opposite gesture inside it: a fill accelerates and thickens while
	// the mix is still held back. Drive speed and density from this and leave brightness to the
	// brace, so the picture winds up in the dark and the release is still the first thing that
	// actually lights
	windup: number;
	// A real transient in the audio: a segment that begins with a fast attack AND arrives louder
	// than the segments around it. 0 on every other frame, 0..1 on the frame it happens.
	//
	// This is what a HIT is, as opposed to what a BEAT is. Beats come from a tempo grid the tracker
	// fits over the track, which on music that does not keep a regular metre - math rock, odd time,
	// rubato - is a regular pulse laid over an irregular piece, and firing percussion from it looks
	// exactly as wrong as that sounds. Segments are timbral events measured from the audio itself
	// and follow the music whatever it does with its bar lines. On ordinary music the two coincide,
	// because a kick makes a sharp segment.
	strike: number;
	// The hit that has NOT HAPPENED YET, if one is due within `seconds`. Returns how far off it is
	// and how hard it will be.
	//
	// An eye reads an event at its PEAK, not at its onset. Anything whose response takes time to
	// reach full strength therefore has to be started BEFORE the hit, or its peak lands after it and
	// the whole thing feels late - which is what "late" has meant every single time it was reported
	// in this project. The star's rise alone is 0.4s of lateness.
	//
	// This is possible at all only because the analysis is a timeline rather than a stream: the
	// segments after the playhead are already in memory, with their loudness and their attack. It is
	// the first thing here to actually use that, and it is what ARCHITECTURE §1 has always claimed.
	lookAhead: (seconds: number) => { inSeconds: number; power: number; sharpness: number; downbeat: boolean } | null;
	// fires ON the boundary, scaled by how much louder the new section actually is. Bigger and rarer
	// than `pop`, which fires on every beat
	impact: number;
	// how big the part of the song currently playing is, as its rank among this track's own
	// sections: 0 is its quietest passage, 1 its biggest. Eased, so a boundary is a slope rather
	// than a step. Read this to spend a budget on the chorus - particles, size, brightness - instead
	// of spreading it evenly over a track that is not evenly interesting. 0.5 with no sections
	sectionIntensity: number;
	// down-flick -> chaos, up-flick -> order. Both eased, both global (the field's mood), and both
	// decay back to neutral within a second or so - a single flick's instant response
	chaos: number;
	order: number;
	// chaos/order INCLUDING a slow-decaying baseline that repeated flicking builds up over tens of
	// seconds and that fades back out over roughly a minute - so conducting for a while actually
	// leaves the piece changed for a while, the way real conducting shapes a performance's arc,
	// rather than a gesture's effect fully evaporating the instant the flick ends. Structural/visual
	// formulas should read these, not the raw pulses above, unless they specifically want "only
	// during the flick itself"
	chaosTotal: number;
	orderTotal: number;
	// fast (~2s) vs slow (~20s) energy average: trend is + while a section is building, - while it's
	// settling; level is roughly "how loud is this whole stretch". Lets a preset's structure respond
	// to the music's actual arc instead of only to per-frame loudness
	trend: number;
	level: number;
	// a slow (~2 minute period), audio- and gesture-independent wander - purely so a preset never
	// sits at one fixed structural resting point for the length of a whole song
	wander: number;
	// direction the cursor is actually moving in right now, and how hard - both eased
	gustAngle: number;
	gustStrength: number;
	// how CONSISTENT that direction has actually been, 0..1 - gustAngle/gustStrength alone can't
	// tell a real swipe from fast erratic wiggling (dancing to the music), since both are "moving
	// fast". This is the magnitude of the eased direction vector before it gets collapsed into just
	// an angle: a steady direction keeps it near 1, a direction that keeps changing (circles, random
	// motion) partially cancels itself out and drags it toward 0. Use this to gate anything that
	// should only respond to a real deliberate gesture, not to "the cursor is moving fast" alone
	gustCoherence: number;
	// brief flash on click, decays fast. Clicks never touch speed
	// true on exactly the frame a click was registered - trigger one-shot effects (a ripple) off this
	// ---- THE BATON --------------------------------------------------------------------------
	// The only shape input is allowed to take in this project: a MAGNITUDE. No position in it, no
	// direction in it, and nothing local - the same number everywhere on the picture.
	//
	// Five attempts at gesture failed before this and DESIGN-RULES §1 records them all as one root
	// cause: raw input setting direction. The cause under that one is that INPUT IS ON A DIFFERENT
	// CLOCK. A hand moves on human whim, the picture moves on the music, and anything that lets the
	// first into the geometry writes a discontinuity there is nothing to smooth against.
	//
	// A conductor does not make the sound. The score is written and the orchestra knows it; the
	// conductor decides how widely it is played. So this measures HOW LARGE THE GESTURE IS, in units
	// of the picture crossed per bar of this track, and it is eased on the music's clock - a flick
	// arrives as a swell over a bar, never as a step.
	//
	// Both are 0 with the pointer at rest, and at 0 every preset behaves exactly as it did before
	// this existed. Conducting is an addition, never a mechanism something depends on.
	/** the gesture, over a BAR - the slow, structural read. 0..1 */
	baton: number;
	/** the same gesture over a BEAT - the quick read, so the two channels it drives cannot fuse */
	hand: number;
	/**
	 * How brightly the pointer's recent path passes through (x, y), 0..1 - the trace it leaves
	 * behind it as it moves.
	 *
	 * This is the one narrow place DESIGN-RULES §2 allows a gesture into brightness, and it is built
	 * to its terms: it LIGHTS A PARTICLE THAT IS ALREADY THERE and never draws a shape of its own,
	 * so there is nothing to see where there is nothing already. It is a PATH, not a disc around the
	 * cursor - a resting pointer's mark decays to nothing within a beat, which is what stops it
	 * becoming the lightbulb that shipped once before. And it is bounded small at the source.
	 *
	 * Light only. It must never reach an angle or a speed: the trail is sampled from raw pointer
	 * position, which is the exact thing §1b forbids in geometry.
	 */
	trailAt: (x: number, y: number) => number;
	/**
	 * A click, as a glow where it landed and a ring spreading out of it, 0..1 at (x, y).
	 *
	 * Light and turbulence only, never speed: the ring is a NARROW band, and it crosses a stationary
	 * particle in about fifty milliseconds. Brightness is allowed to move that fast (§1b); a stroke
	 * length is not, and speed times the frame is stroke length.
	 */
	rippleAt: (x: number, y: number) => number;
	clicked: boolean;
	// same, right mouse button - a different one-shot gesture
	rightClicked: boolean;
	// scroll wheel as a global speed fader - eased towards the raw scroll knob, not applied instantly,
	// so a big wheel tick ramps the speed rather than snapping it
	speedFader: number;
	// cursor Y: +1 attract (top) .. -1 repel (bottom), 0 dead centre
	yAttraction: number;
	// eased timbre[1] (spectral brightness), 0..1
	brightness: number;
	// how percussive the CURRENT segment's own attack is, 0..1 - from loudness_max_time (how long the
	// segment took to reach its peak): a fast rise (a drum hit, a pluck) reads as sharp, a slow swell
	// (a pad, a bowed note, a held vocal) reads as soft. Real per-segment data, not invented - updates
	// once per segment, eased between values so it doesn't snap
	attackSharpness: number;
	// a fast, short-lived pulse (same envelope shape as pop) that fires when the harmony actually
	// moves - the cosine distance between this segment's 12-band chroma and the previous segment's.
	// A held chord stays near zero; an actual chord change or key shift spikes it. Distinct from pop
	// (which fires on ANY beat/segment regardless of harmonic content) and from Chroma Bloom's own
	// key-change detector (which needs a sustained new leader, not a single segment's motion) - this
	// is available to every preset, not just that one
	harmonicShift: number;
	segment: Segment | null;
	beatHit: boolean;
};

// All the eased gesture/audio state every Flow Field variant needs, updated once per frame.
// Call this only on frames that actually render - a paused frame must not advance any of it.
export function createConductor() {
	let lastTime: number | null = null;
	let lastClicks = 0;
	let lastRightClicks = 0;
	let prevMouseX: number | null = null;
	let prevMouseY: number | null = null;
	let chaos = 0;
	let order = 0;
	let gustDirX = 0;
	let gustDirY = 0;
	let gustStrength = 0;
	let momentum = 0;
	let glow = 0;
	let pop = 0;
	let brightness = 0;
	let lastBeatSince: number | null = null;
	let lastSegmentStart: number | null = null;
	let beatStrength = 0.7;
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
	let avgSegmentDb = -20;
	let hitCursor = 0;
	let lastHitScan: number | null = null;
	let strike = 0;
	let sectionIntensity = 0.5;
	let attackSharpness = 0;
	let attackSharpnessTarget = 0;
	let harmonicShift = 0;
	let harmonicShiftTarget = 0;
	let prevPitches: number[] | null = null;
	let chaosBaseline = 0;
	let orderBaseline = 0;
	let wanderTime = 0;
	let scrollSmooth = 0.5;
	// where the pointer was last frame, how far it has travelled recently, and the two eased reads
	let batonPrevX: number | null = null;
	let batonPrevY: number | null = null;
	let baton = 0;
	let hand = 0;
	// the pointer's recent path: a point is laid down every time it has moved far enough for the
	// spacing to be even, and each one fades on its own clock
	const trail: { x: number; y: number; born: number }[] = [];
	let trailClock = 0;
	let laidX: number | null = null;
	let laidY: number | null = null;
	// clicks, each one a glow and a ring going out of it
	const rings: { x: number; y: number; born: number }[] = [];
	const trendTracker = createEnergyTrend();
	// this track's own middle loudness, worked out once when the analysis arrives
	let curveMedian = 0.4;
	let medianFor: unknown = null;

	return (frame: PresetFrame): Conductor => {
		const { width, height, progressSec, audio, mouse } = frame;

		const dt = lastTime !== null ? Math.max(0, Math.min(0.05, progressSec - lastTime)) : 0;
		lastTime = progressSec;
		const scale = Math.min(width, height);

		// ---- THE BATON ---------------------------------------------------------------------------
		const beatSec = audio && audio.tempo > 40 ? 60 / audio.tempo : 0.5;
		const barSec = beatSec * 4;
		if (batonPrevX === null || batonPrevY === null) {
			batonPrevX = mouse.x;
			batonPrevY = mouse.y;
		}
		const moved = Math.hypot(mouse.x - batonPrevX, mouse.y - batonPrevY);
		batonPrevX = mouse.x;
		batonPrevY = mouse.y;
		// HOW FAST THE HAND IS MOVING RIGHT NOW, against a rate of twice the picture's short side per
		// bar of this track. A real unit rather than a number: it holds at any window size and tempo.
		//
		// It used to be distance ACCUMULATED over a bar and then eased over another one, which is two
		// bars of lag on the answer to your own hand, and it read as dead. That design came out of
		// over-applying §1b: geometry may not step, so I made the input wait for the music. The two do
		// not follow from each other. A ramp that begins on the frame of the movement and takes eighty
		// milliseconds to get there is INSTANT to a hand and CONTINUOUS to a trail - there is no
		// discontinuity anywhere in it. The rule was never about latency; it was about direction.
		const swept = dt > 0 ? Math.min(1, moved / dt / ((scale * 2) / barSec)) : 0;
		// UP IN EIGHTY MILLISECONDS, DOWN ON THE MUSIC'S CLOCK. The asymmetry is the whole point: the
		// picture answers the hand at once and lets go over a bar, so a flick swells and settles rather
		// than blinking. Two falls off one rise on purpose - a bar and a beat are far enough apart that
		// the channels they drive stay separate things instead of one knob pushed twice.
		const grab = 1 / 0.08;
		baton += (swept - baton) * Math.min(1, (swept > baton ? grab : 1 / barSec) * dt);
		hand += (swept - hand) * Math.min(1, (swept > hand ? grab : 1 / beatSec) * dt);

		// ---- THE TRACE THE POINTER LEAVES ----------------------------------------------------------
		// Points are laid down BY DISTANCE, not by frame, so a slow hand and a fast one leave the same
		// ribbon rather than the slow one leaving a dense clot - which is how a per-frame sample would
		// concentrate exactly where the pointer lingers, and lingering is where the lightbulb came from.
		trailClock += dt;
		const trailLife = beatSec * 1.2;
		// TEN TIMES THE AREA. At 0.055 the hand's reach was a 56 px wire across a 1024 px picture - it
		// touched five to thirteen strokes out of four hundred, and measured 1.2-4.2% of the light the
		// ground was emitting. DESIGN-RULES §12 already fixed what that means: in the sensitivity sweep
		// that condemned the old Layers, twenty-five of its signals measured under 7% each and that was
		// the evidence they never reached the screen. Conducting was sitting under the project's own
		// threshold for invisible. Local was right; local and tiny was not.
		const trailRadius = scale * 0.17;
		// eight points across the radius whatever the radius is, so the sum below does not have to be
		// renormalised every time the reach changes
		const trailStep = trailRadius / 8;
		// Against the LAST PLACE A POINT WAS LAID, which outlives the trail itself. Reading the head of
		// the buffer instead meant that once the ribbon had aged out from under a resting pointer the
		// buffer was empty, a fresh point went down at full strength, faded over its beat and a bit,
		// and the whole thing repeated - a spot switching on and off under a hand that was not moving,
		// on the beat. That is the lightbulb of DESIGN-RULES §2 with a metronome attached.
		if (laidX === null || laidY === null) {
			laidX = mouse.x;
			laidY = mouse.y;
		} else if (mouse.clicks !== lastClicks || mouse.rightClicks !== lastRightClicks) {
			// a click is the hand touching the picture, so it leaves a point even from a standstill -
			// otherwise a press with a motionless pointer has nowhere to happen
			laidX = mouse.x;
			laidY = mouse.y;
			trail.push({ x: mouse.x, y: mouse.y, born: trailClock });
		} else if (Math.hypot(mouse.x - laidX, mouse.y - laidY) > trailStep) {
			laidX = mouse.x;
			laidY = mouse.y;
			trail.push({ x: mouse.x, y: mouse.y, born: trailClock });
		}
		while (trail.length > 0 && trailClock - trail[0].born > trailLife) trail.shift();
		if (trail.length > 96) trail.shift();
		// ---- A CLICK, AS A GLOW AND A RING ---------------------------------------------------------
		// Both halves are measured in the music's own units: the ring crosses the short side of the
		// picture in a beat and a half and the whole thing is gone in a bar, so a click on a slow
		// track spreads slowly and on a fast one quickly. Nothing here is in seconds.
		if (mouse.clicks !== lastClicks || mouse.rightClicks !== lastRightClicks)
			rings.push({ x: mouse.x, y: mouse.y, born: trailClock });
		const ringLife = barSec;
		const ringSpeed = scale / (beatSec * 1.5);
		while (rings.length > 0 && trailClock - rings[0].born > ringLife) rings.shift();
		if (rings.length > 8) rings.shift();
		const rippleAt = (x: number, y: number) => {
			let sum = 0;
			for (let i = 0; i < rings.length; i++) {
				const age = trailClock - rings[i].born;
				if (age < 0) continue;
				const fade = 1 - age / ringLife;
				const d = Math.hypot(x - rings[i].x, y - rings[i].y);
				// the glow: it stays where the click landed and goes out over a beat, so a press has a
				// body even before the ring has travelled anywhere
				const glowR = scale * 0.11;
				if (d < glowR) {
					const g = 1 - d / glowR;
					sum += g * g * Math.max(0, 1 - age / beatSec);
				}
				// the ring: the band WIDENS as it travels, which is both what a real ripple does and what
				// keeps it from turning into a hard edge once it is large
				const r = ringSpeed * age;
				const band = scale * 0.045 + r * 0.22;
				const off = Math.abs(d - r) / band;
				if (off < 1) {
					const e = 1 - off;
					sum += e * e * fade * fade * 1.3;
				}
			}
			return Math.min(1, sum);
		};

		const trailAt = (x: number, y: number) => {
			let sum = 0;
			for (let i = 0; i < trail.length; i++) {
				const dx = x - trail[i].x;
				const dy = y - trail[i].y;
				const d2 = dx * dx + dy * dy;
				if (d2 > trailRadius * trailRadius) continue;
				// age fades it out, distance shapes it, and both are smooth in their own variable, so a
				// particle moving through the ribbon reads a curve rather than an edge
				const fade = 1 - (trailClock - trail[i].born) / trailLife;
				sum += fade * fade * (1 - Math.sqrt(d2) / trailRadius);
			}
			// a stroke sitting on the path reads about 1, one at half the reach about a quarter
			return Math.min(1, sum * 0.14);
		};

		if (audio && audio.loudnessCurve !== medianFor) {
			medianFor = audio.loudnessCurve;
			const ys = audio.loudnessCurve.map(p => p.y).sort((a, b) => a - b);
			curveMedian = ys.length > 0 ? ys[ys.length >> 1] : 0.4;
		}
		let energy = currentEnergy(frame);
		// A CENTRED WINDOW, not a follower - and measured in BEATS of this track, not in seconds.
		//
		// A follower is by definition late by its own time constant, and it showed: reported as "the
		// melody accelerates late at the drop", and on 一緒なら the melody's own speed peaked 2.9s
		// after it. The speeds read this, so everything the field does was arriving a follower's
		// worth behind the music.
		//
		// The lag is avoidable, and only here: the analysis is a TIMELINE, so the loudness half a
		// second from now is already known. Averaging symmetrically about the playhead removes the
		// delay completely while smoothing the per-segment sawtooth exactly as before. This is the
		// same licence peak alignment uses (DESIGN-RULES §5b), applied to a level instead of an event.
		//
		// A beat and a half wide, because a bar is where "how loud is this passage" stops being about
		// the passage - and a fraction of a beat is the same musical thing on a fast track and a slow
		// one, which a fixed 0.6s is not.
		if (audio) {
			const half = (audio.tempo > 40 ? 60 / audio.tempo : 0.5) * 0.75;
			let sum = 0;
			for (let k = -3; k <= 3; k++) sum += sampleCurve(audio.loudnessCurve, progressSec + (half * k) / 3);
			// a new track is joined over a second and a half, level and light together, from wherever
			// the picture was - never assigned (see BETWEEN TRACKS)
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
		const sinceBeat = audio ? timeSinceLastBeat(audio.beats, progressSec) : null;
		const beatHit = sinceBeat !== null && (lastBeatSince === null || sinceBeat < lastBeatSince);
		lastBeatSince = sinceBeat;
		const segment = audio ? segmentAt(audio.segments, progressSec) : null;
		// a segment boundary is a real timbral transition in the audio, not invented - a second,
		// faster-changing (~0.2-0.4s) reactive signal between beats, not just on them
		const segmentHit = segment !== null && segment.start !== lastSegmentStart;
		lastSegmentStart = segment ? segment.start : null;
		// a beat that starts a bar is the one the body counts on. Both grids come from the analysis
		// separately and do not land on identical floats, so the tolerance is generous; with no bars
		// at all every beat is treated as moderately strong rather than pretending to know
		if (beatHit && sinceBeat !== null) {
			const bars = audio?.bars ?? [];
			const near = nearestBarStart(bars, progressSec - sinceBeat);
			// the tracker's own confidence is carried through rather than assumed: a bar it was unsure
			// about should not drive as hard an accent as one it was certain of, and songs whose metre
			// the tracker cannot follow then simply produce a flatter pulse instead of a confident
			// wrong one
			beatStrength = near === null ? 0.7 : near.distance < 0.07 ? 0.55 + near.confidence * 0.45 : 0.45;
		}
		const popTarget = beatHit ? 0.35 + beatStrength * 0.65 : segmentHit ? 0.5 : 0;
		pop += (popTarget - pop) * Math.min(1, (popTarget > pop ? 30 : 8) * dt);

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
		// ---- a HIT ---------------------------------------------------------------------------------
		// From the audio's own onsets, where the track has them: `rhythmstring` decoded to eight
		// bands, and a hit is where at least three of them fire together (see rhythm.ts for the
		// format and for why a single band cannot be one). Measured against the beat grid over 81
		// tracks this is better than the segment rule on every axis at the same rate - 44% precision
		// against 28%, 63% beat recall against 51%, 61% downbeat recall against 46%.
		//
		// The COUNT is the strength, and that is measured too: across 316k hits, 3 bands land on a
		// beat 34% of the time and 8 bands 64%, rising monotonically. Breadth is how much of a hit
		// it was. How LOUD it was is a different measurement and stays where it was, in the segment
		// amplitude the preset reads separately.
		strike = 0;
		const hits = audio?.hits;
		if (hits && hits.length > 0 && segmentHit && segment) {
			// ON THE SEGMENT CLOCK, filtered by the bands - not on a clock of its own. Fired directly
			// off the onsets this was a measurably BETTER detector and a measurably WORSE picture:
			// the visible light landed on the beat 24% of the time against 41% before, on Harmonious.
			// Everything else in the visual - the loudness curve, the attack character, the harmonic
			// movement - is built from segments, so an event stream on a second clock puts the flash
			// between the frames where the rest of the picture is already moving, and the two smear
			// each other. One clock. The onsets say WHICH segments are hits, which is the thing the
			// segments themselves cannot tell us.
			if (lastHitScan === null || progressSec < lastHitScan || progressSec - lastHitScan > 0.5)
				hitCursor = Math.max(0, hitIndexAt(hits, progressSec - HIT_MATCH));
			lastHitScan = progressSec;
			while (hitCursor < hits.length && hits[hitCursor].t < segment.start - HIT_MATCH) hitCursor++;
			// the broadest agreement anywhere inside this segment's onset window
			for (let i = hitCursor; i < hits.length && hits[i].t <= segment.start + HIT_MATCH; i++)
				strike = Math.max(strike, HIT_FLOOR + ((hits[i].bands - 3) / 5) * (1 - HIT_FLOOR));
		} else if (segmentHit && segment) {
			// no rhythmstring (8 of 89 dumps) or no way to inflate it: a transient stands out from
			// its neighbours, so "loud" here means loud relative to this track's own segments rather
			// than on any absolute scale
			avgSegmentDb += (segment.loudness_max - avgSegmentDb) * 0.03;
			const prominence = Math.min(1, Math.max(0, (segment.loudness_max - avgSegmentDb) / 4));
			if (attackSharpnessTarget > 0.4) strike = Math.min(1, attackSharpnessTarget * (0.45 + prominence));
		}

		attackSharpness += (attackSharpnessTarget - attackSharpness) * Math.min(1, 6 * dt);
		harmonicShift += (harmonicShiftTarget - harmonicShift) * Math.min(1, (harmonicShiftTarget > harmonicShift ? 25 : 7) * dt);

		// how hard the current hit is, used as a smoothing target rather than applied directly, so
		// tracks with unreliable beat tracking still ride their real dynamics instead of sitting flat
		let hitTarget = energy * 0.35;
		if (beatHit) {
			const hitAmp = segment ? Math.pow(10, segment.loudness_max / 20) : energy;
			hitTarget = Math.max(hitTarget, Math.min(1.6, hitAmp * 2.2));
		}
		momentum += (hitTarget - momentum) * Math.min(1, (hitTarget > momentum ? 4 : 0.4) * dt);

		const clicked = mouse.clicks !== lastClicks;
		lastClicks = mouse.clicks;

		const rightClicked = mouse.rightClicks !== lastRightClicks;
		lastRightClicks = mouse.rightClicks;

		scrollSmooth += ((mouse.scroll || 0) - scrollSmooth) * Math.min(1, 1.8 * dt);

		const dxMove = prevMouseX !== null ? mouse.x - prevMouseX : 0;
		const dyMove = prevMouseY !== null ? mouse.y - prevMouseY : 0;
		prevMouseX = mouse.x;
		prevMouseY = mouse.y;
		const moveDist = Math.hypot(dxMove, dyMove);
		const moveSpeed = dt > 0 ? moveDist / dt : 0;

		// threshold deliberately well above ordinary cursor movement - only a real conductor's flick
		// fires this, not "the cursor happened to drift downward"
		const flickThreshold = scale * 2.2;
		const chaosTarget = Math.min(1, (dt > 0 ? Math.max(0, dyMove) / dt : 0) / flickThreshold);
		chaos += (chaosTarget - chaos) * Math.min(1, (chaosTarget > chaos ? 6 : 3) * dt);
		const orderTarget = Math.min(1, (dt > 0 ? Math.max(0, -dyMove) / dt : 0) / flickThreshold);
		order += (orderTarget - order) * Math.min(1, (orderTarget > order ? 6 : 3) * dt);

		if (moveDist > 0.6) {
			gustDirX += (dxMove / moveDist - gustDirX) * Math.min(1, 10 * dt);
			gustDirY += (dyMove / moveDist - gustDirY) * Math.min(1, 10 * dt);
		}
		const gustTarget = Math.min(3, moveSpeed / (scale * 0.4));
		gustStrength += (gustTarget - gustStrength) * Math.min(1, (gustTarget > gustStrength ? 6 : 2.5) * dt);

		brightness += (Math.max(0, timbreBrightness(segment)) - brightness) * Math.min(1, 0.8 * dt);

		const glowTarget = Math.max(0.22, momentum * 0.7 + energy * 0.25);
		glow += (glowTarget - glow) * Math.min(1, (glowTarget > glow ? 4 : 0.5) * dt);

		// the baseline only rises while a pulse is actively sustained (attack time constant ~6s, so a
		// single flick barely moves it - it takes real repeated conducting), and always decays back to
		// neutral on its own over ~45s regardless
		const chaosBaselineTarget = Math.min(0.3, chaos * 0.5);
		chaosBaseline +=
			(chaosBaselineTarget - chaosBaseline) * Math.min(1, (chaosBaselineTarget > chaosBaseline ? 1 / 6 : 1 / 45) * dt);
		const orderBaselineTarget = Math.min(0.3, order * 0.5);
		orderBaseline +=
			(orderBaselineTarget - orderBaseline) * Math.min(1, (orderBaselineTarget > orderBaseline ? 1 / 6 : 1 / 45) * dt);

		// ---- looking forward ---------------------------------------------------------------------
		// `sections` carries each part of the track with its own loudness, so the next loud one is
		// knowable before it arrives. Scan ahead rather than only to the next section: a chorus is
		// usually preceded by the quiet bar that sets it up, and stopping at the first neighbour
		// would miss it every time
		const sections = audio?.sections ?? [];
		const ranks = audio?.sectionIntensity ?? [];
		// everything about the boundary is evaluated slightly ahead of the clock, so the release
		// arrives with the downbeat instead of after it
		const lookAt = progressSec + IMPACT_LEAD_SEC;
		const sectionIndex = sectionIndexAt(sections, lookAt);
		// The moments come from the loudness envelope, not from section boundaries - see findImpacts.
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

		const intensityTarget = sectionIndex >= 0 && ranks.length > 0 ? (ranks[sectionIndex] ?? 0.5) : 0.5;
		// ~7s, not 0.6s. Section boundaries are a timbral segmentation, not musical events, and at
		// 0.6s a boundary arrived as a visible step in speed and brightness - an event manufactured
		// where the music has none. Exactly the mistake `surge` made, through a different door: a
		// signal describing slow context has to move slower than the events it sits underneath.
		sectionIntensity += (intensityTarget - sectionIntensity) * Math.min(1, 0.14 * dt);

		// The release, as a shape in time. Rises for IMPACT_RISE seconds INTO the moment so its peak
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
		// never a step (DESIGN-RULES §5). Squared-ish approach so the pull-back is barely there at
		// four seconds out and unmistakable in the last one
		const anticipationTarget =
			timeToImpact !== null && timeToImpact < leadSeconds
				? Math.pow(1 - timeToImpact / leadSeconds, 1.6) * impactSize
				: 0;
		anticipation +=
			(anticipationTarget - anticipation) * Math.min(1, (anticipationTarget > anticipation ? 3 : 9) * dt);

		// The acceleration. Spans most of the run-in rather than a third of it, and is shaped so it
		// builds gently at first and hardest in the last second - a run-up whose rate is constant
		// reads as the field simply moving faster, not as something being wound up. Peaks AT the
		// moment, then holds and releases over WINDUP_HOLD, because falling to zero the instant the
		// drop lands is the same step the release used to have, in the other channel.
		const windupSpan = Math.max(WINDUP_SPAN_MIN, Math.min(WINDUP_SPAN_MAX, leadSeconds));
		// Gated by how loud the music ACTUALLY IS right now, and this is the correction that matters.
		//
		// The wind-up was a function of the time to the moment and the moment's SIZE - the
		// destination - and read nothing about the present. Measured over 311 run-ins that is not
		// merely deaf, it is INVERTED: r = -0.30 between the energy during a run-in and the speed the
		// run-in reaches. A moment is big in `findRises` precisely because the stretch before it was
		// quiet (the rise is proportional), so size correlates with silence, and speed followed size.
		// The quietest run-ins measured got 2.25x while the loudest got 1.22x - the field sprinting
		// through near-silence and crawling through a riser, which is exactly backwards.
		//
		// Speed reads as loudness. A viewer takes motion for energy, so accelerating through a quiet
		// passage says "loud" while the music says "quiet", and no amount of tuning the curve fixes a
		// statement that contradicts the sound. The run-up survives; its ceiling is now the level of
		// the music carrying it.
		// Measured over the APPROACH, not the present frame, and this distinction is the whole fix.
		// The wind-up peaks AT the moment, where the music is already loud, so gating on instantaneous
		// energy leaves the two seconds actually being looked at completely untouched - it moved the
		// correlation from -0.30 to -0.29. A two-second follower still reflects the run-in at the
		// instant the drop lands, which is the question being asked: how loud has it been on the way
		// in, not how loud is it now.
		// RELATIVE TO THIS TRACK, not to 0.28. The point of this gate is "do not wind up through a
		// passage that is quiet", and quiet is a per-track word: the loudness curve is normalised per
		// track, and its median sits around 0.35-0.46, so a fixed 0.28 was above the whole
		// distribution on some tracks and below it on others - the ceiling-through-the-distribution
		// fault of DESIGN-RULES 3b, in a gate rather than in a colour. Against the track's own typical
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

		const { level, trend } = trendTracker(energy, dt);
		wanderTime += dt;

		// segments are sorted, so the next one after the playhead is a binary search away
		const lookAhead = (seconds: number) => {
			const list = audio?.segments;
			if (!list || list.length === 0) return null;
			let lo = 0;
			let hi = list.length - 1;
			while (lo < hi) {
				const mid = Math.floor((lo + hi) / 2);
				if (list[mid].start <= progressSec) lo = mid + 1;
				else hi = mid;
			}
			const next = list[lo];
			if (!next || next.start <= progressSec || next.start - progressSec > seconds) return null;
			// whether the hit that is COMING lands on a bar line. `beatStrength` describes the last
			// beat, which is the wrong question when the whole point is to act before the next one
			const near = nearestBarStart(audio?.bars ?? [], next.start);
			return {
				// to the segment's PEAK, not to its start. Aligning an event by peak is the whole
				// point of looking ahead, and a segment's loudest instant is `loudness_max_time`
				// into it - up to a tenth of a second of lateness that no amount of tuning downstream
				// could have removed
				inSeconds: next.start + next.loudness_max_time - progressSec,
				// against the track's own big hits, and NOT clamped. Both halves matter: a fixed x1.8 on
				// Spotify's absolute scale saturates for most of a loud master, and a clamp at 1 makes
				// every hit in a chorus compare equal - which silently disables anything built on "was
				// that bigger than the last one"
				power: Math.pow(10, next.loudness_max / 20) / (audio?.hitScale || 0.56),
				sharpness: Math.max(0, Math.min(1, 1 - next.loudness_max_time / 0.25)),
				downbeat: near === null || near.distance < 0.09
			};
		};

		const conducted: Conductor = {
			dt,
			scale,
			lookAhead,
			energy,
			loudness,
			momentum,
			glow,
			pop,
			beatStrength,
			strike,
			timeToImpact,
			anticipation,
			windup,
			runInDip,
			runInBuild,
			impact,
			sectionIntensity,
			attackSharpness,
			harmonicShift,
			chaos,
			order,
			chaosTotal: Math.min(1, chaos + chaosBaseline),
			orderTotal: Math.min(1, order + orderBaseline),
			trend,
			level,
			wander: Math.sin(wanderTime * ((2 * Math.PI) / 120)),
			gustAngle: Math.atan2(gustDirY, gustDirX),
			gustCoherence: Math.min(1, Math.hypot(gustDirX, gustDirY)),
			gustStrength,
			baton,
			hand,
			trailAt,
			rippleAt,
			clicked,
			rightClicked,
			speedFader: 0.35 + scrollSmooth * 1.6,
			yAttraction: 1 - (mouse.y / height) * 2,
			brightness,
			segment,
			beatHit
		};
		lastConducted = conducted;
		return conducted;
	};
}

// ---------------------------------------------------------------------------------------------
// Two tools for looking rather than for guessing. Neither is read by the render path.

// The last frame's conductor, so the "this looks wrong" marker can record what the machine
// believed at the moment the eye disagreed with it. Twenty marks are a dataset; a description of
// what should have happened is a guess, and the descriptions have not worked.
export let lastConducted: Conductor | null = null;

// WHAT A SIMULATION BELIEVES ABOUT ITSELF, for the headless check to assert on.
//
// A preset that draws strokes is fully checked by the fake canvas: every number it hands over is
// seen. A preset that draws PIXELS is not - a Uint8ClampedArray turns a NaN into 0 on the way in,
// so by the time a bad value reaches an ImageData the evidence has been destroyed. Any preset with
// state that is not visible in its draw calls (a fluid's velocity field, a plate's mode
// amplitudes) publishes it here once a frame, and `check-presets.js` asserts every number in it is
// finite and within the range the preset declares.
export let lastDiagnostics: { label: string; values: Record<string, number> } | null = null;
export function publishDiagnostics(label: string, values: Record<string, number>): void {
	lastDiagnostics = { label, values };
}

// Live A/B. A preset reads this to pick between parameter sets, and the hotkey cycles it while the
// music plays - so a comparison is one keypress on the same passage instead of a rebuild, a
// restart, and a memory of what the other one looked like a minute ago.
let variant = 0;
export function getVariant(): number {
	return variant;
}
export function setVariant(v: number): void {
	variant = v;
}

// alt+scroll's particle-count knob, clamped to each preset's own safe ceiling - a one-liner, but
// identical across every preset, so it lives here once instead of five times
export function particleTargetCount(mouse: PresetFrame["mouse"], base: number, max: number): number {
	return Math.min(max, Math.round(base * (0.4 + mouse.particleScale * 1.2)));
}

// bundles the click/ripple/shimmer machinery every preset needs identically - was getting
// copy-pasted into each one nearly verbatim every time a new gesture landed. `begin()` once per
// frame, then `bendTowardRipple`/`glowAt`/`tint` per particle.
export function createGestureLayer() {
	const ripple = createRippleTracker();
	let shimmer = 0;
	let rippleRadius = 1;

	return {
		begin(frame: PresetFrame, c: Conductor, fieldTime: number) {
			const { mouse, width, height } = frame;
			if (c.clicked) ripple.trigger(mouse.x, mouse.y, 1);
			if (c.rightClicked) ripple.trigger(mouse.x, mouse.y, -1);
			ripple.paint(mouse.x, mouse.y, mouse.down, 1);
			ripple.paint(mouse.x, mouse.y, mouse.rightDown, -1);
			ripple.update(c.dt);
			shimmer = shimmerPhase(fieldTime);
			rippleRadius = Math.hypot(width, height); // reaches the whole screen over its life
		},
		// bends `angle` towards the ripple's push/pull, same bounded-bend treatment as every other
		// gesture - `strength` lets a preset with a very different character (Aurora's anisotropic
		// sweep) use a much gentler fraction than the default so the ripple nudges it instead of
		// overriding it outright
		bendTowardRipple(angle: number, x: number, y: number, strength = 0.85, radius = rippleRadius) {
			const rip = rippleInfluence(ripple.pos, ripple.neg, x, y, radius);
			return {
				angle: rip.weight > 0.01 ? lerpAngle(angle, rip.angle, rip.weight * strength) : angle,
				weight: rip.weight
			};
		},
		// how much extra brightness the cursor (while moving) and any active ripple lend to a
		// particle at (x, y) right now - only ever lights up a particle that's actually there
		glowAt(x: number, y: number, mouse: PresetFrame["mouse"], scale: number, gustStrength: number) {
			const dist = Math.hypot(mouse.x - x, mouse.y - y);
			return {
				dist,
				cursorGlow: Math.max(0, 1 - dist / (scale * 0.15)) * Math.min(1, gustStrength),
				rippleGlow: rippleGlowAt(ripple.pos, ripple.neg, x, y, rippleRadius)
			};
		},
		tint(base: { r: number; g: number; b: number }, pop: number) {
			return shimmerTint(base, shimmer, pop);
		}
	};
}

// The per-frame layer everything is drawn into first. It is cleared every frame and is the ONLY
// thing the bloom pass ever blurs - blurring the persistent trail canvas and compositing it back
// onto itself is unbounded positive feedback and whites the screen out within seconds.
export function createBloomLayer() {
	let buffer: HTMLCanvasElement | null = null;

	return {
		begin(width: number, height: number): CanvasRenderingContext2D {
			if (!buffer || buffer.width !== width || buffer.height !== height) {
				buffer = document.createElement("canvas");
				buffer.width = width;
				buffer.height = height;
			}
			const bctx = buffer.getContext("2d")!;
			bctx.clearRect(0, 0, width, height);
			return bctx;
		},
		// composite this frame's strokes sharp, then add the cursor-X bloom send on top of them
		flush(frame: PresetFrame, c: Conductor, blurScale = 0.01) {
			const { ctx } = frame;
			ctx.drawImage(buffer!, 0, 0);

			// Audio only. This used to be `mouse.x / width`, so the amount of bloom over the whole
			// screen was set by where the pointer happened to be resting: parked on the right it meant
			// maximum bloom for an entire song, on every preset, with nothing musical behind it, and
			// parked on the left it meant none at all. It is also the loudest brightness path in the
			// renderer - it re-composites the entire frame - so whatever it was doing overrode the
			// contrast every layer underneath it is carefully budgeted for. Gestures do not control
			// brightness: CLAUDE.md, DESIGN-RULES §2, and SIGNALS.md's own entry for `glow`.
			const amount = Math.min(1, c.glow * 0.55 + c.impact * 0.45);
			if (amount <= 0.03) return;
			ctx.save();
			ctx.globalCompositeOperation = "lighter";
			ctx.filter = `blur(${Math.max(2, c.scale * blurScale * amount)}px)`;
			ctx.globalAlpha = Math.min(0.5, amount * 0.55);
			ctx.drawImage(buffer!, 0, 0);
			ctx.restore();
		}
	};
}

export type Hsl = { h: number; s: number; l: number };

export function rgbToHsl({ r, g, b }: { r: number; g: number; b: number }): Hsl {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const d = max - min;
	const l = (max + min) / 2;
	let h = 0;
	if (d > 1e-6) {
		if (max === rn) h = ((gn - bn) / d) % 6;
		else if (max === gn) h = (bn - rn) / d + 2;
		else h = (rn - gn) / d + 4;
		h = (((h / 6) % 1) + 1) % 1;
	}
	return { h, s: d < 1e-6 ? 0 : d / (1 - Math.abs(2 * l - 1)), l };
}

// the extracted album colour as HSL, with saturation/lightness pulled into a usable band so a
// near-grey or near-black cover doesn't collapse the hue-shifting variants into mud
export function albumHsl(rgb: { r: number; g: number; b: number }): Hsl {
	const { h, s, l } = rgbToHsl(rgb);
	return { h, s: Math.max(0.45, Math.min(0.95, s)), l: Math.max(0.45, Math.min(0.66, l)) };
}
export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
	const hue = (((h % 1) + 1) % 1) * 6;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs((hue % 2) - 1));
	const m = l - c / 2;
	const k = Math.floor(hue) % 6;

	const rgb =
		k === 0 ? [c, x, 0] : k === 1 ? [x, c, 0] : k === 2 ? [0, c, x] : k === 3 ? [0, x, c] : k === 4 ? [x, 0, c] : [c, 0, x];

	return { r: Math.round((rgb[0] + m) * 255), g: Math.round((rgb[1] + m) * 255), b: Math.round((rgb[2] + m) * 255) };
}
