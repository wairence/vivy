// "Listening" to a dump: everything the analysis will say about the MUSIC, arranged the way a
// listener hears it - bars, phrases, where the drums come in and drop out, where the harmony moves,
// where the fills are - so that a claim about what the picture SHOULD do can be checked against what
// the music is actually doing rather than against a memory of it.
//
// Nothing here runs at playback. It is a reading tool.
//
//   node music-lab.js "<dump name>"              the music
//   node music-lab.js "<dump name>" --picture    the music, and what the preset does beside it
//   node music-lab.js "<dump name>" --audio-json the track as a preset sees it, for preview-harness ?audio=
//   node music-lab.js "<dump name>" --picture --preset=layers3d   ...another preset
//
// --picture needs the compiled preset: run `npm run check` once first.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const DIR = path.join(__dirname, "analysis-dumps");

function load(name) {
	const d = JSON.parse(fs.readFileSync(path.join(DIR, name + ".json"), "utf8"));
	const segments = d.segments.map(g => ({
		start: g[0],
		duration: g[1],
		loudMax: g[2],
		maxTime: g[3],
		pitches: g[4],
		timbre: g[5],
		loudStart: g[6],
		confidence: g[8]
	}));
	const bars = d.bars.map(b => ({ start: b[0], duration: b[1], confidence: b[2] }));
	const beats = d.beats.map(b => ({ start: b[0], duration: b[1], confidence: b[2] }));
	const sections = d.sections.map(s => ({
		start: s[0], duration: s[1], confidence: s[2], loudness: s[3],
		tempo: s[4], key: s[5], mode: s[6], sig: s[7]
	}));
	// the same per-track normalisation the preset sees - ENERGY_QUIET/ENERGY_LOUD out of
	// audio-data.ts, verbatim. It said "the same" and used 0.12..0.85 against production's
	// 0.06..0.62 until 2026-09-16, so every range this tool has ever printed, and the behaviour of
	// the preset it drives under --picture, were measured on a curve a third wider than the one
	// that ships. Correlations survive an affine change; ranges do not.
	const ys = d.curve.map(p => p[1]).slice().sort((a, b) => a - b);
	const lo = ys[Math.floor((ys.length - 1) * 0.05)];
	const hi = ys[Math.floor((ys.length - 1) * 0.95)];
	const sc = (0.62 - 0.06) / Math.max(1e-4, hi - lo);
	const curve = d.curve.map(p => ({
		t: p[0],
		y: Math.max(0, Math.min(1, (0.06 + (p[1] - lo) * sc) * 0.7 + p[1] * 0.3))
	}));
	return { name: d.name, track: d.track, segments, beats, bars, sections, curve };
}

function at(curve, t) {
	let lo = 0;
	let hi = curve.length - 1;
	if (t <= curve[0].t) return curve[0].y;
	if (t >= curve[hi].t) return curve[hi].y;
	while (hi - lo > 1) {
		const m = (lo + hi) >> 1;
		if (curve[m].t <= t) lo = m;
		else hi = m;
	}
	return curve[lo].y;
}

function mean(curve, a, b) {
	let s = 0;
	let n = 0;
	for (let t = a; t <= b; t += 0.05) {
		s += at(curve, t);
		n++;
	}
	return n ? s / n : 0;
}

// the eight onset bands, lowest first
function onsetBands(track) {
	if (!track || !track.rhythmstring) return null;
	const raw = Buffer.from(track.rhythmstring.replace(/-/g, "+").replace(/_/g, "/"), "base64");
	const v = zlib.inflateSync(raw).toString("utf8").trim().split(/\s+/).map(Number);
	const sr = v[0];
	const hop = v[1];
	const nb = v[2];
	let i = 3;
	const bands = [];
	for (let b = 0; b < nb; b++) {
		const n = v[i++];
		const out = [];
		let c = 0;
		for (let k = 0; k < n; k++) {
			c += v[i++];
			out.push((c * hop) / sr);
		}
		bands.push(out);
	}
	return bands;
}

const cos = (a, b) => {
	let d = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		d += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return d / Math.max(1e-9, Math.sqrt(na * nb));
};

