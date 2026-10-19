// Headless sanity check for the presets: there is no way to look at this thing while developing it
// (it only runs inside the Spotify client), so instead every preset is driven for a few hundred
// frames against a fake canvas that asserts the numbers it is handed are sane, and that a paused
// frame renders exactly the same calls as the frame before it. Run with `npm run check`.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// inside node_modules so that `require("simplex-noise")` still resolves from the compiled output
const OUT = path.join(__dirname, "node_modules", ".cache", "preset-check");
fs.rmSync(OUT, { recursive: true, force: true });
execFileSync(
	process.execPath,
	[
		path.join(__dirname, "node_modules", "typescript", "bin", "tsc"),
		"src/presets/index.ts",
		"src/colours.ts",
		"src/audio-sync.ts",
		"src/types/audio-analysis.d.ts",
		"src/types/spicetify.d.ts",
		"--outDir",
		OUT,
		"--module",
		"commonjs",
		"--target",
		"es2017",
		"--esModuleInterop",
		"--skipLibCheck",
		"--strict",
		"--ignoreConfig"
	],
	{ cwd: __dirname, stdio: "inherit" }
);

let log = [];
let checking = false;
let label = "";
const warnings = new Set();

const num = (op, value) => {
	if (checking) assert.ok(Number.isFinite(value), `${op}: expected a finite number, got ${value}`);
	return value;
};

function checkStyle(op, value) {
	if (typeof value !== "string") return value;
	const rgba = /^rgba?\(([^)]*)\)$/.exec(value);
	assert.ok(rgba, `${op}: unparseable color ${value}`);
	const parts = rgba[1].split(",").map(p => Number(p.trim()));
	parts.forEach(p => assert.ok(Number.isFinite(p), `${op}: NaN component in ${value}`));
	parts.slice(0, 3).forEach(p => assert.ok(p >= 0 && p <= 255, `${op}: channel out of range in ${value}`));
	if (parts.length === 4) {
		assert.ok(parts[3] >= 0, `${op}: negative alpha in ${value}`);
		// canvas silently clamps alpha above 1, it just means the top of the range is dead
		if (parts[3] > 1) warnings.add(`${label}: ${op} alpha reaches ${parts[3].toFixed(2)}, clamped to 1`);
	}
	return value;
}

