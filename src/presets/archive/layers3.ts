// Layers III. The picture Layers II found, rebuilt so that every line in it is load-bearing and
// its reasons are readable. How each mechanism got here - and the numbers that decided it - is in
// ARCHITECTURE §7.2 and §7.6; the code says what it does now and why, not what it used to be.
//
//   the ground   wide dim strokes, ~8 s life. The loudness of the last ten seconds.
//   the sheet    hairlines, ~3 s life. The loudness now, and the harmony leaning it off the wind.
//   the marks    one per sound. Lit BEFORE the sound by as much as its attack needs, and shaped by
//                it: length is its pace, brightness its loudness, width its breadth, place its ring.
//
// Four rules hold everything else up (DESIGN-RULES §15 says why they are the reason this works):
//   - One wind. Every layer travels along `groundAngle`; a layer is how far it wanders off it.
//   - Geometry never steps; light may. A hit sets a target and a state chases it.
//   - The only coupling is the wake: a mark combs, lights and hurries the field it passes through.
//   - Time is in beats of this track, never in seconds.
import { createNoise3D } from "simplex-noise";
import { createChromaTracker, createDensityGrid, fadeTrail, resizeToCount, shimmerPhase, shimmerTint, createKeyHue } from "../effects";
import { albumHsl, createBloomLayer, createConductor, getVariant, hslToRgb } from "../flowfield-common";
import { createNextSound } from "../next-sound";
import { Preset, PresetDefinition, rgbString } from "../types";

// ---- the canvas it was tuned on ------------------------------------------------------------------
// Tuned by eye in a windowed Spotify. What was tuned is a DENSITY (strokes in view) and a CROSSING
// TIME (how long a stroke takes to cross), so populations scale with area and speeds with size.
const REF_W = 1080;
const REF_H = 1024;
// past ~6x the reference area a stroke stops being free and the eye stops counting
const MAX_DENSITY = 6;

// ---- populations -----------------------------------------------------------------------------------
const GROUND_COUNT = 180;
const SHEET_COUNT = 220;
// The marks' pool. Bigger than the sky ever draws, so a loud chorus never runs out (DESIGN-RULES §3b).
const MARK_POOL = 70;

// ---- the wind ------------------------------------------------------------------------------------
// how far the harmony may lean the sheet off the wind, and how far a mark may wander off it. Both
// are OFFSETS well under PI, so nothing can take the short way round and flip (DESIGN-RULES §1c)
const SHEET_TILT_MAX = 0.5;
const MARK_SPREAD_MAX = 0.35;

// ---- the wake: what a passing mark does to the field -----------------------------------------------
// reach, as a fraction of the short side - a line cut through the field, not a halo
const CUT_RADIUS = 0.09;
// how far the field turns into a mark's heading (well under a right angle: a comb, not a redirect),
// and how fast that turn may change - a rate cap, never a blend
const WAKE_TURN = 0.45;
const WAKE_RATE = 1.6;
// how much the field hurries inside a wake
const WAKE_HURRY = 0.9;

// ---- the marks ---------------------------------------------------------------------------------------
// px/s under each mark's own pace. The trail keeps ~0.37 s of it, so a pace of 2.5 draws ~240 px
const MARK_BASE_SPEED = 120;
// how much faster than its pace a mark runs at the top of its flare - a crack is thrown, a voice drifts
const FLING = 0.95;
// ...and a mark that stood out from the hits around it
const FLING_RANK = 1.2;

// ---- light --------------------------------------------------------------------------------------------
// the trail fade: long, so the ground's wide strokes smear into a wash
const TRAIL_ALPHA = 0.045;
// Ceilings sit above each layer's real p95, never through it (DESIGN-RULES §3b)
const GROUND_ALPHA_CAP = 0.75;
const SHEET_ALPHA_CAP = 0.9;
const MARK_ALPHA_CAP = 0.95;
// the bloom's blur radius, as a fraction of the short side (the classic look, V1)
const BLOOM_SCALE = 0.012;

// ---- THE LIGHT (V0) ---------------------------------------------------------------------------------
// Everything above decides WHERE things are and WHEN; this decides how they SHINE, and none of it
// reaches back into the motion. Two layers over the trail, all composed fresh every frame and
// never written back into it, so nothing here is history being re-blurred (DESIGN-RULES §4):
//   the bloom   the finished picture, bright-passed and blurred at two sizes: a tight core and a
//               wide halo. The halo is the events' channel: it swells with the marks and the drop
//   the stars   a glowing head on every burning mark, so each sound is an OBJECT you can follow
// how much smaller the bloom is rendered than the screen - it is a blur, so resolution is wasted on
// it, and a blur at a quarter size is a sixteenth of the cost. (A nebula - the ground as a wide
// blurred smoke - was tried here on 2026-09-29 and cut on sight.)
const BLOOM_DIV = 4;
const HALO_DIV = 12;

// ---- what the light says (V0) --------------------------------------------------------------------------
// (the harmony's colour is createKeyHue, in effects.ts)
// THE WAKE, LOUDER (V0): how much more a mark does to the field it passes through than it does in
// the classic look - wider, brighter, a deeper comb, a harder hurry. The turn stays under a right
// angle and under the same rate cap, so it is still a comb and still cannot step. (A drawn ring
// and then a wave of light were both tried as "the big hit" and neither read: the first was a
// circle pasted on the picture, the second could not be seen at all. A mark acting on the field
// is the thing this picture already knows how to show.)
const WAKE_GAIN = 1.5;