// A phrase is a repeating group of bars. The length is measured rather than assumed to be four:
// the bar-level harmony is compared with itself at 2, 4, 8 and 16 bars and the best is taken.
function phraseLength(barFeat) {
	let best = 4;
	let bestScore = -1;
	for (const step of [2, 4, 8, 16]) {
		let s = 0;
		let n = 0;
		for (let i = 0; i + step < barFeat.length; i++) {
			s += cos(barFeat[i], barFeat[i + step]);
			n++;
		}
		if (n > 4 && s / n > bestScore) {
			bestScore = s / n;
			best = step;
		}
	}
	return { bars: best, agreement: bestScore };
}

function read(d) {
	const bands = onsetBands(d.track);
	const bars = d.bars.length > 8 ? d.bars : [];
	const barOf = [];
	for (let i = 0; i < bars.length; i++) {
		const a = bars[i].start;
		const b = a + bars[i].duration;
		const inBar = d.segments.filter(s => s.start >= a && s.start < b);
		const chroma = new Array(12).fill(0);
		let bright = 0;
		let w = 0;
		for (const s of inBar) {
			for (let k = 0; k < 12; k++) chroma[k] += s.pitches[k] * s.duration;
			bright += s.timbre[1] * s.duration;
			w += s.duration;
		}
		if (w > 0) {
			for (let k = 0; k < 12; k++) chroma[k] /= w;
			bright /= w;
		}
		const dur = Math.max(0.2, bars[i].duration);
		const low = bands ? bands.slice(0, 3).reduce((n, band) => n + band.filter(t => t >= a && t < b).length, 0) : 0;
		const high = bands ? bands.slice(5).reduce((n, band) => n + band.filter(t => t >= a && t < b).length, 0) : 0;
		barOf.push({
			i,
			t: a,
			dur,
			chroma,
			bright,
			loud: mean(d.curve, a, b),
			low: low / dur,
			high: high / dur,
			segs: inBar.length / dur
		});
	}
	const phrase = barOf.length > 8 ? phraseLength(barOf.map(b => b.chroma)) : { bars: 4, agreement: 0 };
	return { bars: barOf, phrase, bands };
}

module.exports = { load, read, at, mean, onsetBands, cos };

// The track as a preset sees it: the TrackAudioData shape, built from a dump the way the client
// builds it from the endpoint. Shared by --picture, --audio-json and the scratch drivers.
function presetAudio(d) {
	const { findMoments } = require(path.join(__dirname, "node_modules", ".cache", "preset-check", "track-structure.js"));
	const bands = onsetBands(d.track);
	const hits = [];
	if (bands) {
		const all = [];
		bands.forEach((on, b) => { for (const t of on) all.push({ t, b }); });
		all.sort((x, y) => x.t - y.t);
		let j = 0;
		while (j < all.length) {
			let k = j;
			const seen = new Set();
			let sum = 0;
			while (k < all.length && all[k].t - all[j].t <= 0.025) { seen.add(all[k].b); sum += all[k].t; k++; }
			if (seen.size >= 3) { hits.push({ t: sum / (k - j), bands: seen.size }); j = k; } else j++;
		}
	}
	const ord = d.sections.map((s, i) => ({ i, l: s.loudness })).sort((a, b) => a.l - b.l);
	const rank = new Array(d.sections.length).fill(0.5);
	ord.forEach((e, p2) => { rank[e.i] = d.sections.length > 1 ? p2 / (d.sections.length - 1) : 0.5; });
	const lm = d.segments.map(s => Math.pow(10, s.loudMax / 20)).sort((a, b) => a - b);
	const segsForPreset = d.segments.map(s => ({
		start: s.start, duration: s.duration, loudness_max: s.loudMax, loudness_max_time: s.maxTime,
		loudness_start: s.loudStart, loudness_end: 0, pitches: s.pitches, timbre: s.timbre, confidence: s.confidence
	}));
	return {
		beats: d.beats, segments: segsForPreset, loudnessCurve: d.curve, tempo: d.track.tempo,
		bars: d.bars, sections: d.sections.map(s => ({ start: s.start, duration: s.duration, confidence: s.confidence, loudness: s.loudness, tempo: s.tempo, key: s.key, mode: s.mode, time_signature: s.sig })),
		sectionIntensity: rank, hitScale: Math.max(0.02, lm[Math.floor((lm.length - 1) * 0.98)]),
		moments: findMoments(segsForPreset, d.bars, d.curve), tatums: [], hits,
		timbreSorted: d.segments.map(s => s.timbre[1]).sort((a, b) => a - b), trackInfo: d.track
	};
}

