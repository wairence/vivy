import { PRESETS, Preset } from "./src/presets";
import { getVariant, lastConducted, lastDiagnostics, setVariant } from "./src/presets/flowfield-common";
import { normaliseCurve } from "./src/audio-data";
import { hexToRgb, setColours } from "./src/colours";

function fakeAudio() {
	let state = 7;
	const random = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	const beats: { start: number; duration: number; confidence: number }[] = [];
	for (let t = 0.31; t < 600; t += 0.48) beats.push({ start: t, duration: 0.48, confidence: 0.6 + random() * 0.4 });
	const segments: any[] = [];
	const loudnessCurve: { t: number; y: number }[] = [];
	for (let t = 0; t < 600; t += 0.29) {
		const loudness_max = -14 + Math.sin(t * 0.3) * 8 + random() * 4;
		segments.push({
			start: t,
			duration: 0.29,
			loudness_start: loudness_max - 6 - random() * 4,
			loudness_max,
			loudness_max_time: random() * 0.2,
			loudness_end: loudness_max - 8 - random() * 4,
			pitches: Array.from({ length: 12 }, (_, i) => Math.max(0, Math.sin(t * 0.2 + i * 1.3) * 0.5 + 0.5 + random() * 0.2 - 0.1)),
			// timbre[1] is "how ringing was that sound", and it is what every preset here places a mark,
			// a band or a puff by. It used to be a pure slow sine, which is not what a track does: one
			// sound is dull and the next is bright, on top of a slow drift in the mix. With the sine
			// alone every event in this harness landed in the same place on the register axis and
			// Smoke drew one blob - a picture of the harness, not of the preset.
			timbre: [20 + random() * 40, Math.sin(t * 0.15) * 35 + (random() - 0.5) * 95, random() * 100 - 50, ...Array.from({ length: 9 }, () => random() * 100 - 50)]
		});
		loudnessCurve.push({ t, y: Math.pow(10, loudness_max / 20) });
	}
	// bars, sections and hitScale as well: the scope preset draws the metrical grid and the track's
	// own hit scale, and a harness that omits them is not showing what the client shows
	const bars: { start: number; duration: number; confidence: number }[] = [];
	for (let i = 0; i + 4 <= beats.length; i += 4)
		bars.push({ start: beats[i].start, duration: beats[i + 3].start - beats[i].start + beats[i].duration, confidence: 0.8 });
	const sections = [0, 45, 90, 150, 210].map((start, i, all) => ({
		start,
		duration: (all[i + 1] ?? 300) - start,
		confidence: 0.8,
		loudness: [-18, -12, -6, -14, -5][i],
		tempo: 128,
		key: 0,
		mode: 1,
		time_signature: 4
	}));
	const order = sections.map((s, i) => ({ i, l: s.loudness })).sort((a, b) => a.l - b.l);
	const sectionIntensity = new Array(sections.length).fill(0);
	order.forEach((e, p) => (sectionIntensity[e.i] = p / (order.length - 1)));
	// THE SAME STRETCH THE CLIENT APPLIES. Without it the fake track sits at about 0.2 for its whole
	// length - the bottom of the range every preset is tuned against - and everything looks dark and
	// slow here while looking right in Spotify. Both presets rendered as a near-black field of specks
	// in this harness until 2026-09-17, and neither of them was broken.
	normaliseCurve(loudnessCurve);
	const sorted = segments.map(s => Math.pow(10, s.loudness_max / 20)).sort((a, b) => a - b);
	// EVERYTHING A PRESET READS, not only what the first preset to use this harness happened to read.
	// `timbreSorted` was missing, and `rankOf` returns 0.5 when it is - so every preset that places a
	// mark, a band or a puff by register put all of them in the same spot here, and Smoke rendered as
	// one blob in the middle of the screen while being perfectly correct. A harness that omits a field
	// does not show a neutral picture, it shows a WRONG one.
	const timbreSorted = segments.map(s => s.timbre[1]).sort((a, b) => a - b);
	return {
		timbreSorted,
		hits: [],
		tatums: [],
		trackInfo: {},
		beats,
		segments,
		loudnessCurve,
		tempo: 128,
		bars,
		sections,
		sectionIntensity,
		moments: [],
		hitScale: sorted[Math.floor((sorted.length - 1) * 0.98)]
	};
}