// A pixel buffer, as one number. Without this an ImageData logged as `[object Object]`, so for a
// preset that draws by `putImageData` NEITHER of this harness's two jobs was being done: no number
// inside it was ever checked, and the freeze-on-pause test compared two identical strings while the
// pixels underneath were free to change. FNV-1a over the bytes, which is enough to notice one
// changed pixel and costs nothing.
//
// It cannot catch a NaN, and that is worth stating: a Uint8ClampedArray silently turns NaN into 0,
// so by the time a value reaches an ImageData the evidence is gone. That is what `publishDiagnostics`
// in flowfield-common is for - a preset with a simulation behind it reports the state of the
// simulation itself, and the assert below covers it.
function hashPixels(data) {
	let h = 0x811c9dc5;
	for (let i = 0; i < data.length; i++) {
		h ^= data[i];
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}

const describe = a => {
	if (typeof a === "number") return a.toFixed(4);
	if (a && typeof a === "object" && a.data && typeof a.width === "number")
		return `imagedata(${a.width}x${a.height}:${hashPixels(a.data)})`;
	return String(a);
};

function record(op, args) {
	args.forEach(a => typeof a === "number" && num(op, a));
	if (op === "arc") assert.ok(args[2] >= 0, `arc: negative radius ${args[2]}`);
	if (checking) log.push(op + "(" + args.map(describe).join(",") + ")");
}

function createContext() {
	const ctx = {};
	const methods = [
		"clearRect",
		"fillRect",
		"strokeRect",
		"beginPath",
		"closePath",
		"moveTo",
		"lineTo",
		"arc",
		"rect",
		"fill",
		"stroke",
		"save",
		"restore",
		"translate",
		"rotate",
		"scale",
		"putImageData",
		"drawImage",
		"fillText",
		"strokeText",
		"setLineDash"
	];
	for (const name of methods) ctx[name] = (...args) => record(name, args);

	ctx.createLinearGradient = (...args) => {
		record("createLinearGradient", args);
		return { addColorStop: (stop, color) => record("addColorStop", [stop, checkStyle("addColorStop", color)]) };
	};
	ctx.createRadialGradient = (...args) => {
		record("createRadialGradient", args);
		return { addColorStop: (stop, color) => record("addColorStop", [stop, checkStyle("addColorStop", color)]) };
	};
	// enough for a preset that labels what it draws. Width is proportional to the string so a layout
	// that measures text lays out the same way here as in a browser, deterministically
	ctx.measureText = text => ({ width: String(text).length * 0.55 * (Number(ctx.__fontPx) || 10) });
	ctx.createImageData = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });

	for (const prop of ["fillStyle", "strokeStyle"]) {
		let held = "#000";
		Object.defineProperty(ctx, prop, {
			get: () => held,
			set: v => {
				held = checkStyle(prop, v);
				record(prop, [typeof v === "string" ? v : "<gradient>"]);
			}
		});
	}
	for (const prop of ["lineWidth", "shadowBlur"]) {
		let held = 1;
		Object.defineProperty(ctx, prop, {
			get: () => held,
			set: v => {
				assert.ok(Number.isFinite(v) && v > 0, `${prop}: expected a positive number, got ${v}`);
				held = v;
				record(prop, [v]);
			}
		});
	}
	{
		let font = "10px sans-serif";
		Object.defineProperty(ctx, "font", {
			get: () => font,
			set: v => {
				font = String(v);
				ctx.__fontPx = parseFloat(font) || 10;
				record("font", [font]);
			}
		});
	}
	for (const prop of [
		"lineCap",
		"lineJoin",
		"shadowColor",
		"globalCompositeOperation",
		"imageSmoothingEnabled",
		"textAlign",
		"textBaseline"
	])
		ctx[prop] = undefined;

	return ctx;
}

global.Path2D = class {
	moveTo(...args) {
		record("path.moveTo", args);
	}
	lineTo(...args) {
		record("path.lineTo", args);
	}
};
global.document = {
	createElement: () => ({ width: 0, height: 0, getContext: () => createContext() })
};
// just enough for butterchurn's UMD wrapper to `require()` without crashing in plain Node - actually
// using it (new AudioContext(), real WebGL) still throws inside draw(), caught below and skipped
global.window = global;

function fakeAudio(seed) {
	let state = seed;
	const random = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

	const beats = [];
	for (let t = 0.31; t < 200; t += 0.48) beats.push({ start: t, duration: 0.48, confidence: random() });

	const segments = [];
	const loudnessCurve = [];
	for (let t = 0; t < 200; t += 0.29) {
		segments.push({
			start: t,
			duration: 0.29,
			loudness_start: -30 + random() * 25,
			loudness_max: -20 + random() * 18,
			loudness_max_time: random() * 0.2,
			loudness_end: -30 + random() * 25,
			pitches: Array.from({ length: 12 }, () => random()),
			timbre: [random() * 60, random() * 200 - 100, random() * 200 - 100, ...Array.from({ length: 9 }, () => random() * 100 - 50)]
		});
		loudnessCurve.push({ t, y: Math.pow(10, (-30 + random() * 28) / 20) });
	}

	// bars every four beats, and four sections of alternating loudness so the anticipation and
	// impact signals actually get exercised rather than sitting at zero for the whole run
	const bars = [];
	for (let i = 0; i + 4 <= beats.length; i += 4)
		bars.push({ start: beats[i].start, duration: beats[i + 4 - 1].start - beats[i].start + 0.48, confidence: 0.8 });
	const sections = [];
	for (let i = 0; i < 200; i += 25)
		sections.push({ start: i, duration: 25, confidence: 0.7, loudness: i % 50 === 0 ? -18 : -8, tempo: 128, key: 0, mode: 1, time_signature: 4 });

	const ordered = sections.map((s, i) => ({ i, l: s.loudness })).sort((a, b) => a.l - b.l);
	const sectionIntensity = new Array(sections.length).fill(0);
	ordered.forEach((e, pos) => (sectionIntensity[e.i] = ordered.length > 1 ? pos / (ordered.length - 1) : 0.5));
	const { findMoments } = require(path.join(OUT, "track-structure.js"));
	return { beats, segments, loudnessCurve, tempo: 128, bars, sections, sectionIntensity, moments: findMoments(segments, bars, loudnessCurve) };
}

