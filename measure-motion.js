// Measures what a preset actually *does*, as opposed to whether it crashes (that is check-presets).
// Every preset is driven for a minute against fake audio and a still cursor, and three things are
// reported per preset:
//
//   light/frame        sum of alpha x lineWidth over every stroke - the total emission the bloom
//                      pass has to work with. Comparable between presets; Aurora is the reference.
//   turn/frame         how far a single particle's heading moves between consecutive frames. Array
//                      order is stable, so index N is the same particle until it respawns (detected
//                      by its stroke not starting where its last one ended). THIS is the number that
//                      corresponds to "it kinks" - a population average can swing wildly while every
//                      individual filament stays smooth, and did, which sent one investigation down
//                      the wrong path entirely.
//   coherence          how much the particles agree on a heading, 0..1.
//
// Then every preset is driven a second time through an actual song shape - quiet interlude, build,
// drop, outro - and asked the question a music visualizer lives or dies by: does a drop look
// different from an interlude? A preset whose ratio is near 1 looks the same all song no matter
// what is playing.
//
// Run `npm run measure`. See DESIGN-RULES §1c and §3b for the two rules these numbers produced.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const OUT = path.join(__dirname, "node_modules", ".cache", "preset-check");
if (!fs.existsSync(path.join(OUT, "presets", "index.js"))) {
	execFileSync(
		process.execPath,
		[
			path.join(__dirname, "node_modules", "typescript", "bin", "tsc"),
			"src/presets/index.ts", "src/types/audio-analysis.d.ts", "src/types/spicetify.d.ts",
			"--outDir", OUT, "--module", "commonjs", "--target", "es2017",
			"--esModuleInterop", "--skipLibCheck", "--strict", "--ignoreConfig"
		],
		{ cwd: __dirname, stdio: "inherit" }
	);
}

let strokes = []; // { x1, y1, x2, y2, light }
let pending = null;

function createContext() {
	const ctx = {};
	const noop = () => {};
	for (const m of ["clearRect","strokeRect","beginPath","closePath","arc","rect","fill","save","restore","translate","rotate","scale","drawImage","fillText","strokeText","setLineDash"])
		ctx[m] = noop;
	// PRESETS THAT DO NOT DRAW IN STROKES. Smoke hands over one pixel buffer a frame and Plate puts
	// down one small fillRect per grain, so both of them measured as exactly zero light here - the
	// harness that answers "is it what you meant" could not see two of the five presets at all. Both
	// are converted into the same unit a stroke reports: how much light went onto the screen.
	ctx.putImageData = img => {
		if (!img || !img.data) return;
		let lum = 0;
		for (let i = 0; i < img.data.length; i += 4)
			lum += img.data[i] * 0.2126 + img.data[i + 1] * 0.7152 + img.data[i + 2] * 0.0722;
		strokes.push({ light: lum / 255 });
	};
	ctx.fillRect = (x, y, w, h) => {
		// the full-frame fill that clears the canvas is not light
		if (w >= 2000 || h >= 2000) return;
		const m = /^rgba\(([^)]*)\)$/.exec(String(ctx.fillStyle));
		strokes.push({ light: w * h * (m ? Number(m[1].split(",")[3]) : 1) * 0.02 });
	};
	ctx.measureText = text => ({ width: String(text).length * 6 });
	let alpha = 1;
	ctx.moveTo = (x, y) => { pending = { x1: x, y1: y }; };
	ctx.lineTo = (x, y) => { if (pending) { pending.x2 = x; pending.y2 = y; } };
	ctx.stroke = () => {
		if (pending && pending.x2 !== undefined) strokes.push({ ...pending, light: alpha * ctx.lineWidth });
		pending = null;
	};
	// presets that draw motes instead of strokes (Embers) emit their light through gradient stops
	const grad = () => ({
		addColorStop: (_stop, color) => {
			const m = /^rgba\(([^)]*)\)$/.exec(String(color));
			if (m) strokes.push({ light: Number(m[1].split(",")[3]) * 3 });
		}
	});
	ctx.createLinearGradient = ctx.createRadialGradient = grad;
	ctx.createImageData = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
	for (const prop of ["fillStyle", "strokeStyle"]) {
		let held = "#000";
		Object.defineProperty(ctx, prop, {
			get: () => held,
			set: v => {
				held = v;
				if (prop === "strokeStyle") {
					const m = /^rgba\(([^)]*)\)$/.exec(String(v));
					alpha = m ? Number(m[1].split(",")[3]) : 1;
				}
			}
		});
	}
	ctx.lineWidth = 1;
	return ctx;
}