const params = new URLSearchParams(location.search);
// ?audio=shots/<track>.audio.json plays a REAL track, exported by `node music-lab.js "<track>"
// --audio-json` - the same TrackAudioData the client builds. The fake one above is for smoke tests;
// judging a look needs a real drop. Synchronous on purpose: everything below reads `audio` at once.
function loadAudio(url: string) {
	const xhr = new XMLHttpRequest();
	xhr.open("GET", url, false);
	xhr.send();
	if (xhr.status !== 200) throw new Error("no audio at " + url);
	return JSON.parse(xhr.responseText);
}
const audio = params.get("audio") ? loadAudio(params.get("audio")!) : fakeAudio();
// ?at=<seconds>: the warm-up ENDS here, so a shot shows that moment of the track with the history in
// front of it that the client would have had
const warmupFrames = Number(params.get("warmup") || 0);
const trackStart = params.get("at") ? Math.max(0, Number(params.get("at")) - warmupFrames / 60) : 3;
const colorRgb = { r: 30, g: 195, b: 140 };
// a cover's three colours, dark to light (?palette=hex,hex,hex): what the client gets from the art
const palette = (params.get("palette") || "1b2a4a,c8406e,f2c38b").split(",").map(h => hexToRgb("#" + h));
// colours set from the console or a driver: setColours("layers3d", { follows: "depth" })
(window as any).setColours = setColours;

const canvas = document.getElementById("c") as HTMLCanvasElement;
const label = document.getElementById("label") as HTMLDivElement;
// { alpha: false } like the app and the live window. Without it the trail canvas never becomes
// opaque, and `fadeTrail`'s color-burn pass - which needs an opaque backdrop to blend against -
// paints its own near-white source colour instead, washing the whole harness to light grey. The
// preset looks broken and is not: the difference is one context flag.
const ctx = canvas.getContext("2d", { alpha: false })!;

function resize() {
	// a fresh/backgrounded tab can report clientWidth=0 before layout has actually run - fall back to
	// a fixed size instead of ending up with a 0x0 canvas
	const cw = canvas.clientWidth || 1280;
	const ch = canvas.clientHeight || 720;
	const w = Math.round(cw * devicePixelRatio);
	const h = Math.round(ch * devicePixelRatio);
	// ONLY IF IT ACTUALLY CHANGED. Assigning canvas.width clears the canvas even when the value is
	// identical, and a headless tab fires a resize after layout settles - so the screenshot came out
	// black whenever that landed after the last frame was drawn. Every trail-based preset here is
	// nothing BUT accumulated frames, so a stray clear is the whole picture.
	if (canvas.width === w && canvas.height === h) return;
	canvas.width = w;
	canvas.height = h;
}
resize();
window.addEventListener("resize", resize);

// clicks/scroll are part of MouseState in the real app (cumulative click counter + a persistent
// 0..1 scroll fader); without them every preset reading mouse.scroll gets NaN speeds here
const mouse = {
	x: canvas.width / 2,
	y: canvas.height / 2,
	speed: 0,
	clicks: 0,
	rightClicks: 0,
	down: false,
	rightDown: false,
	scroll: 0.5,
	particleScale: 0.5
};
let prevMouseX = mouse.x;
let prevMouseY = mouse.y;
canvas.addEventListener("mousemove", e => {
	const rect = canvas.getBoundingClientRect();
	mouse.x = ((e.clientX - rect.left) / rect.width) * canvas.width;
	mouse.y = ((e.clientY - rect.top) / rect.height) * canvas.height;
});

