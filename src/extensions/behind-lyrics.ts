// Always loaded with vivy: draws a preset in place of Spicy Lyrics' background, under the lyrics,
// on its page and in its fullscreen. Off unless turned on in the knobs panel.
import { AudioSync, createSmoothClock } from "../audio-sync";
import { BehindLyrics, behindLyrics, onBehindLyricsChange, setBehindLyrics } from "../behind-lyrics";
import { Rgb } from "../colours";
import { createFramePacer, frameRate, renderSize } from "../frame-rate";
import { Preset, PRESETS } from "../presets";
import { watchTrackData } from "../track-data";
import { paintBackdrop, storedPicture } from "../ui/picture";

// Spicy Lyrics' page background host; the same box in the side panel's lyrics card is left alone.
const PAGE_HOST = "#SpicyLyricsPage .ContentBox";
const HOST_CLASS = "vivy-behind-lyrics";
const CANVAS_CLASS = "vivy-lyrics-canvas";
const SHADE_CLASS = "vivy-lyrics-shade";
const SEE_THROUGH = "vivy-lyrics-see-through";
// A track's Canvas video takes the cover's place in their fullscreen; ours replaces the video, so the cover comes back.
// With the picture's transparency the page's wrappers go clear and stop isolating, as on vivy's own page.
const STYLE = `
.${HOST_CLASS} > :is(.spicy-dynamic-bg, .CanvasStage, .CanvasAmbient) { visibility: hidden; }
#SpicyLyricsPage.CanvasImmersive:has(.${HOST_CLASS}) .MediaContent { opacity: 1 !important; }
:is(.${CANVAS_CLASS}, .${SHADE_CLASS}) { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 0; }
.${SEE_THROUGH} { background: transparent !important; isolation: auto !important; z-index: auto !important; will-change: auto !important; }`;

// Spicy Lyrics' cinema mode lifts its page out of the window onto the body, away from the picture a theme
// keeps under the window; the theme's layers are copied into the backdrop then, filters and all.
const THEME_LAYERS = ".Root__top-container";
// what the theme has under the window now; a theme swaps its picture some time after the track changes
const themePictureKey = () => {
	const root = document.querySelector(THEME_LAYERS);
	return root ? getComputedStyle(root, "::before").backgroundImage + getComputedStyle(root, "::after").backgroundImage : "";
};

function copyThemePicture(into: HTMLElement, transparency: number) {
	const root = document.querySelector(THEME_LAYERS);
	if (!root) return;
	into.style.background = getComputedStyle(root).backgroundColor;
	for (const pseudo of ["::before", "::after"]) {
		const s = getComputedStyle(root, pseudo);
		if (s.backgroundImage === "none") continue;
		const layer = document.createElement("div");
		Object.assign(layer.style, {
			position: "absolute",
			inset: "0",
			backgroundImage: s.backgroundImage,
			backgroundSize: s.backgroundSize,
			backgroundPosition: s.backgroundPosition,
			backgroundRepeat: s.backgroundRepeat,
			filter: s.filter,
			opacity: s.opacity
		});
		into.append(layer);
	}
	const dark = document.createElement("div");
	Object.assign(dark.style, { position: "absolute", inset: "0", background: `rgba(0, 0, 0, ${1 - transparency})` });
	into.append(dark);
}

function paintSlot(host: Element, slot: Pick<Slot, "shade" | "inWindow" | "copied">) {
	const { transparency } = storedPicture();
	slot.shade.replaceChildren();
	slot.inWindow = !!host.closest(THEME_LAYERS);
	slot.copied = slot.inWindow ? "" : themePictureKey();
	if (!paintBackdrop(slot.shade, transparency)) return;
	seeThroughFrom(slot.inWindow ? host : null);
	if (!slot.inWindow) copyThemePicture(slot.shade, transparency);
}

