import { createLiveAnalyser, LiveAnalyser } from "./src/live-audio";
import { hslToRgb } from "./src/presets/flowfield-common";
import { PRESETS, Preset } from "./src/presets";

// The standalone window: the same eight presets, driven by whatever the computer is playing
// instead of by Spotify's precomputed analysis. src/live-audio.ts does the actual work of turning
// system audio into the TrackAudioData shape everything else already reads, so nothing in src/
// changed to make this exist.
//
// System audio arrives through getDisplayMedia. The browser will not hand out audio on its own, so
// it comes attached to a screen share: pick "Entire Screen" and tick "Also share system audio".
// The video track is requested at the lowest rate the browser will accept and then never looked at
// - it is the price of the audio, not something we want.

const STORAGE_KEY = "spicetify-visualizer:live-preset";

// The presets announce their dev toggles through Spicetify.showNotification, which does not exist
// outside the Spotify client. Rather than teach every preset about a second host, stand up the one
// method they use and render it here - so ctrl+click behaves identically in both windows.
(window as unknown as { Spicetify: { showNotification: (text: string) => void } }).Spicetify = {
	showNotification(text: string) {
		const toast = document.getElementById("toast") as HTMLDivElement;
		toast.textContent = text;
		toast.classList.add("show");
		clearTimeout(toastTimer);
		toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2600);
	}
};
let toastTimer = 0;

const canvas = document.getElementById("c") as HTMLCanvasElement;
const ctx = canvas.getContext("2d", { alpha: false })!;
const startPanel = document.getElementById("start") as HTMLDivElement;
const startButton = document.getElementById("go") as HTMLButtonElement;
const hint = document.getElementById("hint") as HTMLDivElement;
const bar = document.getElementById("bar") as HTMLDivElement;

let analyser: LiveAnalyser | null = null;
let preset: Preset | null = null;
let presetId = localStorage.getItem(STORAGE_KEY) || PRESETS[PRESETS.length - 1].id;

function resize() {
	canvas.width = (canvas.clientWidth || 1280) * devicePixelRatio;
	canvas.height = (canvas.clientHeight || 720) * devicePixelRatio;
}
resize();
window.addEventListener("resize", resize);

// MouseState, same contract as the Spicetify app: raw and cumulative, never eased here
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
let prevX = mouse.x;
let prevY = mouse.y;
canvas.addEventListener("mousemove", e => {
	const rect = canvas.getBoundingClientRect();
	mouse.x = ((e.clientX - rect.left) / rect.width) * canvas.width;
	mouse.y = ((e.clientY - rect.top) / rect.height) * canvas.height;
	mouse.speed = mouse.speed * 0.8 + Math.hypot(mouse.x - prevX, mouse.y - prevY) * 0.2;
	prevX = mouse.x;
	prevY = mouse.y;
});
canvas.addEventListener("mousedown", e => {
	// same dev toggle as the Spicetify app, same event, carrying the active preset's id so only the
	// preset being looked at responds (Aurora records telemetry, Layers switches to its diagnostic
	// palette). This window exists to debug with, so it needs it more than the real one does
	if (e.ctrlKey) {
		window.dispatchEvent(new CustomEvent("flowfield-dev-toggle", { detail: presetId }));
		return;
	}
	if (e.button === 2) {
		mouse.rightClicks++;
		mouse.rightDown = true;
	} else {
		mouse.clicks++;
		mouse.down = true;
	}
});
const release = () => {
	mouse.down = false;
	mouse.rightDown = false;
};
canvas.addEventListener("mouseup", release);
canvas.addEventListener("mouseleave", release);
window.addEventListener("blur", release);
canvas.addEventListener("contextmenu", e => e.preventDefault());
canvas.addEventListener("wheel", e => {
	e.preventDefault();
	const step = e.deltaY > 0 ? -0.06 : 0.06;
	if (e.altKey) mouse.particleScale = Math.max(0, Math.min(1, mouse.particleScale + step));
	else mouse.scroll = Math.max(0, Math.min(1, mouse.scroll + step));
}, { passive: false });