let presetIndex = 0;
let preset: Preset = PRESETS[0].create();
let usePaused = false;
const start = performance.now();
let pauseStart = 0;
let pausedAccum = 0;

function switchPreset(i: number) {
	presetIndex = (i + PRESETS.length) % PRESETS.length;
	preset = PRESETS[presetIndex].create();
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	label.textContent = `${presetIndex + 1}/${PRESETS.length}  ${PRESETS[presetIndex].name} (${PRESETS[presetIndex].id})  v${getVariant()}  paused=${usePaused}`;
}
// the V key in the client, here - a preset's variants are the thing that cannot be chosen from a
// description, so the harness that exists for looking has to be able to show them
// what the machine believes, from the console. The same question the B key answers in the client,
// and the reason this exists: a picture that looks wrong here is either a preset fault or a harness
// fault, and the only way to tell them apart is to read the signals the preset was handed.
(window as any).conducted = () => {
	const c = lastConducted as unknown as Record<string, unknown> | null;
	if (!c) return null;
	const out: Record<string, number> = {};
	for (const k of Object.keys(c)) if (typeof c[k] === "number") out[k] = Number((c[k] as number).toFixed(4));
	return out;
};
// and what a simulation says about itself, for a preset whose state is not in its draw calls
(window as any).diagnostics = () => lastDiagnostics;
(window as any).setVariant = (n: number) => {
	setVariant(n);
	switchPreset(presetIndex);
};
(window as any).switchPreset = switchPreset;
(window as any).presetCount = PRESETS.length;
(window as any).presetNames = PRESETS.map(p => `${p.id}:${p.name}`);
(window as any).saveShot = async (name: string) => {
	// composite onto the dark page background the real app shows behind the canvas -
	// canvas.toDataURL() alone only captures the canvas layer, which reads as pure transparency
	const flat = document.createElement("canvas");
	flat.width = canvas.width;
	flat.height = canvas.height;
	const fctx = flat.getContext("2d")!;
	fctx.fillStyle = "#0a0a0a";
	fctx.fillRect(0, 0, flat.width, flat.height);
	fctx.drawImage(canvas, 0, 0);
	await fetch("/save/" + name, { method: "POST", body: flat.toDataURL("image/png") });
};
(window as any).simulateMouseCircle = (radius: number, cx: number, cy: number, angle: number) => {
	mouse.x = cx + Math.cos(angle) * radius;
	mouse.y = cy + Math.sin(angle) * radius;
};
// drives the preset synchronously, bypassing requestAnimationFrame - needed because a backgrounded/
// non-visible tab never fires rAF (or renders anything), which real screenshot capture depends on
let manualElapsedMs = 0;
(window as any).drawFramesSync = (count: number, dtMs = 16.7, mouseAngleStep = 0.05, mouseRadius = 300) => {
	for (let f = 0; f < count; f++) {
		manualElapsedMs += dtMs;
		const angle = manualElapsedMs * 0.002 * mouseAngleStep * 50;
		const nx = canvas.width / 2 + Math.cos(angle) * mouseRadius * (canvas.width / 800);
		const ny = canvas.height / 2 + Math.sin(angle) * mouseRadius * (canvas.height / 450);
		const speed = Math.hypot(nx - prevMouseX, ny - prevMouseY);
		mouse.speed = mouse.speed * 0.8 + speed * 0.2;
		prevMouseX = mouse.x = nx;
		prevMouseY = mouse.y = ny;

		const progressSec = trackStart + manualElapsedMs / 1000;
		preset.draw({
			ctx,
			width: canvas.width,
			height: canvas.height,
			progressSec,
			isPlaying: !usePaused,
			audio,
			colorRgb,
			palette,
			mouse
		} as any);
	}
};
// ?preset=<id or index> so a single preset can be opened - or screenshotted headlessly - directly
setVariant(Number(new URLSearchParams(location.search).get("variant") || 0));
const wanted = new URLSearchParams(location.search).get("preset");
const wantedIndex = wanted === null ? 0 : PRESETS.findIndex(p => p.id === wanted || p.name === wanted);
switchPreset(wantedIndex < 0 ? Number(wanted) || 0 : wantedIndex);
// ?warmup=N runs N frames synchronously before anything is shown. A headless screenshot cannot rely
// on rAF having run a useful number of times, and anything with history to fill looks broken until
// it has. Mouse held still: the base is the product.
const warmup = Number(new URLSearchParams(location.search).get("warmup") || 0);
if (warmup > 0) {
	// ?fps= warms up over the SAME stretch of track at another frame rate (warmup counts 60 Hz
	// frames), so a 144 Hz screen can be compared against the 60 Hz one the look was tuned on
	const fps = Number(new URLSearchParams(location.search).get("fps") || 0);
	if (fps > 0) (window as any).drawFramesSync(Math.round((warmup * fps) / 60), 1000 / fps, 0, 0);
	else (window as any).drawFramesSync(warmup, 16.7, 0, 0);
	// AND THE rAF LOOP PICKS UP WHERE THE WARMUP LEFT OFF. It did not: the warmup ran on its own
	// `manualElapsedMs` accumulator while `render()` computes the time from `start`, so the first
	// real frame after a warmup handed the conductor a progressSec fifteen seconds in the PAST. `dt`
	// is clamped at zero from below, so every frame after that had dt = 0 - nothing moved, every
	// stroke had zero length, and `fadeTrail` went on clearing the canvas until it was black.
	//
	// Which is why every headless screenshot this project has taken came out as a near-black field
	// of specks, on every preset, including ones that are fine in the client. The tool for LOOKING
	// was showing an empty picture and it was never the picture's fault.
	pausedAccum -= manualElapsedMs;
	// ?freeze=1 stops the clock right there. A headless screenshot otherwise captures the warm-up
	// PLUS however many frames the virtual-time budget managed afterwards, which is a different
	// moment of the track every time and on a preset that changes slowly is a different picture -
	// the shot and the numbers read from the same page did not agree until this existed.
	if (new URLSearchParams(location.search).get("freeze") === "1") {
		usePaused = true;
		pauseStart = performance.now();
	}
}