function seeThroughFrom(host: Element | null) {
	document.querySelectorAll(`.${SEE_THROUGH}`).forEach(el => el.classList.remove(SEE_THROUGH));
	for (let el = host; el && !el.matches(".Root__top-container, body"); el = el.parentElement) el.classList.add(SEE_THROUGH);
}
const SCAN_MS = 500;

type Slot = { canvas: HTMLCanvasElement; shade: HTMLDivElement; inWindow: boolean; copied: string; ctx: CanvasRenderingContext2D; preset: Preset; clock: ReturnType<typeof createSmoothClock> };

const onVivyPage = () => Spicetify.Platform?.History?.location?.pathname?.startsWith("/vivy") ?? false;

function hosts(): Element[] {
	// the app draws its own picture; two at once would only cost
	if (onVivyPage()) return [];
	return [...document.querySelectorAll(PAGE_HOST)].filter(el => !el.closest("aside"));
}

function start(initial: BehindLyrics) {
	let settings = initial;
	const style = document.createElement("style");
	style.textContent = STYLE;
	document.head.append(style);
	const track = watchTrackData(undefined, true);
	const audioSync = new AudioSync();
	const pace = createFramePacer();
	const slots = new Map<Element, Slot>();
	let shown: Rgb[] = track.cover().slice();
	let lastColourAt = performance.now();
	let requestId = 0;

	const definition = () => PRESETS.find(p => p.id === settings.preset) ?? PRESETS[0];
	const unmount = (host: Element, slot: Slot) => {
		slot.preset.dispose();
		slot.canvas.remove();
		slot.shade.remove();
		host.classList.remove(HOST_CLASS);
		slots.delete(host);
		seeThroughFrom(null);
	};
	const mount = (host: Element) => {
		const canvas = document.createElement("canvas");
		canvas.className = CANVAS_CLASS;
		canvas.style.filter = settings.dim ? `brightness(${1 - settings.dim})` : "";
		// the black under the picture, thinned by the picture's transparency
		const shade = document.createElement("div");
		shade.className = SHADE_CLASS;
		const { transparency } = storedPicture();
		if (transparency) canvas.style.mixBlendMode = "screen";
		const theirs = host.querySelector(":scope > .spicy-dynamic-bg");
		if (theirs) theirs.after(shade, canvas);
		else host.prepend(shade, canvas);
		host.classList.add(HOST_CLASS);
		const ctx = canvas.getContext("2d", { alpha: false });
		if (!ctx) return (canvas.remove(), shade.remove());
		const slot = { canvas, shade, inWindow: true, copied: "" };
		paintSlot(host, slot);
		slots.set(host, { ...slot, ctx, preset: definition().create(), clock: createSmoothClock() });
	};

	const render = () => {
		requestId = slots.size ? requestAnimationFrame(render) : 0;
		if (!pace(performance.now(), frameRate())) return;
		const wall = performance.now();
		const colourStep = 1 - Math.exp(-Math.min(0.1, (wall - lastColourAt) / 1000) / 0.6);
		lastColourAt = wall;
		const target = track.cover();
		shown = shown.map((d, i) => ({
			r: d.r + (target[i].r - d.r) * colourStep,
			g: d.g + (target[i].g - d.g) * colourStep,
			b: d.b + (target[i].b - d.b) * colourStep
		}));
		const isPlaying = Spicetify.Player.isPlaying();
		const playerSec = Spicetify.Player.getProgress() / 1000;
		for (const slot of slots.values()) {
			if (!slot.canvas.clientWidth || !slot.canvas.clientHeight) continue;
			const { w, h } = renderSize(slot.canvas, devicePixelRatio);
			if (slot.canvas.width !== w || slot.canvas.height !== h) {
				slot.canvas.width = w;
				slot.canvas.height = h;
			}
			try {
				slot.preset.draw({
					ctx: slot.ctx,
					width: w,
					height: h,
					progressSec: slot.clock(playerSec, isPlaying, wall / 1000) - audioSync.getLatencySec(),
					isPlaying,
					audio: track.audio(),
					colorRgb: shown[1],
					palette: shown.slice(0, 3),
					coverColours: shown
				});
			} catch (err) {
				console.error("[vivy] behind lyrics", err);
			}
		}
	};

	const scan = () => {
		const live = new Set(hosts());
		for (const [host, slot] of slots) if (!host.isConnected || !live.has(host)) unmount(host, slot);
		for (const host of live) if (!slots.has(host)) mount(host);
		// moved in or out of the window (their cinema mode)
		for (const [host, slot] of slots)
			if (slot.inWindow !== !!host.closest(THEME_LAYERS) || (!slot.inWindow && slot.copied !== themePictureKey())) paintSlot(host, slot);
		if (slots.size && !requestId) requestId = requestAnimationFrame(render);
	};
	const scanId = window.setInterval(scan, SCAN_MS);
	scan();
	// a blurred-cover backdrop follows the track
	const repaint = () => {
		for (const [host, slot] of slots) paintSlot(host, slot);
	};
	Spicetify.Player.addEventListener("songchange", repaint);

	return {
		update(next: BehindLyrics) {
			const presetChanged = next.preset !== settings.preset;
			settings = next;
			for (const [host, slot] of slots) {
				if (presetChanged) unmount(host, slot);
				else slot.canvas.style.filter = settings.dim ? `brightness(${1 - settings.dim})` : "";
			}
			scan();
		},
		stop() {
			window.clearInterval(scanId);
			Spicetify.Player.removeEventListener("songchange", repaint);
			cancelAnimationFrame(requestId);
			for (const [host, slot] of slots) unmount(host, slot);
			track.dispose();
			audioSync.dispose();
			style.remove();
		}
	};
}

