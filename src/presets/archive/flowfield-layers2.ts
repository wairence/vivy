// Layers II starts as a byte-for-byte copy of Layers. The visual is the thing being kept; the
// insides are the thing being replaced. Three attempts at rebuilding the look from a description
// of it produced three pictures that were not it, so the look is no longer being described - it is
// being carried over and then hollowed out one piece at a time, with the V key flipping between
// before and after so the eye decides at every step whether anything changed.
//
// What comes out, in order, each one its own A/B:
//   1. the gesture layer - cursor, ripples, gusts, particle-count knob (already slated for rework)
//   2. chaos/order and the invented heuristics on top of them
//   3. the twenty-six-signal modulation web on speed, replaced by the three measured time bands
//   4. p.power out of the speed - the 602 one-frame accelerations a minute
//
import { createNoise3D } from "simplex-noise";
import { createChromaTracker, createDensityGrid, fadeTrail, resizeToCount } from "../effects";
import {
	albumHsl,
	createBloomLayer,
	createConductor,
	createGestureLayer,
	hslToRgb,
	getVariant
} from "../flowfield-common";
import { rankOf } from "../../audio-data";
import { Preset, PresetDefinition, rgbString } from "../types";

// Layers. Every other preset in the family mixes all of the audio signals into one field that every
// particle follows, which is a claim about the music that is never true: music is not one thing.
// Here there are three populations, each driven by the layer of the music it belongs to and
// deliberately deaf to the others' signals - the sustained low end, the percussion, and the melody
// between them. One noise field feeds all three; what differs is the frequency it is sampled at,
// how fast it drifts, and the speed/spread/life curves each group rides.
//
// The layers are also COUPLED, but never continuously and never symmetrically. Common fate (things
// that move together are perceived as one thing) means constant mutual influence would fuse the
// three groups back into the single field this preset exists to escape. In real music each layer
// influences the others on the timescale it operates at musically: percussion instantly and
// briefly, bass continuously but slowly, melody rarely and structurally. Those different time
// constants are what let the eye read the couplings as separate. See COUPLINGS below.
//
// A layer only ever changes another layer's *conditions* - its brightness, its frame of reference,
// its spread, its turn rate. It never hands another layer a direction or a point to aim at, for the
// same reason a gesture never does (DESIGN-RULES §1).

// How far each group's heading may sit from the shared ground direction. These are OFFSETS, not
// directions: every group travels along the one wind, and a group's identity is how widely it
// wanders around it, never a heading of its own. Bounded well under PI on purpose - two independent
// absolute angles blended with lerpAngle are discontinuous when they approach opposite, because the
// shortest path flips sides. That measured as the melody frame jumping ~2.5 rad in a single frame,
// 5.5 times a second (154 rad/s peak, against Aurora's 0.79), which is what "particles with long
// trails change direction out of nowhere" looked like. An offset that can never reach PI cannot do
// this at all - the fix is structural, not a tuning.
// How far a lit spark's passage is felt by the other two layers, and how hard. Small on purpose -
// this is a cut through the field, not a glow around the cursor.
// x scale. 0.05 put a 72px halo on a 1440px-tall screen and the coupling measured 2-3% of the
// layer's light - the mark passed and nothing answered. Measured mean `cut` was 0.015.
const CUT_RADIUS = 0.09;
// How far the field turns into the wake a spark leaves, and how much it hurries there. The turn is
// bounded well under a right angle: this is a comb through the field, not a redirection of it.
const WAKE_TURN = 0.45;
// radians per second the turn into a wake may change - a cap, never a blend
const WAKE_RATE = 1.6;
const WAKE_SPEED = 0.9;

// How far above a TYPICAL recent hit one has to reach for the middle rank. Not measured against the
// star's decaying peak any more: that peak falls with a 4.6s half-life, which is faster than hits
// arrive, so by the next beat it had already dropped below the last hit and 71-92% of hits cleared
// it on the tracks measured. A rank that most hits reach is not a rank, it is the texture moving
// faster. Against a running average of what a hit sounds like around here, x1.1 promotes 2-34%
// depending on how dynamic the track is - and a compressed track honestly getting almost none is
// the right answer, not a bug.
const STREAK_OVER = 1.1;
// px/s before each spark's own pace. The streak the eye sees is this times the pace times the
// trail's ~0.37s, so a pace of 2.5 at 260 px/s draws about 240 pixels of falling star and a pace of
// 0.3 draws thirty.
const PERC_BASE = 120;
// how much faster a lit spark travels at the top of its flare, over its own pace, and how much more
// one that stood out from its neighbours gets
const FLING = 0.95;
const FLING_RANK = 1.2;
// what V flips between: how many sparks there are at all. "Too many" is the live complaint, so this
// is the knob that matters right now
const PERC_COUNTS = [70, 130, 200];
// almost nothing: the middle rank is longer-lived, not faster. Same reasoning as the star
// the release leans on light and width; speed is the channel every complaint about this has named
const MELODY_TILT_MAX = 0.5;
const PERC_SPREAD_MAX = 0.35;

// THE CANVAS THIS PRESET IS WRITTEN FOR. Everything below in pixels or in whole populations was
// tuned by eye in a windowed Spotify, not fullscreen, and what was tuned there is a DENSITY - how
// many strokes are in view at once - and a CROSSING TIME - how long one takes to travel the picture.
// Neither survives being handed four times the area with the same numbers: the same 400 strokes over
// four times the area is a quarter of the density, and 100 px/s crosses a small window in seven
// seconds and a large one in twenty-five. Widths, radii and the reach of a mark were already written
// against `scale` and needed nothing.
const REF_W = 1080;
const REF_H = 1024;

const BASS_COUNT = 180;
const MELODY_COUNT = 220;
// The dormant pool is deliberately larger than the loudest passage needs. A spark that never
// lights costs nothing to look at, but a pool that runs out is a ceiling on the population in
// exactly the way a clamped alpha is a ceiling on brightness (DESIGN-RULES §3b): at saturation a
// louder chorus cannot show as more, and the layer's dynamics flatten at the top.

// long, so the wide dim bass strokes smear into a wash rather than reading as strokes
const TRAIL_ALPHA = 0.045;

// the brightness budget. Three stacked layers summing to what one preset normally emits, or the
// bloom pass turns every overlap into a white blob (DESIGN-RULES §3) - and the drum layer only
// reads as a hit because the other two get out of its way, not because it is brighter still
const BASS_ALPHA_CAP = 0.75;
const MELODY_ALPHA_CAP = 0.9;
const PERC_ALPHA_CAP = 0.95;

// ctrl+click paints each group a flat identifiable colour so a misbehaving group can be named
// instead of guessed at. Diagnostic only - the album colour is the real palette, this just answers
// "which layer is that?". Module scope, not inside create(), for the same reason Aurora's telemetry
// listener is: create() reruns on every preset switch and an inner listener would leak a duplicate
// every time. Rides the existing telemetry-toggle event, so no new input plumbing in app.tsx; the
// guard keeps the headless check harness (no DOM events, no Spicetify global) out of it.
let diagnostic = false;
const DIAGNOSTIC_RGB = {
	bass: { r: 255, g: 64, b: 64 },
	melody: { r: 64, g: 255, b: 112 },
	perc: { r: 96, g: 156, b: 255 }
};
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
	window.addEventListener("flowfield-dev-toggle", (event: Event) => {
		if ((event as CustomEvent<string | null>).detail !== flowFieldLayers2Preset.id) return;
		diagnostic = !diagnostic;
		Spicetify.showNotification(
			diagnostic ? "Layers: bass red / melody green / percussion blue" : "Layers: album colour restored"
		);
	});
}

// `lit` is how much this particle is currently caught in a passing spark's wake. Eased, per
// particle: read straight off distance it is a switch - light on when a spark enters range, off
// when it leaves - which is what "unclear, ugly lighting" was. With its own attack and a slower
// release it becomes something arriving and fading instead.
type Particle = {
	// the wake this particle is sitting in: a direction and a strength, as a vector, eased. Kept per
	// particle rather than read fresh so the wake TRAILS - a spark passes, the field it went through
	// stays combed for about a second and relaxes back
	wx: number;
	wy: number;
	// how far it is currently turned into that wake, radians. See the comment at its use
	turn: number; x: number; y: number; life: number; brightness: number; lit: number };
// percussion particles are dormant most of the time: `fire` is the one-shot target a beat sets,
// `charge` is the eased follower that is actually drawn, so a spark lights over ~40ms instead of
// appearing at full brightness in a single frame
// `power` is how hard the hit that lit this spark actually was - the segment's own loudness_max as
// linear amplitude, real per-segment data rather than a guess (DESIGN-RULES §8). It stays with the
// spark for its whole life, so a soft hit is a slow short dim streak and a hard one is a fast long
// bright one, and the layer has a dynamic range instead of one uniform kind of spark.
type Spark = Particle & {
	// LEVEL 4: this spark's place in the sky's own order, fixed for its life. A hit reaches every
	// spark whose place falls inside its reach, so the same hit always finds the same sparks and the
	// response to a given size of hit is the same every time. This replaces `Math.random()` per
	// spark per hit, which made one hit look different from the next for no musical reason - and
	// made the offline measurements themselves swing by three points between identical runs.
	place: number;
	// Its own speed, fixed for its whole life. A hit may never change a spark's speed - that is the
	// 602 one-frame steps a minute - but the sparks do not have to be alike. Variety lives in the
	// POPULATION, not in time: one spark is a long fast streak all its life, the next barely drifts,
	// and neither ever changes. Skewed low, so most of the sky is slow and a fast one is an event by
	// being rare rather than by accelerating.
	pace: number;
	// the direction it is travelling, as a unit vector. The other two layers read it - see the wake
	// below - and a vector rather than an angle because several of them get summed
	dirX: number;
	dirY: number;
	// how fast its shove arrives, 1/s. Separate from the light's rise so that motion and brightness
	// can have different clocks: at a drop the light has to be there at once while the take-off is
	// the thing being watched
	chase: number;
	// how broadband the sound was, 0 for a vowel and 1 for a full-spectrum crack. It sets WIDTH,
	// because that is the channel that was carrying nothing: length already comes from the pace and
	// brightness from the loudness, so this is the free one, and it is the axis the eye needs to
	// tell a drum from a voice
	breadth: number;
	// 1 for a sound that swelled in, 0 for one that was simply there. Width reads it: measured over
	// 3947 marks, HALF of them sat at the minimum width, because width came only from how broadband
	// the attack was and 45% of sounds have no broadband attack at all - every sustained note, every
	// vowel. They came out as specks. A sound with no attack is not a small event, it is a soft one:
	// wide and gentle rather than narrow and quick.
	soft: number;
	// How much faster than its own pace it is going right now, 0..1-ish, and the important word is
	// STATE. A hit sets a target; this chases it. The 602 one-frame steps a minute came from a value
	// being ASSIGNED into the speed, not from the speed changing - at 5/s a hit moves this by 8% of
	// the gap in the first frame instead of 124% of the speed, and gets the whole fling inside a
	// quarter second anyway. The veto was on the step, never on the acceleration.
	boost: number;
	// THE SHAPE OF THE SOUND THAT LIT IT. Every attack is measured, never guessed: how long it took
	// to reach its peak, and how far it falls before the next event begins. Over 18 230 attacks the
	// two run with how broadband the onset was - three bands peak in 43ms and fall 6.6dB, eight peak
	// in 22ms and fall 11.7dB - which is the drum-against-voice axis, measured rather than assumed.
	// A crack gets a short bright dart. A voice gets a long slow drift that arrives without a snap.
	age: number;
	rise: number;
	decay: number;
	fling: number;
	charge: number;
	power: number;
	// middle rank: 0 for texture, 1 for a hit that stood out without owning the passage
	streak: number;
	// how long this particular spark holds, as a multiple. Fixed when it is created and unrelated to
	// how hard it was struck - a population where every member behaves identically reads as a
	// mechanism, and a few that simply hang on longer than their neighbours is what makes it read as
	// a population instead. Length of trail, again, from duration rather than from speed
	endurance: number;
};