global.document = { createElement: () => ({ width: 0, height: 0, getContext: () => createContext() }) };
global.window = global;

// A I-IV-V-ii progression at one chord per bar. The pitch classes matter: an earlier version of
// this harness filled pitches[12] with twelve independent random numbers per segment, which is not
// music - consecutive segments then share no harmony at all, so `harmonicShift` (cosine distance
// between adjacent chroma vectors) sat pinned near its maximum for the entire run. Every
// measurement of anything driven by harmony was reading a permanent chord change. The melody layer
// in Layers measured 6x calmer the moment the drive held an actual chord.
const TRIADS = [[0, 4, 7], [5, 9, 0], [7, 11, 2], [2, 5, 9]];
const BAR = 1.875; // 128 bpm, four beats

function fakeAudio(seed) {
	let st = seed;
	const r = () => ((st = (st * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	const beats = [];
	for (let t = 0.31; t < 400; t += 0.48) beats.push({ start: t, duration: 0.48, confidence: 0.6 + r() * 0.4 });
	const segments = [];
	const loudnessCurve = [];
	for (let t = 0; t < 400; t += 0.29) {
		const triad = TRIADS[Math.floor(t / BAR) % TRIADS.length];
		segments.push({
			start: t, duration: 0.29,
			loudness_start: -30 + r() * 25, loudness_max: -20 + r() * 18,
			loudness_max_time: r() * 0.2, loudness_end: -30 + r() * 25,
			pitches: Array.from({ length: 12 }, (_, i) => (triad.includes(i) ? 0.8 + r() * 0.2 : 0.04 + r() * 0.12)),
			timbre: [r() * 60, r() * 200 - 100, r() * 200 - 100, ...Array.from({ length: 9 }, () => r() * 100 - 50)]
		});
		loudnessCurve.push({ t, y: Math.pow(10, (-30 + r() * 28) / 20) });
	}
	const bars = [];
	for (let i = 0; i + 4 <= beats.length; i += 4)
		bars.push({ start: beats[i].start, duration: beats[i + 3].start - beats[i].start + 0.48, confidence: 0.8 });
	const sections = [];
	for (let i = 0; i < 400; i += 20)
		sections.push({ start: i, duration: 20, confidence: 0.7, loudness: i % 40 === 0 ? -17 : -9, tempo: 128, key: 0, mode: 1, time_signature: 4 });
	const ordered = sections.map((s, i) => ({ i, l: s.loudness })).sort((a, b) => a.l - b.l);
	const sectionIntensity = new Array(sections.length).fill(0);
	ordered.forEach((e, pos) => (sectionIntensity[e.i] = ordered.length > 1 ? pos / (ordered.length - 1) : 0.5));
	const { findMoments } = require(path.join(OUT, "track-structure.js"));
	return { beats, segments, loudnessCurve, tempo: 128, bars, sections, sectionIntensity, moments: findMoments(segments, bars, loudnessCurve) };
}

const { PRESETS } = require(path.join(OUT, "presets", "index.js"));
const W = 2560, H = 1440, FPS = 60, FRAMES = 3600, SETTLE = 300;
const audio = fakeAudio(7);
const wrap = d => ((d + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
const heading = s => Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
const knob = 0.5;
const targetCount = (base, max) => Math.min(max, Math.round(base * (0.4 + knob * 1.2)));

// Layers is the one preset whose groups are meaningfully different populations, so it gets a
// breakdown. Counts mirror the constants in flowfield-layers.ts; they only need to stay in sync
// while the split is wanted.
const LAYER_SPLIT = { bass: targetCount(180, 280), melody: targetCount(220, 340) };

function stats(values, digits = 3) {
	if (!values.length) return null;
	const d = values.slice().sort((a, b) => a - b);
	const q = p => d[Math.floor((d.length - 1) * p)];
	return { p50: q(0.5).toFixed(digits), p95: q(0.95).toFixed(digits), max: q(1).toFixed(digits) };
}

function analyse(name, framesOfStrokes) {
	const turns = [];
	const coherence = [];
	let light = 0;
	for (let f = 0; f < framesOfStrokes.length; f++) {
		const cur = framesOfStrokes[f];
		light += cur.reduce((s, x) => s + (x.light || 0), 0);
		const drawn = cur.filter(s => s.x2 !== undefined);
		if (drawn.length) {
			let sx = 0, sy = 0;
			for (const s of drawn) { const a = heading(s); sx += Math.cos(a); sy += Math.sin(a); }
			coherence.push(Math.hypot(sx, sy) / drawn.length);
		}
		const prev = f > 0 ? framesOfStrokes[f - 1].filter(s => s.x2 !== undefined) : [];
		for (let i = 0; i < Math.min(drawn.length, prev.length); i++) {
			const a = prev[i], b = drawn[i];
			if (Math.hypot(b.x1 - a.x2, b.y1 - a.y2) > 0.5) continue; // respawned - not a turn
			turns.push(Math.abs(wrap(heading(b) - heading(a))));
		}
	}
	const t = stats(turns);
	const corners = turns.filter(x => x > 0.35).length; // a visible corner: >20 degrees in one frame
	const coh = coherence.length ? coherence.reduce((s, x) => s + x, 0) / coherence.length : 0;
	console.log(
		`  ${name.padEnd(9)} light/frame ${String(Math.round(light / framesOfStrokes.length)).padStart(5)}` +
		(t ? `   turn/frame p50=${t.p50} p95=${t.p95} max=${t.max} rad   corners>20°: ${(corners / turns.length * 100).toFixed(3)}%` : "") +
		`   coherence ${coh.toFixed(2)}`
	);
	return coh;
}

for (const def of PRESETS) {
	const preset = def.create();
	const ctx = createContext();
	const captured = [];
	let t = 3;
	for (let f = 0; f < FRAMES; f++) {
		t += 1 / FPS;
		strokes = [];
		preset.draw({
			ctx, width: W, height: H, progressSec: t, isPlaying: true, audio,
			colorRgb: { r: 30.5, g: 215.2, b: 96.8 },
			mouse: { x: W * 0.5, y: H * 0.5, speed: 0, clicks: 0, rightClicks: 0, down: false, rightDown: false, scroll: 0.5, particleScale: knob }
		});
		if (f >= SETTLE) captured.push(strokes);
	}
	console.log(`\n${def.id}`);
	if (def.id === "flowfield-layers") {
		const { bass, melody } = LAYER_SPLIT;
		const headings = [];
		for (const group of [["bass", s => s.slice(0, bass)], ["melody", s => s.slice(bass, bass + melody)], ["perc", s => s.slice(bass + melody)]])
			headings.push(analyse(group[0], captured.map(group[1])));
		void headings;
		// do the three groups travel along one wind, or in unrelated directions?
		let agreement = 0;
		for (const frame of captured) {
			const groups = [frame.slice(0, bass), frame.slice(bass, bass + melody), frame.slice(bass + melody)];
			let sx = 0, sy = 0, n = 0;
			for (const g of groups) {
				const drawn = g.filter(s => s.x2 !== undefined);
				if (!drawn.length) continue;
				let gx = 0, gy = 0;
				for (const s of drawn) { const a = heading(s); gx += Math.cos(a); gy += Math.sin(a); }
				const m = Math.hypot(gx, gy);
				if (m > 1e-9) { sx += gx / m; sy += gy / m; n++; }
			}
			if (n) agreement += Math.hypot(sx, sy) / n;
		}
		console.log(`  agreement between the groups: ${(agreement / captured.length).toFixed(2)}  (1 = one wind, 0 = unrelated)`);
	} else {
		analyse("all", captured);
	}
}

// ---------------------------------------------------------------------------------------------
// Second drive: does the picture know which part of the song it is in?
//
// dB values are what Spotify actually reports. -26 is a quiet passage, -5 a loud one - about ten
// times the amplitude once dB is converted, which is the range the picture has to work with.
const SECTIONS = [
	{ name: "interlude", from: 6, to: 46, db: -26, beat: 0.6, percussive: false },
	{ name: "build", from: 46, to: 76, db: null, beat: 0.48, percussive: false },
	{ name: "drop", from: 76, to: 126, db: -5, beat: 0.3, percussive: true },
	{ name: "outro", from: 126, to: 166, db: -22, beat: 0.6, percussive: false }
];
const sectionAt = t => SECTIONS.find(s => t >= s.from && t < s.to) || SECTIONS[0];
const dbAt = t => {
	const s = sectionAt(t);
	return s.db !== null ? s.db : -26 + ((t - s.from) / (s.to - s.from)) * 21;
};

function songAudio() {
	let st = 5;
	const r = () => ((st = (st * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	const beats = [];
	for (let t = 6; t < 166; ) { beats.push({ start: t, duration: sectionAt(t).beat, confidence: 0.85 }); t += sectionAt(t).beat; }
	const segments = [];
	const loudnessCurve = [];
	for (let t = 0; t < 170; t += 0.29) {
		const s = sectionAt(t);
		const db = dbAt(t);
		const triad = TRIADS[Math.floor(t / BAR) % TRIADS.length];
		segments.push({
			start: t, duration: 0.29,
			loudness_start: db - 4, loudness_max: db, loudness_end: db - 3,
			loudness_max_time: s.percussive ? r() * 0.03 : 0.08 + r() * 0.14,
			pitches: Array.from({ length: 12 }, (_, i) => (triad.includes(i) ? 0.8 + r() * 0.2 : 0.05 + r() * 0.1)),
			timbre: [40, (s.percussive ? 40 : -20) + r() * 30, 10, ...Array.from({ length: 9 }, () => r() * 20 - 10)]
		});
		loudnessCurve.push({ t, y: Math.pow(10, (db - 2 + r() * 4) / 20) });
	}
	// the song shape as real sections, so anticipation has something true to look forward to
	const bars = [];
	for (let i = 0; i + 4 <= beats.length; i += 4)
		bars.push({ start: beats[i].start, duration: beats[i + 3].start - beats[i].start + beats[i].duration, confidence: 0.9 });
	const sections = SECTIONS.map(s => ({
		start: s.from,
		duration: s.to - s.from,
		confidence: 0.9,
		loudness: s.db === null ? -16 : s.db,
		tempo: 128,
		key: 0,
		mode: 1,
		time_signature: 4
	}));
	const ordered = sections.map((s, i) => ({ i, l: s.loudness })).sort((a, b) => a.l - b.l);
	const sectionIntensity = new Array(sections.length).fill(0);
	ordered.forEach((e, pos) => (sectionIntensity[e.i] = ordered.length > 1 ? pos / (ordered.length - 1) : 0.5));
	const { findMoments } = require(path.join(OUT, "track-structure.js"));
	return { beats, segments, loudnessCurve, tempo: 128, bars, sections, sectionIntensity, moments: findMoments(segments, bars, loudnessCurve) };
}

const song = songAudio();
console.log("");
console.log("section response - light per frame, and how far a particle travels per second");
console.log("preset                interlude       drop         drop/interlude");
for (const def of PRESETS) {
	const preset = def.create();
	const ctx = createContext();
	const acc = {};
	for (const s of SECTIONS) acc[s.name] = { light: 0, len: 0, n: 0, frames: 0 };
	let t = 3;
	for (let f = 0; f < 166 * FPS; f++) {
		t += 1 / FPS;
		if (t >= 166) break;
		strokes = [];
		preset.draw({
			ctx, width: W, height: H, progressSec: t, isPlaying: true, audio: song,
			colorRgb: { r: 30.5, g: 215.2, b: 96.8 },
			mouse: { x: W * 0.5, y: H * 0.5, speed: 0, clicks: 0, rightClicks: 0, down: false, rightDown: false, scroll: 0.5, particleScale: knob }
		});
		if (t < 6) continue;
		const b = acc[sectionAt(t).name];
		b.frames++;
		for (const s of strokes) {
			b.light += s.light || 0;
			if (s.x2 !== undefined) { b.len += Math.hypot(s.x2 - s.x1, s.y2 - s.y1); b.n++; }
		}
	}
	const lightOf = k => acc[k].light / Math.max(1, acc[k].frames);
	const speedOf = k => (acc[k].n ? (acc[k].len / acc[k].n) * FPS : 0);
	const ratio = lightOf("interlude") > 0.01 ? lightOf("drop") / lightOf("interlude") : 0;
	console.log(
		`${def.id.padEnd(20)} ${String(Math.round(lightOf("interlude"))).padStart(6)} ${String(Math.round(speedOf("interlude"))).padStart(5)}px/s` +
		` ${String(Math.round(lightOf("drop"))).padStart(6)} ${String(Math.round(speedOf("drop"))).padStart(5)}px/s` +
		`    light x${ratio.toFixed(2)}  speed x${(speedOf("drop") / Math.max(1, speedOf("interlude"))).toFixed(2)}`
	);
}