const { PRESETS } = require(path.join(OUT, "presets", "index.js"));
const common = require(path.join(OUT, "presets", "flowfield-common.js"));

// what a simulation says about itself, checked on every frame a preset publishes it. The fake
// canvas cannot see inside a Float32Array, and a pixel buffer destroys the evidence of a NaN, so
// this is the only place a fluid or a field solver can be caught going bad.
function checkDiagnostics(where) {
	const d = common.lastDiagnostics;
	if (!d) return;
	for (const [key, value] of Object.entries(d.values))
		assert.ok(Number.isFinite(value), `${where}: ${d.label}.${key} is ${value}`);
}
const WIDTH = 2560;
const HEIGHT = 1440;

for (const audio of [fakeAudio(7), null]) {
	for (const definition of PRESETS) {
		const preset = definition.create();
		const ctx = createContext();
		label = `${definition.id}/${audio ? "analysed" : "no-analysis"}`;
		checking = true;

		let progressSec = 3;
		const frameAt = (t, isPlaying, mouseFrame) => ({
			ctx,
			width: WIDTH,
			height: HEIGHT,
			progressSec: t,
			isPlaying,
			audio,
			colorRgb: { r: 30.5, g: 215.2, b: 96.8 },
			mouse: {
				x: WIDTH * (0.5 + Math.sin(mouseFrame * 0.11) * 0.45),
				y: HEIGHT * (0.5 + Math.cos(mouseFrame * 0.07) * 0.45),
				speed: mouseFrame % 90 < 45 ? 0 : 5 + (mouseFrame % 45),
				clicks: Math.floor(mouseFrame / 37),
				rightClicks: Math.floor(mouseFrame / 53),
				down: mouseFrame % 37 < 10,
				rightDown: mouseFrame % 53 < 8,
				scroll: 0.5 + Math.sin(mouseFrame * 0.05) * 0.5,
				particleScale: 0.5 + Math.sin(mouseFrame * 0.03) * 0.5
			}
		});

		try {
			for (let f = 0; f < 400; f++) {
				progressSec += 1 / 60;
				preset.draw(frameAt(progressSec, true, f));
				checkDiagnostics(`${label} frame ${f}`);
			}

			// seeking backwards must not produce a negative dt anywhere
			preset.draw(frameAt(progressSec - 40, true, 0));
			preset.draw(frameAt(progressSec - 40 + 1 / 60, true, 1));

			// paused, cursor held still: consecutive frames must be byte-identical, otherwise the
			// preset keeps animating (or fading its own trails away) while the music is stopped
			preset.draw(frameAt(progressSec, false, 12));
			log = [];
			preset.draw(frameAt(progressSec, false, 12));
			const first = log.join("\n");
			log = [];
			preset.draw(frameAt(progressSec, false, 12));
			assert.strictEqual(log.join("\n"), first, `${label}: kept animating while paused`);

			checking = false;
			console.log(`ok  ${label}${first.length === 0 ? " (frozen, no draw calls)" : ""}`);
		} catch (e) {
			checking = false;
			// presets that need a real browser (AudioContext/WebGL2 - e.g. the Butterchurn-based one)
			// can't run in plain Node - skip rather than fail, they're only verifiable via `npm run preview`
			if (e instanceof ReferenceError && /AudioContext/.test(e.message)) {
				console.log(`skip ${label}: needs a real browser (${e.message}) - verify with npm run preview`);
			} else {
				throw e;
			}
		}
	}
}

