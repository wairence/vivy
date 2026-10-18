// SMOKE - Jos Stam's Stable Fluids (1999 / "Real-Time Fluid Dynamics for Games", 2003), ported.
//
// DESIGN-RULES §8: port proven work, translate a real algorithm, do not improvise an original one.
// This is that algorithm, unchanged in its mathematics: advect the velocity field along itself,
// project it back to divergence-free, advect the dye along the result. Everything this project adds
// sits OUTSIDE the solver, in what pushes it.
//
// Why a fluid at all, when there are already two particle presets: a fluid has MOMENTUM and a
// memory of its own. A noise field's particle knows nothing except where the noise points this
// frame; a fluid carries what happened four bars ago through the room and mixes it. That is the one
// material this project does not have, and it is the material a sound actually behaves like.
//
// The shape of the music in it:
//   - every sound is a PUFF of dye and an IMPULSE of force, thrown in before the sound (§5b) at the
//     place on the register axis that sound occupies
//   - the wind's speed is the loudness and nothing else (§5a, §12)
//   - how much the smoke curls is how percussive the passage is
//   - the brace thins the room out; the release is one large injection, not a separate mechanism
//
// The hand may raise the curl where it has been, and nothing else. Injecting force along the
// pointer's movement is the most natural line of code to write in a fluid and it is exactly the
// failure §1b describes - raw input setting a direction - in the one medium that remembers it for
// seconds. It is not written here on purpose.
import { fadeTrail } from "../effects";
import { albumHsl, createBloomLayer, createConductor, getVariant, hslToRgb, publishDiagnostics } from "../flowfield-common";
import { createNoise3D } from "simplex-noise";
import { rankOf } from "../../audio-data";
import { Preset, PresetDefinition } from "../types";

// The grid. The cost of a frame is linear in cells and the Jacobi solve multiplies it by its
// iteration count, so this is the number the whole preset's budget hangs on - but 128 across was too
// coarse to hide: a dense plume showed its own cells through the upscale as visible blocks. 192 is
// where that stops at a full-screen canvas and a frame still costs about three milliseconds. Rows
// follow the canvas aspect so cells stay square - a stretched cell makes the smoke drift diagonally
// for no reason.
const GRID_X = 192;
const MIN_ROWS = 72;
const MAX_ROWS = 192;
// How hard the pressure solve works. Stam uses 20; below about 12 the field stays visibly
// divergent, which looks like the smoke breathing in and out of nowhere.
const JACOBI = 18;
// how sharply a puff is bounded, in cells - a gaussian, so it has no edge to see
const PUFF_CELLS = 7.5;

type Variant = {
	name: string;
	// how many cells across the picture the wind moves per second, at the reference loudness
	windFloor: number;
	windRange: number;
	// how much of the dye is gone after one beat: the room's own memory, in the music's units
	dyePerBeat: number;
	// how hard a sound is thrown into the room
	puffDye: number;
	puffForce: number;
	// the curl the vorticity term puts back. Stable Fluids is famous for eating small eddies on the
	// grid; vorticity confinement (Fedkiw et al. 2001) is the standard answer and this is it
	vorticity: number;
	// how bright the dye is when it is drawn
	gain: number;
	// how much the wind varies across the room, as a share of the wind's own speed. This is what
	// tears a plume into filaments; without it the smoke stays the round blob it was born as
	shear: number;
	// how much of the flash is left after one beat, and how bright it burns. This is the whole of
	// what "reacts to the music" means in a fluid: the dye says what the room HAS and the heat says
	// what just HAPPENED in it
	heatPerBeat: number;
	heatGain: number;
};

// A PUFF HAS TO CROSS THE ROOM BEFORE IT FADES, or the picture is a blob sitting where a sound
// happened and nothing else. The first numbers here gave a puff a half-life of about a beat against
// a wind of ten cells a second, so it travelled five per cent of the width in its whole life: three
// puffs on screen, all of them round, none of them going anywhere. The memory and the wind are one
// decision, not two - the product of the two is how far smoke gets, and that distance is the look.
const VARIANTS: Variant[] = [
	// a room. Slow wind, long memory: plumes that drift most of the way across before they thin out
	{ name: "room", windFloor: 5, windRange: 46, dyePerBeat: 0.8, puffDye: 0.34, puffForce: 26, vorticity: 9, gain: 5.2, shear: 0.25, heatPerBeat: 0.05, heatGain: 3.4 },
	// a draught. Faster and shorter: the smoke is pulled into streaks rather than clouds
	{ name: "draught", windFloor: 9, windRange: 80, dyePerBeat: 0.72, puffDye: 0.42, puffForce: 40, vorticity: 14, gain: 4.6, shear: 0.3, heatPerBeat: 0.035, heatGain: 3.8 },
	// still air. Almost no wind, so a sound's own impulse is the only thing that moves anything, and
	// what is on screen is the shape a room takes when nothing pushes it
	{ name: "still", windFloor: 1, windRange: 12, dyePerBeat: 0.9, puffDye: 0.26, puffForce: 52, vorticity: 18, gain: 6.0, shear: 0.2, heatPerBeat: 0.07, heatGain: 3.0 }
];