// ---- what the preset does, phrase by phrase --------------------------------------------------
function renderPhrases(d, r) {
	const OUT = path.join(__dirname, "node_modules", ".cache", "preset-check");
	let segs = [];
// what a pixel preset put on screen this frame, in the same units as `ink` (see putImageData below)
let pixelLight = 0;
	let pending = null;
	const alphaOf = v => {
		const m = /^rgba\(([^)]*)\)$/.exec(String(v));
		return m ? Number(m[1].split(",")[3]) : 1;
	};
	const ctx = () => {
		const c = {};
		const noop = () => {};
		for (const m of ["clearRect","strokeRect","beginPath","closePath","arc","rect","fill","save","restore","translate","rotate","scale","drawImage","fillText","strokeText","setLineDash"]) c[m] = noop;
		// A PRESET THAT DRAWS IN DOTS. Plate puts down one fillRect per grain and no strokes at all,
		// so without this its light measured as zero exactly like Smoke's did. Area x alpha, which is
		// the same quantity `ink` means for a stroke - and the full-frame fill that clears the canvas
		// is skipped, or the clear would be most of the light.
		c.fillRect = (x, y, w2, h2) => {
			if (w2 >= 2000 || h2 >= 2000) return;
			pixelLight += w2 * h2 * alphaOf(c.fillStyle) * 0.02;
		};
		// A PIXEL PRESET HAS NO STROKES, and "light" for it is the buffer it hands over. Smoke draws
		// one `putImageData` a frame and nothing else, so without this its whole picture measured as
		// zero and every correlation below was undefined. Luminance summed over the buffer, scaled to
		// sit in the same rough range as a stroke preset's ink so the two are readable side by side.
		c.putImageData = img => {
			if (!img || !img.data) return;
			let lum = 0;
			for (let i = 0; i < img.data.length; i += 4)
				lum += img.data[i] * 0.2126 + img.data[i + 1] * 0.7152 + img.data[i + 2] * 0.0722;
			pixelLight += lum / 255;
		};
		c.measureText = t => ({ width: String(t).length * 6 });
		c.moveTo = (x, y) => { pending = { x1: x, y1: y }; };
		c.lineTo = (x, y) => { if (pending) { pending.x2 = x; pending.y2 = y; } };
		c.stroke = () => {
			if (pending && pending.x2 !== undefined) { pending.a = alphaOf(c.strokeStyle); pending.w = c.lineWidth; segs.push(pending); }
			pending = null;
		};
		c.createLinearGradient = c.createRadialGradient = () => ({ addColorStop: noop });
		c.createImageData = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
		for (const k of ["fillStyle", "strokeStyle"]) { let held = "#000"; Object.defineProperty(c, k, { get: () => held, set: v => { held = v; } }); }
		c.lineWidth = 1;
		return c;
	};
	global.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx() }) };
	global.window = global;
	const { PRESETS } = require(path.join(OUT, "presets", "index.js"));
	const common = require(path.join(OUT, "presets", "flowfield-common.js"));

	const audio = presetAudio(d);
	const W = 2560;
	const H = 1440;
	const FPS = 30;
	const id = (process.argv.find(a => a.startsWith("--preset=")) || "--preset=ridge").slice(9);
	const definition = PRESETS.find(p2 => p2.id === id);
	if (!definition) {
		console.error("no such preset: " + id + " (have: " + PRESETS.map(p2 => p2.id).join(", ") + ")");
		process.exit(1);
	}
	// the V key, from the command line: a preset's variants are parameter sets, and a measurement
	// that only ever sees the first one is measuring a third of the preset
	common.setVariant(Number((process.argv.find(a => a.startsWith("--variant=")) || "--variant=0").slice(10)));
	const preset = definition.create();
	// WHERE THE EVENT LAYER STARTS, in stroke order. It was a hardcoded 400, which was the answer at
	// the window this was first run in and has been wrong ever since: at 2560x1440 the density
	// multiplier is 3.33, so Layers II draws 600 ground strokes and 733 sheet strokes before the
	// first mark, and everything this tool has called a "mark" was the tail of the sheet. Derived
	// from the same constants the preset uses, so it moves with the canvas.
	// A preset with no separate event layer says so instead of guessing - Flow Field's events are
	// light on a fixed population, which is not a population at all.
	const dens = Math.min(6, (W * H) / (1080 * 1024));
	const EVENT_LAYER_AT = { layers2: Math.round(180 * dens) + Math.round(220 * dens), layers3: Math.round(180 * dens) + Math.round(220 * dens) };
	const eventAt = EVENT_LAYER_AT[id];
	const c2 = ctx();
	const mouse = { x: W / 2, y: H / 2, speed: 0, clicks: 0, rightClicks: 0, down: false, rightDown: false, scroll: 0.5, particleScale: 0.5 };
	const len = s => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
	const dur = Math.min(d.track.duration, d.curve[d.curve.length - 1].t);
	const frames = [];
	for (let f = 0; f < dur * FPS; f++) {
		const t = f / FPS;
		segs = [];
		pixelLight = 0;
		preset.draw({ ctx: c2, width: W, height: H, progressSec: t, isPlaying: true, audio, colorRgb: { r: 30, g: 215, b: 96 }, mouse });
		const sp = eventAt === undefined ? [] : segs.slice(eventAt);
		// where the marks sit across the wind, which is the register channel. The wind's heading is
		// taken from where the marks are actually travelling this frame.
		let across = 0;
		if (sp.length > 3) {
			let dx = 0;
			let dy = 0;
			for (const g of sp) { dx += g.x2 - g.x1; dy += g.y2 - g.y1; }
			const L2 = Math.hypot(dx, dy) || 1;
			const ax = -dy / L2;
			const ay = dx / L2;
			for (const g of sp) across += ((g.x1 - W / 2) * ax + (g.y1 - H / 2) * ay);
			across = across / sp.length / (Math.min(W, H) * 0.46);
		}
		const moving = eventAt === undefined ? segs : sp;
		// a preset with no strokes reports its own motion through the diagnostics channel - for Smoke
		// that is the fastest cell in the room, which is what "how fast is the picture moving" means
		// when the picture is a field rather than a set of objects
		const diag = common.lastDiagnostics && common.lastDiagnostics.values;
		const simSpeed = diag && typeof diag.meanSpeed === "number" ? diag.meanSpeed : 0;
		frames.push({
			t,
			ink: segs.reduce((a, g) => a + len(g) * (g.w || 0) * (g.a || 0), 0) + pixelLight,
			marks: sp.filter(g => (g.a || 0) > 0.02).length,
			speed: moving.length ? (moving.reduce((a, g) => a + len(g), 0) / moving.length) * FPS : simSpeed,
			across,
			// the whole picture's alpha distribution, so a ceiling can be set from the measurement
			// rather than from taste (DESIGN-RULES §3b) - a cap with p50 anywhere near it has become
			// the value and the dynamics underneath it are gone
			alphaP50: segs.length ? segs.map(g => g.a || 0).sort((x, y) => x - y)[segs.length >> 1] : 0,
			alphaP95: segs.length ? segs.map(g => g.a || 0).sort((x, y) => x - y)[Math.floor((segs.length - 1) * 0.95)] : 0
		});
	}
	return frames;
}
module.exports.renderPhrases = renderPhrases;
module.exports.presetAudio = presetAudio;