(async () => {
	while (!Spicetify.Player?.addEventListener || !Spicetify.Platform?.History || !Spicetify.colorExtractor) await new Promise(r => setTimeout(r, 100));
	let running: ReturnType<typeof start> | null = null;
	const apply = (settings: BehindLyrics) => {
		if (settings.on && !running) running = start(settings);
		else if (!settings.on && running) {
			running.stop();
			running = null;
		} else running?.update(settings);
		showToggleState(settings);
	};
	onBehindLyricsChange(apply);
	apply(behindLyrics());
	// their controls are rebuilt with the page, so the button is put back whenever it is missing
	window.setInterval(placeToggle, 1000);
})();

const TOGGLE_ID = "VivyBehindLyricsToggle";
const VIVY_MARK =
	'<svg class="NoFill" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">' +
	'<path d="M14.6 1.8L2.6 9.6L11.6 14.3Z" fill="currentColor" stroke="none"/>' +
	'<path d="M14.6 1.8L2.6 9.6L9.4 22.2L21.4 14Z M14.6 1.8L11.6 14.3L9.4 22.2 M2.6 9.6L11.6 14.3L21.4 14"/></svg>';

function placeToggle() {
	const controls = [...document.querySelectorAll("#SpicyLyricsPage .ViewControls")].find(el => !el.closest("aside"));
	if (!controls || controls.querySelector(`#${TOGGLE_ID}`)) return;
	const button = document.createElement("button");
	button.id = TOGGLE_ID;
	button.className = "ViewControl";
	button.innerHTML = VIVY_MARK;
	button.addEventListener("click", () => setBehindLyrics({ on: !behindLyrics().on }));
	controls.insertBefore(button, controls.querySelector("#SettingsToggle"));
	showToggleState(behindLyrics());
}

function showToggleState(settings: BehindLyrics) {
	const button = document.getElementById(TOGGLE_ID);
	if (!button) return;
	const name = PRESETS.find(p => p.id === settings.preset)?.name ?? "vivy";
	button.title = settings.on ? `vivy behind the lyrics: ${name}. Click to turn off` : "vivy behind the lyrics: off. Click to turn on";
	button.style.opacity = settings.on ? "" : "0.45";
}