// The knobs (T in the client): every one at the bottom of its slider, then every one at the top. A
// slider's ends are part of the preset, so no end may draw a NaN.
{
	const tune = require(path.join(OUT, "presets", "tune.js"));
	for (const definition of PRESETS) {
		const t = tune.tuningOf(definition.id);
		if (!t || t.knobs.length === 0) continue;
		for (const end of ["min", "max"]) {
			for (const k of t.knobs) tune.setKnob(definition.id, k.key, k[end]);
			const preset = definition.create();
			const ctx = createContext();
			label = `${definition.id}/knobs at ${end}`;
			checking = true;
			for (let f = 0; f < 200; f++) {
				preset.draw({ ctx, width: WIDTH, height: HEIGHT, progressSec: 3 + f / 60, isPlaying: true, audio: fakeAudio(7), colorRgb: { r: 30, g: 215, b: 96 }, mouse: { x: 0, y: 0, speed: 0, clicks: 0, rightClicks: 0, down: false, rightDown: false, scroll: 0.5, particleScale: 0.5 } });
				checkDiagnostics(`${label} frame ${f}`);
			}
			checking = false;
		}
		tune.resetKnobs(definition.id);
		console.log(`ok  ${definition.id} knobs (${t.knobs.length}, all at min and all at max)`);
	}
}

// The colours: every source with every gradient, from a dark, a grey and a light cover palette and
// from picked colours (pure black and white among them). No combination may draw a NaN.
{
	const colours = require(path.join(OUT, "colours.js"));
	const palette = [{ r: 12, g: 20, b: 60 }, { r: 128, g: 128, b: 128 }, { r: 250, g: 240, b: 200 }];
	for (const definition of PRESETS) {
		let n = 0;
		const own = colours.coloursOf(definition.id);
		for (const mode of ["cover", "custom"])
			for (const [follows] of own ? own.gradients : [["none"]]) {
				colours.setColours(definition.id, { mode, follows, stops: ["#000000", "#ff2a6d", "#ffffff"], harmony: 0.5 });
				const preset = definition.create();
				const ctx = createContext();
				label = `${definition.id}/colours ${mode} ${follows}`;
				checking = true;
				for (let f = 0; f < 120; f++) {
					preset.draw({ ctx, width: WIDTH, height: HEIGHT, progressSec: 3 + f / 60, isPlaying: true, audio: fakeAudio(7), colorRgb: palette[1], palette, coverColours: [...palette, { r: 200, g: 40, b: 40 }, { r: 90, g: 90, b: 100 }, { r: 40, g: 180, b: 90 }], mouse: { x: 0, y: 0, speed: 0, clicks: 0, rightClicks: 0, down: false, rightDown: false, scroll: 0.5, particleScale: 0.5 } });
					checkDiagnostics(`${label} frame ${f}`);
				}
				checking = false;
				n++;
			}
		console.log(`ok  ${definition.id} colours (${n} combinations)`);
	}
	for (const definition of PRESETS) {
		const own = colours.coloursOf(definition.id);
		if (own) colours.setColours(definition.id, { mode: "cover", follows: own.gradients[0][0], stops: ["#1e3a8a", "#5de6f0"], harmony: 1 });
	}
}