// ---- colour ------------------------------------------------------------------------------------
// There is no album art here, so the accent comes from the music itself: the chroma's tonal centre
// picks a hue and it eases toward it, the same slow chase app.tsx runs on the extracted album
// colour. A film with no strong tonality simply sits still on whatever hue it last settled on.
let hue = 0.45;
let colorRgb = { r: 40, g: 200, b: 160 };
function updateColour(chroma: Float32Array) {
	let x = 0;
	let y = 0;
	for (let i = 0; i < 12; i++) {
		const angle = (i / 12) * Math.PI * 2;
		x += chroma[i] * Math.cos(angle);
		y += chroma[i] * Math.sin(angle);
	}
	if (Math.hypot(x, y) > 0.15) {
		const target = ((Math.atan2(y, x) / (Math.PI * 2)) % 1 + 1) % 1;
		let diff = target - hue;
		if (diff > 0.5) diff -= 1;
		if (diff < -0.5) diff += 1;
		hue = (hue + diff * 0.01 + 1) % 1;
	}
	colorRgb = hslToRgb(hue, 0.72, 0.55);
}

// ---- chrome ------------------------------------------------------------------------------------
function buildBar() {
	bar.innerHTML = "";
	PRESETS.forEach((definition, i) => {
		const button = document.createElement("button");
		button.textContent = `${i + 1} ${definition.name}`;
		button.className = definition.id === presetId ? "active" : "";
		button.onclick = () => selectPreset(definition.id);
		bar.appendChild(button);
	});
	const full = document.createElement("button");
	full.textContent = "Fullscreen";
	full.onclick = () => void document.documentElement.requestFullscreen();
	bar.appendChild(full);
}

function selectPreset(id: string) {
	presetId = id;
	localStorage.setItem(STORAGE_KEY, id);
	preset = PRESETS.find(p => p.id === id)!.create();
	// otherwise a trail-based preset opens by fading out whatever the last one left behind
	ctx.fillStyle = "#000";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	buildBar();
}

window.addEventListener("keydown", e => {
	const index = Number(e.key) - 1;
	if (index >= 0 && index < PRESETS.length) selectPreset(PRESETS[index].id);
	if (e.key === "f") void document.documentElement.requestFullscreen();
	if (e.key === "Escape" && document.fullscreenElement) void document.exitFullscreen();
});

// idle-hide the chrome, so a movie gets the whole window
let idleTimer = 0;
window.addEventListener("mousemove", () => {
	document.body.classList.remove("idle");
	clearTimeout(idleTimer);
	idleTimer = window.setTimeout(() => document.body.classList.add("idle"), 2500);
});

// ---- start -------------------------------------------------------------------------------------
startButton.onclick = async () => {
	try {
		const stream = await navigator.mediaDevices.getDisplayMedia({
			// the browser will not give audio without video; ask for as little of it as possible
			video: { frameRate: 1, width: 320, height: 180 },
			audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
		});
		if (stream.getAudioTracks().length === 0) {
			stream.getTracks().forEach(t => t.stop());
			hint.textContent =
				"That share had no audio. Choose Entire Screen and tick “Also share system audio”, then try again.";
			hint.className = "warn";
			return;
		}
		analyser = createLiveAnalyser(stream);
		stream.getVideoTracks()[0].addEventListener("ended", () => {
			analyser?.stop();
			analyser = null;
			startPanel.style.display = "";
			hint.textContent = "Sharing stopped.";
			hint.className = "";
		});
		selectPreset(presetId);
		startPanel.style.display = "none";
		document.body.classList.add("idle");
	} catch (err) {
		hint.textContent = `Could not start: ${(err as Error).message}`;
		hint.className = "warn";
	}
};

buildBar();

function loop() {
	requestAnimationFrame(loop);
	if (!analyser || !preset) return;
	analyser.update();
	updateColour(analyser.chroma);
	preset.draw({
		ctx,
		width: canvas.width,
		height: canvas.height,
		progressSec: analyser.now(),
		// freeze exactly like the Spicetify app does when nothing is playing: silence holds the last
		// frame rather than fading the trails away to black
		isPlaying: analyser.live,
		audio: analyser.audio,
		colorRgb,
		mouse
	});
}
requestAnimationFrame(loop);