// THE CAMERA (V0). The picture is a volume and the camera ORBITS it: everything nearer than the
// pivot slides one way and everything beyond it slides the other, which is the one cue that says
// "depth" without anything having to be bigger. Nothing in the simulation knows - it is a
// projection applied when a stroke is drawn, and the volume wraps, so the orbit never runs out.
// (The first camera swung +-0.16 rad about a slab: 15-25 px/s of parallax under strokes moving at
// 50-250, which nobody could see.)
// how fast it orbits, in short sides of the screen per second: at rest, and per unit of loudness
const CAM_ORBIT_REST = 0.03;
const CAM_ORBIT_LOUD = 0.22;
// the depth that stays put; nearer slides with the orbit, further against it
const CAM_PIVOT = 0.25;
// how much bigger the nearest stroke is than the furthest
const CAM_NEAR = 0.45;
// the vertical sway, in short sides
const CAM_SWAY = 0.12;

// ctrl+click: each layer in a flat identifiable colour, to answer "which layer is doing that?".
// Module scope because create() reruns on every preset switch and would leak a listener each time.
let diagnostic = false;
const DIAGNOSTIC_RGB = {
	ground: { r: 255, g: 64, b: 64 },
	sheet: { r: 64, g: 255, b: 112 },
	marks: { r: 96, g: 156, b: 255 }
};
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
	window.addEventListener("flowfield-dev-toggle", (event: Event) => {
		if ((event as CustomEvent<string | null>).detail !== layers3Preset.id) return;
		diagnostic = !diagnostic;
		Spicetify.showNotification(
			diagnostic ? "Layers III: ground red / sheet green / marks blue" : "Layers III: album colour restored"
		);
	});
}

type Rgb = { r: number; g: number; b: number };

// A stroke in the ground or the sheet. `lit`, `wx/wy` and `turn` are all EASED per particle, so a
// wake arrives and lets go instead of switching with distance.
type Particle = {
	x: number;
	y: number;
	life: number;
	// its own fixed brightness, so a population does not read as a mechanism
	brightness: number;
	// how much a passing mark is lighting it
	lit: number;
	// the wake it is sitting in, as a vector (several marks sum; angles would wrap)
	wx: number;
	wy: number;
	// how far it is turned into that wake, radians - a stored offset under a rate cap
	turn: number;
	// its place in the depth of its layer, 0..1, fixed for life
	z: number;
	// where it was last drawn on screen. NaN = not drawn since it was (re)born, so no stroke may
	// start from it
	sx: number;
	sy: number;
};

// A mark. Everything about it is the sound that lit it, fixed when it is lit - nothing is ever
// ASSIGNED into a quantity that is visibly moving; a mark is only written to while it is dark.
type Mark = Particle & {
	// its own speed for life, skewed low, so a fast one is an event by being rare, not by accelerating
	pace: number;
	// heading as a unit vector - the field reads it for the wake
	dirX: number;
	dirY: number;
	// 1/s: how fast its throw arrives. Its own clock, separate from the light's rise
	chase: number;
	// 0 for a vowel, 1 for a full-spectrum crack. Sets WIDTH
	breadth: number;
	// 1 for a sound that swelled in. Also sets width: a sound with no attack is soft, not small
	soft: number;
	// how much faster than its pace it runs right now - a state chasing `charge * fling`
	boost: number;
	// the envelope: age against the sound's own measured rise and decay. Negative age = not yet
	age: number;
	rise: number;
	decay: number;
	fling: number;
	// the light, 0..1, a pure function of age
	charge: number;
	// the hit's real amplitude over this track's big-hit scale
	power: number;
	// 1 for a hit that stood out: it holds longer and is thrown harder
	streak: number;
	// how near it is, 0 far to 1 near: the faster of a sound's marks are the nearer ones, so the sky
	// has a parallax it already moves by. Light and size only
	depth: number;
	// where its head is on screen
	hx: number;
	hy: number;
};

