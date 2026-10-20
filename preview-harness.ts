import { PRESETS, Preset } from "./src/presets";
import { lastConducted } from "./src/presets/conductor";
import { lastDiagnostics } from "./src/presets/types";
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
			// timbre[1] needs per-segment scatter on top of the drift, or every mark lands in one place.
			timbre: [20 + random() * 40, Math.sin(t * 0.15) * 35 + (random() - 0.5) * 95, random() * 100 - 50, ...Array.from({ length: 9 }, () => random() * 100 - 50)]
		});
		loudnessCurve.push({ t, y: Math.pow(10, loudness_max / 20) });
	}
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
	// Same stretch as the client; without it the picture is dark and slow.
	normaliseCurve(loudnessCurve);
	const sorted = segments.map(s => Math.pow(10, s.loudness_max / 20)).sort((a, b) => a - b);
	// Every field a preset reads must be present (rankOf returns 0.5 without timbreSorted).
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
		moments: [],
		hitScale: sorted[Math.floor((sorted.length - 1) * 0.98)]
	};
}

const params = new URLSearchParams(location.search);
// URL parameters: ?preset=<id|index>  ?audio=<url of TrackAudioData JSON>  ?at=<s>  ?warmup=<60 Hz frames>
// ?fps=<n> (warmup at another rate)  ?freeze=1  ?manual=1  ?palette=<hex,hex,hex>
// Synchronous load: everything below reads `audio` at once.
function loadAudio(url: string) {
	const xhr = new XMLHttpRequest();
	xhr.open("GET", url, false);
	xhr.send();
	if (xhr.status !== 200) throw new Error("no audio at " + url);
	return JSON.parse(xhr.responseText);
}
const audio = params.get("audio") ? loadAudio(params.get("audio")!) : fakeAudio();
// ?at: the warm-up ends at this track time.
const warmupFrames = Number(params.get("warmup") || 0);
const trackStart = params.get("at") ? Math.max(0, Number(params.get("at")) - warmupFrames / 60) : 3;
const colorRgb = { r: 30, g: 195, b: 140 };
// cover colours, dark to light
const palette = (params.get("palette") || "1b2a4a,c8406e,f2c38b").split(",").map(h => hexToRgb("#" + h));
// console hook: setColours("layers3d", { follows: "depth" })
(window as any).setColours = setColours;

const canvas = document.getElementById("c") as HTMLCanvasElement;
const label = document.getElementById("label") as HTMLDivElement;
// opaque like the client
const ctx = canvas.getContext("2d", { alpha: false })!;

function resize() {
	// a fresh tab can report clientWidth=0 before layout
	const cw = canvas.clientWidth || 1280;
	const ch = canvas.clientHeight || 720;
	const w = Math.round(cw * devicePixelRatio);
	const h = Math.round(ch * devicePixelRatio);
	// Assigning canvas.width clears it even when unchanged, which blanks headless screenshots.
	if (canvas.width === w && canvas.height === h) return;
	canvas.width = w;
	canvas.height = h;
}
resize();
window.addEventListener("resize", resize);

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
	label.textContent = `${presetIndex + 1}/${PRESETS.length}  ${PRESETS[presetIndex].name} (${PRESETS[presetIndex].id})  paused=${usePaused}`;
}
// console: the conductor's signals, to tell a preset fault from a harness fault
(window as any).conducted = () => {
	const c = lastConducted as unknown as Record<string, unknown> | null;
	if (!c) return null;
	const out: Record<string, number> = {};
	for (const k of Object.keys(c)) if (typeof c[k] === "number") out[k] = Number((c[k] as number).toFixed(4));
	return out;
};
// console: published simulation state
(window as any).diagnostics = () => lastDiagnostics;
(window as any).switchPreset = switchPreset;
(window as any).presetCount = PRESETS.length;
(window as any).presetNames = PRESETS.map(p => `${p.id}:${p.name}`);
(window as any).saveShot = async (name: string) => {
	// flatten onto the page background; toDataURL alone is transparent
	const flat = document.createElement("canvas");
	flat.width = canvas.width;
	flat.height = canvas.height;
	const fctx = flat.getContext("2d")!;
	fctx.fillStyle = "#0a0a0a";
	fctx.fillRect(0, 0, flat.width, flat.height);
	fctx.drawImage(canvas, 0, 0);
	await fetch("/save/" + name, { method: "POST", body: flat.toDataURL("image/png") });
};
// Draws synchronously: a hidden tab never fires rAF.
let manualElapsedMs = 0;
(window as any).drawFramesSync = (count: number, dtMs = 16.7) => {
	for (let f = 0; f < count; f++) {
		manualElapsedMs += dtMs;
		const progressSec = trackStart + manualElapsedMs / 1000;
		preset.draw({
			ctx,
			width: canvas.width,
			height: canvas.height,
			progressSec,
			isPlaying: !usePaused,
			audio,
			colorRgb,
			palette
		} as any);
	}
};
const wanted = new URLSearchParams(location.search).get("preset");
const wantedIndex = wanted === null ? 0 : PRESETS.findIndex(p => p.id === wanted || p.name === wanted);
switchPreset(wantedIndex < 0 ? Number(wanted) || 0 : wantedIndex);
// ?warmup fills history before the first shot.
const warmup = Number(new URLSearchParams(location.search).get("warmup") || 0);
if (warmup > 0) {
	const fps = Number(new URLSearchParams(location.search).get("fps") || 0);
	if (fps > 0) (window as any).drawFramesSync(Math.round((warmup * fps) / 60), 1000 / fps);
	else (window as any).drawFramesSync(warmup, 16.7);
	// Continue the rAF clock from the warm-up; otherwise progressSec jumps back and dt clamps to 0.
	pausedAccum -= manualElapsedMs;
	// ?freeze=1: a fixed moment for screenshots
	if (new URLSearchParams(location.search).get("freeze") === "1") {
		usePaused = true;
		pauseStart = performance.now();
	}
}

window.addEventListener("keydown", e => {
	if (e.key === "ArrowRight") switchPreset(presetIndex + 1);
	if (e.key === "ArrowLeft") switchPreset(presetIndex - 1);
	if (e.key === " ") {
		usePaused = !usePaused;
		if (usePaused) pauseStart = performance.now();
		else pausedAccum += performance.now() - pauseStart;
		label.textContent = `${presetIndex + 1}/${PRESETS.length}  ${PRESETS[presetIndex].name} (${PRESETS[presetIndex].id})  paused=${usePaused}`;
	}
});

function render() {
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
// ?manual=1: only drawFramesSync draws; two clocks make a preset see seeks (Ridgeline sinks its terrain).
if (params.get("manual") !== "1") requestAnimationFrame(render);
