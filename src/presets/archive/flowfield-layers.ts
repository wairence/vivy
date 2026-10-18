import { createNoise3D } from "simplex-noise";
import { createChromaTracker, createDensityGrid, fadeTrail, resizeToCount } from "../effects";
import {
	albumHsl,
	createBloomLayer,
	createConductor,
	createGestureLayer,
	hslToRgb,
	lerpAngle,
	particleTargetCount
} from "../flowfield-common";
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
const CUT_RADIUS = 0.05; // x scale

// The star.
//
// Every spark in this layer is identical, which is what makes the layer read as weather rather than
// as anything happening. On a hit that genuinely stands out, exactly ONE of them stops being
// weather: it crosses the sky on its own straight line, fast and bright, and burns out.
//
// One, not several, and this is the whole design. Rarity IS the content - a sky where every star
// streaks is a snowstorm, and a snowstorm has no moment in it. A single streak also gives the eye
// somewhere to GO: attention can follow one thing and nothing at all when there are two hundred, so
// the difference between one and many is the difference between watching a movement and reading a
// brightness. And because it is a different KIND of object from the fields around it, it does not
// have to win a fight for brightness to be seen - which is just as well, since we know how those
// fights end (DESIGN-RULES §3b).
//
// The rule that keeps it from decaying back into texture: a bigger moment makes the star longer,
// faster and brighter. It never makes MORE of them. That is the exact inverse of how the rest of
// this layer works, where force goes into population, and it is why the two do not compete.
// Three ranks, not two. Ordinary sparks are the texture; a hit that stands out from its neighbours
// gets a longer, faster streak; a hit that beats everything in recent memory gets the star. Texture,
// accent, event - so the layer has somewhere to go between "weather" and "the one thing you look at".
//
// There is deliberately NO minimum interval on the star any more. A fixed gap does not skip an
// event, it DISPLACES it: the standout hit is refused and the next, weaker one is promoted instead,
// so the star lands late and on the wrong beat. Rarity comes from the decaying peak it has to beat,
// which is self-spacing and always picks the right hit.
const STAR_LIFE_SEC = 2.2;
// A star crosses the sky because it LIVES long enough to, not because it is flung. Length of trail
// was being bought with speed, which is why a rank kept reading as something suddenly moving at a
// different rate from everything around it - and a rate that changes for no visible reason is the
// one thing that always looks wrong. Barely quicker than the field; the distinction is duration.
const STAR_SPEED = 1.35;
// how much of its life is the arrival. Nothing in this preset may appear at full strength - the
// star's envelope had a decay and NO attack, so it existed at full speed and full brightness in
// the first frame it drew, which is the definition of something happening with nothing before it
const STAR_RISE = 0.3;
// launched this far ahead of the hit, so the rise finishes ON it rather than starting there
const STAR_LEAD = STAR_LIFE_SEC * STAR_RISE;
// The star's LIGHT is a separate envelope from its motion, and it is the one that has to hit. Its
// approach takes two thirds of a second, which is correct for something that has to get into frame
// without appearing there - but a brightness that also takes two thirds of a second to arrive is a
// swell, not a hit, and the report was exactly that: "they don't read as on the beat, they just fly
// past". A drum is an attack and a decay. So the geometry keeps the long smooth approach and the
// light strikes: ~0.14s up, peaking ON the hit, ~0.5s down. The corner at the peak is the event -
// it is the one place in this preset where a discontinuity in the rate is wanted, and brightness is
// the only channel allowed to have one (DESIGN-RULES §1b).
const STAR_ATTACK = 0.14;
const STAR_DECAY = 0.5;
// How far above a TYPICAL recent hit one has to reach for the middle rank. Not measured against the
// star's decaying peak any more: that peak falls with a 4.6s half-life, which is faster than hits
// arrive, so by the next beat it had already dropped below the last hit and 71-92% of hits cleared
// it on the tracks measured. A rank that most hits reach is not a rank, it is the texture moving
// faster. Against a running average of what a hit sounds like around here, x1.1 promotes 2-34%
// depending on how dynamic the track is - and a compressed track honestly getting almost none is
// the right answer, not a bug.
const STREAK_OVER = 1.1;
const STREAK_LIFE = 2.8;        // times an ordinary spark's
// what a spark's light falls to after one second, at endurance 1 - so a 0.26s time constant
const HIT_TAIL = 0.02;
// almost nothing: the middle rank is longer-lived, not faster. Same reasoning as the star
const STREAK_SPEED = 1.12;
// the release leans on light and width; speed is the channel every complaint about this has named
const RELEASE_SPEED = 0.75;
const MELODY_TILT_MAX = 0.5;
const PERC_SPREAD_MAX = 0.35;

