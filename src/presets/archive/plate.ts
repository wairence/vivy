// PLATE - Chladni figures. Sand on a vibrating plate collects where the plate is still.
//
// The physics is real and the formula is closed-form (Chladni 1787; the square-plate solution is
// the standard one): a mode (n, m) has the shape
//
//     cos(n·pi·x)·cos(m·pi·y) - cos(m·pi·x)·cos(n·pi·y)
//
// and a plate driven at a frequency rings in a sum of them. Sand on its surface is thrown where the
// plate moves and comes to rest where it does not, so the pattern that appears IS the nodal set of
// the sum - the places that are standing still.
//
// Why this preset exists: it answers the question Layers II admits it cannot. Register and harmony
// are the two things the analysis knows well and the other presets can only whisper - a mark's
// place on one axis, a hue shifted by a fraction. Here the HARMONY IS THE FIGURE. Twelve modes,
// one per pitch class, each one's amplitude the live energy of that class: a chord makes a shape,
// a chord change melts it and it re-forms as a different one, and none of that is a metaphor - it
// is the same mathematics in the plate and in the music.
//
// What the music does, one driver each (DESIGN-RULES §12):
//   - the FIGURE is the harmony: twelve chroma bands, twelve modes
//   - which modes carry the weight is the REGISTER: a dull passage rings in coarse modes, a bright
//     one in fine ones
//   - how hard the sand jumps is the LOUDNESS, and a hit is a shake rather than a new figure
//   - the brace calms the plate, so the lines go sharp before a drop; the release shakes it
//
// The rule this preset is built around, and the reason it can never produce the discontinuity that
// has cost this project six rounds: a particle's motion is the GRADIENT OF A SCALAR FIELD. There is
// no angle anywhere in it, so there is nothing that can wrap, flip or be blended across a branch
// cut (§1c). And the amplitudes are interpolated, never the mode numbers - an integer mode index
// would step, and a rate-capped chase after a stepping target is the bang-bang controller of §1c,
// measured in this project at 4.1 reversals a second.
import { createChromaTracker, fadeTrail } from "../effects";
import { albumHsl, createBloomLayer, createConductor, getVariant, hslToRgb, publishDiagnostics } from "../flowfield-common";
import { rankOf } from "../../audio-data";
import { Preset, PresetDefinition, rgbString } from "../types";

// The field is evaluated on a grid and the particles read it by interpolation - evaluating twelve
// modes per particle per frame is four times the work for a picture nobody can tell apart. 96 is
// where a nodal line is about a pixel wide at a full-screen canvas.
const GRID = 96;
// twelve modes, one per pitch class, ordered from coarse to fine. The pairs are the classical ones:
// (n, m) with n != m, because n == m gives a figure with no nodal structure at all
const MODES: [number, number][] = [
	[1, 2],
	[1, 3],
	[2, 3],
	[1, 4],
	[2, 4],
	[3, 4],
	[1, 5],
	[2, 5],
	[3, 5],
	[4, 5],
	[3, 6],
	[4, 6]
];

// THE GENERAL COMBINATION OF A DEGENERATE PAIR, not the antisymmetric one.
//
// (n, m) and (m, n) are the same frequency on a square plate, so what rings is any mixture of the
// two: A·cos(n pi x)cos(m pi y) + B·cos(m pi x)cos(n pi y). The textbook figure uses A = -B, and
// that combination is zero along x = y for EVERY mode - so the sand piled onto the same bright
// diagonal in every frame of every track, an artefact of the formula rather than anything the music
// did. Giving each mode its own fixed mixing angle removes the shared zero and gives the twelve
// figures twelve different characters, at no cost in continuity: the angles never change.
const MIX_COS: number[] = [];
const MIX_SIN: number[] = [];

type Variant = {
	name: string;
	count: number;
	// how fast the sand walks down the gradient, in fractions of the plate per second
	settle: number;
	// how hard it jumps where the plate is moving, at the reference loudness
	jitter: number;
	// the dot's size, as a fraction of the short side
	grain: number;
	alphaCap: number;
};