if (require.main === module) {
	const d = load(process.argv[2]);
	// the track as the preset sees it, for the preview harness: ?audio=shots/<name>.audio.json
	if (process.argv.includes("--audio-json")) {
		const file = path.join(__dirname, "shots", process.argv[2] + ".audio.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(presetAudio(d)));
		console.log("wrote " + path.relative(__dirname, file));
		process.exit(0);
	}
	const r = read(d);
	const B = r.bars;
	const mmss = t => Math.floor(t / 60) + ":" + String(Math.floor(t % 60)).padStart(2, "0");
	const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) * p)];

	console.log("\n=== " + d.name + " ===");
	console.log(
		d.track.duration.toFixed(0) + "s, " + d.track.tempo.toFixed(0) + " bpm, " + d.track.time_signature + "/4, " +
		"key " + d.track.key + " " + (d.track.mode ? "major" : "minor") + " (conf " + d.track.key_confidence.toFixed(2) + ")"
	);
	console.log(d.bars.length + " bars, " + d.beats.length + " beats, " + d.segments.length + " segments, " + d.sections.length + " sections");
	console.log("phrase length: " + r.phrase.bars + " bars (self-agreement " + r.phrase.agreement.toFixed(2) + ")");

	console.log("\n-- sections ------------------------------------------------------------------");
	for (const s of d.sections) {
		const inSec = B.filter(b => b.t >= s.start && b.t < s.start + s.duration);
		const l = inSec.length ? inSec.reduce((a, b) => a + b.loud, 0) / inSec.length : 0;
		const dr = inSec.length ? inSec.reduce((a, b) => a + b.low, 0) / inSec.length : 0;
		console.log(
			"  " + mmss(s.start).padStart(5) + " " + s.duration.toFixed(0).padStart(3) + "s   loud " + l.toFixed(2) +
			"   low-onsets " + dr.toFixed(1) + "/s   " + s.tempo.toFixed(0) + "bpm   conf " + s.confidence.toFixed(2)
		);
	}
	// The onset bands cannot answer this. Measured on the first track read with them: the low band
	// runs at 8.5 events a second from the first bar to the last and never moves - the same thing
	// found across 81 dumps, a band's own rate is pinned whatever the music does. So texture is read
	// from what does move: how many separate sounds a bar holds, and how loud it is.
	console.log("");
	console.log("-- texture, bar by bar (events per second against this track median) -------");
	const medSegs = q(B.map(b => b.segs), 0.5);
	let state = null;
	let changes = 0;
	for (const b of B) {
		const busy = b.segs > medSegs * 0.78;
		if (state === null) { state = busy; continue; }
		if (busy !== state) {
			console.log("  " + mmss(b.t).padStart(5) + "   " + (busy ? "fills in " : "thins out") + "   " + b.segs.toFixed(1) + "/s against " + medSegs.toFixed(1));
			state = busy;
			changes++;
		}
	}
	if (changes === 0) console.log("  even all the way through, " + medSegs.toFixed(1) + " events a second");

	console.log("\n-- harmony -------------------------------------------------------------------");
	const moves = [];
	for (let i = 1; i < B.length; i++) moves.push({ t: B[i].t, d: 1 - cos(B[i].chroma, B[i - 1].chroma) });
	const bigMove = q(moves.map(m => m.d), 0.85);
	console.log(
		"  moves on " + (moves.filter(m => m.d > bigMove).length / (d.track.duration / 60)).toFixed(1) +
		" bars per minute (top 15% of bar-to-bar change)"
	);
	console.log("  biggest: " + moves.slice().sort((a, b) => b.d - a.d).slice(0, 6).map(m => mmss(m.t)).join(", "));

	console.log("\n-- fills at phrase ends ------------------------------------------------------");
	const P = r.phrase.bars;
	const fills = [];
	for (let i = 1; i < B.length - 1; i++) {
		const near = B.slice(Math.max(0, i - P), i).map(b => b.segs);
		if (near.length < 2) continue;
		const base = near.reduce((a, x) => a + x, 0) / near.length;
		if (B[i].segs > base * 1.4 && (i + 1) % P === 0) fills.push({ t: B[i].t, r: B[i].segs / base });
	}
	console.log("  " + (fills.length ? fills.map(f => mmss(f.t) + " (x" + f.r.toFixed(1) + ")").join(", ") : "none found"));

	const withPicture = process.argv.includes("--picture");
	const frames = withPicture ? require("./music-lab").renderPhrases(d, r) : null;
	const over = (a, b, pick) => {
		const f = frames.filter(x => x.t >= a && x.t < b);
		return f.length ? f.reduce((s, x) => s + pick(x), 0) / f.length : 0;
	};
	console.log("");
	console.log("-- the music, phrase by phrase" + (withPicture ? ", and what the preset does" : "") + " ---------------");
	if (withPicture) console.log("           MUSIC                                   |  PICTURE");
	const rows = [];
	for (let i = 0; i + P <= B.length; i += P) {
		const ph = B.slice(i, i + P);
		const a = ph[0].t;
		const b = ph[ph.length - 1].t + ph[ph.length - 1].dur;
		const l = ph.reduce((x, y) => x + y.loud, 0) / ph.length;
		const ev = ph.reduce((x, y) => x + y.segs, 0) / ph.length;
		const br = ph.reduce((x, y) => x + y.bright, 0) / ph.length;
		let line = "  " + mmss(a).padStart(5) + "  loud " + l.toFixed(2) + " " + "#".repeat(Math.round(l * 24)).padEnd(24) + " ev " + ev.toFixed(1).padStart(4) + "  ring " + br.toFixed(0).padStart(5);
		if (withPicture) {
			const ink = over(a, b, x => x.ink);
			const marks = over(a, b, x => x.marks);
			const speed = over(a, b, x => x.speed);
			rows.push({ loud: l, ev, ink, marks, speed, ring: br, across: over(a, b, x => x.across) });
			line += "  |  light " + ink.toFixed(0).padStart(5) + "  marks " + marks.toFixed(0).padStart(3) + "  speed " + speed.toFixed(0).padStart(4) + "  place " + over(a, b, x => x.across).toFixed(2).padStart(5);
		}
		console.log(line);
	}
	if (withPicture && rows.length > 2) {
		const corr = (f, g) => {
			const n = rows.length;
			const mx = rows.reduce((s, x) => s + f(x), 0) / n;
			const my = rows.reduce((s, x) => s + g(x), 0) / n;
			let sxy = 0, sx = 0, sy = 0;
			for (const x of rows) { const dx = f(x) - mx, dy = g(x) - my; sxy += dx * dy; sx += dx * dx; sy += dy * dy; }
			return sxy / Math.max(1e-9, Math.sqrt(sx * sy));
		};
		const span = f => { const v = rows.map(f).sort((x, y) => x - y); return v[v.length - 1] / Math.max(1e-9, v[0]); };
		console.log("");
		console.log("-- does the picture follow the music, phrase to phrase? ---------------------");
		console.log("  light vs loudness   r " + corr(x => x.ink, x => x.loud).toFixed(2) + "    music spans x" + span(x => x.loud).toFixed(1) + ", light spans x" + span(x => x.ink).toFixed(1));
		const anyMarks = rows.some(x => x.marks > 0);
		if (anyMarks)
			console.log("  marks vs events     r " + corr(x => x.marks, x => x.ev).toFixed(2) + "    music spans x" + span(x => x.ev).toFixed(1) + ", marks span x" + span(x => x.marks).toFixed(1));
		else console.log("  marks               - this preset has no event layer: its events are light on a fixed population");
		console.log("  speed vs loudness   r " + corr(x => x.speed, x => x.loud).toFixed(2) + "    speed spans x" + span(x => x.speed).toFixed(1));
		// loudness drives both the number of sounds and the number of marks, so the raw correlation
		// between them says little. This one holds loudness still and asks what is left.
		const partial = (f, g, h) => {
			const rfg = corr(f, g);
			const rfh = corr(f, h);
			const rgh = corr(g, h);
			return (rfg - rfh * rgh) / Math.max(1e-9, Math.sqrt((1 - rfh * rfh) * (1 - rgh * rgh)));
		};
		console.log("  place vs how ringing the music is   r " + corr(x => x.across, x => x.ring).toFixed(2) + "    (the register channel)");
		if (anyMarks)
			console.log("  marks vs events, with loudness held still   r " + partial(x => x.marks, x => x.ev, x => x.loud).toFixed(2));
		const meanOf = f => frames.reduce((a, x) => a + f(x), 0) / Math.max(1, frames.length);
		const topOf = f => frames.map(f).sort((a, b) => a - b)[Math.floor((frames.length - 1) * 0.95)];
		console.log("  stroke alpha        p50 " + meanOf(x => x.alphaP50).toFixed(3) + "  p95 " + meanOf(x => x.alphaP95).toFixed(3) +
			"  worst-frame p95 " + topOf(x => x.alphaP95).toFixed(3) + "   (the ceiling belongs above this, never through it)");

		// ---- where the two disagree ------------------------------------------------------------
		// Bar by bar, both put on the same scale, and the bars where they part company most. This is
		// the automated form of a listener pointing at a second and saying "that is wrong".
		const perBar = B.map(b => {
			const f = frames.filter(x => x.t >= b.t && x.t < b.t + b.dur);
			return { t: b.t, loud: b.loud, ink: f.length ? f.reduce((s2, x) => s2 + x.ink, 0) / f.length : 0 };
		}).filter(x => x.ink > 0);
		const z = arr => {
			const m = arr.reduce((a, x) => a + x, 0) / arr.length;
			const sd = Math.sqrt(arr.reduce((a, x) => a + (x - m) * (x - m), 0) / arr.length) || 1;
			return arr.map(x => (x - m) / sd);
		};
		const zm = z(perBar.map(x => x.loud));
		const zp = z(perBar.map(x => x.ink));
		const gap = perBar.map((x, i) => ({ t: x.t, d: zp[i] - zm[i] }));
		const worst = gap.slice().sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 8).sort((a, b) => a.t - b.t);
		console.log("");
		console.log("-- the bars where the picture and the music disagree most ------------------");
		for (const w of worst) {
			console.log("  " + mmss(w.t).padStart(5) + "   picture is " + (w.d > 0 ? "BRIGHTER" : "darker  ") + " than the music by " + Math.abs(w.d).toFixed(2) + " of a standard deviation");
		}
	}
}