// The cover's colours by area: a speck of red on a blue cover is not a second colour, two big areas are
{
	const { coverHues } = require(path.join(OUT, "colours.js"));
	const cover = parts => {
		const px = new Uint8ClampedArray(48 * 48 * 4);
		let i = 0;
		for (const [share, rgb] of parts)
			for (let n = Math.round(share * 48 * 48); n > 0 && i < px.length; n--, i += 4) px.set([...rgb, 255], i);
		return px;
	};
	assert.strictEqual(coverHues(cover([[0.25, [45, 179, 235]], [0.012, [172, 0, 22]], [0.7, [20, 20, 24]]])).length, 0, "a red speck on a blue cover made a palette");
	assert.strictEqual(coverHues(cover([[0.4, [45, 179, 235]], [0.3, [235, 140, 40]], [0.3, [10, 10, 10]]])).length, 2, "blue and orange halves were not two colours");
	assert.strictEqual(coverHues(cover([[1, [128, 128, 128]]])).length, 0, "a grey cover made a palette");
	console.log("ok  cover colours by area (a speck is not a colour, two halves are two)");
}

for (const warning of warnings) console.log(`warn  ${warning}`);
// Between tracks: the analysis goes away, the clock goes back to zero, and a different song arrives at a
// different level. The conductor's level may not climb while it waits and may not step when it joins.
{
	const { createConductor } = require(path.join(OUT, "presets", "flowfield-common.js"));
	const conduct = createConductor();
	const mouse = { x: 400, y: 300, speed: 0, clicks: 0, rightClicks: 0, down: false, rightDown: false, scroll: 0.5, particleScale: 0.5 };
	const at = (audio, t) => conduct({ ctx: createContext(), width: WIDTH, height: HEIGHT, progressSec: t, isPlaying: true, audio, colorRgb: { r: 30, g: 215, b: 96 }, mouse });
	const a = fakeAudio(7);
	const b = fakeAudio(11);
	let last = 0;
	for (let f = 0; f < 600; f++) last = at(a, 40 + f / 120).loudness;
	const leaving = last;
	let worst = 0;
	let highest = 0;
	for (let f = 0; f < 90; f++) {
		const l = at(null, f / 120).loudness;
		worst = Math.max(worst, Math.abs(l - last));
		highest = Math.max(highest, l);
		last = l;
	}
	for (let f = 0; f < 360; f++) {
		const l = at(b, 0.75 + f / 120).loudness;
		worst = Math.max(worst, Math.abs(l - last));
		last = l;
	}
	assert.ok(highest <= leaving + 1e-9, `between tracks: the level climbed to ${highest.toFixed(3)} from ${leaving.toFixed(3)} while waiting`);
	assert.ok(worst < 0.02, `between tracks: the level stepped ${worst.toFixed(3)} in one frame`);
	console.log(`ok  between tracks (level never above ${leaving.toFixed(2)} while waiting, worst one-frame step ${worst.toFixed(4)})`);
}

// The smooth clock: the player reports whole milliseconds, and at 240 Hz that is a 20% step in every
// sixth frame. Fed exactly that, what it hands on must advance evenly and stay on the player's time.
{
	const { createSmoothClock } = require(path.join(OUT, "audio-sync.js"));
	const clock = createSmoothClock();
	const steps = [];
	let last = null;
	let worstLag = 0;
	for (let f = 0; f < 2400; f++) {
		const wall = f / 240;
		const t = clock(Math.floor((30 + wall) * 1000) / 1000, true, wall);
		if (last !== null && f > 240) steps.push(t - last);
		if (f > 240) worstLag = Math.max(worstLag, Math.abs(t - (30 + wall)));
		last = t;
	}
	const spread = (Math.max(...steps) - Math.min(...steps)) / (1 / 240);
	assert.ok(spread < 0.03, `smooth clock: frame steps still differ by ${(spread * 100).toFixed(1)}%`);
	assert.ok(worstLag < 0.002, `smooth clock: drifted ${(worstLag * 1000).toFixed(2)} ms off the player`);
	// a seek is taken at once
	assert.ok(Math.abs(clock(90, true, 10.01) - 90) < 1e-9, "smooth clock: did not follow a seek");
	console.log(`ok  smooth clock (frame steps within ${(spread * 100).toFixed(1)}%, ${(worstLag * 1000).toFixed(2)} ms off the player at worst)`);
}

console.log(`\nall ${PRESETS.length} presets ok`);