const VARIANTS: Variant[] = [
	// sand: many small grains, quick to settle, sharp lines
	{ name: "sand", count: 12000, settle: 0.9, jitter: 0.6, grain: 0.0022, alphaCap: 0.8 },
	// dust: fewer, larger, slower - the figure is suggested rather than drawn
	{ name: "dust", count: 5000, settle: 0.5, jitter: 0.9, grain: 0.0042, alphaCap: 0.7 },
	// iron filings: slow and heavy, so the plate has to work to move them and the figure lags the
	// harmony by a beat or two - which is a different musical statement, not a worse one
	{ name: "filings", count: 7000, settle: 1.6, jitter: 0.4, grain: 0.0028, alphaCap: 0.85 }
];

let diagnostic = false;
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
	window.addEventListener("flowfield-dev-toggle", (event: Event) => {
		if ((event as CustomEvent<string | null>).detail !== platePreset.id) return;
		diagnostic = !diagnostic;
		Spicetify.showNotification(diagnostic ? "Plate: the field itself, red where it rings" : "Plate: the sand again");
	});
}

function create(): Preset {
	const conduct = createConductor();
	const bloom = createBloomLayer();
	const chroma = createChromaTracker();

	// the field, and its absolute value's gradient, on the grid
	const field = new Float32Array(GRID * GRID);
	// THE PLATE ITSELF, DRAWN. Only the sand was on screen, and sand alone is a few curves of dots
	// with nothing to say where they came from - "I did not understand what you were going for" was
	// the exact verdict. A Chladni figure is sand ON something, and the something is a plate that is
	// visibly ringing: shown faintly, it turns the picture from an abstract scatter into an object
	// with a reason. It also fills the screen, which the sand by itself never will.
	let plateCanvas: HTMLCanvasElement | null = null;
	let plateImage: ImageData | null = null;
	// the previous frame's field, so the preset can report HOW MUCH THE FIGURE IS MOVING. This is the
	// channel this preset actually carries - its light barely varies and its motion is a settling,
	// while the thing that answers the music is the SHAPE - and a channel nobody measures is a
	// channel nobody can tell is broken (DESIGN-RULES §12)
	const lastField = new Float32Array(GRID * GRID);
	// one cosine table per mode index, so the field costs table lookups rather than trigonometry
	const maxIndex = MODES.reduce((mx, pair) => Math.max(mx, pair[0], pair[1]), 1);
	if (MIX_COS.length === 0)
		for (let k = 0; k < MODES.length; k++) {
			// spread around the circle, skipping the pure +-45 degrees that would restore the shared
			// diagonal; the offset is what makes each mode's figure its own
			const angle = Math.PI * (0.18 + (k / MODES.length) * 0.64);
			MIX_COS.push(Math.cos(angle));
			MIX_SIN.push(Math.sin(angle));
		}
	const cosTable: Float32Array[] = [];
	for (let n = 0; n <= maxIndex; n++) {
		const row = new Float32Array(GRID);
		for (let i = 0; i < GRID; i++) row[i] = Math.cos((n * Math.PI * i) / (GRID - 1));
		cosTable.push(row);
	}

	let xs = new Float32Array(0);
	let ys = new Float32Array(0);
	let seeds = new Float32Array(0);
	// the amplitudes actually in use, eased - the chroma is already smooth, but the register weight
	// that multiplies it is not, and this is the amplitude of a geometry
	const amps = new Float32Array(MODES.length);
	let harm = 0;
	let flash = 0;
	// where on the coarse-to-fine axis the plate is currently ringing. State, not a fresh reading:
	// the figure is a thing that holds until the harmony asks it to change
	let axis = 0.5;
	// the chroma's tonal centre, kept as a vector so it is never blended as an angle
	let smoothX = 0;
	let smoothY = 0;
	// how ringing the music has been lately, rather than how ringing the last segment was
	let ring = 0.5;
	// THE STRUCK PLATE. Everybody has seen the video: the tone changes, the sand LEAPS and re-forms.
	// That leap is the whole legibility of the thing and it was missing - the sand only ever jittered
	// in place, so nothing on screen ever happened at the moment a sound did. Rises on the frame of a
	// hit and falls over about a beat, which is what a plate being struck does.
	let shake = 0;
	let clock = 0;

	return {
		draw(frame) {
			const { ctx, width, height, isPlaying, colorRgb, audio, progressSec } = frame;
			if (!isPlaying) return;

			const c = conduct(frame);
			const v = VARIANTS[getVariant() % VARIANTS.length];
			const scale = c.scale;
			const beat = audio?.tempo && audio.tempo > 40 ? 60 / audio.tempo : 0.5;
			clock += c.dt;
			harm += (c.harmonicShift - harm) * Math.min(1, 6 * c.dt);
			flash += ((c.timeToImpact !== null && c.timeToImpact > 0 ? 0 : c.impact) - flash) * Math.min(1, (c.impact > flash ? 11 : 3) * c.dt);

			if (xs.length !== v.count) {
				xs = new Float32Array(v.count);
				ys = new Float32Array(v.count);
				seeds = new Float32Array(v.count);
				for (let i = 0; i < v.count; i++) {
					xs[i] = Math.random();
					ys[i] = Math.random();
					seeds[i] = Math.random();
				}
			}

			// ---- the harmony, as the shape of the plate -----------------------------------------------
			// Twelve bands in, twelve amplitudes out. The bands are already eased (and, since
			// 2026-09-16, eased in SECONDS rather than in frames); this eases the product with the
			// register weight on top, because that product is the amplitude of a geometry and a step
			// in it moves every grain at once.
			const bands = chroma(audio, progressSec, isPlaying, c.dt);
			// WHICH MODES RING is the register: a dull sound is a coarse figure, a ringing one a fine
			// figure. `rankOf` against this track's own segments, so it means the same on every track.
			// EASED. `rankOf` of a segment's timbre is a per-SEGMENT quantity, which means it jumps
			// several times a second across the whole 0..1 range - an envelope, not a level (§5a). Fed
			// straight into the axis it was the thing actually moving the figure: measured, the axis
			// target travelled a quarter of the ring EVERY SECOND whether the harmony had moved or
			// not, and the chord changes this preset is built around could not be seen in it at all.
			const ringNow = c.segment && audio ? rankOf(audio.timbreSorted, c.segment.timbre[1]) : 0.5;
			ring += (ringNow - ring) * Math.min(1, 0.8 * c.dt);
			// THE CHORD PICKS A PLACE ON THE AXIS, rather than lighting all twelve modes at once.
			//
			// Twelve independent amplitudes is the obvious reading of "twelve modes, one per pitch
			// class", and it was the first one built. It does not produce a FIGURE: the nodal set of a
			// flat sum of six or seven modes is a scatter of unrelated curves, because a generic
			// superposition has a generic zero set. A Chladni figure - the thing worth putting on
			// screen - is what one or two modes give.
			//
			// So the chroma's own tonal centre chooses where on the coarse-to-fine axis the plate
			// rings, and how concentrated the chroma is chooses how narrow that is: a single held note
			// gives one clean mode, a spread chord rings two or three together and the figure is
			// correspondingly busier. The centre is the circular mean over all twelve classes - the
			// same continuous statistic Layers II uses for its lean, and for the same reason: an
			// argmax steps and a step here is every grain moving at once (§1c).
			let rawX = 0;
			let rawY = 0;
			let total = 0;
			for (let k = 0; k < 12; k++) {
				const b = Math.max(0, bands[k]);
				rawX += b * Math.cos((k / 12) * Math.PI * 2);
				rawY += b * Math.sin((k / 12) * Math.PI * 2);
				total += b;
			}
			// EASED AS A VECTOR, never as an angle (§1c). And the reason it has to be eased at all is
			// worth keeping: the angle of a weak resultant is noise. Measured, the raw centre covered
			// the entire ring over one track and moved a quarter of it in ANY given second - during a
			// chord change and during a held chord alike - so the figure it was supposed to shape had
			// nothing stable to sit on. A twelve-band chroma that is nearly flat has no tonal centre,
			// and asking for one anyway gets an answer that means nothing.
			smoothX += (rawX / Math.max(1e-6, total) - smoothX) * Math.min(1, 1.2 * c.dt);
			smoothY += (rawY / Math.max(1e-6, total) - smoothY) * Math.min(1, 1.2 * c.dt);
			const centre = (Math.atan2(smoothY, smoothX) / (Math.PI * 2) + 1) % 1;
			// how sure that centre is: the length of the same vector. A concentrated chroma - a clear
			// chord - is near 1; a flat one is near 0, and then the harmony has no say at all
			const concentration = Math.min(1, Math.hypot(smoothX, smoothY) * 2.6);
			// the register decides how fine the figure is; the harmony decides which of the modes
			// AROUND that fineness are the ones ringing
			// A RATE CAP, UNLOCKED BY THE HARMONY. The axis used to chase its target continuously, and
			// measured, that made the preset's central claim false: the figure moved x1.01 in the
			// second after a chord change, which is to say it was already moving all the time and a
			// chord change was not an event in it at all. The chroma jitters; a continuous chase turns
			// that jitter into a permanent slow morph that swamps the thing worth seeing.
			//
			// So the plate holds its figure and re-tunes when the harmony actually moves - rare,
			// large, slow, which is the shape §11 gives a structural coupling, and the same mechanism
			// that unlocks the ground's turn rate in Layers II. Wrapped, because the axis is a ring.
			// TRUSTED IN PROPORTION TO ITS OWN CONFIDENCE. When the chroma has a real centre the harmony
			// places the figure; when it does not, the register does, which is a statistic that is
			// always well defined. The same gate `gustCoherence` exists for on the input side.
			const say = 0.75 * concentration;
			const axisTarget = Math.max(0, Math.min(1, ring * (1 - say) + centre * say));
			let axisDiff = axisTarget - axis;
			if (axisDiff > 0.5) axisDiff -= 1;
			else if (axisDiff < -0.5) axisDiff += 1;
			const axisStep = (0.012 + harm * 0.95) * c.dt;
			axis = (axis + Math.max(-axisStep, Math.min(axisStep, axisDiff)) + 1) % 1;
			const window = 0.06 + (1 - concentration) * 0.16;
			let sum = 0;
			for (let k = 0; k < MODES.length; k++) {
				const fineness = k / (MODES.length - 1);
				// wrapped, so the axis is a ring rather than a line - a harmony that walks off one end
				// comes back at the other instead of piling up against a wall
				let d = Math.abs(fineness - axis);
				if (d > 0.5) d = 1 - d;
				const target = Math.exp(-(d * d) / (2 * window * window)) * (0.35 + Math.max(0, bands[k]) * 0.9);
				amps[k] += (target - amps[k]) * Math.min(1, 1.6 * c.dt);
				sum += Math.abs(amps[k]);
			}
			// normalised, so the plate's own scale does not drift with how many pitch classes happen
			// to be sounding - the FIGURE is the information, not its amplitude
			const norm = 1 / Math.max(0.05, sum);

			// ---- the field ----------------------------------------------------------------------------
			for (let j = 0; j < GRID; j++) {
				for (let i = 0; i < GRID; i++) {
					let s = 0;
					for (let k = 0; k < MODES.length; k++) {
						const a = amps[k];
						if (a < 0.004) continue;
						const n = MODES[k][0];
						const m = MODES[k][1];
						s += a * (MIX_COS[k] * cosTable[n][i] * cosTable[m][j] + MIX_SIN[k] * cosTable[m][i] * cosTable[n][j]);
					}
					field[i + j * GRID] = s * norm;
				}
			}

			let figureChange = 0;
			for (let i = 0; i < field.length; i++) {
				figureChange += Math.abs(field[i] - lastField[i]);
				lastField[i] = field[i];
			}
			figureChange /= field.length;

			// ---- how hard the plate is being driven ---------------------------------------------------
			// The loudness, and a hit is a SHAKE rather than a new figure: the pattern is the harmony,
			// and what an event does is make the sand jump. The brace calms the plate - which sharpens
			// the lines instead of dimming them, a withdrawal that costs no light (§11) - and the
			// release shakes it.
			const braceEarly = Math.max(c.anticipation, Math.min(1, c.windup * 0.8));
			// the strike is a one-frame event; the shake is what it leaves behind. Up at once, down over
			// a beat of this track - the same asymmetry every event in this project has.
			// THE HIT'S OWN SIZE, not the passage's level. Gated by the loudness it came out at 0.148
			// on a quiet stretch - a shake of a seventh of nothing - because the level is already in
			// the base term below and multiplying by it twice is the compounding of §13 with the
			// event channel as its victim. A quiet passage should still JUMP on its own kick.
			const struck = Math.max(c.strike, c.pop * 0.7);
			shake += (struck - shake) * Math.min(1, (struck > shake ? 26 : 1 / (beat * 0.9)) * c.dt);
			const drive = (0.25 + c.loudness * 1.25) * (1 - braceEarly * 0.55) * (1 + flash * 0.8) * (1 + shake * 5);
			const settle = v.settle * (1 + braceEarly * 0.5);

			const px = (x: number) => x * width;
			const py = (y: number) => y * height;
			const sampleField = (x: number, y: number) => {
				const fx = Math.max(0, Math.min(GRID - 1.001, x * (GRID - 1)));
				const fy = Math.max(0, Math.min(GRID - 1.001, y * (GRID - 1)));
				const i0 = Math.floor(fx);
				const j0 = Math.floor(fy);
				const tx = fx - i0;
				const ty = fy - j0;
				const a = field[i0 + j0 * GRID];
				const b = field[i0 + 1 + j0 * GRID];
				const cc = field[i0 + (j0 + 1) * GRID];
				const d = field[i0 + 1 + (j0 + 1) * GRID];
				return (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + d * tx) * ty;
			};

			fadeTrail(ctx, width, height, 1);
			const pctx = bloom.begin(width, height);
			const base = albumHsl(colorRgb);
			const still = hslToRgb(base.h, base.s * 0.9, Math.min(0.8, base.l + 0.14));
			// A GRAIN IN THE AIR IS THE EVENT, so it is the bright one. The first version gave the
			// light to stillness, which is true of a photograph and wrong for something being watched:
			// the moment worth seeing is the sand leaving the lines, and it was the dimmest thing on
			// screen exactly while it happened.
			const moving = hslToRgb(base.h + 0.16, Math.min(1, base.s + 0.1), 0.7);
			// the plate's own colour: the album's, dark, so the sand sits on it rather than in it
			const plateRgb = hslToRgb(base.h + 0.46, base.s * 0.34, 0.3);

			// the plate, behind everything: |S| as a wash, so the standing wave is a thing you can see
			// rather than a thing the sand implies. Brightest where the plate moves most, black along
			// the nodal lines - which is exactly where the sand then piles up, and that coincidence is
			// the whole picture explaining itself.
			if (!plateCanvas || plateCanvas.width !== GRID || plateCanvas.height !== GRID) {
				plateCanvas = document.createElement("canvas");
				plateCanvas.width = GRID;
				plateCanvas.height = GRID;
				plateImage = plateCanvas.getContext("2d")!.createImageData(GRID, GRID);
			}
			{
				const px2 = plateImage!.data;
				// how hard it is ringing: the same drive the sand feels, so the wash and the jumping
				// are one event rather than two
				// A HINT, not the subject. At (0.1 + drive*0.5) the plate came out as bright wallpaper
				// with the sand as a thin outline on it - the background had taken the picture over,
				// which is the opposite of the fault it was added to fix. It only has to say "there is
				// something here that is ringing".
				const wash = (0.03 + drive * 0.14) * (1 + shake * 1.8);
				for (let i = 0; i < GRID * GRID; i++) {
					const a = Math.min(1, Math.abs(field[i]) * 5.5) * wash;
					const o = i * 4;
					px2[o] = plateRgb.r * a;
					px2[o + 1] = plateRgb.g * a;
					px2[o + 2] = plateRgb.b * a;
					px2[o + 3] = 255;
				}
				const bctx = plateCanvas!.getContext("2d")!;
				bctx.putImageData(plateImage!, 0, 0);
				pctx.imageSmoothingEnabled = true;
				pctx.drawImage(plateCanvas!, 0, 0, width, height);
			}

			if (diagnostic) {
				// the field itself, so a figure can be checked against the harmony that is supposed to
				// be making it
				const cell = Math.max(1, Math.ceil(Math.min(width, height) / GRID));
				for (let j = 0; j < GRID; j++)
					for (let i = 0; i < GRID; i++) {
						const s = field[i + j * GRID];
						pctx.fillStyle = `rgba(${Math.round(Math.min(255, Math.abs(s) * 900))}, ${Math.round(Math.max(0, 120 - Math.abs(s) * 600))}, 60, 0.9)`;
						pctx.fillRect((i / GRID) * width, (j / GRID) * height, cell, cell);
					}
				bloom.flush(frame, c, 0.01);
				publishDiagnostics("plate", { drive, norm, ring, figureChange });
				return;
			}

			// ---- the sand -------------------------------------------------------------------------------
			// Down the gradient of |S|, which is the one motion this preset has. A grain moves towards
			// stillness and jumps where the plate is loud, and both of those are the physics rather
			// than a decoration: sand on a plate really does migrate from the antinodes to the nodes,
			// and that migration IS the figure appearing.
			const h = 1 / (GRID - 1);
			const grain = Math.max(1, scale * v.grain);
			let onLine = 0;
			let maxStep = 0;
			for (let i = 0; i < v.count; i++) {
				const x = xs[i];
				const y = ys[i];
				const s = Math.abs(sampleField(x, y));
				// central differences of |S|, so the step is towards where the plate is stiller
				const gx = (Math.abs(sampleField(x + h, y)) - Math.abs(sampleField(x - h, y))) / (2 * h);
				const gy = (Math.abs(sampleField(x, y + h)) - Math.abs(sampleField(x, y - h))) / (2 * h);
				// the jump: where the plate is moving hardest, a grain is thrown furthest. Deterministic
				// per grain and per frame rather than random, so a grain has a character instead of a
				// twitch - and so that two runs of the same passage are the same picture
				const phase = clock * (1.7 + seeds[i] * 2.3) + seeds[i] * 37;
				const jump = s * drive * v.jitter;
				let nx = x - gx * settle * c.dt * 0.02 + Math.cos(phase) * jump * c.dt;
				let ny = y - gy * settle * c.dt * 0.02 + Math.sin(phase * 1.3) * jump * c.dt;
				// the plate has edges, and sand that reaches one stays on it rather than vanishing
				if (nx < 0) nx = -nx;
				else if (nx > 1) nx = 2 - nx;
				if (ny < 0) ny = -ny;
				else if (ny > 1) ny = 2 - ny;
				const step = Math.abs(nx - x) + Math.abs(ny - y);
				if (step > maxStep) maxStep = step;
				xs[i] = nx;
				ys[i] = ny;
				if (s < 0.08) onLine++;

				// a grain sitting still is bright and takes the album's own colour; one being thrown
				// around is dimmer and cooler. Light comes from stillness, which is the opposite of
				// every other preset here and is what this material actually does
				// A GRAIN IN FLIGHT IS STILL A GRAIN. The first version gave stillness all of the light,
				// which is true of a photograph of a plate and wrong for a picture that is watched: a
				// figure re-forming after a chord change is sand IN MOTION, and it went invisible for
				// exactly as long as the interesting part lasted. Stillness still has most of it.
				const rest = Math.max(0, 1 - s * 7);
				const alpha = Math.min(v.alphaCap, 0.16 + rest * 0.5 + c.loudness * 0.3 * rest + flash * 0.1);
				const col = rest > 0.5 ? still : moving;
				pctx.fillStyle = rgbString(col, alpha);
				pctx.fillRect(px(nx) - grain * 0.5, py(ny) - grain * 0.5, grain, grain);
			}

			bloom.flush(frame, c, 0.012);
			publishDiagnostics("plate", {
				drive,
				shake,
				norm,
				ring,
				axis,
				axisTarget,
				centre,
				concentration,
				ringEased: ring,
				figureChange,
				onLineShare: onLine / v.count,
				maxStep
			});
		}
	};
}

export const platePreset: PresetDefinition = { id: "plate", name: "Plate", create };