// shortest signed way round from one angle to another
const shortest = (d: number) => ((d + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
// the envelope's rise: reaches full brightness without snapping into it however short the rise
const smoothstep = (t: number) => t * t * (3 - 2 * t);

function create(): Preset {
	const noise = createNoise3D();
	const bloom = createBloomLayer();
	const conduct = createConductor();
	const chroma = createChromaTracker();
	const nextSound = createNextSound();
	// one grid, rebuilt per layer - a shared one would brighten wherever two layers merely overlap
	const density = createDensityGrid(16, 16);

	// ---- the light's canvases (V0). All sized lazily to the screen they are drawn for ----------------
	type Layer = { c: HTMLCanvasElement; x: CanvasRenderingContext2D };
	const layer = (opaque: boolean): Layer => {
		const c = document.createElement("canvas");
		return { c, x: c.getContext("2d", opaque ? { alpha: false } : undefined)! };
	};
	const sized = (l: Layer, w: number, h: number) => {
		if (l.c.width === w && l.c.height === h) return false;
		l.c.width = w;
		l.c.height = h;
		return true;
	};
	// the trail itself, now off screen: the screen is the trail plus the light, rebuilt every frame
	const trail = layer(true);
	// this frame's strokes
	const fresh = layer(false);
	const core = layer(false);
	const halo = layer(false);
	// the star's sprite, redrawn only when the colour it is tinted with actually moves
	const star = layer(false);
	let starKey = "";
	// the soft head: a voice's star - wider, coloured, no white core
	const softStar = layer(false);
	// the palette's lean off the album hue, from the harmony
	const keyHue = createKeyHue();
	// the camera's place on its orbit, and the variant last drawn
	let camTime = 0;
	let camX = 0;
	let lastVariant = -1;

	const ground: Particle[] = [];
	const sheet: Particle[] = [];
	const marks: Mark[] = [];

	let fieldTime = 0;
	// The wind. Persistent and rate-capped: a frame of reference that jumps is useless.
	let groundAngle = 0;
	// how far the harmony leans the sheet off the wind - a bounded scalar, so nothing can wrap
	let sheetTilt = 0;
	// how widely the sheet wanders, eased: it is the amplitude of a geometric deviation
	let sheetSpread = 0.5;
	// the sidechain: how hard the marks are ducking the other two right now
	let duck = 0;
	// how much light the marks put out last frame - the duck follows it
	let flare = 0;
	// THE BACKGROUND: a ten-second follower over the loudness. Continuous, where the section rank it
	// replaces is a step
	let slowBand = 0.35;
	// how many marks are in the sky, stepped one slot at a time with a whole slot of deadband
	let skySize = 0;
	// harmonic movement, eased slower than the conductor's (it reaches light)
	let harm = 0;
	// round-robin over the sky, so consecutive sounds land on different marks
	let cursor = 0;
	// the release, eased: up in a tenth of a second, down over a third
	let flash = 0;

	const spawn = (width: number, height: number): Particle => ({
		x: Math.random() * width,
		y: Math.random() * height,
		wx: 0,
		wy: 0,
		turn: 0,
		life: 1,
		brightness: 0.35 + Math.random() * 0.65,
		lit: 0,
		z: Math.random(),
		sx: NaN,
		sy: NaN
	});
	const spawnMark = (width: number, height: number): Mark => ({
		...spawn(width, height),
		pace: 0.3 + Math.pow(Math.random(), 2.2) * 1.8,
		dirX: 1,
		dirY: 0,
		chase: 8,
		breadth: 0.5,
		soft: 0,
		boost: 0,
		age: 99,
		rise: 0.06,
		decay: 0.22,
		fling: 0,
		charge: 0,
		power: 0.5,
		streak: 0,
		depth: 0.5,
		hx: 0,
		hy: 0
	});

	return {
		draw(frame) {
			const { ctx, width: sw, height: sh, isPlaying, colorRgb, audio, progressSec } = frame;
			// freeze on pause: nothing below may advance (DESIGN-RULES §6)
			if (!isPlaying) return;

			const c = conduct(frame);
			const scale = c.scale;
			// V1 is the picture as it was: strokes on the screen itself, one blur, no light layers
			// V0 everything, V1 the classic look, V2 the light without what it says (stars and bloom only)
			const variant = getVariant() % 3;
			const classic = variant === 1;
			const rich = variant === 0;
			const width = sw;
			const height = sh;
			sized(fresh, sw, sh);
			fresh.x.clearRect(0, 0, sw, sh);
			const pctx = classic ? bloom.begin(sw, sh) : fresh.x;
			if (sized(trail, sw, sh)) {
				trail.x.fillStyle = "rgb(0, 0, 0)";
				trail.x.fillRect(0, 0, sw, sh);
			}
			const trailCtx = classic ? ctx : trail.x;
			fadeTrail(trailCtx, sw, sh, TRAIL_ALPHA);

			// populations by AREA, speeds by SIZE, against the canvas this was tuned on
			const dens = Math.min(MAX_DENSITY, (width * height) / (REF_W * REF_H));
			const pace = Math.min(sw, sh) / Math.min(REF_W, REF_H);
			// with a camera the near strokes are drawn bigger and some of them land off screen, so each
			// layer carries enough extra to look as full as it did (the square of its mean size)
			resizeToCount(ground, Math.round(GROUND_COUNT * dens * (rich ? 1.25 : 1)), () => spawn(width, height));
			resizeToCount(sheet, Math.round(SHEET_COUNT * dens * (rich ? 1.5 : 1)), () => spawn(width, height));
			resizeToCount(marks, Math.round(MARK_POOL * dens), () => spawnMark(width, height));

			// the music's own beat, which every time constant below is measured in
			const beat = audio?.tempo && audio.tempo > 40 ? 60 / audio.tempo : 0.5;

			slowBand += (c.loudness - slowBand) * Math.min(1, 0.1 * c.dt);

			// ---- the sky ------------------------------------------------------------------------------
			// How many marks can be seen is a slow musical statement, set by the background and nothing
			// else. Computed ONCE, here, and every loop over the marks reads this one number
			// (DESIGN-RULES §14). One slot at a time with a slot of deadband, so a count sitting on a
			// rounding boundary cannot blink a burning mark in and out.
			const skyTarget = Math.max(8, Math.min(marks.length, marks.length * (0.35 + slowBand * 0.75)));
			if (skySize === 0) skySize = Math.round(skyTarget);
			else if (skyTarget >= skySize + 1) skySize++;
			else if (skyTarget <= skySize - 1) skySize--;
			const inSky = Math.max(8, Math.min(marks.length, skySize));

			// the marks that are cutting through the field this frame, from where they were last frame
			// (~2.5 px of travel against a ~100 px reach - the staleness is invisible)
			const cutters: Mark[] = [];
			for (let i = 0; i < inSky; i++) if (marks[i].charge > 0.15) cutters.push(marks[i]);
			// outside the sky a mark goes dark on its own clock rather than freezing mid-burn (§5c)
			for (let i = inSky; i < marks.length; i++) {
				marks[i].age += c.dt;
				marks[i].charge = 0;
			}

			// ---- the brace and the release --------------------------------------------------------------
			// Into a moment the LIGHT goes down with the music and the SPEED winds up - darker and faster
			// on the way in, which is what a build-up is - and the release lets go. The two are in
			// different channels because in one channel they cancelled.
			//
			// The brace borrows `windup`'s span, because `anticipation` alone arrives at the same instant
			// as the release it is meant to make room for.
			const braceEarly = Math.max(c.anticipation, Math.min(1, c.windup * 0.8));
			// light may not rise before the event: `impact` carries a lead for geometry, not for alpha
			const releaseRaw = c.timeToImpact !== null && c.timeToImpact > 0 ? 0 : c.impact;
			flash += (releaseRaw - flash) * Math.min(1, (releaseRaw > flash ? 11 : 3) * c.dt);
			const release = flash;
			// follow the music down where it thins out, climb with it where it builds - measured per
			// moment from this track (runInDip/runInBuild), not assumed
			const runDip = Math.max(0.12, c.runInDip);
			const windUp = 1 + c.windup * (0.12 + c.runInBuild * 0.9);
			// a fill is a burst of transients; without this the marks' cut would light the sheet exactly
			// while it is supposed to be withdrawing
			const cutGate = 1 - braceEarly * 0.5;
			const dim = (1 - braceEarly * 0.42 * runDip) * (1 + release * 0.15);
			// on the way in the field goes laminar - gathering, stored energy. The release does NOT
			// throw it open: a rare event from a detector we do not trust may light the picture, never
			// move it
			const contraction = 1 - braceEarly * 0.55;

			// ---- the field's clocks ------------------------------------------------------------------------
			harm += (c.harmonicShift - harm) * Math.min(1, 6 * c.dt);
			fieldTime += (0.05 + c.brightness * 0.1) * c.dt;
			const shimmer = shimmerPhase(fieldTime);

			// ---- the sidechain ------------------------------------------------------------------------------
			// A hit does not get brighter; everything around it gets dimmer. Quick in, released over a
			// third of a second - the fastest of the couplings, because the marks are the fastest layer
			const duckTarget = Math.min(1, flare * (0.55 + c.attackSharpness * 0.5));
			duck += (duckTarget - duck) * Math.min(1, (duckTarget > duck ? 10 : 2.6) * c.dt);
			// the hue nudge rides the marks' own light, so colour and event share one clock
			const tintPulse = Math.min(1, flare * 1.1);

			// ---- the wind -----------------------------------------------------------------------------------
			// It wanders very slowly on its own; a real harmonic move unlocks its turn rate for a second
			// or two - the one moment a bass is obliged to move. Rare, large, slow.
			const groundWander = noise(fieldTime * 0.14, 11.3, 0) * Math.PI;
			const groundStep = (0.22 + harm * 1.5) * c.dt;
			groundAngle += Math.max(-groundStep, Math.min(groundStep, shortest(groundWander - groundAngle)));

			// ---- the sheet's lean -----------------------------------------------------------------------------
			// The chroma's tonal centre, as all twelve bands weighted by where they sit on the circle -
			// continuous, where an argmax would step and a capped chase after it would reverse four
			// times a second. Then drawn towards how much the harmony is moving.
			const bands = chroma(audio, progressSec, isPlaying, c.dt);
			let centre = 0;
			let weight = 0;
			for (let i = 0; i < 12; i++) {
				centre += bands[i] * Math.sin((i / 12) * Math.PI * 2);
				weight += bands[i];
			}
			// x2.5 because twelve real bands rarely concentrate past ~0.4
			let tiltTarget = Math.max(-1, Math.min(1, weight > 1e-6 ? (centre / weight) * 2.5 : 0)) * SHEET_TILT_MAX;
			tiltTarget +=
				(Math.max(-SHEET_TILT_MAX, Math.min(SHEET_TILT_MAX, (harm - 0.45) * 2.2)) - tiltTarget) *
				Math.min(1, 0.25 * c.dt);
			const tiltStep = 0.35 * c.dt;
			sheetTilt += Math.max(-tiltStep, Math.min(tiltStep, tiltTarget - sheetTilt));
			// the sheet is sampled in the GROUND's frame, leaned by the harmony: a note means something
			// different over a different bass, so its deviation from the ground is the information
			const sheetFrame = groundAngle + sheetTilt;

			// ---- colour ----------------------------------------------------------------------------------------
			// one family of hues; size and lightness do the separating. Tinted once a frame, not per stroke
			const base = albumHsl(colorRgb);
			base.h += keyHue(audio, progressSec, c.dt, rich);
			const tint = (rgb: Rgb, amount: number) => (diagnostic ? rgb : shimmerTint(rgb, shimmer, amount));
			const groundRgb = tint(diagnostic ? DIAGNOSTIC_RGB.ground : hslToRgb(base.h, base.s * 0.7, base.l * 0.62), tintPulse * 0.4);
			const sheetRgb = tint(diagnostic ? DIAGNOSTIC_RGB.sheet : hslToRgb(base.h + 0.06, base.s, base.l), tintPulse);
			const markRgb = tint(
				diagnostic
					? DIAGNOSTIC_RGB.marks
					: hslToRgb(base.h + 0.14, Math.min(1, base.s + 0.08), Math.min(0.78, base.l + 0.14)),
				tintPulse
			);

			// ---- what reaches a stroke from outside it ------------------------------------------------------
			// The CUT: how hard marks are passing through (x, y), and the summed heading of those that
			// are. Scalars and a heading only - never a direction relative to a mark's position, which
			// sweeps 180 degrees as the mark passes (DESIGN-RULES §1, fifth occurrence).
			// ---- the camera --------------------------------------------------------------------------------
			if (variant !== lastVariant) {
				lastVariant = variant;
				for (const list of [ground, sheet, marks]) for (const q of list) q.sx = NaN;
			}
			// the orbit: a steady turn, quicker when the music is loud, and a slow sway up and down
			camTime += c.dt;
			if (rich) camX += scale * (CAM_ORBIT_REST + c.loudness * CAM_ORBIT_LOUD) * c.dt;
			const camY = Math.sin(camTime * 0.17) * scale * CAM_SWAY;
			const wrapTo = (v: number, n: number) => ((v % n) + n) % n;
			// where a point of the volume lands on the screen, and how big it is there
			let px = 0;
			let py = 0;
			let pk = 1;
			const project = (x: number, y: number, z: number) => {
				const g = z - CAM_PIVOT;
				pk = 1 + z * CAM_NEAR;
				px = sw / 2 + (wrapTo(x + camX * g, width) - width / 2) * pk;
				py = sh / 2 + (wrapTo(y + camY * g, height) - height / 2) * pk;
			};
			// the volume wraps, so a stroke that would cross the whole screen is two strokes
			const seam = Math.min(sw, sh) * 0.3;
			const pad = scale * 0.05;
			const wakeGain = rich ? WAKE_GAIN : 1;

			const cutRadius = scale * CUT_RADIUS * wakeGain;
			let cutX = 0;
			let cutY = 0;
			let cutW = 0;
			const cutAt = (x: number, y: number) => {
				cutW = 0;
				cutX = 0;
				cutY = 0;
				for (const m of cutters) {
					const dx = x - m.hx;
					const dy = y - m.hy;
					const d2 = dx * dx + dy * dy;
					if (d2 > cutRadius * cutRadius) continue;
					// a harder hit cuts a brighter line
					const force = m.charge * (0.45 + m.power * 0.85) * (1 - Math.sqrt(d2) / cutRadius);
					cutW += force;
					cutX += m.dirX * force;
					cutY += m.dirY * force;
				}
				cutW = Math.min(1, cutW);
				return cutW;
			};
			// the lit line lets go over a beat; the wake arrives in a third of one and lets go over two
			const cutFall = 1 / beat;
			const wakeRise = 1 / (0.3 * beat);
			const wakeFall = 1 / (2.2 * beat);
			// THE HAND: a mark that does not die. Where the pointer has been, it lights, stirs and
			// hurries - the same three scalars a mark uses, and never a direction (DESIGN-RULES §1d).
			// The field reads the bar-long `baton`, the marks the beat-long `hand`, so one gesture stays
			// two things.
			const handField = (x: number, y: number) => c.trailAt(x, y) * (0.35 + c.baton * 0.65);
			const handMark = (x: number, y: number) => c.trailAt(x, y) * (0.35 + c.hand * 0.65);
			// A stroke is invisible before it respawns: a fade by DISTANCE to the edge, which can only
			// fall as a particle approaches it (a fade by life walked it over the peak of its bell)
			const edgeMargin = scale * 0.18;
			const edgeFade = (x: number, y: number) => {
				const d = Math.min(x, width - x, y, height - y);
				return d < edgeMargin ? Math.max(0, d / edgeMargin) : 1;
			};

			pctx.lineCap = "round";

			// ---- the ground and the sheet ---------------------------------------------------------------------
			// The same machine with different settings. Per stroke: sample the noise in the layer's
			// frame, widen it where a mark or the hand is working, turn into any wake under a rate cap,
			// hurry, and light by the background, the loudness and whatever is passing.
			const drawField = (
				target: CanvasRenderingContext2D,
				particles: Particle[],
				frameAngle: number,
				freqAlong: number,
				freqAcross: number,
				drift: number,
				spread: number,
				cutStir: number,
				handStir: number,
				speed: number,
				wakeHurry: number,
				handHurry: number,
				// the part of the light that is the same for every stroke this frame
				lightBase: number,
				lightBrightness: number,
				lightCut: number,
				lightHand: number,
				lightRing: number,
				// how deep the duck goes, and what multiplies the whole layer
				duckDepth: number,
				layerLight: number,
				alphaCap: number,
				lineWidth: number,
				rgb: Rgb,
				lifeRate: number,
				// where this layer sits in the depth of the volume
				zNear: number,
				zSpan: number
			) => {
				const fc = Math.cos(frameAngle);
				const fs = Math.sin(frameAngle);
				density.begin(width, height);
				for (const p of particles) density.add(p.x, p.y);

				for (const p of particles) {
					const along = (p.x * fc + p.y * fs) / scale;
					const across = (-p.x * fs + p.y * fc) / scale;
					// everything that reaches a stroke from outside is looked up where the stroke is SEEN
					const qx = p.sx === p.sx ? p.sx : p.x;
					const qy = p.sx === p.sx ? p.sy : p.y;
					const cutNow = cutAt(qx, qy);
					// up in a twelfth of a second - a mark crosses its own reach in a fraction of one
					p.lit += (cutNow - p.lit) * Math.min(1, (cutNow > p.lit ? 12 : cutFall) * c.dt);
					const cut = p.lit;
					const hand = handField(qx, qy);
					const ring = c.rippleAt(qx, qy);
					// turbulence is an AMPLITUDE on the noise already there - it cannot aim anything
					const deviation =
						noise(along * freqAlong, across * freqAcross, fieldTime * drift) *
						(spread + cut * cutGate * cutStir * wakeGain + hand * handStir);
					// both components on one clock, or the stored vector rotates while it converges
					const wakeStep = Math.min(1, (cutW > 0 ? wakeRise : wakeFall) * c.dt);
					p.wx += (cutX - p.wx) * wakeStep;
					p.wy += (cutY - p.wy) * wakeStep;
					const wake = Math.min(1, Math.hypot(p.wx, p.wy));
					const wanted = wake > 0.02 ? shortest(Math.atan2(p.wy, p.wx) - (frameAngle + deviation)) * wake * WAKE_TURN * wakeGain : 0;
					const step = WAKE_RATE * c.dt;
					p.turn += Math.max(-step, Math.min(step, wanted - p.turn));
					const angle = frameAngle + deviation + p.turn;

					const v = speed * (1 + wake * WAKE_HURRY * wakeGain * wakeHurry + hand * handHurry);
					const nx = p.x + Math.cos(angle) * v * c.dt;
					const ny = p.y + Math.sin(angle) * v * c.dt;

					// the lit line is exempt from the duck: everything around a mark ducks, the line it
					// cuts does not - a highlight is contrast, not magnitude (DESIGN-RULES §3b)
					const lineCut = cut * cutGate;
					const alpha = Math.min(
						alphaCap,
						Math.max(
							0,
							(lightBase +
								p.brightness * lightBrightness +
								density.at(p.x, p.y) * 0.1 +
								lineCut * lightCut * wakeGain +
								hand * lightHand +
								ring * lightRing) *
								Math.sin(p.life * Math.PI) *
								edgeFade(p.x, p.y) *
								(1 - duck * duckDepth * (1 - lineCut)) *
								layerLight *
								0.72
						)
					);
					if (rich) {
						project(nx, ny, zNear + p.z * zSpan);
						const joined = p.sx === p.sx && Math.abs(px - p.sx) < seam && Math.abs(py - p.sy) < seam;
						// off screen it still moves, it just is not drawn
						if (joined && px > -pad && px < sw + pad && py > -pad && py < sh + pad) {
							target.beginPath();
							target.moveTo(p.sx, p.sy);
							target.lineTo(px, py);
							target.lineWidth = lineWidth * pk;
							target.strokeStyle = rgbString(rgb, alpha);
							target.stroke();
						}
						p.sx = px;
						p.sy = py;
					} else {
						target.beginPath();
						target.moveTo(p.x, p.y);
						target.lineTo(nx, ny);
						target.lineWidth = lineWidth;
						target.strokeStyle = rgbString(rgb, alpha);
						target.stroke();
						p.sx = nx;
						p.sy = ny;
					}

					p.x = nx;
					p.y = ny;
					p.life -= c.dt * lifeRate;
					if (p.life <= 0 || p.x < 0 || p.x > width || p.y < 0 || p.y > height) Object.assign(p, spawn(width, height));
				}
			};

			// THE GROUND. Deaf to anything beat-crisp: big slow eddies, wide near-transparent strokes.
			// Speed opens DOWNWARD from a fixed top, so a quiet passage is genuinely slower (§13).
			drawField(
				pctx,
				ground,
				groundAngle,
				0.6,
				0.9,
				0.35,
				Math.max(0.08, (0.2 + slowBand * 0.5) * contraction),
				0.3,
				0.95,
				(8 + c.loudness * 95) * windUp * pace,
				1,
				0.7,
				0.3 + slowBand * 0.28 + c.loudness * 0.5 + release * 0.03,
				0.14,
				0.55,
				1.2,
				1.0,
				0.55,
				dim * (1 - release * 0.1),
				GROUND_ALPHA_CAP,
				Math.max(0.8, scale * 0.0027 * (0.75 + slowBand * 0.45 + c.loudness * 0.2) * (1 + release * 0.15)),
				groundRgb,
				0.12, // ~8 s
				0,
				0.5 // the far half
			);

			// THE SHEET. Hairlines with real trails; opens up as the harmony moves, draws in on a brace.
			const spreadTarget = Math.max(0.05, 0.34 + c.loudness * 0.24 + harm * 0.75);
			sheetSpread += (spreadTarget - sheetSpread) * Math.min(1, 2.2 * c.dt);
			drawField(
				pctx,
				sheet,
				sheetFrame,
				1.2,
				1.6,
				1,
				Math.max(0.04, sheetSpread * (1 - braceEarly * 0.35)),
				0.18,
				0.7,
				(10 + c.loudness * 185) * windUp * pace,
				1.3,
				0.9,
				0.22 + c.loudness * 0.45 + slowBand * 0.26 + harm * 0.21 + release * 0.06,
				0.17,
				0.6,
				1.25,
				1.05,
				0.3,
				dim,
				SHEET_ALPHA_CAP,
				Math.max(0.6, scale * 0.0016 * (0.8 + c.loudness * 0.35 + c.brightness * 0.4) * (1 + release * 0.15)),
				sheetRgb,
				0.33, // ~3 s
				0.2,
				0.6 // the middle
			);

			// ---- the next sound -------------------------------------------------------------------------------
			// the one ABOUT to happen, with its measured shape - see next-sound.ts
			const sound = nextSound(audio, progressSec, beat, c.energy);
			const hitAmp = sound.amp;
			const ringing = sound.ringing;
			const hitRise = sound.rise;
			const hitDecay = sound.decay;
			const hitSharp = sound.sharp;
			const breadth = sound.breadth;
			// only a crack is thrown
			const hitFling = FLING * (0.35 + hitSharp * hitSharp * 0.65) * (0.5 + breadth * 0.8);

			// ---- where a mark is born ----------------------------------------------------------------------
			// ACROSS the wind, by how ringing the sound was. Along the wind the drift would wipe the
			// reading within a second; across it, the drift runs parallel and never changes it.
			const acrossX = -Math.sin(groundAngle);
			const acrossY = Math.cos(groundAngle);
			const alongX = Math.cos(groundAngle);
			const alongY = Math.sin(groundAngle);
			const acrossReach = Math.min(width, height) * 0.46;
			const alongReach = Math.hypot(width, height) * 0.5;
			// `spread` is how far off its own place a mark may land: a hard mapping draws a chart
			const placeMark = (m: Mark, at: number, spread: number) => {
				const a = (Math.max(0, Math.min(1, at + (Math.random() - 0.5) * spread)) - 0.5) * 2;
				const along = (Math.random() - 0.5) * 2;
				m.x = Math.max(2, Math.min(width - 2, width / 2 + acrossX * a * acrossReach + alongX * along * alongReach));
				m.y = Math.max(2, Math.min(height - 2, height / 2 + acrossY * a * acrossReach + alongY * along * alongReach));
				// with a camera that place is on the SCREEN: undo the projection for this mark's depth
				if (rich) {
					const g = m.depth - CAM_PIVOT;
					const k = 1 + m.depth * CAM_NEAR;
					m.x = wrapTo((m.x - sw / 2) / k + width / 2 - camX * g, width);
					m.y = wrapTo((m.y - sh / 2) / k + height / 2 - camY * g, height);
				}
				m.sx = NaN;
			};

			const standout = sound.standout;

			// ---- lighting a mark ------------------------------------------------------------------------------
			// Written only while it is dark: its light starts at zero and rises through a smoothstep, so
			// nothing visible ever changes speed. Nothing is born from a click - only the music lights.
			const ignite = (m: Mark, lit: number, wanted: number) => {
				m.streak = lit === 0 && standout ? 1 : 0;
				// a burst spread over a few dozen milliseconds is a sound with a body, not a flashbulb
				m.age = -lit * 0.014;
				m.rise = hitRise * (0.85 + Math.random() * 0.35);
				m.decay = hitDecay * (0.8 + Math.random() * 0.5) * (m.streak > 0 ? 1.6 : 1);
				m.fling = hitFling * (m.streak > 0 ? FLING_RANK / FLING : 1);
				m.chase = 0.9 / Math.max(0.08, m.rise);
				m.power = Math.min(1, hitAmp) * (0.7 + Math.random() * 0.45);
				m.breadth = breadth * (0.8 + Math.random() * 0.4);
				m.soft = 1 - hitSharp;
				// A few RUN, and always down the middle of the axis - a lane the eye can learn. Everything
				// taking off at once is one object moving, with nothing to read it against; the slow ones
				// are the reference the runners are read against.
				const runner = Math.random() < 0.1;
				const r = Math.random();
				// the faster of a sound's marks are the nearer ones
				m.depth = runner ? 1 : 0.15 + r * 0.7;
				placeMark(m, runner ? 0.5 : ringing, runner ? 0.3 : 0.2 + Math.min(0.45, wanted * 0.008));
				// the floor sits near the sheet's own speed: a mark slower than the ground is not a mark
				m.pace = (0.95 + hitSharp * hitSharp * 1.55) * (0.8 + r * 0.45) * (runner ? 1.5 : 0.88);
				if (runner) {
					m.fling *= 1.8;
					m.chase = 3.6;
				}
			};

			// EVERY NEW SOUND IS AN EVENT - a segment start, fired `lead` early, once per sound. A drop is
			// nothing but a big one: we cannot find drops reliably, and a spectacular effect on an
			// unreliable trigger is spectacularly wrong whenever the trigger is.
			if (sound.fired) {
				// how big the sound was, times where the song is - the same hit is an event in a verse and
				// a detail in a chorus
				const grandeur = 1.2 + Math.min(1.4, hitAmp) * 3.2 + breadth * 2.8 + release * 3;
				const wanted = Math.max(2, Math.round(grandeur * (0.5 + slowBand * 1.5)));
				let lit = 0;
				for (let tries = 0; tries < inSky && lit < wanted; tries++) {
					const m = marks[cursor++ % inSky];
					if (m.age <= m.rise + m.decay * 0.6) continue;
					ignite(m, lit, wanted);
					lit++;
				}
			}

			// ---- the marks ----------------------------------------------------------------------------------------
			// The background sets how many marks there are and how wide; it may not also halve how bright
			// each is, or a quiet track loses its events twice over.
			const sectionPower = 0.78 + slowBand * 0.45;
			const markSpread = MARK_SPREAD_MAX * contraction;
			const markSpeed = MARK_BASE_SPEED * (0.3 + c.loudness * 1.2) * windUp * pace;
			const markWidthBand = 0.7 + slowBand * 0.6;
			let flareNow = 0;
			// where the burning marks' heads are this frame, for the stars (V0)
			const heads: Mark[] = [];
			density.begin(width, height);
			for (let i = 0; i < inSky; i++) density.add(marks[i].x, marks[i].y);

			for (let i = 0; i < inSky; i++) {
				const m = marks[i];
				const hand = handMark(m.hx, m.hy);
				const ring = c.rippleAt(m.hx, m.hy);
				const angle = groundAngle + noise((m.x / scale) * 2, (m.y / scale) * 2, fieldTime * 2.2) * markSpread;

				// the envelope is a function of age, with the sound's own rise and decay - nothing chases
				// a pulse, so nothing depends on the frame rate
				m.age += c.dt;
				m.charge =
					m.age <= 0
						? 0
						: m.age < m.rise
							? smoothstep(m.age / m.rise)
							: m.age > m.rise + m.decay * 6
								? 0
								: Math.exp(-(m.age - m.rise) / m.decay);

				// the throw is chased, never assigned, as quickly as the sound itself arrived
				const boostTarget = Math.min(1, m.charge) * m.fling;
				m.boost += (boostTarget - m.boost) * Math.min(1, (boostTarget > m.boost ? m.chase : m.chase * 0.4) * c.dt);

				// A mark travels at its own pace all its life - falling stars are what this layer is made
				// of, and a hit only LIGHTS one. The hit lives in light and width, which may be sharp.
				const speed = markSpeed * m.pace * (1 + m.boost + hand * 1.0 + ring * 0.7);
				const nx = m.x + Math.cos(angle) * speed * c.dt;
				const ny = m.y + Math.sin(angle) * speed * c.dt;
				m.dirX = Math.cos(angle);
				m.dirY = Math.sin(angle);

				if (m.charge > 0.02) {
					const alpha = Math.min(
						MARK_ALPHA_CAP,
						Math.max(
							0,
							m.charge *
								(0.8 + m.power * 1.3) *
								sectionPower *
								(0.62 + m.brightness * 0.55 + density.at(m.x, m.y) * 0.25 + hand * 2.0 + ring * 1.6)
						)
					);
					// the tail is where the mark has actually been - one segment a frame on the trail canvas
					pctx.beginPath();
					if (rich) {
						project(nx, ny, m.depth);
						const joined = m.sx === m.sx && Math.abs(px - m.sx) < seam && Math.abs(py - m.sy) < seam;
						pctx.moveTo(joined ? m.sx : px, joined ? m.sy : py);
						pctx.lineTo(px, py);
					} else {
						pctx.moveTo(m.x, m.y);
						pctx.lineTo(nx, ny);
					}
					// depth (V0): a far mark is fainter and finer, a near one fuller
					const near = rich ? m.depth : 0.5;
					pctx.strokeStyle = rgbString(markRgb, rich ? Math.min(MARK_ALPHA_CAP, alpha * (0.6 + near * 0.6)) : alpha);
					// one channel each: length is the pace, brightness the loudness, width the breadth
					pctx.lineWidth = Math.max(
						0.8,
						scale * 0.0016 * (0.5 + m.breadth * 1.0 + m.soft * 0.75 + m.charge * 0.6) * markWidthBand * (rich ? (0.6 + near * 0.8) * pk : 1)
					);
					pctx.stroke();
				}

				if (m.charge > flareNow) flareNow = m.charge;
				if (m.charge > 0.04) heads.push(m);

				m.x = nx;
				m.y = ny;
				// recycled on a slow ~14 s clock as well as at the edges, or the population queues up at
				// the downwind edge; only ever while dark, so the teleport is never seen
				m.life -= c.dt * 0.07;
				// leaving, it re-enters at the opposite edge by exactly its overshoot, still burning
				if (m.x < 0) m.x += width;
				else if (m.x > width) m.x -= width;
				if (m.y < 0) m.y += height;
				else if (m.y > height) m.y -= height;
				// where its head is on screen now; a mark that just wrapped starts a new tail there
				if (rich) project(m.x, m.y, m.depth);
				else {
					px = m.x;
					py = m.y;
				}
				m.sx = px;
				m.sy = py;
				m.hx = px;
				m.hy = py;
				if (m.charge <= 0.02 && m.life <= 0) Object.assign(m, spawnMark(width, height));
			}

			flare = flareNow;
			if (classic) {
				bloom.flush(frame, c, BLOOM_SCALE);
				return;
			}

			// ---- THE LIGHT ------------------------------------------------------------------------------
			// the strokes go into the trail exactly as they always went onto the screen
			trail.x.drawImage(fresh.c, 0, 0);
			ctx.drawImage(trail.c, 0, 0);
			ctx.save();
			ctx.globalCompositeOperation = "lighter";

			const nw = Math.max(1, Math.ceil(sw / BLOOM_DIV));
			const nh = Math.max(1, Math.ceil(sh / BLOOM_DIV));

			// the bloom: only what is already bright (contrast is the bright-pass), at two sizes. The core
			// is steady; the halo is where an event and the drop are SEEN - it follows the marks' own
			// light and the release, the same two things that already carry the events
			sized(core, nw, nh);
			core.x.clearRect(0, 0, nw, nh);
			core.x.filter = `contrast(1.8) brightness(1.3) blur(${Math.max(1, (scale * 0.006) / BLOOM_DIV)}px)`;
			core.x.drawImage(trail.c, 0, 0, nw, nh);
			core.x.filter = "none";
			ctx.globalAlpha = 0.8;
			ctx.drawImage(core.c, 0, 0, sw, sh);
			const hw = Math.max(1, Math.ceil(sw / HALO_DIV));
			const hh = Math.max(1, Math.ceil(sh / HALO_DIV));
			sized(halo, hw, hh);
			halo.x.clearRect(0, 0, hw, hh);
			halo.x.filter = `blur(${Math.max(1, (scale * 0.03) / HALO_DIV)}px) brightness(2.2)`;
			halo.x.drawImage(core.c, 0, 0, hw, hh);
			halo.x.filter = "none";
			ctx.globalAlpha = Math.min(1, 0.45 + tintPulse * 0.35 + release * 0.9);
			ctx.drawImage(halo.c, 0, 0, sw, sh);

			// the stars: a head on every burning mark, as bright as its sound and as big as its hit
			const key = `${markRgb.r | 0},${markRgb.g | 0},${markRgb.b | 0}`;
			if (key !== starKey) {
				starKey = key;
				sized(star, 64, 64);
				star.x.clearRect(0, 0, 64, 64);
				const g = star.x.createRadialGradient(32, 32, 0, 32, 32, 32);
				g.addColorStop(0, "rgba(255, 255, 255, 1)");
				g.addColorStop(0.12, rgbString(markRgb, 0.9));
				g.addColorStop(0.4, rgbString(markRgb, 0.22));
				g.addColorStop(1, rgbString(markRgb, 0));
				star.x.fillStyle = g;
				star.x.fillRect(0, 0, 64, 64);
				// a voice's head: no white-hot core, a wider coloured glow
				sized(softStar, 64, 64);
				softStar.x.clearRect(0, 0, 64, 64);
				const sg = softStar.x.createRadialGradient(32, 32, 0, 32, 32, 32);
				sg.addColorStop(0, rgbString(markRgb, 0.75));
				sg.addColorStop(0.35, rgbString(markRgb, 0.3));
				sg.addColorStop(1, rgbString(markRgb, 0));
				softStar.x.fillStyle = sg;
				softStar.x.fillRect(0, 0, 64, 64);
			}
			for (const m of heads) {
				const near = rich ? m.depth : 0.5;
				const size = scale * (0.014 + m.power * 0.03) * (0.55 + m.charge * 0.45) * (rich ? 0.5 + near : 1);
				const light = Math.min(1, m.charge * (0.35 + m.power * 0.65) * sectionPower * (rich ? 0.6 + near * 0.6 : 1));
				// CHARACTER (V0): a broadband crack burns white-hot and tight, a voice glows soft and wide
				const hot = rich ? Math.max(0, Math.min(1, 0.35 + m.breadth * 0.9 - m.soft * 0.6)) : 1;
				if (hot > 0.02) {
					ctx.globalAlpha = light * hot;
					ctx.drawImage(star.c, m.hx - size / 2, m.hy - size / 2, size, size);
				}
				if (hot < 0.98) {
					const wide = size * 1.5;
					ctx.globalAlpha = light * (1 - hot);
					ctx.drawImage(softStar.c, m.hx - wide / 2, m.hy - wide / 2, wide, wide);
				}
			}

			ctx.restore();
		}
	};
}

export const layers3Preset: PresetDefinition = { id: "layers3", name: "Layers III", create };