// ctrl+click: the three fields drawn separately, so a misbehaving one can be named rather than
// guessed at. Module scope for the same reason Layers II's is - create() reruns on every preset
// switch and an inner listener would leak a duplicate every time.
let diagnostic = false;
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
	window.addEventListener("flowfield-dev-toggle", (event: Event) => {
		if ((event as CustomEvent<string | null>).detail !== smokePreset.id) return;
		diagnostic = !diagnostic;
		Spicetify.showNotification(diagnostic ? "Smoke: red speed / green dye / blue curl" : "Smoke: album colour restored");
	});
}

function createFluid() {
	let nx = 0;
	let ny = 0;
	let w = 0; // row stride, nx + 2
	let cells = 0;
	let u = new Float32Array(0);
	let v = new Float32Array(0);
	let u0 = new Float32Array(0);
	let v0 = new Float32Array(0);
	let dye = new Float32Array(0);
	let dye0 = new Float32Array(0);
	// HEAT: the same fluid carrying a second thing, which lives for a fraction of a beat instead of
	// several of them. Dye is what the room HAS; heat is what just happened in it.
	let heat = new Float32Array(0);
	let heat0 = new Float32Array(0);
	let p = new Float32Array(0);
	let div = new Float32Array(0);
	let curl = new Float32Array(0);

	const resize = (gx: number, gy: number) => {
		nx = gx;
		ny = gy;
		w = nx + 2;
		cells = w * (ny + 2);
		u = new Float32Array(cells);
		v = new Float32Array(cells);
		u0 = new Float32Array(cells);
		v0 = new Float32Array(cells);
		dye = new Float32Array(cells);
		dye0 = new Float32Array(cells);
		heat = new Float32Array(cells);
		heat0 = new Float32Array(cells);
		p = new Float32Array(cells);
		div = new Float32Array(cells);
		curl = new Float32Array(cells);
	};

	// PERIODIC, and this is a measurement rather than a preference.
	//
	// Stam's boundary reflects at a wall, which piles smoke against the edge of the screen; the
	// obvious alternative is outflow, which lets it leave. Outflow was the first version and it put
	// a hole in the middle of the whole design: how long dye stays in the room then depends on how
	// far it has to travel to the nearest edge, which depends on where it was born and which way the
	// wind happens to be pointing - a slow wander with nothing musical in it. Measured, the light
	// swung 37 -> 89 -> 56 -> 103 between neighbouring phrases while the music moved by a tenth, and
	// it measured r 0.69 against the music no matter which of its two drivers was ablated. The room
	// was bright when the wind was pointing the long way across it.
	//
	// Wrapping removes the geometry from the answer entirely: every cell has the same residence
	// time, so what is in the room is what the music put there minus what has faded, and nothing
	// else. There is no visible seam, because the field is continuous across the join by
	// construction - the same reason a tiling noise has none.
	const bound = (field: Float32Array, _dyeLike: boolean) => {
		for (let j = 1; j <= ny; j++) {
			field[j * w] = field[nx + j * w];
			field[nx + 1 + j * w] = field[1 + j * w];
		}
		for (let i = 1; i <= nx; i++) {
			field[i] = field[i + ny * w];
			field[i + (ny + 1) * w] = field[i + w];
		}
		field[0] = field[nx + ny * w];
		field[nx + 1] = field[1 + ny * w];
		field[(ny + 1) * w] = field[nx + w];
		field[nx + 1 + (ny + 1) * w] = field[1 + w];
	};

	// semi-Lagrangian advection: look back along the velocity to where this cell's contents came
	// from, and interpolate. This is the step that makes the whole scheme unconditionally stable,
	// which is the entire reason this algorithm and not a spring lattice.
	const advect = (dst: Float32Array, src: Float32Array, dt: number, dyeLike: boolean) => {
		for (let j = 1; j <= ny; j++)
			for (let i = 1; i <= nx; i++) {
				const k = i + j * w;
				let x = i - dt * u[k];
				let y = j - dt * v[k];
				if (x < 0.5) x = 0.5;
				else if (x > nx + 0.5) x = nx + 0.5;
				if (y < 0.5) y = 0.5;
				else if (y > ny + 0.5) y = ny + 0.5;
				const i0 = Math.floor(x);
				const j0 = Math.floor(y);
				const s1 = x - i0;
				const s0 = 1 - s1;
				const t1 = y - j0;
				const t0 = 1 - t1;
				const a = i0 + j0 * w;
				dst[k] = s0 * (t0 * src[a] + t1 * src[a + w]) + s1 * (t0 * src[a + 1] + t1 * src[a + w + 1]);
			}
		bound(dst, dyeLike);
	};

	// the projection: subtract the gradient of the pressure that makes the field divergence-free.
	// Without it a fluid gains and loses matter from nothing and reads as boiling.
	const project = () => {
		for (let j = 1; j <= ny; j++)
			for (let i = 1; i <= nx; i++) {
				const k = i + j * w;
				div[k] = -0.5 * (u[k + 1] - u[k - 1] + v[k + w] - v[k - w]);
				p[k] = 0;
			}
		bound(div, false);
		bound(p, false);
		for (let n = 0; n < JACOBI; n++) {
			for (let j = 1; j <= ny; j++)
				for (let i = 1; i <= nx; i++) {
					const k = i + j * w;
					p[k] = (div[k] + p[k - 1] + p[k + 1] + p[k - w] + p[k + w]) * 0.25;
				}
			bound(p, false);
		}
		for (let j = 1; j <= ny; j++)
			for (let i = 1; i <= nx; i++) {
				const k = i + j * w;
				u[k] -= 0.5 * (p[k + 1] - p[k - 1]);
				v[k] -= 0.5 * (p[k + w] - p[k - w]);
			}
		bound(u, false);
		bound(v, false);
	};

	// Vorticity confinement (Fedkiw, Stam & Jensen 2001). A grid solver damps exactly the small
	// eddies that make smoke look like smoke; this finds where the curl is and pushes it back up its
	// own gradient, which restores them without inventing motion anywhere the fluid was still.
	const confine = (amount: number, dt: number) => {
		if (amount <= 0) return;
		for (let j = 1; j <= ny; j++)
			for (let i = 1; i <= nx; i++) {
				const k = i + j * w;
				curl[k] = 0.5 * (v[k + 1] - v[k - 1] - (u[k + w] - u[k - w]));
			}
		for (let j = 2; j < ny; j++)
			for (let i = 2; i < nx; i++) {
				const k = i + j * w;
				const dx = 0.5 * (Math.abs(curl[k + 1]) - Math.abs(curl[k - 1]));
				const dy = 0.5 * (Math.abs(curl[k + w]) - Math.abs(curl[k - w]));
				const len = Math.hypot(dx, dy) + 1e-5;
				u[k] += amount * dt * (dy / len) * curl[k];
				v[k] += amount * dt * -(dx / len) * curl[k];
			}
	};

	return {
		get nx() {
			return nx;
		},
		get ny() {
			return ny;
		},
		get stride() {
			return w;
		},
		get dye() {
			return dye;
		},
		get heat() {
			return heat;
		},
		get u() {
			return u;
		},
		get v() {
			return v;
		},
		get curl() {
			return curl;
		},
		resize,
		ready: () => cells > 0,
		// a puff of dye and a push, both gaussian, both in grid units
		inject(cx: number, cy: number, radius: number, amount: number, fx: number, fy: number, hot = 0) {
			const r = Math.max(1, radius);
			const i0 = Math.max(1, Math.floor(cx - r * 2));
			const i1 = Math.min(nx, Math.ceil(cx + r * 2));
			const j0 = Math.max(1, Math.floor(cy - r * 2));
			const j1 = Math.min(ny, Math.ceil(cy + r * 2));
			for (let j = j0; j <= j1; j++)
				for (let i = i0; i <= i1; i++) {
					const dx = i - cx;
					const dy = j - cy;
					const g = Math.exp(-(dx * dx + dy * dy) / (2 * r * r));
					const k = i + j * w;
					dye[k] += amount * g;
					// the flash is TIGHTER than the smoke it comes with - a sound is a point that then
					// becomes a cloud, not a cloud that lights up
					heat[k] += hot * g * g;
					u[k] += fx * g;
					v[k] += fy * g;
				}
		},
		// A wind over the whole room, as a velocity the field RELAXES TOWARDS rather than one it is
		// given. Assigning it every frame would erase the fluid's memory, which is the one thing a
		// fluid is for; adding it as a pure acceleration has no steady state at all, and measured,
		// that is exactly what happened - with no drag the field integrated the wind for three
		// minutes and reached 273 cells a second, crossing the whole room twice a second, and every
		// puff was smeared out before it could be seen. A relaxation has both: an impulse survives
		// for seconds and decays, and the room settles at the wind rather than past it.
		// ...and it relaxes THE MEAN, not every cell. Relaxing each cell towards the wind erases the
		// eddies at the same rate as it corrects the drift, so the room could either follow the music
		// or remember a sound, never both: measured, the fastest cell in the room tracked the
		// loudness at r 0.45 while the wind itself was a clean function of it. Splitting the field
		// into its mean and its fluctuations lets the mean answer the music in half a beat while
		// every deviation - which is all of the smoke's structure - is left exactly as it was.
		blow(tx: number, ty: number, rate: number, dt: number) {
			let mu = 0;
			let mv = 0;
			for (let k = 0; k < cells; k++) {
				mu += u[k];
				mv += v[k];
			}
			mu /= cells;
			mv /= cells;
			const a = Math.min(1, rate * dt);
			const du = (tx - mu) * a;
			const dv = (ty - mv) * a;
			for (let k = 0; k < cells; k++) {
				u[k] += du;
				v[k] += dv;
			}
		},
		// A WIND THAT IS NOT THE SAME EVERYWHERE. The mean is the music's (above); this adds a slow
		// spatial variation around it, which is what tears a plume into filaments instead of carrying
		// it along as the round blob it was born as. Measured by eye: with a uniform wind, raising the
		// vorticity from 2 to 9 changed nothing, because confinement can only amplify curl that
		// exists and a uniform flow has none. Shear makes the curl; confinement then keeps it.
		//
		// It is a target the field relaxes towards, not a velocity written into it, so the fluid
		// still owns its own motion - and its mean is zero by construction, so the music's wind is
		// left exactly where it was put.
		shear(field: (x: number, y: number) => number, amount: number, rate: number, dt: number) {
			if (amount <= 0) return;
			const a = Math.min(1, rate * dt);
			for (let j = 1; j <= ny; j++)
				for (let i = 1; i <= nx; i++) {
					const k = i + j * w;
					const ang = field(i / nx, j / ny) * Math.PI;
					u[k] += Math.cos(ang) * amount * a;
					v[k] += Math.sin(ang) * amount * a;
				}
		},
		// THE HAND STIRS. A tangential velocity around a point, gaussian in the distance from it,
		// with a strength that is the gesture's size and a SENSE that is a constant - so no part of
		// the direction comes from the input. It cannot clot the way a pull towards a point does
		// (nothing converges: the field it adds is divergence-free by construction) and it cannot
		// make a bright place, because it never touches the dye.
		//
		// Confinement was tried first, which is the more conservative thing - amplify the curl that
		// is already there - and it measured at nothing: +4% of the room's flow, no change in the
		// light at all. Amplifying zero is zero, and the fluid under a hand is mostly irrotational.
		// DESIGN-RULES §12: a signal that cannot move the picture is not a control.
		stir(cx: number, cy: number, radius: number, strength: number, dt: number) {
			if (strength <= 0) return;
			const i0 = Math.max(1, Math.floor(cx - radius * 2.5));
			const i1 = Math.min(nx, Math.ceil(cx + radius * 2.5));
			const j0 = Math.max(1, Math.floor(cy - radius * 2.5));
			const j1 = Math.min(ny, Math.ceil(cy + radius * 2.5));
			for (let j = j0; j <= j1; j++)
				for (let i = i0; i <= i1; i++) {
					const dx = i - cx;
					const dy = j - cy;
					const d2 = dx * dx + dy * dy;
					const g = Math.exp(-d2 / (2 * radius * radius));
					const k = i + j * w;
					// tangential: (-dy, dx) normalised, so the flow goes round rather than in or out
					const len = Math.sqrt(d2) + 1e-4;
					u[k] += (-dy / len) * strength * g * dt;
					v[k] += (dx / len) * strength * g * dt;
				}
		},
		step(dt: number, dyeKeep: number, heatKeep: number, vorticity: number) {
			confine(vorticity, dt);
			u0.set(u);
			v0.set(v);
			// advect the velocity along itself - the two temporaries hold the field being read while
			// the live one is written
			const su = u0;
			const sv = v0;
			for (let j = 1; j <= ny; j++)
				for (let i = 1; i <= nx; i++) {
					const k = i + j * w;
					let x = i - dt * su[k];
					let y = j - dt * sv[k];
					if (x < 0.5) x = 0.5;
					else if (x > nx + 0.5) x = nx + 0.5;
					if (y < 0.5) y = 0.5;
					else if (y > ny + 0.5) y = ny + 0.5;
					const i0 = Math.floor(x);
					const j0 = Math.floor(y);
					const s1 = x - i0;
					const s0 = 1 - s1;
					const t1 = y - j0;
					const t0 = 1 - t1;
					const a = i0 + j0 * w;
					u[k] = s0 * (t0 * su[a] + t1 * su[a + w]) + s1 * (t0 * su[a + 1] + t1 * su[a + w + 1]);
					v[k] = s0 * (t0 * sv[a] + t1 * sv[a + w]) + s1 * (t0 * sv[a + 1] + t1 * sv[a + w + 1]);
				}
			bound(u, false);
			bound(v, false);
			project();
			dye0.set(dye);
			advect(dye, dye0, dt, true);
			heat0.set(heat);
			advect(heat, heat0, dt, true);
			for (let k = 0; k < cells; k++) {
				dye[k] *= dyeKeep;
				heat[k] *= heatKeep;
			}
		}
	};
}