// shortest signed way round from one angle to another
const shortest = (d: number) => ((d + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

function create(): Preset {
	const noise = createNoise3D();
	const bloom = createBloomLayer();
	const conduct = createConductor();
	const gesture = createGestureLayer();
	const chroma = createChromaTracker();
	// one grid, run separately over each layer. A shared grid would brighten wherever two layers
	// merely overlap, which is exactly the mush this preset is trying not to be
	const density = createDensityGrid(16, 16);

	let bass: Particle[] = [];
	let melody: Particle[] = [];
	let perc: Spark[] = [];

	let fieldTime = 0;
	// the ground: the direction the low end is currently lying in. Persistent and rate-capped, never
	// recomputed fresh - it is a frame of reference, and a frame of reference that jumps is useless
	let groundAngle = 0;
	// how far the harmony currently leans OFF the ground, in radians. A plain bounded scalar, eased
	// with a rate cap - a scalar has no wraparound, so it cannot produce the discontinuity an angle
	// blend can
	let melodyTilt = 0;
	// the sidechain envelope: how hard percussion is currently ducking everything else
	let duck = 0;
	// how widely the melody currently wanders off the frame. Eased, not used raw: its inputs include
	// harmonicShift, which rises in ~40ms, and this value is the AMPLITUDE of a geometric deviation -
	// snapping it kicks every melody particle's heading at once. Measured at 0.243 rad of turn in a
	// single frame against Aurora's 0.070 before this was eased.
	let melodySpread = 0.5;
	// How much drumming has happened RECENTLY, as opposed to how hard the last hit was. Rises with
	// every strike and drains over about a second, so a fast run compounds into something bigger
	// than any single hit while a lone hit every two seconds never accumulates at all - which is
	// what separates a fill from a metronome. Per LAYER, not per particle: a given spark is
	// re-ignited only rarely out of a pool of hundreds, so accumulating on the particle raised the
	// whole layer evenly and did nothing for density, which is the opposite of the point.
	// how much light the sparks put out last frame - the duck is this, one frame behind
	let flare = 0;
	// LEVEL 4 state: how big the sky is, and which part of its order the hits are reaching now. Both
	// move on their own slow clocks - the population is a structural statement and may not be set by
	// an event, and a reach that never moved would light the same sparks all song
	let slowBand = 0.35;
	// how many sparks are currently in the sky, as state rather than as a fresh rounding every frame
	let skySize = 0;
	let harm = 0;
	// round-robin over the pool, so consecutive events land on different sparks rather than on
	// whichever one happens to be free nearest the start of the array
	let cursor = 0;
	// the loudest hit of the last few seconds, decaying - so "stands out" is judged against what
	// this passage has actually been doing rather than against a fixed number
	// what a hit sounds like around here, updated once per hit rather than once per frame
	let hitAverage = 0;
	// the segment this preset last saw start, so one new sound is one event
	let lastSegStart: number | null = null;
	// walked forward through the segments so the NEXT one is always to hand
	let nextSeg = 0;
	let lastScan = -1;
	// the eased form of the release - see its use
	let flash = 0;

	const spawn = (width: number, height: number): Particle => ({
		x: Math.random() * width,
		y: Math.random() * height,
		wx: 0,
		wy: 0,
		turn: 0,
		life: 1,
		brightness: 0.35 + Math.random() * 0.65,
		lit: 0
	});
	const spawnSpark = (width: number, height: number): Spark => ({ ...spawn(width, height), place: Math.random(), boost: 0, soft: 0, dirX: 1, dirY: 0, chase: 8, age: 99, rise: 0.06, decay: 0.22, fling: 0, pace: 0.3 + Math.pow(Math.random(), 2.2) * 1.8, breadth: 0.5, charge: 0, power: 0.5,  streak: 0,
		endurance: 1
	});

	return {
		draw(frame) {
			const { ctx, width, height, isPlaying, colorRgb, audio, progressSec } = frame;
			if (!isPlaying) return;

			const c = conduct(frame);
			const pctx = bloom.begin(width, height);
			fadeTrail(ctx, width, height, TRAIL_ALPHA);

			// per AREA, so the density stays what it was. Capped at six times the reference: a 4K
			// fullscreen canvas is 7.5x this window, and past a point the cost of a stroke stops being
			// free while the eye stops counting.
			const dens = Math.min(6, (width * height) / (REF_W * REF_H));
			// per LINEAR SIZE, so a stroke crosses the picture in the same time - which also keeps the
			// filament the same fraction of the screen, because a trail's length is speed x persistence
			const pace = Math.min(width, height) / Math.min(REF_W, REF_H);
			resizeToCount(bass, Math.round(BASS_COUNT * dens), () => spawn(width, height));
			resizeToCount(melody, Math.round(MELODY_COUNT * dens), () => spawn(width, height));
			resizeToCount(perc, Math.round(PERC_COUNTS[getVariant() % PERC_COUNTS.length] * dens), () => spawnSpark(width, height));

			// THE BACKGROUND, and it is continuous. A ten-second follower over the loudness, updated
			// before anything reads it, because every layer here is scaled by it. It replaces
			// `c.sectionIntensity` throughout - the section rank is the same statement (they agree at
			// r = 0.79) but it is a STEP FUNCTION, and it was stepping the brightness of both the bass
			// and the melody every time a section changed.
			slowBand += (c.loudness - slowBand) * Math.min(1, 0.1 * c.dt);
			// ---- HOW BIG THE SKY IS ---------------------------------------------------------------
			// The cast is fixed by the slow band and nothing else; a hit only changes how the sky that
			// is already there looks. Every birth is a teleport, and a birth triggered by a hit happens
			// at the exact moment the eye has been pulled to that spot.
			//
			// It is computed HERE, before anything reads the sparks, because the two loops that use it
			// have to agree about it. They did not: `cutters` filtered the whole pool while the draw
			// loop covered only this many, so a spark that had just been lit and then fell outside it -
			// about 22 slots leave the pool a minute, on the slow band's own drift - was never drawn
			// and never aged again. Its charge FROZE and it went on lighting and combing the other two
			// layers from a fixed point, invisibly, until the pool grew back over it. Measured on three
			// real tracks: 17-46% of frames carried at least one, up to four at once, 2.5-3.5% of all
			// the cut weight in the picture. Light with nothing under it.
			// `Math.min` on the top: the arithmetic allows 110% of the pool, and reading past the end
			// of the array would be an exception rather than a look. The slow band has never measured
			// above 0.564 on any of 91 tracks, so it has never happened - which is not the same as it
			// being impossible.
			// A WHOLE SLOT OF DEADBAND. `Math.round` of a slowly drifting number chatters when it sits
			// on a boundary - 82, 83, 82, 83 - and each flip takes a spark out of the drawn set and
			// puts it back, which for a spark that happens to be burning is a mark blinking. One slot
			// at a time, and only once the target has genuinely passed the next one: the size of the
			// sky is a slow musical statement, so it is allowed to take a few frames to change.
			const skyTarget = Math.max(8, Math.min(perc.length, perc.length * (0.35 + slowBand * 0.75)));
			if (skySize === 0) skySize = Math.round(skyTarget);
			else if (skyTarget >= skySize + 1) skySize++;
			else if (skyTarget <= skySize - 1) skySize--;
			const inSky = Math.max(8, Math.min(perc.length, skySize));

			// Percussion is drawn last but its effect on the other two is sampled here, from where the
			// sparks were at the end of the previous frame. At ~2.5px of travel per frame against a
			// ~100px radius that staleness is invisible, and it avoids splitting the percussion loop
			// into an update pass and a draw pass purely for ordering.
			const cutters: Spark[] = [];
			for (let pi = 0; pi < inSky; pi++) if (perc[pi].charge > 0.15) cutters.push(perc[pi]);
			// and everything outside the sky goes DARK on its own clock rather than freezing mid-burn.
			// A spark that is not drawn is not aged either, so without this the one the pool drops
			// keeps its charge until the pool takes it back - and then resumes, at a stale position,
			// half-lit, which is an event appearing at strength with nothing before it (§5c). Age is
			// all it needs: nothing outside the sky moves, draws or couples.
			for (let pi = inSky; pi < perc.length; pi++) {
				perc[pi].age += c.dt;
				perc[pi].charge = 0;
			}
			// ---- the brace, and the release ----------------------------------------------------------
			// c.anticipation rises over the few seconds before a section that is measurably louder and
			// releases at it; c.impact fires there. Everything below reads them the same way: withdraw,
			// then let go. The withdrawal is capped well under 1 on purpose - the music is usually
			// already thinning out before a chorus, so this compounds with a real drop in energy, and
			// at full strength the two together would take the screen to black, making the release a
			// fade-up from nothing rather than a release
			// The gesture on the way into a moment is chosen by what the MUSIC does there, not by a
			// fixed idea of what a run-up looks like. When the track thins out before a chorus we go
			// down with it; when it climbs we wind up with it; when it just arrives we barely move and
			// let the release do all the work. Dimming through a track that was accelerating, and
			// dimming again through one that had already dropped out, is what made this read as wrong
			// on most songs while looking right on the few that happen to build the assumed way.
			//
			// The brace pulls below normal; the release has to go ABOVE it. Returning to the steady
			// state is not an impact - it is the withdrawal ending, and it reads as a speed wobble
			// rather than as a hit.
			// The brace and the release the music makes ITSELF, with nothing predicted.
			//
			// A chorus was reported as landing perfectly on a track whose only special feature is a
			// real lull before it - no detector involved, nothing knew the chorus was coming. That is
			// the whole mechanism worth having: `trend` is this moment's energy against the last
			// twenty seconds of it, so a lull drives it negative and an arrival drives it sharply
			// positive. It cannot fire in the wrong place, because it is not predicting a place - it
			// is reporting what just happened relative to what had been happening.
			//
			// Asymmetric on purpose: withdrawing is allowed to be deep, arriving is allowed to be
			// bigger still, and the two together are the shape a listener already hears.
			// The lull is a STATE and it stays: `trend` compares this moment against the last twenty
			// seconds, so a real thinning-out registers and nothing has to predict it.
			//
			// The ARRIVAL that used to sit next to it is gone. It measured the rate of change of a fast
			// energy average against a slow one - a hand-made online detector, exactly the kind this
			// project keeps proving wrong - and it drove BOTH the brightness lift and the speed lift.
			// Measured across twenty real tracks it fired 8 to 80 times a song, twice inside the same
			// second more than once, which is what "a crude glow and a crude acceleration hand in hand,
			// out of place" was. Two earlier rounds of tuning cut its amplitude and never touched its
			// rate, which was the whole problem: a payoff that happens once a phrase is not a payoff.
			//
			// The release now comes from `impact` alone, i.e. from the track's own biggest sustained
			// steps up in loudness, found offline over the whole curve and capped at five a track
			// (track-structure.ts, findRises). Bounded by construction rather than by a threshold.

			// A lull is a state that can last a minute, so it may not take the picture as far down as a
			// four-second run-in can: at full strength it left a quiet passage at a seventeenth of a
			// chorus's light, which is not restraint, it is switching off
			// the brace no longer reads `lull`. That is a RELATIVE signal - this stretch against the last
			// twenty seconds - so the same music dims the picture or does not depending only on what came
			// before it, which is a brightness change with nothing audible under it
			const brace = c.anticipation;
			// LIGHT MAY NOT RISE BEFORE THE EVENT. `c.impact` is built with a lead so that a response
			// which takes time to grow peaks ON the moment (DESIGN-RULES 5b) - right for anything with
			// an attack, wrong for alpha, which has none. Measured around Borderline's moment: the
			// layers were at 1.3x their own average half a second BEFORE it and 2.6x a quarter second
			// before, which is the "they light up prematurely" report, exactly. The lead is kept for
			// the geometry that still reads it and dropped for the light.
			const releaseRaw = c.timeToImpact !== null && c.timeToImpact > 0 ? 0 : c.impact;
			// EASED, because it is a switch. `releaseRaw` goes 0 -> 0.9 on one frame, and it multiplies
			// the ground layers' brightness and nearly triples the bass's line width, so the drop began
			// with a pop: measured, the picture went 0.75x -> 4.14x of its own level inside three
			// frames and then kept SWELLING for another half second. Wrong order - that is a clap
			// followed by a bloom. Up in about a tenth of a second, down over a third.
			flash += (releaseRaw - flash) * Math.min(1, (releaseRaw > flash ? 11 : 3) * c.dt);
			const release = flash;
			// `releaseShape` used to sit here: an eased copy of the release, so that GEOMETRY could not
			// be moved by a signal that might step. `impact` is a shape in time now and cannot step, so
			// the filter was pure delay - and delay in the geometry channel only is exactly the report
			// that the big particles arrive a moment late. Both channels read the same envelope.
			// The release is a pulse and a pulse can rise in a single frame. That is fine for light -
			// DESIGN-RULES §1b is explicit that brightness may jitter without consequence - and not
			// fine for GEOMETRY: it also scales the melody's deviation, so a stepped release stepped
			// every melody particle's angle at once. Measured as 0.043% of turns over 20 degrees where
			// everything else in this preset is at 0.000%. Light keeps the pulse; shape gets a version
			// that cannot step.

			// The run-up into a chorus is a drum fill, which is a burst of transients, which lights
			// sparks - and a lit spark cuts through the melody and BRIGHTENS it. So the layer that was
			// meant to be withdrawing lit up instead, exactly during the build-up, and only the small
			// particles did it because only they take the cut. The brace has to hold the cut down as
			// well, or the fill overrules the withdrawal it is part of.
			// and the brace has to be EARLY. Measured, `anticipation` is 0.03 one second out and 0.23
			// half a second out - it arrives at the same instant as the release it is supposed to make
			// room for, so the two cancel and the run-in is never dark. The measured lead-in is what
			// `windup` spans, so the brace borrows its span and keeps anticipation's shape on top.
			const beat = audio?.tempo && audio.tempo > 40 ? 60 / audio.tempo : 0.5;
			const braceEarly = Math.max(brace, Math.min(1, c.windup * 0.8));

			// ---- THE RUN-IN FOLLOWS THE MUSIC'S OWN SHAPE ----------------------------------------------
			// Traced on Daten's drop at 2:06: from 2:01 to 2:04 the music DOUBLES - its one-second mean
			// goes 0.23 to 0.48 - and the picture dimmed through all of it, `dim` falling 0.97 to 0.67.
			// Louder and darker, for five and a half seconds. And the analysis had already measured the
			// answer for that moment: dip 0.10, build 1.00, which says in so many words "the music does
			// not drop away here, it climbs".
			//
			// I cut `runInDip` out of the brace in the audit, for a real reason - it comes from the same
			// moments whose timing we did not trust - and threw away the distinction between a run-in
			// that thins out and one that builds along with it. The timing is fixed now; this is not.
			// Follow the music down where it goes down, and climb with it where it climbs.
			const runDip = Math.max(0.12, c.runInDip);
			const runBuild = c.runInBuild;
			// and the wind-up finally reaches the speed again. It was in `slow`, which I lost when the
			// variants collapsed into one build, so for the last several rounds there has been no
			// acceleration into a drop at all - measured on Daten, percussion ran 232 -> 267 -> 190 px/s
			// across the whole run-in, falling at the end because speed follows the loudness and the
			// music breathes in just before it lands.
			const windUp = 1 + c.windup * (0.12 + runBuild * 0.9);
			const cutGate = 1 - braceEarly * 0.5;
			// The release leans on width, speed and sheer number of particles rather than on alpha
			// alone. Alpha is capped, so pushing the overshoot through it only flattens everything
			// against the ceiling at the exact moment it is supposed to be loudest (DESIGN-RULES §3b);
			// width and stroke length are not capped and read as force rather than as glare
			const dim = (1 - braceEarly * 0.42 * runDip) * (1 + release * 0.15);
			// Speed is not monotonic through the run-up. It falls away with the brace, then the last bar
			// winds it back up and past its resting rate, and the release throws it further. Brightness
			// does none of this - it stays down until the release - so the wind-up is felt as movement
			// in the dark rather than seen, which is what makes the release the first thing that lights

			// The brace no longer touches speed. Withdrawing and winding up were fighting each other in
			// the same channel - the pull-back subtracted almost exactly what the run-up was adding, so
			// the net was flat until the last half second and then everything arrived at once. The two
			// belong in different channels and always did: the brace takes the LIGHT down, the wind-up
			// takes the SPEED up. Darker and faster on the way in, which is what a build-up is.

			const scale = c.scale;
			// No gestures, no chaos/order, no cursor, no ripple. They used to be here as constants
			// folded to zero, which reads as "the code still supports this" and does not: dead terms in
			// live expressions are where the last several bugs were hiding, so they are gone rather
			// than neutralised.

			// THE BACKGROUND, and it is continuous. A ten-second follower over the loudness, updated
			// before anything reads it, because every layer here is scaled by it. It replaces
			// `c.sectionIntensity` throughout - the section rank is the same statement (they agree at
			// r = 0.79) but it is a STEP FUNCTION, and it was stepping the brightness of both the bass
			// and the melody every time a section changed.
			// ---- THIS TRACK'S OWN CLOCK ----------------------------------------------------------------
			// The time constants below are measured in beats of the song that is playing, not in
			// seconds. A wake that takes 0.45s to arrive is late on a fast track and early on a slow
			// one; the same fraction of a beat is the same thing on both. Falls back to a moderate
			// 120bpm only when the analysis gives no tempo at all.

			// harmonicShift comes out of the conductor with a 25/s attack - 42% of the way in a single
			// frame - which is fine as a gesture and not fine in a brightness. Its own slower copy
			harm += (c.harmonicShift - harm) * Math.min(1, 6 * c.dt);

			fieldTime += (0.05 + c.brightness * 0.1) * c.dt;
			gesture.begin(frame, c, fieldTime);

			// ---- COUPLING: percussion -> everything (sidechain / masking) ----------------------------
			// A hit does not get brighter; everything around it briefly gets dimmer. That is how a mix
			// actually makes a kick punch, it is how ducking sounds, and it is the only way to add
			// emphasis without adding light to a bloom pass. Fast attack (~45ms), release ~0.35s - the
			// shortest time constant of the five couplings, because percussion is the fastest layer.
			// The star's envelope, computed once a frame from the time of the hit it was launched for
			// rather than from its own age - so the light is tied to the music's clock and not to the
			// particle's. Positive before the hit, negative after.
			// The STAR is gone. It was one spark promoted on a hit that beat everything in the last few
			// seconds, thrown across the sky on its own straight path - and its rarity gate was
			// `downbeat`, which came out in the audit as a second clock with nothing put in its place.
			// Measured after that: its own test passed 28 to 100 times a MINUTE. A star that common is
			// not a star, it is the layer. Its job - a standout hit gets a bigger mark - is already
			// done by the rank, which measures loudness against the neighbours rather than against a
			// bar line, so this is one special case with its own speed, angle and entry point removed
			// rather than given a newly invented rarity rule.
			const duckTarget = Math.min(1, flare * (0.55 + c.attackSharpness * 0.5));
			// The colour tint used to ride `c.pop`, which fires on the BEAT grid - so the hue pulsed on
			// the metronome while every mark appeared on a segment start. The last of the two-clock
			// problems in this preset, and the smallest, but the same fault: it is the sparks' own
			// light again, so colour and event cannot drift apart.
			const tintPulse = Math.min(1, flare * 1.1);
			// 10/s rather than 22: a sidechain has to be quick to read as one, but at 22 it took 37% of the
			// whole drop in a single frame, on every hit, over both the other layers at once
			duck += (duckTarget - duck) * Math.min(1, (duckTarget > duck ? 10 : 2.6) * c.dt);

			// ---- COUPLING: melody -> bass (the chord change) ------------------------------------------
			// The ground wanders on its own, very slowly. A real harmonic move - the chroma actually
			// changing, not just a beat ticking over - is the moment the bass is obliged to shift, so it
			// unlocks the ground's turn rate for a second or two. Rare, large, slow: the opposite
			// envelope from the duck above, which is what keeps the two readable as different things.
			const groundWander = noise(fieldTime * 0.14, 11.3, 0) * Math.PI;
			const groundStep = (0.22 + harm * 1.5) * c.dt;
			const groundDiff = ((groundWander - groundAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
			groundAngle += Math.max(-groundStep, Math.min(groundStep, groundDiff));

			// ---- COUPLING: melody -> percussion, prepared here -----------------------------------------
			// the live chroma's strongest pitch class, as one shared angle. Discrete when the leader
			// changes, so it is turned towards at a capped rate rather than assigned
			// the chroma's tonal centre, as a bounded LEAN off the ground rather than a heading of its
			// own. Deliberately not the argmax pitch class: an argmax is a STEP function, the leader
			// swaps discretely, and a rate-capped chase after a stepping target sits pinned at its cap
			// and reverses every time the leader changes - measured as 4.1 direction reversals a second
			// in the melody layer. Weighting all twelve bands by where they sit on the circle gives a
			// value that is continuous in the (already eased) band energies, so there is no step to
			// chase in the first place. It also uses the whole chroma vector instead of throwing away
			// eleven twelfths of it.
			const bands = chroma(audio, progressSec, isPlaying, c.dt);
			let centre = 0;
			let weight = 0;
			for (let i = 0; i < 12; i++) {
				centre += bands[i] * Math.sin((i / 12) * Math.PI * 2);
				weight += bands[i];
			}
			// a spread-out chroma sits near zero (no strong tonal centre, no lean); one concentrated to
			// one side leans that way. x2.5 because twelve real bands rarely concentrate past ~0.4
			let tiltTarget =
				Math.max(-1, Math.min(1, weight > 1e-6 ? (centre / weight) * 2.5 : 0)) * MELODY_TILT_MAX;
			// the cursor reaches the melody layer only through this ONE shared lean - a deliberate
			// coherent swipe tips the whole harmony frame. Nothing per-particle, nothing positional:
			// melody particles all share this frame, so a proximity-driven per-particle bend would
			// align whichever ones pass near the cursor into a seam (DESIGN-RULES §1b, the Aurora
			// failure). gustCoherence gates out "the cursor is moving fast" from "this is a gesture".
			// The swipe direction is folded in as its offset from the ground, clamped like any other,
			// so even a gust pointing straight backwards can only lean the melody, never flip it.
			// This was dead. Its only input was the cursor's gust, which has been zero since the gestures
			// came out, so the melody's frame has been exactly the wind's and the layer has had no heading
			// of its own at all. Re-tied to harmonic movement: the melody leans when the harmony moves,
			// which is the middle band's own business and the one thing that genuinely separates this
			// layer from the ground it sits on.
			tiltTarget +=
				(Math.max(-MELODY_TILT_MAX, Math.min(MELODY_TILT_MAX, (harm - 0.45) * 2.2)) - tiltTarget) *
				Math.min(1, 0.25 * c.dt);
			// a plain scalar chase with a rate cap: no angles, no wraparound, nothing to flip
			const tiltStep = 0.35 * c.dt;
			melodyTilt += Math.max(-tiltStep, Math.min(tiltStep, tiltTarget - melodyTilt));

			// ---- COUPLING: bass -> melody (harmonic function, and masking) -----------------------------
			// A melody note means something different over a different bass note; its absolute
			// direction is not the information, its deviation from the ground is. So the melody's field
			// is sampled in the GROUND's rotated frame, leaned partway towards the harmony - continuous
			// and slow, the always-on coupling that makes the two read as the same piece of music
			// without ever synchronising them.
			const melodyFrame = groundAngle + melodyTilt;
			// ...and a loud sustained low end masks the mids: in a dense loud stretch the middle layer
			// sits still and lets the low end do the work, and it opens back up when the bass thins.
			// ~20s time constant (level is the slow energy average) - the slowest coupling of the five.
			// `masking` is gone. It scaled the melody's spread by `c.level` - a twenty-second average -
			// so how wide the melody ran depended on how loud the last twenty seconds had been. A slow
			// average may set slow things; it may not shape geometry, or the same music has a different
			// shape depending only on what preceded it.

			const base = albumHsl(colorRgb);
			// one family of hues; size and lightness do the actual separating, not colour
			const bassRgb = diagnostic ? DIAGNOSTIC_RGB.bass : hslToRgb(base.h, base.s * 0.7, base.l * 0.62);
			const melodyRgb = diagnostic ? DIAGNOSTIC_RGB.melody : hslToRgb(base.h + 0.06, base.s, base.l);
			const percRgb = diagnostic
				? DIAGNOSTIC_RGB.perc
				: hslToRgb(base.h + 0.14, Math.min(1, base.s + 0.08), Math.min(0.78, base.l + 0.14));
			// the shimmer rotates colour channels, which would have the three groups swapping
			// identities mid-hit - exactly what the diagnostic mode exists to rule out
			const tint = (rgb: { r: number; g: number; b: number }, pop: number) =>
				diagnostic ? rgb : gesture.tint(rgb, pop);

			// how hard a spark is cutting through the point (x, y) right now, 0..1. Percussion is an
			// audio layer, so unlike a gesture this is allowed to drive brightness (DESIGN-RULES §2).
			const cutRadius = scale * CUT_RADIUS;
			// the wake arrives inside a third of a beat and lets go over two of them. Reported as
			// "group 2 accelerates late at the drop", and it was: at a flat 2.2/s the melody's own peak
			// landed 2.93s after the drop on 一緒なら. Rising in a fraction of a beat puts it with the
			// marks; falling over beats keeps it a wake rather than a second field.
			// the light of the cut lets go over a beat of THIS track, so the wake is a musical length
			// rather than 0.55s whatever is playing
			const cutFall = 1 / beat;
			const wakeRise = 1 / (0.3 * beat);
			const wakeFall = 1 / (2.2 * beat);
			//
			// A SCALAR, deliberately. Two versions of this pushed particles away from the spark and
			// both wrote visible corners into the other layers: 1.03 rad of turn in a single frame
			// picking the nearest spark, 1.38 rad summing the sparks as vectors. Summing was not the
			// fix because selection was not the cause - repulsion from a MOVING point sweeps through
			// 180 degrees as the point passes, and it does so exactly while its weight is highest. No
			// smoothing removes that; it is the geometry. DESIGN-RULES §1b, for the fifth time in this
			// project's history, and the first time with a number attached.
			//
			// So the cut is brightness and turbulence. It lights what it passes through and stirs the
			// field there, which is what a cut looks like, and neither can point a particle anywhere
			// the field was not already going.
			//
			// THE WAKE, and why it is not the thing that failed twice. Those versions pushed a particle
			// AWAY FROM the spark's position; this one turns it TOWARDS THE SPARK'S OWN HEADING. A
			// position-relative direction sweeps through 180 degrees as the point passes and does it
			// while its weight is highest, which is the corner. A heading does not: it is the same
			// before the spark arrives and after it has gone, so there is nothing to sweep.
			//
			// Summed as a VECTOR, never as angles (DESIGN-RULES §1c), so several sparks near one
			// particle average into a direction instead of fighting over a number that wraps.
			let cutW = 0;
			let cutX = 0;
			let cutY = 0;
			const cutAt = (x: number, y: number) => {
				cutW = 0;
				cutX = 0;
				cutY = 0;
				for (const spark of cutters) {
					const dx = x - spark.x;
					const dy = y - spark.y;
					const d2 = dx * dx + dy * dy;
					if (d2 > cutRadius * cutRadius) continue;
					// scaled by the hit that lit this spark, so a snare cuts a brighter line through the
					// other layers than a soft kick does - the same power that no longer buys it speed
					const force = spark.charge * (0.45 + spark.power * 0.85) * (1 - Math.sqrt(d2) / cutRadius);
					cutW += force;
					cutX += spark.dirX * force;
					cutY += spark.dirY * force;
				}
				cutW = Math.min(1, cutW);
				return cutW;
			};
			// ---- THE HAND, AS A PLACE --------------------------------------------------------------------
			// The cursor is a mark that does not die. Everything a spark does to the field it passes
			// through, the hand does too, through the same three scalars and no others - it lights, it
			// stirs, and it hurries. What it may never do is point a particle anywhere, which is the one
			// thing all five failed gesture attempts had in common (DESIGN-RULES §1).
			//
			// THE RIPPLE IS LIGHT ONLY, and so is the part of it that reaches the marks. It was briefly in
			// the turbulence as well and that put three turns over 0.3 rad into a run - the first
			// non-zero this preset has measured all session. Same reason it was kept out of speed and I
			// failed to carry the reasoning across: the ring is a narrow band travelling at about
			// 1100 px/s, so anything reading it changes FAST, and turbulence is an amplitude on the
			// noise that sets the angle. The ribbon may stir, because it is broad and moves with the
			// hand. A shockwave may not.
			//
			// `c.trailAt` says WHERE the hand has been - a fading ribbon along its path, laid by distance
			// so a slow hand and a fast one leave the same shape. `c.baton` says HOW HARD it is working.
			// A still hand leaves no ribbon, so a still hand does none of this: presence at rest lives in
			// where events are BORN instead, below, where there is no history to break.
			const handAt = (x: number, y: number) => c.trailAt(x, y) * (0.35 + c.baton * 0.65);
			// THE MARKS READ THE FAST HALF. Everything the hand did reached only the ground and the
			// sheet, which are the two dimmest things in the picture - mean alpha 0.19 and 0.24 - so it
			// was raising by 40% what is already almost invisible while group 1, the only layer the eye
			// actually reads, was completely deaf to it. That is the whole of "I cannot feel it".
			//
			// A hand may not BIRTH a mark - tried, and it looks like exactly what it is, a burst
			// appearing where the pointer is. It may light and hurry one that is already flying, which
			// is the same rule hits have obeyed here from the start. And it reads `c.hand` rather than
			// `c.baton`: the marks are the event layer and they answer on a beat, the field is the
			// structural one and answers over a bar. Same gesture, two clocks, which is what stops the
			// two from fusing into one knob.
			const handMark = (x: number, y: number) => c.trailAt(x, y) * (0.35 + c.hand * 0.65);
			const edgeMargin = scale * 0.18;
			// A particle must be invisible before the respawn teleports it (DESIGN-RULES §5), and this
			// is a fade BY DISTANCE, not an acceleration of its life.
			//
			// It used to race `p.life` to zero near the edge. But the light of these two layers is a bell
			// over the life - `sin(life * PI)` - which PEAKS AT HALF-LIFE, so dragging the life down
			// through 0.5 in a fraction of a second walked the particle straight over the top of its own
			// curve: a stroke arriving at the edge with life 0.9 went from 0.31 of its light to full in
			// about two tenths of a second and only then died. Measured: 100% of the bass's sudden
			// brightenings and 94% of the melody's happened inside this margin, 96-98% of them while the
			// music was not getting louder. The mechanism that existed to hide the respawn was the single
			// largest source of light with nothing under it.
			//
			// A distance fade cannot do that. A particle heading for the edge only ever gets closer to
			// it, so its light only ever falls.
			const edgeFade = (x: number, y: number) => {
				const edgeDist = Math.min(x, width - x, y, height - y);
				return edgeDist < edgeMargin ? Math.max(0, edgeDist / edgeMargin) : 1;
			};

			pctx.lineCap = "round";

			// ---- layer 1: sustained low end ------------------------------------------------------------
			// Reads level/trend/energy and NOTHING beat-crisp - the whole point is that it does not
			// twitch when the drums hit. Big slow eddies (lowest sampling frequency, slowest drift),
			// drawn as wide near-transparent strokes that accumulate into a wash rather than filaments.
			// low constant, high coefficients. The old (16 + level*40 + energy*22) meant a quiet passage
			// and a drop differed by 1.8x where the audio differs by ten - the constant floor was most
			// of the speed in both, so every section moved at roughly the same rate
			const bassSpeed =
				// THE RANGE OPENS DOWNWARD, never upward. Measured phrase by phrase over six tracks, the
				// speed of the picture spanned x1.3 to x2.0 across whole songs whose loudness spanned
				// x2.5 to x4.9, and correlated with it at -0.12 to 0.37 on five of the six - motion was
				// saying nothing about the music at all. That is my own doing: flattening the response
				// was how the racing complaint got fixed, and it took the dynamics with it. The
				// complaint was about jitter and about the top speed, so the top stays exactly where it
				// is and the quiet end goes down.
				(8 + c.loudness * 95) * windUp * pace;
			// x1.5, not x2.9. The bass is the ground; at a drop it was nearly tripling its line width,
			// which is the single biggest reason the bottom of the picture flared.
			const bassWidthBoost = 1 + release * 0.15;
			// a building section fans the ground out, a settling one draws it back in
			// CONTRACTION, which is what a run-in should be doing instead of accelerating. A build-up is
			// stored energy, not spent energy: a wave draws back, a spring compresses, an orchestra
			// goes quiet and tight. So the brace pulls the whole field toward one heading - it goes
			// laminar, which the eye reads as gathering - and the release throws it open again. This
			// costs no speed and no brightness, so it works in a passage that has neither.
			// the brace still contracts the field - that is the mechanic worth having - but the release
			// no longer expands it. A rare event fired by a detector measured to be unreliable may light
			// the picture; it may not move it. Every complaint about sudden inappropriate acceleration
			// has come from a rare event holding the geometry.
			const contraction = 1 - braceEarly * 0.55;
			const bassSpread =
				// `c.trend` is out for the same reason as `lull`: it is this stretch against the last
				// twenty seconds, so it says nothing about what is playing, only about what came before
				Math.max(0.08, (0.2 + slowBand * 0.5) * contraction);
			const bassWidth = scale * 0.0027 * (0.75 + slowBand * 0.45 + c.loudness * 0.2);
			// and it takes less than the melody of the drop's own lift, for the same reason
			// THE CUT IS APPLIED AS CONTRAST, NOT AS MAGNITUDE (DESIGN-RULES §3b). Raising the additive
			// term alone was tried and only pushed the whole layer onto its ceiling. So the duck - the
			// layer getting out of the way on a hit - is CANCELLED WHERE A SPARK IS PASSING. Everything
			// around the mark ducks; the line the mark is cutting does not. The lit line and the field
			// separate without either of them changing its own budget.
			const bassLight = (v: number) => (1 - duck * 0.55 * (1 - v)) * dim * (1 - release * 0.1);

			density.begin(width, height);
			for (const p of bass) density.add(p.x, p.y);

			for (const p of bass) {
				const along = (p.x * Math.cos(groundAngle) + p.y * Math.sin(groundAngle)) / scale;
				const across = (-p.x * Math.sin(groundAngle) + p.y * Math.cos(groundAngle)) / scale;
				// the ground is not something you can push around: the cursor is a scalar here and only
				// a scalar - it can hurry a stroke along, never point it somewhere the field was not
				// already going. These strokes live ~8s, so any raw per-frame angle response would be
				// writing a kink into eight seconds of visible trail
				const cutNow = cutAt(p.x, p.y);
				// UP IN A TWELFTH OF A SECOND, down over a beat. At 4/s the rise was slower than the pass
				// itself: a mark crossing its own halo is inside it for a fraction of a second, so the
				// particle only ever reached a fraction of the cut before the mark had gone. It stays a
				// filter rather than a raw read because `cut` also sets the turbulence, and a spark
				// recycled onto a new event teleports - geometry may not step (DESIGN-RULES §1b).
				p.lit += (cutNow - p.lit) * Math.min(1, (cutNow > p.lit ? 12 : cutFall) * c.dt);
				const cut = p.lit;
				const hand = handAt(p.x, p.y);
				// AMPLITUDE on the noise that is already there, never an angle of its own. This is the
				// form §1b names as the safe one and the form the spark's own cut was rewritten into
				// when repulsion measured 1.03 rad of turn in a frame; that rewrite measured 0.000%
				// corners. The field stirs harder where the hand is working it and cannot be aimed.
				const ring = c.rippleAt(p.x, p.y);
				const deviation =
					noise(along * 0.6, across * 0.9, fieldTime * 0.35) *
					(bassSpread + cut * cutGate * 0.3 + hand * 0.95);
				// BOTH COMPONENTS ON THE SAME CLOCK. This is one VECTOR, and two axes converging at
				// different rates rotate it: x was moved onto the track's beat and y was left at the
				// old fixed 5.5/1.2, so the stored wake pointed somewhere neither the mark nor the
				// field was going for as long as it was rising or falling - about 9 degrees off at
				// 60 bpm, nothing at 120, which is the tempo it happened to be checked at.
				const wakeStep = Math.min(1, (cutW > 0 ? wakeRise : wakeFall) * c.dt);
				p.wx += (cutX - p.wx) * wakeStep;
				p.wy += (cutY - p.wy) * wakeStep;
				const wake = Math.min(1, Math.hypot(p.wx, p.wy));
				// A STORED OFFSET WITH A RATE CAP, not a blend. Blending the angle towards the wake let a
				// particle whose wake pointed the other way turn 1.4 radians in one frame - exactly pi
				// times the blend weight - measured 35 times in three minutes, against zero without the
				// wake at all. Same pattern the melody's own tilt uses: a capped scalar chase, so no angle
				// is ever blended and there is nothing that can wrap.
				const wanted = wake > 0.02 ? shortest(Math.atan2(p.wy, p.wx) - (groundAngle + deviation)) * wake * WAKE_TURN : 0;
				const step = WAKE_RATE * c.dt;
				p.turn += Math.max(-step, Math.min(step, wanted - p.turn));
				const angle = groundAngle + deviation + p.turn;

				const speed = bassSpeed * (1 + wake * WAKE_SPEED + hand * 0.7);
				const nx = p.x + Math.cos(angle) * speed * c.dt;
				const ny = p.y + Math.sin(angle) * speed * c.dt;

				const alpha = Math.min(
					BASS_ALPHA_CAP,
					Math.max(
						0,
						// everything here except `cut` is deliberately held down. A highlight is contrast,
						// not magnitude: raising the cut alone only drove the whole layer onto its
						// ceiling, where the lit line and the field around it are the same value and
						// nothing reads as lit at all (DESIGN-RULES §3b)
						// Rebuilt, because measured it was not following the music: the bass's light swung +-30%
						// around its own mean at r = 0.42 against loudness - less than a fifth of it explained by
						// anything audible. Ablating each term one at a time moved nothing, and that is the answer:
						// no single term was wrong, the COMPOSITION was. Its largest coefficient was the percussion
						// cut, and its largest musical one was `c.level`, a twenty-second average which measured
						// r = -0.07 against the very brightness it was setting. A picture lit mostly by accumulators
						// drifts on their clocks instead of on the song's.
						//
						// Now: the background it sits in, the loudness it is hearing, and one event.
						// THE LIGHT GIVES BACK WHAT THE MOTION NOW CARRIES. Measured phrase by phrase, the
						// picture spanned x4.7 to x10.8 across songs whose loudness spanned x2.6 to x4.9 -
						// it was exaggerating dynamics by nearly a factor of two, which is why quiet
						// passages went to almost nothing. Four separate loudness-dependent terms were
						// multiplying together: alpha, width, stroke length and the number of marks. With
						// the speed now carrying its share, alpha and width can carry less.
						(0.3 +
							p.brightness * 0.14 +
							density.at(p.x, p.y) * 0.1 +
							slowBand * 0.28 +
							c.loudness * 0.5 +
							release * 0.03 +
							cut * cutGate * 0.55 +
							hand * 1.2 +
							ring * 1.0) *
							Math.sin(p.life * Math.PI) *
							edgeFade(p.x, p.y) *
							bassLight(cut * cutGate) *
							0.72
					)
				);
				pctx.beginPath();
				pctx.moveTo(p.x, p.y);
				pctx.lineTo(nx, ny);
				pctx.strokeStyle = rgbString(tint(bassRgb, tintPulse * 0.4), alpha);
				pctx.lineWidth = Math.max(0.8, bassWidth * bassWidthBoost);
				pctx.stroke();

				p.x = nx;
				p.y = ny;
				p.life -= c.dt * 0.12; // ~8s of travel
				if (p.life <= 0 || p.x < 0 || p.x > width || p.y < 0 || p.y > height) Object.assign(p, spawn(width, height));
			}

			// ---- layer 2: melody -------------------------------------------------------------------------
			// Mid sampling frequency, mid drift, hairlines with a real trail. Rides harmonicShift,
			// chroma and spectral brightness; the beat only reaches it as the duck.
			const melodySpeed =
				(10 + c.loudness * 185) * windUp * pace;
			const spreadTarget =
				// the sawtooth is out of the geometry too: `c.energy` reverses 3.8 times a second, and
				// this is the melody's own spread - a shape, not a light
				Math.max(0.05, 0.34 + c.loudness * 0.24 + harm * 0.75);
			melodySpread += (spreadTarget - melodySpread) * Math.min(1, 2.2 * c.dt);
			// the sheets flatten toward laminar as the brace tightens and spring open on the hit -
			// applied after the ease, so the release is as fast as the impact rather than as slow as
			// the chase that produced the spread
			// The release adds very little to the SPREAD. At 1.1 it put more than a radian of extra deviation
			// into the melody at exactly the loudest moments, which is a line thrashing rather than a line
			// arriving - and showing a strong moment is the star's job, done by one object the eye can
			// follow instead of by two hundred wobbling at once. The release still lands, in light,
			// width and speed
			const bracedSpread = Math.max(0.04, melodySpread * (1 - braceEarly * 0.35));
			const melodyLight = (v: number) => (1 - duck * 0.3 * (1 - v)) * dim;
			const frameCos = Math.cos(melodyFrame);
			const frameSin = Math.sin(melodyFrame);

			density.begin(width, height);
			for (const p of melody) density.add(p.x, p.y);

			for (const p of melody) {
				const along = (p.x * frameCos + p.y * frameSin) / scale;
				const across = (-p.x * frameSin + p.y * frameCos) / scale;
				// same scalar-only treatment as the bass, for the same reason: these particles share the
				// melody frame, so proximity may widen how hard the noise swings (turbulence) but may
				// never contribute an angle of its own
				const cutNow = cutAt(p.x, p.y);
				p.lit += (cutNow - p.lit) * Math.min(1, (cutNow > p.lit ? 12 : cutFall) * c.dt);
				const cut = p.lit;
				const hand = handAt(p.x, p.y);
				const ring = c.rippleAt(p.x, p.y);
				const deviation =
					noise(along * 1.2, across * 1.6, fieldTime) * (bracedSpread + cut * cutGate * 0.18 + hand * 0.7);
				// same one clock, and the beat-relative pair rather than the old fixed one: these are
				// the constants that were written FOR this layer - "group 2 accelerates late at the
				// drop", measured at 2.93s late on 一緒なら - and until now they were never applied
				// to it at all
				const wakeStep = Math.min(1, (cutW > 0 ? wakeRise : wakeFall) * c.dt);
				p.wx += (cutX - p.wx) * wakeStep;
				p.wy += (cutY - p.wy) * wakeStep;
				const wake = Math.min(1, Math.hypot(p.wx, p.wy));
				// A STORED OFFSET WITH A RATE CAP, not a blend. Blending the angle towards the wake let a
				// particle whose wake pointed the other way turn 1.4 radians in one frame - exactly pi
				// times the blend weight - measured 35 times in three minutes, against zero without the
				// wake at all. Same pattern the melody's own tilt uses: a capped scalar chase, so no angle
				// is ever blended and there is nothing that can wrap.
				const wanted = wake > 0.02 ? shortest(Math.atan2(p.wy, p.wx) - (melodyFrame + deviation)) * wake * WAKE_TURN : 0;
				const step = WAKE_RATE * c.dt;
				p.turn += Math.max(-step, Math.min(step, wanted - p.turn));
				const angle = melodyFrame + deviation + p.turn;

				const speed = melodySpeed * (1 + wake * WAKE_SPEED * 1.3 + hand * 0.9);
				const nx = p.x + Math.cos(angle) * speed * c.dt;
				const ny = p.y + Math.sin(angle) * speed * c.dt;

				const alpha = Math.min(
					MELODY_ALPHA_CAP,
					Math.max(
						0,
						// same treatment. This one was following better - r = 0.62 to 0.78 - but `c.glow` is built
						// on momentum, a hit accumulator with a two-second release: it keeps the picture lit for
						// seconds after the reason for it has gone.
						(0.22 +
							p.brightness * 0.17 +
							density.at(p.x, p.y) * 0.1 +
							c.loudness * 0.45 +
							slowBand * 0.26 +
							harm * 0.21 +
							release * 0.06 +
							cut * cutGate * 0.6 +
							hand * 1.25 +
							ring * 1.05) *
							Math.sin(p.life * Math.PI) *
							edgeFade(p.x, p.y) *
							melodyLight(cut * cutGate) *
							0.72
					)
				);
				pctx.beginPath();
				pctx.moveTo(p.x, p.y);
				pctx.lineTo(nx, ny);
				pctx.strokeStyle = rgbString(tint(melodyRgb, tintPulse), alpha);
				// x1.15, not x2.2. This was the last place where a rare event fired by a detector we do not
				// trust could still take the picture over, and it was the biggest of them: width times
				// alpha IS light, so 220 strokes more than doubling their width doubles the layer.
				// Reported at Children of the City 1:44 as a glow with nothing under it, and the trace
				// says exactly that - the mean melody width went 2.34 -> 4.83 across a tenth of a second
				// while the loudness sat at 0.43 -> 0.47 and `strike` never fired. The music did nothing
				// there. Every other `release` term in this preset is 0.03 to 0.15; this one was 1.2.
				// The drop reaches the picture through the number of marks, which is the layer that
				// exists for events, and nowhere else (DESIGN-RULES §12, and the seamless rule).
				pctx.lineWidth = Math.max(0.6, scale * 0.0016 * (0.8 + c.loudness * 0.35 + c.brightness * 0.4) * (1 + release * 0.15));
				pctx.stroke();

				p.x = nx;
				p.y = ny;
				p.life -= c.dt * 0.33; // ~3s of travel
				if (p.life <= 0 || p.x < 0 || p.x > width || p.y < 0 || p.y > height) Object.assign(p, spawn(width, height));
			}

			// ---- layer 3: percussion ----------------------------------------------------------------------
			// Dormant by default and invisible between hits - which is the layer doing its job, not a
			// layer missing. Highest sampling frequency, fastest drift, and the only group whose speed
			// is an impulse rather than a rate: a sharp attack flings a spark, a soft swell barely moves
			// it. Isotropic (no shared frame) and ~0.3s of visible life, so unlike the other two this
			// one can safely take a per-particle bend from the cursor - there is no long trail for a
			// kink to be recorded into, and nothing pre-aligned to collapse into a seam.
			// derived from the melody's rather than tuned alongside it: percussion must always be the
			// quicker layer, and two independently tuned formulas only hold that ordering by luck -
			// at high energy the melody's own terms used to overtake it
			// The x1.6 was flat, so percussion was 60% faster than the melody in a silent passage exactly
			// as in a chorus. Measured on Harmonious, whose quietest bucket is most of the track: in
			// near-silence the sparks' fast tail reached 169 px/s at p95 and 369 at the maximum, against
			// the bass's 55 and 132 - and above the melody's fastest tail in the track's LOUDEST passage.
			// Speed reads as loudness; this is the same mistake the wind-up made, in the layer that
			// moves quickest and is therefore most visible making it.
			// Cut at every level, not only the quiet one. The previous version kept the loud end exactly
			// where it was, on the reasoning that "nothing was wrong up there" - which was an assumption,
			// and it was wrong. Measured on Charlie's Inferno's loudest passage: percussion reached
			// 1986 px/s at the maximum against the bass's 283 and the melody's 635 - seven times the one
			// and three times the other. A spark crossed a 1440-high screen in seven tenths of a second.
			// That is the layer tearing around, and it does it hardest exactly where there is most of it.
			//
			// This layer is the quickest by design and should stay the quickest. It should not be a
			// different order of magnitude from the sky it belongs to.
			//
			// And then, after all that, it still raced - because the LEVEL was never the whole
			// problem. `c.loudness` rather than `c.energy` in all three speeds is the rest of it: on
			// Borderline at 0:08 the raw curve runs 0.16 -> 0.30 -> 0.19 -> 0.30 -> 0.51 -> 0.66 ->
			// 0.17 inside half a second, and every one of those steps was an acceleration. The
			// sparks were not just fast, they were flooring it and braking three times a second.
			// How far a spark travels in a second. The trail canvas keeps roughly 0.37s of it, so the visible
			// streak is about a third of this in pixels - which is the whole reason the number is this
			// big. It is a property of the material and barely moves with the music: a small loudness
			// term so a quiet passage is not identical to a chorus, and nothing else. No hit, no power,
			// no charge, no impact.
			const percSpeed = PERC_BASE * (0.3 + c.loudness * 1.2) * windUp * pace;
			// the current hit's real amplitude, over what a big hit sounds like on THIS track. It goes
			// to light and width only - never to speed, and never to how many sparks exist
			// ---- WHERE A MARK IS BORN ---------------------------------------------------------------
			// ACROSS THE WIND, never along it. The field is one heading and it carries everything with
			// it, so anything encoded along that heading is wiped within a second; encoded ACROSS it,
			// the drift runs parallel to the axis and never changes the reading. It also keeps the
			// areas equal, puts nothing in the middle to collect into a blob, and does not care about
			// the screen's aspect.
			//
			// The scale is "how ringing was the sound" - timbre[1], normalised per track. It is not a
			// pitch: `pitches` gives the note without the octave, so a low C and a high C are the same
			// number, and the rhythm bands cannot do it either - 48% of our hits touch the lowest band
			// AND the highest at once, because the detector selects broadband events by design and a
			// broadband sound has no register. What this measures is dull-versus-ringing, which is the
			// nearest honest thing.
			const acrossX = -Math.sin(groundAngle);
			const acrossY = Math.cos(groundAngle);
			const alongX = Math.cos(groundAngle);
			const alongY = Math.sin(groundAngle);
			const acrossReach = Math.min(width, height) * 0.46;
			const alongReach = Math.hypot(width, height) * 0.5;
			// `spread` is how much of the axis this mark may wander from its own place: a hard mapping
			// would draw a line, and a line is a chart, not a picture
			// Presence-at-rest was tried here, as a translation of the whole placement toward the pointer.
			// It worked mechanically and was cut on the listener's judgement: events drifting toward the
			// hand does not READ as the picture knowing where you are. Worth recording so it is not
			// rebuilt bigger - it was already faint at this scale, a 119 px shift against a spread of
			// +-744 px along the wind, and the only way to make it plain is a pull strong enough to
			// gather marks AT the hand. Gathering is the thing that clots (DESIGN-RULES §1).
			const placeMark = (p: Spark, at: number, spread: number) => {
				const a = (Math.max(0, Math.min(1, at + (Math.random() - 0.5) * spread)) - 0.5) * 2;
				const along = (Math.random() - 0.5) * 2;
				p.x = Math.max(2, Math.min(width - 2, width / 2 + acrossX * a * acrossReach + alongX * along * alongReach));
				p.y = Math.max(2, Math.min(height - 2, height / 2 + acrossY * a * acrossReach + alongY * along * alongReach));
			};

			// ---- THE SOUND THAT IS ABOUT TO HAPPEN -----------------------------------------------------
			// Not the one that is happening. A mark needs time to reach full brightness and longer to reach
			// full speed, so lit ON its sound it peaks after it - and the eye reads an event at its peak
			// (DESIGN-RULES §5b). The analysis is a timeline, not a stream: the next segment is already in
			// memory with its loudness and its attack, so the sound can be answered before it arrives.
			//
			// The lead is per sound, because the shove's own clock is: a crack leans into its speed in a
			// tenth of a second and a swell takes most of one, and both have to be AT full speed when the
			// sound lands. Long-lived marks are the slow ones, so they get the most warning.
			const segs = audio?.segments;
			if (segs && segs.length > 0) {
				if (progressSec < lastScan || progressSec - lastScan > 0.5) {
					let lo = 0;
					let hi = segs.length - 1;
					while (lo < hi) {
						const mid = (lo + hi) >> 1;
						if (segs[mid].start < progressSec) lo = mid + 1;
						else hi = mid;
					}
					nextSeg = lo;
				}
				lastScan = progressSec;
				while (nextSeg < segs.length && segs[nextSeg].start < progressSec - 0.02) nextSeg++;
			}
			const coming = segs && nextSeg < segs.length ? segs[nextSeg] : null;
			
			const hitAmp = coming ? Math.pow(10, coming.loudness_max / 20) / (audio?.hitScale || 0.56) : c.energy;
			const ringing = coming && audio ? rankOf(audio.timbreSorted, coming.timbre[1]) : 0.5;
			
			// ---- the shape of that attack --------------------------------------------------------------
			// loudness_max_time is how long the sound takes to reach its peak - 11ms at the sharp end of the
			// distribution, 245ms at the soft. The fall is that peak against where the NEXT event starts:
			// how much of it is gone by the time anything else happens. Sharp and falling far is a crack;
			// slow and holding is a voice, and a voice must not snap on.
			let hitRise = 0.06;
			let hitDecay = 0.22;
			let hitFling = FLING;
			let hitSharp = 0.6;
			// 0 for a sound with no broadband attack at all - a vowel, a bowed note, a pad - up to 1 for a
			// full-spectrum crack. Not a gate: a quality
			let breadth = 0;
			if (coming && audio && audio.hits && audio.hits.length > 0) {
				const h = audio.hits;
				let lo = 0;
				let hi = h.length - 1;
				while (lo < hi) {
					const mid = Math.ceil((lo + hi) / 2);
					if (h[mid].t <= coming.start + 0.06) lo = mid;
					else hi = mid - 1;
				}
				if (Math.abs(h[lo].t - coming.start) < 0.07) breadth = (h[lo].bands - 3) / 5;
			}
			if (coming && segs) {
				const after = segs[nextSeg + 1];
				const fall = after ? coming.loudness_max - after.loudness_start : 8;
				hitSharp = 1 - Math.min(1, coming.loudness_max_time / 0.12);
				// never under three frames: below that a rise is a step whatever the arithmetic says
				hitRise = Math.max(0.05, Math.min(0.55, coming.loudness_max_time * 2.4 + 0.04));
				// a big fall means the sound is gone before anything else happens; a small one means it is
				// still ringing under the next event, so its light should still be there too. The SHAPE is
				// measured; the scale is a decision - the median mark holds about 0.43s, a ringing one over a
				// second, because marks that died with their sound left the sky empty between events.
				// bounded in BEATS, not seconds: a mark may not outlive about a beat and a half of the
				// song it belongs to, and may not be shorter than a fifth of one
				hitDecay = Math.max(beat * 0.4, Math.min(beat * 1.6, 3.4 / Math.max(3, fall)));
				// only a crack gets thrown. A voice drifts, and it leans into it slowly
				hitFling = FLING * (0.35 + hitSharp * hitSharp * 0.65) * (0.5 + breadth * 0.8);
			}
			// how far ahead this particular sound has to be answered for its shove to land ON it
			const lead = Math.min(0.4, hitRise * 0.9);

			// How hard this layer is allowed to go right now. Every beat still lights sparks - trying to
			// pick out only the percussive ones through attackSharpness was a dead end, because that comes
			// from the SEGMENT's loudness_max_time, and a segment of a dense mix contains the drum along
			// with everything else, so its attack time describes the mix rather than the drum. Percussion
			// cannot be isolated from this data at all.
			//
			// What the data does say reliably is which part of the song this is. So the beat stays the
			// trigger and the SECTION sets the amount: a quiet verse gets a handful of sparks, a chorus is
			// allowed to come apart completely. level and sectionIntensity rather than energy, because
			// verse-versus-chorus is a section-scale question and energy answers a per-moment one.
			// the drums leave first and come back hardest. The brace suppresses ignition almost
			// entirely - which is what a real breakdown does - and the impact term is large enough to
			// light most of the dormant pool inside its ~0.3s, which is what keeping that pool bigger
			// than any passage needs was for
			// The population is a budget, and it is spent where the song is big rather than spread flat
			// across it. sectionIntensity is this part's rank among the track's own sections, so a
			// verse runs on a third of what a chorus gets - which is what gives a chorus its weight,
			// more than any amount of extra brightness would
			// and each spark carries more of its hit where the section is big
			// the same continuous background, in the brightness of every spark and the width of every mark
			// the background sets HOW MANY marks there are and how wide; it may not also halve how
			// bright each one is, or a quiet track loses its events twice over. Measured: group 1 was
			// 11% of the light on Harmonious against 25% on Borderline, for the same job.
			const sectionPower = 0.78 + slowBand * 0.45;
			// bounded like the melody's lean, just wider: percussion is the group allowed to wander
			// furthest off the wind, but it still travels along it rather than in a direction of its own
			// the middle rank: clearly above what has been happening around it, without topping it
			const standout = hitAverage > 1e-3 && hitAmp > hitAverage * STREAK_OVER;

			const percSpread = PERC_SPREAD_MAX * contraction;

			// ---- level 4: a hit may not create anything ------------------------------------------------
			// A hit only changes how the sky that is already there looks: it may not spawn. Every birth
			// is a teleport, and a birth triggered by a hit happens at the exact moment the eye has
			// been pulled to that spot - so hit-driven spawning puts the most visible artefact at the
			// most visible instant. It also removes the last place a value gets ASSIGNED on a beat,
			// which is what stepped the speed 602 times a minute. How big the sky is, is `inSky`,
			// worked out at the top of the frame where both loops that read it can see the same number.

			// ---- A DROP IS A BIG HIT, AND NOTHING ELSE ------------------------------------------------
			// There was a whole separate mechanism here: its own burst of marks, its own speeds, its own
			// placement, its own launch clock. It is gone, and the reason is the detector rather than
			// the look. We cannot find a drop reliably - measured, two of the moments the listener
			// objected to scored 1.00 and 0.77 - and a spectacular effect on an unreliable trigger is
			// spectacularly wrong every time the trigger is wrong.
			//
			// So a drop is now nothing but a large ordinary hit: it goes into `grandeur` below, the
			// same number every hit is sized by, and everything else - the shape, the placement, the
			// shove, the runners - happens through the one path all sounds take. When the detector is
			// wrong the picture is merely a little busier for a second, which is never wrong.
			// ---- ONE EVENT, ONE SPARK -------------------------------------------------------------------
			// Not a reach into a population, not a probability per spark: an attack happens, a single
			// spark carries it. Everything about that spark is the sound - its pace, its rise, its
			// decay, its throw - so what is on screen is a list of the sounds that have happened
			// recently, one mark each, and nothing is an average of several.
			//
			// Its pace is ASSIGNED here, which is allowed for exactly one reason: the spark is dark at
			// this instant. Its light starts at zero and rises through a smoothstep, so by the time
			// anything is visible the speed has been constant for several frames. A value written into
			// a moving quantity is a step only if something can be seen moving.
			// EVERY NEW SOUND IS AN EVENT. `c.strike` gates on at least three of the eight rhythm bands
			// firing together, and that gate exists to answer "is this a drum" - a question this preset
			// gave up on for good reasons. A sung note swells in and lights no bands at all, so it was
			// not being missed, it was being FILTERED OUT, by design, along with every bowed, blown or
			// held sound in the track.
			//
			// A segment start is the analysis saying the timbre just changed: something new is
			// sounding. That is the event. How broadband it was survives as a QUALITY of it - how
			// percussive, how many sparks, how hard they are thrown - instead of as a threshold. A
			// crack and a vowel both get marked; they get marked differently.
			// fired EARLY - `lead` seconds before the sound, worked out from that sound's own attack -
			// and once per sound, whatever the frame rate
			// ONE PLACE A SPARK IS LIT, and only the music lights one. A click used to throw its own disc
			// of marks from under the pointer - correct by every rule in this project and cut on sight,
			// because a burst appearing where the hand is looks like a burst appearing where the hand
			// is. A click is a glow and a ring now, and nothing is born from it.
			const ignite = (p: Spark, lit: number, wanted: number) => {
				// no `beatStrength`: that is the tempo grid, a second clock, and the marks ride segment
				// starts. A hit stands out by being louder than the ones around it - a property of the
				// sound, not of where a tracker put a bar line
				p.streak = lit === 0 && standout ? 1 : 0;
				// not at once, and not identical. A burst that arrives on one frame is a flashbulb;
				// spread over a few dozen milliseconds it is a sound with a body. The envelope reads
				// its own age, so a negative one simply means "not yet"
				p.age = -lit * 0.014;
				p.rise = hitRise * (0.85 + Math.random() * 0.35);
				p.decay = hitDecay * (0.8 + Math.random() * 0.5) * (p.streak > 0 ? 1.6 : 1);
				p.fling = hitFling * (p.streak > 0 ? FLING_RANK / FLING : 1);
				p.chase = 0.9 / Math.max(0.08, p.rise);
				p.power = Math.min(1, hitAmp) * (0.7 + Math.random() * 0.45);
				p.breadth = breadth * (0.8 + Math.random() * 0.4);
				p.soft = 1 - hitSharp;
				// a big hit takes more of the axis than a small one, which is the whole of what used to
				// be a special broadband rule for drops
				// Chosen independently of the sound, and PLACED in the middle rather than selected from
				// whatever happens to be there. Tied to the register it was fragile: whether a drop
				// had any runners at all depended on where one segment's timbre landed on the axis,
				// and on 一緒なら that meant a drop with no fast marks in it at all. The middle of the
				// axis is now the runners' lane, which is a rule the eye can learn.
				const runner = Math.random() < 0.1;
				placeMark(p, runner ? 0.5 : ringing, runner ? 0.3 : 0.2 + Math.min(0.45, wanted * 0.008));
				// a crack travels, a swell drifts - and no two of them exactly alike
				// The FLOOR is the part that matters. Measured, px/s, p50/p95/max across three tracks:
				// sparks 145/269/465, melody 89/103/113, bass 49/56/61 - but the softest sparks were
				// running at 43, which is slower than the bass, and a mark that drifts slower than
				// the ground is not a mark. The bottom is now around the melody's own speed; the top
				// is left where it was, because that end was not the complaint.
				// A FEW OF THEM RUN, and they are the ones in the middle. A burst where everything
				// takes off at once is one object moving, and one object moving has nothing to be
				// measured against - which is why the shove could not be felt however hard it was
				// made. The slow ones are the reference; the runners are read against them. Central
				// on the axis means mid-register, so this is a property of the sound rather than a
				// decoration: a dull thud and a thin ring both stay put, and the body of the music
				// is what throws.
				p.pace = (0.95 + hitSharp * hitSharp * 1.55) * (0.8 + Math.random() * 0.45) * (runner ? 1.5 : 0.88);
				if (runner) {
					p.fling *= 1.8;
					p.chase = 3.6;
				}
			};

			const newSound = coming !== null && coming.start !== lastSegStart && coming.start - progressSec <= lead;
			if (newSound && coming) lastSegStart = coming.start;
			if (newSound) {
				hitAverage += (hitAmp - hitAverage) * 0.2;
				// HOW BIG THE EVENT WAS, TIMES WHERE THE SONG IS. Both, always - the size of a hit
				// means nothing on its own, because the same hit is an event in a verse and a detail
				// in a chorus. The background here is the slow band, which is continuous, rather than
				// the section rank, which is a step: the two agree at r = 0.79 and only one of them
				// can be crossed without anything jumping.
				const grandeur = 1.2 + Math.min(1.4, hitAmp) * 3.2 + breadth * 2.8 + release * 3;
				// No gesture term here any more. How many marks an event throws is a global quantity, and a
				// global change has NO AUTHOR - you cannot see from the picture that it was you rather
				// than the music getting louder, which is what made the first conducting build feel like
				// nothing. Everything the hand does now has a place: it lights, stirs and hurries where
				// it is, and it moves where events are born. `c.hand` is spent on the second of those.
				const wanted = Math.max(2, Math.round(grandeur * (0.5 + slowBand * 1.5)));
				let lit = 0;
				// WITHIN THE VISIBLE POOL. This was the bug behind "it does not react to every sound":
				// ignition walked the whole array while the draw loop only covers the first `inSky` of
				// it, and `inSky` is 35-100% of the pool depending on the slow band. So in a quiet
				// passage up to two thirds of all events were handed to sparks that are never drawn -
				// lit, burning, invisible, and the event simply did not happen on screen.
				for (let tries = 0; tries < inSky && lit < wanted; tries++) {
					const p = perc[cursor++ % inSky];
					if (p.age <= p.rise + p.decay * 0.6) continue;
					ignite(p, lit, wanted);
					lit++;
				}
			}

			let flareNow = 0;
			density.begin(width, height);
			for (let pi = 0; pi < inSky; pi++) density.add(perc[pi].x, perc[pi].y);

			for (let pi = 0; pi < inSky; pi++) {
				const p = perc[pi];
				const fx = p.x / scale;
				const fy = p.y / scale;
				const markHand = handMark(p.x, p.y);
				const markRing = c.rippleAt(p.x, p.y);
				const percDeviation = noise(fx * 2, fy * 2, fieldTime * 2.2) * percSpread;
				const angle = groundAngle + percDeviation;

				// COUPLING: melody -> percussion. A drum hit has no pitch of its own, but it is heard
				// against whatever harmony is sounding. On a beat the sparks that light are biased
				// towards those whose local field angle agrees with where the harmony is leaning: the
				// same amount of light, redistributed - so the drum layer's TEXTURE moves with the
				// chords while its timing stays purely rhythmic. No brightness added, no angle imposed.
				// fired by real transients rather than by the beat grid - see Conductor.strike. On a
				// track that keeps regular time the two are the same events; on one that does not,
				// this follows the music and the grid does not
				// One star, on a hit that beats everything the last few seconds contained and lands on a
				// strong beat. Self-adjusting rarity: a dense passage raises its own bar, a sparse one
				// lowers it, so the star always goes to something that actually stood out
				// Launched BEFORE the hit it belongs to, so its rise completes ON the beat rather than
				// beginning there. An object aligned by its birth peaks late by however long it takes
				// to reach full strength, which for this one is four tenths of a second - and "late"
				// is what has been reported about this mechanic every single time.
				// The envelope is a FUNCTION OF ITS OWN AGE, with the rise and the decay the sound
				// itself had. Nothing chases a pulse, so nothing depends on the frame rate and nothing
				// can be caught halfway - and the rise is a smoothstep, so a spark reaches full
				// brightness without snapping into it however sharp the sound was.
				p.age += c.dt;
				p.charge =
					p.age <= 0
						? 0
						: p.age < p.rise
							? (t => t * t * (3 - 2 * t))(p.age / p.rise)
							: p.age > p.rise + p.decay * 6
								? 0
								: Math.exp(-(p.age - p.rise) / p.decay);

				// chased, never assigned - and the chase is as quick as the sound was. A crack leans
				// into its fling in a fifth of a second; a voice takes most of a second to get there
				const boostTarget = Math.min(1, p.charge) * p.fling;
				const chase = p.chase;
				p.boost += (boostTarget - p.boost) * Math.min(1, (boostTarget > p.boost ? chase : chase * 0.4) * c.dt);


				// A hit used to be an impulse - speed proportional to charge squared, so a spark shot off
				// at ~500 px/s and visibly braked to a crawl as its charge decayed. That is what
				// "it stops" was. The layer now travels steadily like the other two and the beat is a
				// modulation on top, not a launch: the hit lives in brightness and width, which is
				// where a hit can be sharp without the motion having to be.
				// tied to the spark's own charge, so the extra speed arrives with the light rather than
				// a step ahead of it. Nothing in a rank may switch on

				const speed =
					// The power->speed range is deliberately narrow at the top. On a plain kick-snare
					// pattern the snare is the louder hit, and at the old spread it visibly outran the
					// kick every other beat - the eye read it as the layer speeding up and slowing down
					// rather than as two different drums. A hard hit is still quicker, just not by much;
					// what it gets instead is light, below
					// LEVEL 3: p.power leaves the speed. It is ASSIGNED on a hit, and it sat in a
					// multiplier, so a spark stepped its speed by up to 124% inside one 16ms frame -
					// measured at 602 such steps a minute, 3.3 a second, none in bass or melody. No
					// amount of tuning reaches that; only never writing a value into a moving quantity.
					percSpeed * p.pace * (1 + p.boost + markHand * 1.0 + markRing * 0.7);
				const nx = p.x + Math.cos(angle) * speed * c.dt;
				const ny = p.y + Math.sin(angle) * speed * c.dt;
				p.dirX = Math.cos(angle);
				p.dirY = Math.sin(angle);

				if (p.charge > 0.02) {
						const alpha = Math.min(
						PERC_ALPHA_CAP,
						Math.max(
							0,
							p.charge *
								(0.8 + p.power * 1.3) *
								sectionPower *
								(0.62 + p.brightness * 0.55 + density.at(p.x, p.y) * 0.25 + markHand * 2.0 + markRing * 1.6)
						)
					);
					// THE TAIL IS WHERE THE SPARK HAS ACTUALLY BEEN.
					//
					// The previous version drew a comet backwards from the head along its heading. It
					// was not a path, it was a stick that grew out of the particle, and it looked like
					// one. A trail is a consequence of movement or it is nothing.
					//
					// Which forces the real conclusion: a long streak means the spark genuinely travels
					// far in the time the trail canvas keeps it. It cannot be ACCELERATED into that on
					// a hit - that is the 602 one-frame steps a minute - so it travels that fast ALL
					// THE TIME. Falling stars are what this layer is made of; a hit only lights them.
					// Nothing here changes speed, ever.
					pctx.beginPath();
					pctx.moveTo(p.x, p.y);
					pctx.lineTo(nx, ny);
					pctx.strokeStyle = rgbString(tint(percRgb, tintPulse), alpha);
					// thinner the faster it goes: a long streak drawn as thick as a slow mark is a smear, and a
					// slow one drawn as thin as a streak disappears. Same ink, different shape.
					// One channel each, and the pace is out of the width entirely. It used to divide it,
					// so a sharp sound - which is a fast one - drew THINNER than a soft one, and the two
					// cancelled: the crack was long and faint, the voice short and fat, and neither read
					// as itself. Now length is the pace, brightness is the loudness, width is the
					// breadth. A crack is a long wide streak. A voice is a slow narrow one that lingers.
					pctx.lineWidth = Math.max(
						0.8,
						scale * 0.0016 * (0.5 + p.breadth * 1.0 + p.soft * 0.75 + p.charge * 0.6) * (0.7 + slowBand * 0.6)
					);
					pctx.stroke();
				}

				if (p.charge > flareNow) flareNow = p.charge;

				p.x = nx;
				p.y = ny;
				// Recycled on a slow clock as well as at the edges, and that is what fixes the balance.
				// Recycling ONLY on exit is a conveyor: every spark enters wherever it was born, drifts
				// downwind and leaves at one end, so in the steady state the population piles up toward
				// that end - measured at 53% of all percussion drawn in the last fifth of the screen
				// against 4% in the first, while the bass, which dies on a timer and is reborn in
				// place, sat evenly. A slow timer here spreads the same particles across the sky
				// instead of queueing them at its downwind edge.
				//
				// ~14s, far longer than a spark stays lit, and only ever while it is dark - so the
				// teleport is still something nobody can see.
				p.life -= c.dt * 0.07;
				// A spark that leaves comes straight back in at the opposite edge, still carrying its
				// charge, instead of parking off-screen until it goes dark. Waiting for the light to
				// decay meant a third of every stroke this layer drew was outside the canvas, and each
				// of those sparks held a slot in the population the whole time it was invisible - which
				// is most of what left the upwind side thin. It re-enters by exactly as much as it
				// overshot, so it crosses the border moving inwards, the way it would have entered if
				// it had come from beyond it.
				if (p.x < 0) p.x += width;
				else if (p.x > width) p.x -= width;
				if (p.y < 0) p.y += height;
				else if (p.y > height) p.y -= height;
				// the slow clock still recycles it outright, and still only while it is dark, so the
				// teleport that reseeds brightness and endurance remains something nobody can see
				if (p.charge <= 0.02 && p.life <= 0) Object.assign(p, spawnSpark(width, height));
			}

			flare = flareNow;

			bloom.flush(frame, c, 0.012);
		}
	};
}

export const flowFieldLayers2Preset: PresetDefinition = { id: "layers2", name: "Layers II", create };