window.addEventListener("keydown", e => {
	if (e.key === "ArrowRight") switchPreset(presetIndex + 1);
	if (e.key === "ArrowLeft") switchPreset(presetIndex - 1);
	if (e.key === "v" || e.key === "V") {
		setVariant((getVariant() + 1) % 3);
		switchPreset(presetIndex);
	}
	if (e.key === " ") {
		usePaused = !usePaused;
		if (usePaused) pauseStart = performance.now();
		else pausedAccum += performance.now() - pauseStart;
		label.textContent = `${presetIndex + 1}/${PRESETS.length}  ${PRESETS[presetIndex].name} (${PRESETS[presetIndex].id})  paused=${usePaused}`;
	}
});

function render() {
	const speed = Math.hypot(mouse.x - prevMouseX, mouse.y - prevMouseY);
	mouse.speed = mouse.speed * 0.8 + speed * 0.2;
	prevMouseX = mouse.x;
	prevMouseY = mouse.y;

	const elapsed = usePaused ? pauseStart - start - pausedAccum : performance.now() - start - pausedAccum;
	const progressSec = trackStart + elapsed / 1000;

	preset.draw({
		ctx,
		width: canvas.width,
		height: canvas.height,
		progressSec,
		isPlaying: !usePaused,
		audio,
		colorRgb,
		palette,
		mouse
	} as any);

	requestAnimationFrame(render);
}
// ?manual=1: nothing draws but drawFramesSync. The loop above runs on the wall clock and
// drawFramesSync on its own, so with both alive the track position handed to a preset jumps back and
// forth between them - which a preset that treats a jump as a seek (Ridgeline sinks its terrain)
// answers by never showing its real picture, and every timing taken that way is of the wrong thing.
if (params.get("manual") !== "1") requestAnimationFrame(render);