const BASS_COUNT = 180;
const BASS_MAX = 280;
const MELODY_COUNT = 220;
const MELODY_MAX = 340;
// The dormant pool is deliberately larger than the loudest passage needs. A spark that never
// lights costs nothing to look at, but a pool that runs out is a ceiling on the population in
// exactly the way a clamped alpha is a ceiling on brightness (DESIGN-RULES §3b): at saturation a
// louder chorus cannot show as more, and the layer's dynamics flatten at the top.
const PERC_COUNT = 150;
const PERC_MAX = 240;

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
		if ((event as CustomEvent<string | null>).detail !== flowFieldLayersPreset.id) return;
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
type Particle = { x: number; y: number; life: number; brightness: number; lit: number };
// percussion particles are dormant most of the time: `fire` is the one-shot target a beat sets,
// `charge` is the eased follower that is actually drawn, so a spark lights over ~40ms instead of
// appearing at full brightness in a single frame
// `power` is how hard the hit that lit this spark actually was - the segment's own loudness_max as
// linear amplitude, real per-segment data rather than a guess (DESIGN-RULES §8). It stays with the
// spark for its whole life, so a soft hit is a slow short dim streak and a hard one is a fast long
// bright one, and the layer has a dynamic range instead of one uniform kind of spark.
type Spark = Particle & {
	fire: number;
	charge: number;
	power: number;
	// >0 while this spark is THE star: on a hit that stands out from everything around it, one
	// dormant spark is promoted, thrown across the sky on its own straight path and left to burn
	// out. Its own countdown, in seconds
	star: number;
	starAngle: number;
	// middle rank: 0 for texture, 1 for a hit that stood out without owning the passage
	streak: number;
	// how long this particular spark holds, as a multiple. Fixed when it is created and unrelated to
	// how hard it was struck - a population where every member behaves identically reads as a
	// mechanism, and a few that simply hang on longer than their neighbours is what makes it read as
	// a population instead. Length of trail, again, from duration rather than from speed
	endurance: number;
};

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
	let drumming = 0;
	// the loudest hit of the last few seconds, decaying - so "stands out" is judged against what
	// this passage has actually been doing rather than against a fixed number
	let recentPeak = 0;
	let sinceStar = 99;
	let lastStarHit = -1;
	// what a hit sounds like around here, updated once per hit rather than once per frame
	let hitAverage = 0;
	let wasStriking = false;

	const spawn = (width: number, height: number): Particle => ({
		x: Math.random() * width,
		y: Math.random() * height,
		life: 1,
		brightness: 0.35 + Math.random() * 0.65,
		lit: 0
	});
	const spawnSpark = (width: number, height: number): Spark => ({ ...spawn(width, height), fire: 0, charge: 0, power: 0.5, star: 0, starAngle: 0, streak: 0,
		// about a quarter of them, and never the same quarter twice, since a spark is recycled
		endurance: Math.random() < 0.26 ? 1.7 + Math.random() * 0.9 : 1
	});

	return {
		draw(frame) {
			const { ctx, width, height, isPlaying, colorRgb, mouse, audio, progressSec } = frame;
			if (!isPlaying) return;

			const c = conduct(frame);
			const pctx = bloom.begin(width, height);
			fadeTrail(ctx, width, height, TRAIL_ALPHA);

			resizeToCount(bass, particleTargetCount(mouse, BASS_COUNT, BASS_MAX), () => spawn(width, height));
			resizeToCount(melody, particleTargetCount(mouse, MELODY_COUNT, MELODY_MAX), () => spawn(width, height));
			resizeToCount(perc, particleTargetCount(mouse, PERC_COUNT, PERC_MAX), () => spawnSpark(width, height));

			// Percussion is drawn last but its effect on the other two is sampled here, from where the
			// sparks were at the end of the previous frame. At ~2.5px of travel per frame against a
			// ~100px radius that staleness is invisible, and it avoids splitting the percussion loop
			// into an update pass and a draw pass purely for ordering.
			const cutters = perc.filter(p => p.charge > 0.15 || p.star > 0);
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
			const lull = Math.max(0, Math.min(1, -c.trend * 7));

			// A lull is a state that can last a minute, so it may not take the picture as far down as a
			// four-second run-in can: at full strength it left a quiet passage at a seventeenth of a
			// chorus's light, which is not restraint, it is switching off
			const brace = Math.max(c.anticipation, lull * 0.5);
			const release = c.impact;
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
			const cutGate = 1 - brace * (0.35 + c.runInDip * 0.55);
			// The release leans on width, speed and sheer number of particles rather than on alpha
			// alone. Alpha is capped, so pushing the overshoot through it only flattens everything
			// against the ceiling at the exact moment it is supposed to be loudest (DESIGN-RULES §3b);
			// width and stroke length are not capped and read as force rather than as glare
			const dim = (1 - brace * (0.2 + Math.max(c.runInDip, lull) * 0.75)) * (1 + release * 0.95);
			// Speed is not monotonic through the run-up. It falls away with the brace, then the last bar
			// winds it back up and past its resting rate, and the release throws it further. Brightness
			// does none of this - it stays down until the release - so the wind-up is felt as movement
			// in the dark rather than seen, which is what makes the release the first thing that lights

			// The brace no longer touches speed. Withdrawing and winding up were fighting each other in
			// the same channel - the pull-back subtracted almost exactly what the run-up was adding, so
			// the net was flat until the last half second and then everything arrived at once. The two
			// belong in different channels and always did: the brace takes the LIGHT down, the wind-up
			// takes the SPEED up. Darker and faster on the way in, which is what a build-up is.
			const slow =
				(1 + c.windup * (0.35 + c.runInBuild * 0.9)) *
				(1 + release * RELEASE_SPEED);

			const scale = c.scale;
			fieldTime += (0.05 + c.brightness * 0.1) * Math.max(0.1, 1 + c.chaos * 0.7 - c.order * 0.85) * c.dt;
			gesture.begin(frame, c, fieldTime);

			// ---- COUPLING: percussion -> everything (sidechain / masking) ----------------------------
			// A hit does not get brighter; everything around it briefly gets dimmer. That is how a mix
			// actually makes a kick punch, it is how ducking sounds, and it is the only way to add
			// emphasis without adding light to a bloom pass. Fast attack (~45ms), release ~0.35s - the
			// shortest time constant of the five couplings, because percussion is the fastest layer.
			// The star's envelope, computed once a frame from the time of the hit it was launched for
			// rather than from its own age - so the light is tied to the music's clock and not to the
			// particle's. Positive before the hit, negative after.
			const toStarHit = lastStarHit - progressSec;
			const starStrike =
				toStarHit > 0
					? toStarHit < STAR_ATTACK
						? (t => t * t * (3 - 2 * t))(1 - toStarHit / STAR_ATTACK)
						: 0
					: Math.pow(0.03, -toStarHit / STAR_DECAY);
			// and the sky bows for it. Asked for directly: more than one star, "but in exchange quieten
			// everything else". A star is not brighter than the layer around it, it is brighter than the
			// layer around it is AT THAT INSTANT - which is the same trick as the sidechain below, spent
			// on the rarest event in the preset instead of on every beat.
			const duckTarget = Math.min(1, c.pop * (0.45 + c.attackSharpness * 0.55) + starStrike * 0.5);
			duck += (duckTarget - duck) * Math.min(1, (duckTarget > duck ? 22 : 3) * c.dt);

			// ---- COUPLING: melody -> bass (the chord change) ------------------------------------------
			// The ground wanders on its own, very slowly. A real harmonic move - the chroma actually
			// changing, not just a beat ticking over - is the moment the bass is obliged to shift, so it
			// unlocks the ground's turn rate for a second or two. Rare, large, slow: the opposite
			// envelope from the duck above, which is what keeps the two readable as different things.
			const groundWander = noise(fieldTime * 0.14, 11.3, 0) * Math.PI;
			const groundStep = (0.22 + c.harmonicShift * 1.5) * c.dt;
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
			const motionKick = Math.min(0.6, c.gustStrength * 0.2 * c.gustCoherence);
			if (motionKick > 0.01) {
				const gustOffset = ((c.gustAngle - groundAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
				const clamped = Math.max(-MELODY_TILT_MAX, Math.min(MELODY_TILT_MAX, gustOffset));
				tiltTarget += (clamped - tiltTarget) * motionKick;
			}
			// a plain scalar chase with a rate cap: no angles, no wraparound, nothing to flip
			const tiltStep = (0.7 + c.gustStrength * 1.5) * c.dt;
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
			const masking = 1 - Math.min(0.5, Math.max(0, c.level - 0.35) * 1.1);

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

			const influenceRadius = scale * 0.3;
			// how hard a spark is cutting through the point (x, y) right now, 0..1. Percussion is an
			// audio layer, so unlike a gesture this is allowed to drive brightness (DESIGN-RULES §2).
			const cutRadius = scale * CUT_RADIUS;
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
			const cutAt = (x: number, y: number) => {
				let weight = 0;
				for (const spark of cutters) {
					const dx = x - spark.x;
					const dy = y - spark.y;
					const d2 = dx * dx + dy * dy;
					if (d2 > cutRadius * cutRadius) continue;
					// scaled by the hit that lit this spark, so a snare cuts a brighter line through the
					// other layers than a soft kick does - the same power that no longer buys it speed
					const force = spark.star > 0 ? 0.85 : spark.charge * (0.45 + spark.power * 0.85);
					weight += force * (1 - Math.sqrt(d2) / cutRadius);
				}
				return Math.min(1, weight);
			};
			const edgeMargin = scale * 0.18;
			// a particle's decay races to zero as it nears an edge, so its alpha has already faded out
			// by the time the respawn teleports it (DESIGN-RULES §5)
			const edgeDecay = (x: number, y: number) => {
				const edgeDist = Math.min(x, width - x, y, height - y);
				return edgeDist < edgeMargin ? (1 - edgeDist / edgeMargin) * 2.2 : 0;
			};

			pctx.lineCap = "round";

			// ---- layer 1: sustained low end ------------------------------------------------------------
			// Reads level/trend/energy and NOTHING beat-crisp - the whole point is that it does not
			// twitch when the drums hit. Big slow eddies (lowest sampling frequency, slowest drift),
			// drawn as wide near-transparent strokes that accumulate into a wash rather than filaments.
			// low constant, high coefficients. The old (16 + level*40 + energy*22) meant a quiet passage
			// and a drop differed by 1.8x where the audio differs by ten - the constant floor was most
			// of the speed in both, so every section moved at roughly the same rate
			const bassSpeed = (9 + c.level * 34 + c.loudness * 60 + c.sectionIntensity * 22) * c.speedFader * slow;
			const bassWidthBoost = 1 + release * 1.9;
			// a building section fans the ground out, a settling one draws it back in
			// CONTRACTION, which is what a run-in should be doing instead of accelerating. A build-up is
			// stored energy, not spent energy: a wave draws back, a spring compresses, an orchestra
			// goes quiet and tight. So the brace pulls the whole field toward one heading - it goes
			// laminar, which the eye reads as gathering - and the release throws it open again. This
			// costs no speed and no brightness, so it works in a passage that has neither.
			const contraction = 1 - brace * 0.55 + release * 0.5;
			const bassSpread =
				Math.max(0.08, (0.22 + c.trend * 0.8 + c.chaosTotal * 0.35 - c.orderTotal * 0.15) * contraction);
			const bassWidth = scale * 0.0027 * (0.6 + c.glow * 0.7 + c.level * 0.5);
			const bassLight = (1 - duck * 0.55) * dim; // ducks hardest: kick and bass are the classic pair

			density.begin(width, height);
			for (const p of bass) density.add(p.x, p.y);

			for (const p of bass) {
				const along = (p.x * Math.cos(groundAngle) + p.y * Math.sin(groundAngle)) / scale;
				const across = (-p.x * Math.sin(groundAngle) + p.y * Math.cos(groundAngle)) / scale;
				const proximity = Math.max(0, 1 - Math.hypot(mouse.x - p.x, mouse.y - p.y) / influenceRadius);
				// the ground is not something you can push around: the cursor is a scalar here and only
				// a scalar - it can hurry a stroke along, never point it somewhere the field was not
				// already going. These strokes live ~8s, so any raw per-frame angle response would be
				// writing a kink into eight seconds of visible trail
				const cutNow = cutAt(p.x, p.y);
				p.lit += (cutNow - p.lit) * Math.min(1, (cutNow > p.lit ? 4 : 1.8) * c.dt);
				const cut = p.lit;
				const deviation = noise(along * 0.6, across * 0.9, fieldTime * 0.35) * (bassSpread + cut * cutGate * 0.3);
				let angle = groundAngle + deviation;
				const rip = gesture.bendTowardRipple(angle, p.x, p.y, 0.1, scale * 0.5);
				angle = rip.angle;

				const speed = bassSpeed * (1 + proximity * Math.min(1, c.gustStrength) * 0.35) * (1 + rip.weight * 0.2);
				const nx = p.x + Math.cos(angle) * speed * c.dt;
				const ny = p.y + Math.sin(angle) * speed * c.dt;

				const { cursorGlow, rippleGlow } = gesture.glowAt(p.x, p.y, mouse, scale, c.gustStrength);
				const alpha = Math.min(
					BASS_ALPHA_CAP,
					Math.max(
						0,
						// everything here except `cut` is deliberately held down. A highlight is contrast,
						// not magnitude: raising the cut alone only drove the whole layer onto its
						// ceiling, where the lit line and the field around it are the same value and
						// nothing reads as lit at all (DESIGN-RULES §3b)
						(p.brightness * 0.15 +
							density.at(p.x, p.y) * 0.15 +
							c.level * 0.5 +
							c.sectionIntensity * 0.35 +
							c.glow * 0.26 +
							c.impact * 0.45 +
							cut * cutGate * 1.15 +
							cursorGlow * 0.15 +
							rippleGlow * 0.5) *
							Math.sin(p.life * Math.PI) *
							bassLight *
							0.72
					)
				);
				pctx.beginPath();
				pctx.moveTo(p.x, p.y);
				pctx.lineTo(nx, ny);
				pctx.strokeStyle = rgbString(tint(bassRgb, c.pop * 0.4), alpha);
				pctx.lineWidth = Math.max(0.8, bassWidth * bassWidthBoost);
				pctx.stroke();

				p.x = nx;
				p.y = ny;
				p.life -= c.dt * (0.12 + edgeDecay(p.x, p.y)); // ~8s of travel
				if (p.life <= 0 || p.x < 0 || p.x > width || p.y < 0 || p.y > height) Object.assign(p, spawn(width, height));
			}

			// ---- layer 2: melody -------------------------------------------------------------------------
			// Mid sampling frequency, mid drift, hairlines with a real trail. Rides harmonicShift,
			// chroma and spectral brightness; the beat only reaches it as the duck.
			const melodySpeed = (24 + c.loudness * 165 + c.sectionIntensity * 44 + c.brightness * 18) * c.speedFader * slow;
			const spreadTarget =
				Math.max(0.05, 0.34 + c.energy * 0.22 + c.harmonicShift * 0.75 + c.chaosTotal * 0.8 - c.orderTotal * 0.45) *
				masking;
			melodySpread += (spreadTarget - melodySpread) * Math.min(1, 2.2 * c.dt);
			// the sheets flatten toward laminar as the brace tightens and spring open on the hit -
			// applied after the ease, so the release is as fast as the impact rather than as slow as
			// the chase that produced the spread
			// The release adds very little to the SPREAD. At 1.1 it put more than a radian of extra deviation
			// into the melody at exactly the loudest moments, which is a line thrashing rather than a line
			// arriving - and showing a strong moment is the star's job, done by one object the eye can
			// follow instead of by two hundred wobbling at once. The release still lands, in light,
			// width and speed
			const bracedSpread = Math.max(0.04, melodySpread * (1 - brace * (0.15 + c.runInDip * 0.5)) + release * 0.2);
			const melodyLight = (1 - duck * 0.3) * dim;
			const frameCos = Math.cos(melodyFrame);
			const frameSin = Math.sin(melodyFrame);

			density.begin(width, height);
			for (const p of melody) density.add(p.x, p.y);

			for (const p of melody) {
				const along = (p.x * frameCos + p.y * frameSin) / scale;
				const across = (-p.x * frameSin + p.y * frameCos) / scale;
				const proximity = Math.max(0, 1 - Math.hypot(mouse.x - p.x, mouse.y - p.y) / influenceRadius);
				// same scalar-only treatment as the bass, for the same reason: these particles share the
				// melody frame, so proximity may widen how hard the noise swings (turbulence) but may
				// never contribute an angle of its own
				const turbulence = proximity * Math.min(1, c.gustStrength) * c.gustCoherence;
				const cutNow = cutAt(p.x, p.y);
				p.lit += (cutNow - p.lit) * Math.min(1, (cutNow > p.lit ? 4 : 1.8) * c.dt);
				const cut = p.lit;
				const deviation = noise(along * 1.2, across * 1.6, fieldTime) * (bracedSpread + turbulence * 0.5 + cut * cutGate * 0.18);
				let angle = melodyFrame + deviation;
				const rip = gesture.bendTowardRipple(angle, p.x, p.y, 0.35, scale * 0.55);
				angle = rip.angle;

				const speed = melodySpeed * (1 + turbulence * 0.8) * (1 + rip.weight * 0.35);
				const nx = p.x + Math.cos(angle) * speed * c.dt;
				const ny = p.y + Math.sin(angle) * speed * c.dt;

				const { cursorGlow, rippleGlow } = gesture.glowAt(p.x, p.y, mouse, scale, c.gustStrength);
				const alpha = Math.min(
					MELODY_ALPHA_CAP,
					Math.max(
						0,
						(0.02 +
							p.brightness * 0.17 +
							density.at(p.x, p.y) * 0.15 +
							c.glow * 0.46 +
							c.energy * 0.34 +
							c.sectionIntensity * 0.26 +
							c.harmonicShift * 0.21 +
							c.impact * 0.5 +
							cut * cutGate * 1.25 +
							cursorGlow * 0.2 +
							rippleGlow * 0.8) *
							Math.sin(p.life * Math.PI) *
							melodyLight *
							(1 + c.orderTotal * 0.3 - c.chaosTotal * 0.15) *
							0.72
					)
				);
				pctx.beginPath();
				pctx.moveTo(p.x, p.y);
				pctx.lineTo(nx, ny);
				pctx.strokeStyle = rgbString(tint(melodyRgb, c.pop), alpha);
				pctx.lineWidth = Math.max(0.6, scale * 0.0016 * (0.6 + c.glow + c.brightness * 0.4) * (1 + release * 1.2));
				pctx.stroke();

				p.x = nx;
				p.y = ny;
				p.life -= c.dt * (0.33 + edgeDecay(p.x, p.y)); // ~3s of travel
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
			drumming = Math.min(1.6, drumming * Math.pow(0.3, c.dt) + c.strike * 0.7);
			recentPeak *= Math.pow(0.86, c.dt); // ~4.5s half-life
			sinceStar += c.dt;
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
			const percSpeed = melodySpeed * (0.6 + Math.min(0.3, c.loudness * 0.7)) * (1 + c.impact * 0.3);
			// and the fling gets the same treatment. A spark's impulse was ungated: a hit in a quiet
			// passage lit it with the same charge, and threw it the same distance, as a hit in a drop
			const flingAllowance = 0.25 + Math.min(1, c.loudness / 0.35) * 0.75;  // no speed term: accumulation shows as density and light, and a speed change reads as an event
			// the current hit's real amplitude, stamped onto whichever sparks it lights
			const hitAmp = c.segment ? Math.pow(10, c.segment.loudness_max / 20) / (audio?.hitScale || 0.56) : c.energy;
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
			const ignition =
				(0.12 + c.level * 1.2 + c.energy * 0.7) *
					(0.45 + c.sectionIntensity * 1.25) *
					// no wind-up term here. Igniting more sparks IS more light, and a run-up that lights
					// up is the thing reported as "premature glow, as if it forgot about the build-up".
					// The wind-up belongs entirely in movement; brightness stays down until the release
					(1 - brace * (0.25 + c.runInDip * 0.7)) +
				c.impact * 13;
			// and each spark carries more of its hit where the section is big
			const sectionPower = 0.55 + c.sectionIntensity * 0.7;
			// bounded like the melody's lean, just wider: percussion is the group allowed to wander
			// furthest off the wind, but it still travels along it rather than in a direction of its own
			const striking = c.strike > 0.05;
			if (striking && !wasStriking) hitAverage += (hitAmp - hitAverage) * 0.2;
			wasStriking = striking;
			// the middle rank: clearly above what has been happening around it, without topping it
			const standout = hitAverage > 1e-3 && hitAmp > hitAverage * STREAK_OVER;

			const percSpread = PERC_SPREAD_MAX * (1 + c.chaosTotal * 0.6 - c.orderTotal * 0.3) * contraction;

			density.begin(width, height);
			for (const p of perc) density.add(p.x, p.y);

			for (const p of perc) {
				const fx = p.x / scale;
				const fy = p.y / scale;
				const percDeviation = noise(fx * 2, fy * 2, fieldTime * 2.2) * percSpread;
				let angle = groundAngle + percDeviation;

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
				const coming = c.lookAhead(STAR_LEAD);
				if (
					coming !== null &&
					coming.power > recentPeak &&
					coming.sharpness > 0.4 &&
					coming.downbeat &&
					p.star <= 0 &&
					p.charge < 0.02 &&
					progressSec + coming.inSeconds !== lastStarHit
				) {
					lastStarHit = progressSec + coming.inSeconds;
					sinceStar = 0;
					recentPeak = coming.power;
					p.star = STAR_LIFE_SEC;
					p.power = Math.min(1, coming.power); // unclamped for the comparison above, clamped for what it draws
					// along the wind but visibly off it: it belongs to this sky and still departs from
					// it. Straight, and never bent by the field afterwards - it is not part of the flow
					p.starAngle = groundAngle + (Math.random() - 0.5) * 1.2;
					// enters from the upstream edge and crosses. Promoted only while invisible, so the
					// teleport that puts it there can never be seen
					// Placed just outside the edge it comes from, measured along its own ray - not at a
					// fixed fraction of the diagonal. Once the star stopped being flung and started
					// crossing on duration instead, a fixed offset put it further away than its whole
					// life could travel, so it would have burnt out before reaching the frame.
					const cosA = Math.cos(p.starAngle);
					const sinA = Math.sin(p.starAngle);
					const toEdge = Math.min(
						Math.abs(cosA) > 1e-3 ? width / 2 / Math.abs(cosA) : Infinity,
						Math.abs(sinA) > 1e-3 ? height / 2 / Math.abs(sinA) : Infinity
					);
					// How far back it starts is varied, and that is about where it is SEEN rather than
					// where it begins. Starting every star just outside the same edge means every star
					// is brightest at roughly the same place - it reaches its peak after travelling a
					// fixed distance - so one side of the sky collects all of them and the other stays
					// empty. Spreading the entry point spreads the peaks, which is the part that
					// matters. A star that begins inside the frame does not pop, because it has a rise
					// to fade in through.
					const back = toEdge * (0.5 + Math.random() * 0.6) + scale * 0.04;
					const offset = (Math.random() - 0.5) * scale * 0.85;
					p.x = width / 2 - cosA * back - sinA * offset;
					p.y = height / 2 - sinA * back + cosA * offset;
				}
				if (c.strike > 0.05) {
					if (hitAmp > recentPeak) recentPeak = hitAmp;
					const agreement = 0.5 + 0.5 * Math.cos(percDeviation - melodyTilt);
					// how MANY sparks light is itself a function of how loud the hit is. It used to be a
					// fixed probability, so a quiet passage lit as many sparks as a drop and the layer's
					// density said nothing about the music
					// x2.6 on what this was, and the reason is bookkeeping rather than taste: `strike` now
					// fires on 2.0 events a second instead of 3.5 (the band gate throws out the segments
					// that are not drums) and each spark's tail is 0.26s instead of 0.42s. Both are
					// wanted, and together they cost the layer two thirds of its light - measured at 4%
					// of everything painted on Harmonious, against 21% before. Lighting more sparks per
					// hit buys that back without lengthening anything: the same amount of light, spent
					// in events instead of in a glow.
					if (Math.random() < (0.034 + agreement * 0.099) * ignition * (0.2 + c.strike * 0.7 + drumming * 0.3)) {
						p.streak = standout && c.beatStrength > 0.6 ? 1 : 0;
						// Hits ACCUMULATE instead of replacing each other. Assigning 1 made a dense fill
						// look exactly like a single hit, because every strike simply reset the same
						// envelope; adding lets a fast run of them compound into something bigger than
						// any one of them, which is what a fill or a blast of drums actually does. The
						// same for power, so a spark struck repeatedly carries more than the last blow
						// that landed on it. Both bounded, or a long roll would saturate the layer.
						p.fire = Math.min(1.8, p.fire + 0.85 + drumming * 0.35);
						p.power = Math.min(1, hitAmp * (0.7 + drumming * 0.35));
					}
				}
				const holds = p.endurance * (p.streak > 0 ? STREAK_LIFE : 1);
				// A SPARK'S TAIL MUST BE SHORTER THAN THE GAP BETWEEN HITS, or hits cannot be seen as
				// separate things. At 0.09 an ordinary spark decayed with a 0.42s time constant while
				// the music delivers a hit every 0.32s, so every hit landed on top of the last two and
				// the layer never returned to dark - which is what "the percussion does not read as on
				// the beat" is. Measured: at 0.09 only 8% of beats on Borderline produced a visible
				// rise in the painted light; at 0.02 (0.26s) that is 8-13% and the share of visible
				// events landing on a beat goes 30% -> 39% on UNDEAD, 8% -> 15% on Borderline.
				//
				// It is a trade and worth naming: a shorter tail is a dimmer layer, 21% of all light
				// down to 14%. Legibility was the complaint, brightness was not.
				p.fire *= Math.pow(Math.pow(HIT_TAIL, 1 / holds), c.dt);
				p.charge += (p.fire - p.charge) * Math.min(1, 26 * c.dt);

				if (p.star > 0) {
					// straight, fast, bright, and burning out. No field, no gesture, no ripple: a star
					// is not weather and nothing in the weather may steer it
					const life = p.star / STAR_LIFE_SEC;
					// grow, peak, fade - the build-up is inside the event, because a personal best is
					// only knowable at the instant it happens and cannot be announced in advance. So
					// the star announces itself: it enters slow and dim, gathers, and burns out
					const rise = Math.min(1, (1 - life) / STAR_RISE);
					const grow = rise * rise * (3 - 2 * rise);
					const intensity = grow * Math.pow(life, 0.8);
					const speed = percSpeed * STAR_SPEED * (0.45 + 0.55 * grow) * (0.75 + p.power * 0.5);
					const nx = p.x + Math.cos(p.starAngle) * speed * c.dt;
					const ny = p.y + Math.sin(p.starAngle) * speed * c.dt;
					// bright head, tapering tail - the taper is the streak, and it fades rather than
					// stopping, so the end of it is never a hard edge

					pctx.beginPath();
					pctx.moveTo(p.x, p.y);
					pctx.lineTo(nx, ny);
					// faint while it approaches, then the strike. Roughly eight to one between the two,
					// which is the contrast the eye reads as an event rather than as a passing object
					pctx.strokeStyle = rgbString(tint(percRgb, c.pop), Math.min(PERC_ALPHA_CAP, intensity * 0.18 + starStrike * 0.8));
					pctx.lineWidth = Math.max(
						0.9,
						scale * 0.0016 * (0.75 + p.power * 0.55) * (0.2 + grow * 0.22 + starStrike * 0.6)
					);
					pctx.stroke();
					p.x = nx;
					p.y = ny;
					p.star -= c.dt;
					const gone = p.x < -scale || p.x > width + scale || p.y < -scale || p.y > height + scale;
					if (p.star <= 0 || gone) Object.assign(p, spawnSpark(width, height));
					continue;
				}

				const dx = mouse.x - p.x;
				const dy = mouse.y - p.y;
				const proximity = Math.max(0, 1 - Math.hypot(dx, dy) / influenceRadius);
				const gustWeight = proximity * Math.min(1, c.gustStrength) * c.gustCoherence;
				if (gustWeight > 0.01) angle = lerpAngle(angle, c.gustAngle, gustWeight * 0.3);
				// no point-bend here any more. Aiming at the cursor is a position-dependent target, so
				// every particle gets a different angle - which is a large part of what read as the
				// percussion "going in random directions" (DESIGN-RULES §1). yAttraction survives as a
				// scalar on travel speed instead: the cursor can hurry this layer along or hold it
				// back, but it cannot point it anywhere.
				const pull = 1 + proximity * c.yAttraction * 0.35;
				const rip = gesture.bendTowardRipple(angle, p.x, p.y, 0.85);
				angle = rip.angle;

				// A hit used to be an impulse - speed proportional to charge squared, so a spark shot off
				// at ~500 px/s and visibly braked to a crawl as its charge decayed. That is what
				// "it stops" was. The layer now travels steadily like the other two and the beat is a
				// modulation on top, not a launch: the hit lives in brightness and width, which is
				// where a hit can be sharp without the motion having to be.
				const burst = p.charge;
				// tied to the spark's own charge, so the extra speed arrives with the light rather than
				// a step ahead of it. Nothing in a rank may switch on
				const rankSpeed = 1 + p.streak * (STREAK_SPEED - 1) * Math.min(1, p.charge);
				const speed =
					// The power->speed range is deliberately narrow at the top. On a plain kick-snare
					// pattern the snare is the louder hit, and at the old spread it visibly outran the
					// kick every other beat - the eye read it as the layer speeding up and slowing down
					// rather than as two different drums. A hard hit is still quicker, just not by much;
					// what it gets instead is light, below
					(percSpeed * (0.42 + p.power * 0.66) +
						burst * (8 + p.power * c.attackSharpness * 26) * flingAllowance) *
					pull *
					rankSpeed *
					(1 + gustWeight * 0.6) *
					(1 + rip.weight * 0.4);
				const nx = p.x + Math.cos(angle) * speed * c.dt;
				const ny = p.y + Math.sin(angle) * speed * c.dt;

				if (p.charge > 0.02) {
					const { cursorGlow, rippleGlow } = gesture.glowAt(p.x, p.y, mouse, scale, c.gustStrength);
					const alpha = Math.min(
						PERC_ALPHA_CAP,
						Math.max(
							0,
							p.charge *
								(0.12 + p.power * 0.5) *
								sectionPower *
								(0.62 + p.brightness * 0.55 + density.at(p.x, p.y) * 0.25 + cursorGlow * 0.2 + rippleGlow * 0.75)
						)
					);
					// one segment with a round cap: a dot while the spark coasts, a dash while it flings
					pctx.beginPath();
					pctx.moveTo(p.x, p.y);
					pctx.lineTo(nx, ny);
					pctx.strokeStyle = rgbString(tint(percRgb, c.pop), alpha);
					pctx.lineWidth = Math.max(0.8, scale * 0.0016 * (0.32 + p.power * 0.78 + p.charge * 1.1 + c.attackSharpness * 0.45) * (0.7 + c.sectionIntensity * 0.5));
					pctx.stroke();
				}

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

			bloom.flush(frame, c, 0.012);
		}
	};
}

export const flowFieldLayersPreset: PresetDefinition = { id: "flowfield-layers", name: "Layers", create };