function create(): Preset {
	const conduct = createConductor();
	const bloom = createBloomLayer();
	const fluid = createFluid();
	const noise = createNoise3D();

	let buffer: HTMLCanvasElement | null = null;
	let image: ImageData | null = null;
	let clock = 0;
	let windAngle = 0;
	let harm = 0;
	let flash = 0;
	// the segment this preset last threw into the room, so one new sound is one puff
	let lastSegStart: number | null = null;
	let nextSeg = 0;
	let lastScan = -1;

	return {
		draw(frame) {
			const { ctx, width, height, isPlaying, colorRgb, audio, progressSec } = frame;
			if (!isPlaying) return; // the room simply holds its last state

			const c = conduct(frame);
			const v = VARIANTS[getVariant() % VARIANTS.length];

			// the grid follows the canvas aspect so cells stay square
			const rows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.round((GRID_X * height) / Math.max(1, width))));
			if (fluid.nx !== GRID_X || fluid.ny !== rows) {
				fluid.resize(GRID_X, rows);
				buffer = null;
			}
			const nx = fluid.nx;
			const ny = fluid.ny;
			const stride = fluid.stride;
			if (!buffer || buffer.width !== nx || buffer.height !== ny) {
				buffer = document.createElement("canvas");
				buffer.width = nx;
				buffer.height = ny;
				image = buffer.getContext("2d")!.createImageData(nx, ny);
			}

			const beat = audio?.tempo && audio.tempo > 40 ? 60 / audio.tempo : 0.5;
			clock += c.dt;
			harm += (c.harmonicShift - harm) * Math.min(1, 6 * c.dt);
			flash += ((c.timeToImpact !== null && c.timeToImpact > 0 ? 0 : c.impact) - flash) * Math.min(1, (c.impact > flash ? 11 : 3) * c.dt);

			// ---- the wind ---------------------------------------------------------------------------
			// One direction for the whole room, wandering slowly, unlocked by real harmonic movement -
			// the same structure as the other two presets, and for the same reason: one primary
			// direction and bounded offsets from it, never two absolute angles blended (§1c).
			const wanderTarget = Math.sin(clock * 0.07) * Math.PI;
			const turnStep = (0.1 + harm * 0.7) * c.dt;
			const turnDiff = ((wanderTarget - windAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
			windAngle += Math.max(-turnStep, Math.min(turnStep, turnDiff));

			// the brace, early: `anticipation` alone arrives at the same instant as the release it is
			// supposed to make room for, so it borrows the wind-up's measured span
			const braceEarly = Math.max(c.anticipation, Math.min(1, c.windup * 0.8));
			// ...and it acts on the ROOM rather than on the light: the smoke thins out on the way in,
			// which is a withdrawal that costs no brightness and no speed
			const dissipation = 1 + braceEarly * 0.8;
			// the speed of the wind is the loudness, and nothing else (§12). Opened downward (§13).
			const windSpeed = (v.windFloor + c.loudness * v.windRange) * (1 + c.windup * 0.35);
			// how fast the room takes on the wind: slow enough that a sound's own push lives for a
			// couple of beats before the room absorbs it, which is the whole point of the medium
			fluid.blow(Math.cos(windAngle) * windSpeed, Math.sin(windAngle) * windSpeed, 1 / (beat * 0.5), c.dt);
			// the shear: a slow noise field of direction, a fraction of the wind's own speed, drifting
			// on the field's own clock rather than the music's - the room's weather, not its rhythm
			// THE SHEAR IS WHAT MAKES IT SMOKE, AND IT COSTS CORRELATION. Measured on one track at one
			// grid, changing nothing else:
			//
			//     no shear            light follows the music at r 0.86, and every plume is a round blob
			//     a quarter of the wind                        r 0.79, and plumes tear into filaments
			//     a fixed 15 cells/s                           r 0.66
			//     half the wind                                r 0.64
			//
			// Mixing is what a shear does, and mixing makes the room's density depend on its own
			// history rather than on what was last put in. There is no version of this that is free:
			// the round blobs are what a fluid looks like when nothing pulls it apart. A quarter of
			// the wind is where the picture becomes the material it is supposed to be while the light
			// still follows the song - and it is a share of the wind rather than a constant, because
			// measured, a constant was worse on both counts at once.
			fluid.shear((x, y) => noise(x * 1.7, y * 1.7, clock * 0.06), windSpeed * v.shear, 1 / (beat * 2), c.dt);

			// ---- the sound that is about to happen ---------------------------------------------------
			// The analysis is a timeline, so a puff can be thrown in BEFORE its sound and be at full
			// size on it (§5b). Everything about the puff is that sound: where on the register axis it
			// sits, how broad it is, how hard it is thrown.
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
			if (coming && coming.start !== lastSegStart) {
				const rise = Math.max(0.05, Math.min(0.55, coming.loudness_max_time * 2.4 + 0.04));
				if (coming.start - progressSec <= Math.min(0.4, rise * 0.9)) {
					lastSegStart = coming.start;
					const amp = Math.pow(10, coming.loudness_max / 20) / (audio?.hitScale || 0.56);
					// ACROSS THE WIND, by register. Along the wind it would be wiped within a second -
					// the field carries everything downwind - while across it the drift runs parallel to
					// the axis and the reading survives.
					const place = (audio ? rankOf(audio.timbreSorted, coming.timbre[1]) : 0.5) * 2 - 1;
					const ax = -Math.sin(windAngle);
					const ay = Math.cos(windAngle);
					// upwind of centre, so the room has something to carry: a puff born in the middle
					// has half a screen to cross, one born downwind is gone before it is seen
					const cx = nx * 0.5 + ax * place * nx * 0.42 - Math.cos(windAngle) * nx * 0.22;
					const cy = ny * 0.5 + ay * place * ny * 0.42 - Math.sin(windAngle) * ny * 0.22;
					// how sharp the sound was decides how hard it is thrown; how loud it was decides
					// how much of it there is. One channel, one driver.
					const sharp = 1 - Math.min(1, coming.loudness_max_time / 0.12);
					// BIGGER, and this is the difference between a sound being in the room and a sound
					// being SEEN. At 3.2 cells on a 192-wide grid a puff covered 2.6% of the width - the
					// events were 39% of all the light in the picture and still read as "not reacting",
					// because thirty-nine per cent spread over a hundred small merging blots is a fog,
					// not an event.
					const size = PUFF_CELLS * (0.55 + Math.min(1.2, amp) * 0.9);
					const force = v.puffForce * (0.3 + sharp * sharp * 0.9) * Math.min(1.3, amp);

					// ONE DRIVER EACH (§12). How much dye a sound puts in is how big that SOUND was, and
					// nothing else; how bright the dye is, is how loud the music is right now - that
					// lives in `gain` below. Both carried the loudness at first and the two multiplied:
					// light measured r 0.59 against the music with a range two and a half times the
					// music's own, which is the compounding §13 names, in a preset with only two
					// channels to compound.
					fluid.inject(
						cx,
						cy,
						size,
						// A FLOOR UNDER THE PUFF, for the same reason every speed in this project has one.
						// Read off the measurement rather than chosen: the room's density against the
						// music came out as a straight line with a NEGATIVE intercept - dye ~ 955L - 94
						// over a whole track - and a line through below zero exaggerates every ratio on
						// it. That is how a x1.76 song became a x3.07 room. The floor lifts the
						// intercept back to where a quiet passage is quiet rather than empty, and the
						// range follows the music instead of outrunning it (§13).
						v.puffDye * (0.5 + Math.min(1.3, amp) * 0.75),
						Math.cos(windAngle) * force,
						Math.sin(windAngle) * force
					);
				}
			}
			// the release is a big hit and nothing else: one large injection through the same door
			if (flash > 0.01 && c.impact > 0.01) {
				const ax = -Math.sin(windAngle);
				const ay = Math.cos(windAngle);
				const spread = (Math.random() - 0.5) * 1.4;
				fluid.inject(
					nx * 0.5 + ax * spread * nx * 0.4 - Math.cos(windAngle) * nx * 0.3,
					ny * 0.5 + ay * spread * ny * 0.4 - Math.sin(windAngle) * ny * 0.3,
					PUFF_CELLS * 2.2,
					v.puffDye * 1.1 * flash * c.dt * 8,
					Math.cos(windAngle) * v.puffForce * 1.6 * flash * c.dt * 8,
					Math.sin(windAngle) * v.puffForce * 1.6 * flash * c.dt * 8,
					flash * c.dt * 10
				);
			}

			// ---- THE HAND: CURL, AND ONLY CURL -------------------------------------------------------
			// Everything the hand does to this room is to amplify motion that is already there. It may
			// not inject force along its own movement - that is raw input setting a direction (§1b), in
			// the one medium that keeps it for seconds - and it may not add dye, because dye is
			// brightness and §2 is explicit.
			// gated by `baton`, which is zero with the pointer at rest - so a hand left on the canvas
			// does nothing at all, and there is no permanent eddy sitting where somebody parked it
			if (c.baton > 0.02)
				fluid.stir(
					(frame.mouse.x / Math.max(1, width)) * nx,
					(frame.mouse.y / Math.max(1, height)) * ny,
					nx * 0.11,
					c.baton * 150,
					c.dt
				);

			// how much of the dye survives one frame, measured in BEATS of this track rather than in
			// seconds, so the room's memory is a musical length
			const dyeKeep = Math.pow(v.dyePerBeat, (c.dt / beat) * dissipation);
			// the flash lives in fractions of a beat, the smoke in several of them - two clocks, so the
			// picture can say "now" and "lately" at the same time
			const heatKeep = Math.pow(v.heatPerBeat, c.dt / beat);
			fluid.step(c.dt, dyeKeep, heatKeep, v.vorticity * (0.6 + c.attackSharpness * 0.8));

			// ---- drawing ------------------------------------------------------------------------------
			const dye = fluid.dye;
			const hot = fluid.heat;
			const uu = fluid.u;
			const vv = fluid.v;
			const base = albumHsl(colorRgb);
			const cool = hslToRgb(base.h, base.s * 0.8, base.l * 0.5);
			const warm = hslToRgb(base.h + 0.1, Math.min(1, base.s + 0.1), Math.min(0.82, base.l + 0.2));
			// what a flash looks like: the album's hue pushed further round and much lighter, so a hit
			// is a different COLOUR as well as more light - the one channel a single-material picture
			// otherwise cannot use
			const flare = hslToRgb(base.h + 0.18, Math.min(1, base.s + 0.15), 0.72);
			const data = image!.data;
			// the ring, in grid coordinates: one lookup per cell, and the conductor's own ripple does
			// the work - so a click spreads on the music's clock here exactly as it does everywhere else
			const cellW = width / nx;
			const cellH = height / ny;
			const ringAt = (i: number, j: number) => c.rippleAt((i + 0.5) * cellW, (j + 0.5) * cellH);
			// HOW BRIGHT A UNIT OF DYE IS, and it does NOT read the loudness. The dye's own amount is
			// already proportional to the music (see the floor under the puff), so putting the
			// loudness here too multiplies the song's dynamics by themselves: measured on Harmonious,
			// whose music spans x4.1, the light came out spanning x28 - the exact square. One channel,
			// one driver (§12), and in a fluid the channel is the dye.
			// It keeps a SMALL share of the loudness - measured over three tracks, a flat gain and a
			// gain carrying the whole loudness both came out worse than this: flat left the picture
			// understating a dynamic track, and the full term squared the song's own range.
			const gain = v.gain * (1 + flash * 0.25) * (0.7 + c.loudness * 0.55);
			// and the room is not a vacuum. A haze that owes nothing to the music keeps the black
			// level off zero, which is where a ratio goes to infinity - and is also just true of air.
			// 0.02 measured: at 0.035 the haze itself was most of the light in the frame and the
			// picture stopped moving with the music at all.
			const haze = 0.02;
			let maxDye = 0;
			let totalDye = 0;
			let maxSpeed = 0;
			let sumSpeed = 0;
			for (let j = 0; j < ny; j++)
				for (let i = 0; i < nx; i++) {
					const k = i + 1 + (j + 1) * stride;
					const d = dye[k];
					if (d > maxDye) maxDye = d;
					totalDye += d;
					const sp = Math.abs(uu[k]) + Math.abs(vv[k]);
					if (sp > maxSpeed) maxSpeed = sp;
					sumSpeed += sp;
					const o = (i + j * nx) * 4;
					if (diagnostic) {
						data[o] = Math.min(255, hot[k] * 300);
						data[o + 1] = Math.min(255, d * 220);
						data[o + 2] = Math.min(255, sp * 6);
						data[o + 3] = 255;
						continue;
					}
					// the dye's own density picks the colour between the room's two ends, so a dense
					// plume is not merely a brighter version of a thin one - it is a different colour,
					// which is the channel a single-material picture otherwise does not have
					const t = Math.min(1, d * 0.9);
					// A CLICK LIGHTS WHAT IS ALREADY THERE. The ring is the one narrow place
					// DESIGN-RULES §2 lets a gesture into brightness, and it is built to its terms:
					// it multiplies the smoke that happens to be at that cell and draws nothing of its
					// own, so a click into an empty corner of the room shows nothing at all.
					const ring = ringAt(i, j);
					// BEER-LAMBERT, not a clamp. How much light a column of smoke returns is
					// 1 - exp(-density), which is what smoke actually does and, for this picture's
					// purposes, a ceiling that approaches rather than arrives: a dense plume keeps
					// getting brighter for as long as it keeps getting denser, where `min(1, ...)`
					// flattens every plume past a point into one flat white and takes the dynamics
					// with it (§3b, in a pixel rather than in a stroke).
					// the flash on top, additively and in its own colour. Additive because that is what a
					// bright thing in smoke does to the smoke around it, and because a multiplier on a
					// dark cell is still dark - a sound arriving into an empty part of the room has to
					// be visible there too
					const hv = hot[k];
					const lum = (1 - Math.exp(-(d + haze) * gain)) * (1 + ring * 0.9);
					const fl = hv > 0.001 ? 1 - Math.exp(-hv * v.heatGain) : 0;
					data[o] = (cool.r + (warm.r - cool.r) * t) * lum + flare.r * fl;
					data[o + 1] = (cool.g + (warm.g - cool.g) * t) * lum + flare.g * fl;
					data[o + 2] = (cool.b + (warm.b - cool.b) * t) * lum + flare.b * fl;
					data[o + 3] = 255;
				}

			// the room is its own memory, so there is no trail canvas to fade - but the black floor
			// still matters, because the upscale is drawn over the previous frame
			fadeTrail(ctx, width, height, 1);
			const bctx = buffer!.getContext("2d")!;
			bctx.putImageData(image!, 0, 0);
			const pctx = bloom.begin(width, height);
			pctx.imageSmoothingEnabled = true;
			pctx.drawImage(buffer!, 0, 0, width, height);
			bloom.flush(frame, c, 0.014);

			// what the simulation believes about itself, for the headless check: a fluid's state is
			// invisible in its draw calls, and a pixel buffer destroys the evidence of a NaN
			// `meanSpeed` rather than `maxSpeed` is what "how fast is the picture moving" means for a
			// field: the maximum is whichever puff went in last, so it reports the events and not the
			// flow - measured, it tracked the loudness at r 0.35 while the flow it was supposed to
			// describe tracked it at three times that.
			publishDiagnostics("smoke", {
				maxDye,
				totalDye,
				maxSpeed,
				meanSpeed: sumSpeed / Math.max(1, nx * ny),
				windSpeed,
				dyeKeep
			});
		}
	};
}

export const smokePreset: PresetDefinition = { id: "smoke", name: "Smoke", create };
