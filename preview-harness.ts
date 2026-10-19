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
			// timbre[1] is "how ringing was that sound", and it is what the presets place a mark by. A
			// pure slow sine is not what a track does: one sound is dull and the next is bright, on top
			// of a slow drift in the mix. With a sine alone every event lands in the same place on the
			// register axis.
			timbre: [20 + random() * 40, Math.sin(t * 0.15) * 35 + (random() - 0.5) * 95, random() * 100 - 50, ...Array.from({ length: 9 }, () => random() * 100 - 50)]
		});
		loudnessCurve.push({ t, y: Math.pow(10, loudness_max / 20) });
	}
	// bars, sections and hitScale as well: the presets read the metrical grid and the track's own
	// hit scale, and a harness that omits them is not showing what the client shows
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
	// The same stretch the client applies. Without it the fake track sits at about 0.2 for its whole
	// length - the bottom of the range every preset is tuned against - and everything looks dark and
	// slow here while looking right in Spotify.
	normaliseCurve(loudnessCurve);
	const sorted = segments.map(s => Math.pow(10, s.loudness_max / 20)).sort((a, b) => a - b);
	// Everything a preset reads, not only what the first preset to use this harness happened to read.
	// `rankOf` returns 0.5 when `timbreSorted` is missing, so every preset that places a mark, a band
	// or a puff by register would put all of them in the same spot. A harness that omits a field
	// does not show a neutral picture, it shows a wrong one.
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
// ?audio=<url> plays a real track, given as JSON: the same TrackAudioData the client builds. The
// fake one above is for smoke tests; judging a look needs a real drop. Synchronous on purpose:
// everything below reads `audio` at once.
function loadAudio(url: string) {
	const xhr = new XMLHttpRequest();
	xhr.open("GET", url, false);
	xhr.send();
	if (xhr.status !== 200) throw new Error("no audio at " + url);
	return JSON.parse(xhr.responseText);
}
const audio = params.get("audio") ? loadAudio(params.get("audio")!) : fakeAudio();
// ?at=<seconds>: the warm-up ends here, so a shot shows that moment of the track with the history in
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
// { alpha: false } like the app: the canvas is opaque, as it is in the client.
const ctx = canvas.getContext("2d", { alpha: false })!;

function resize() {
	// a fresh/backgrounded tab can report clientWidth=0 before layout has actually run - fall back to
	// a fixed size instead of ending up with a 0x0 canvas
	const cw = canvas.clientWidth || 1280;
	const ch = canvas.clientHeight || 720;
	const w = Math.round(cw * devicePixelRatio);
	const h = Math.round(ch * devicePixelRatio);
	// Only if it actually changed. Assigning canvas.width clears the canvas even when the value is
	// identical, and a headless tab fires a resize after layout settles - so the screenshot comes
	// out black whenever that lands after the last frame is drawn.
	if (canvas.width === w && canvas.height === h) return;
	canvas.width = w;
	canvas.height = h;
}
resize();
window.addEventListener("resize", resize);

// the MouseState the real app passes to presets (cumulative click counters, a persistent 0..1
// scroll fader). Neither current preset reads it
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
// what the conductor holds, from the console: the signals the B key records in the client. A
// picture that looks wrong here is either a preset fault or a harness fault, and the way to tell
// them apart is to read the signals the preset was handed.
(window as any).conducted = () => {
	const c = lastConducted as unknown as Record<string, unknown> | null;
	if (!c) return null;
	const out: Record<string, number> = {};
	for (const k of Object.keys(c)) if (typeof c[k] === "number") out[k] = Number((c[k] as number).toFixed(4));
	return out;
};
// and what a simulation says about itself, for a preset whose state is not in its draw calls
(window as any).diagnostics = () => lastDiagnostics;
// a parameter set by index (?variant=, key V); neither current preset reads it
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
// it has. Mouse held still.
const warmup = Number(new URLSearchParams(location.search).get("warmup") || 0);
if (warmup > 0) {
	// ?fps= warms up over the SAME stretch of track at another frame rate (warmup counts 60 Hz
	// frames), so a 144 Hz screen can be compared against the 60 Hz one the look was tuned on
	const fps = Number(new URLSearchParams(location.search).get("fps") || 0);
	if (fps > 0) (window as any).drawFramesSync(Math.round((warmup * fps) / 60), 1000 / fps, 0, 0);
	else (window as any).drawFramesSync(warmup, 16.7, 0, 0);
	// The rAF loop picks up where the warmup left off. The warmup runs on its own `manualElapsedMs`
	// accumulator while `render()` computes the time from `start`, so without this the first real
	// frame after a warmup would hand the conductor a progressSec fifteen seconds in the past. `dt`
	// is clamped at zero from below, so every frame after that would have dt = 0 and nothing
	// would move.
	pausedAccum -= manualElapsedMs;
	// ?freeze=1 stops the clock right there. A headless screenshot otherwise captures the warm-up
	// plus however many frames the virtual-time budget managed afterwards, which is a different
	// moment of the track every time.
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
