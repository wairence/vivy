import { sectionIndexAt, TrackAudioData } from "../audio-data";
import { HUE_REACH } from "../colours";

type Segment = SpotifyAudioAnalysis["segments"][number];

// iridescence on a flare (Drift): a hue lean on a slow phase, so each hit shows a slightly different hue. It is added to
// the key's lean, which familyHue caps, so it stays inside the cover's colours
export function shimmerPhase(t: number): number {
	return (Math.sin(t * 2.4) + 1) / 2;
}
export function shimmerHue(phase: number, amount: number): number {
	return (phase * 2 - 1) * Math.min(1, amount) * HUE_REACH * 0.6;
}

// timbre[1] is roughly "brightness" in Spotify's timbre basis and spans about +-100
export function timbreBrightness(segment: Segment | null): number {
	if (!segment) return 0;
	return Math.max(-1, Math.min(1, (segment.timbre[1] || 0) / 100));
}

// each section has its own key; the hue leans off the album's by its distance from the home key on the circle
// of fifths, so the picture re-tints about as often as the song changes part. Lean at the far side, in turns of hue,
// and the most it may move per second. The far side is the palette's reach, so a lean never sits on that cap
const HUE_SWING = HUE_REACH;
const HUE_RATE = 0.05;

// the lean the section playing at `t` asks for - for a preset that reads ahead of the playhead
export function keyHueAt(audio: TrackAudioData | null, t: number): number {
	// (a track without analysis, or a harness, may carry neither sections nor track info)
	const section = audio?.sections ? audio.sections[sectionIndexAt(audio.sections, t)] : undefined;
	const home = audio?.trackInfo?.key;
	if (!section || typeof home !== "number" || !(section.key >= 0) || !(home >= 0)) return 0;
	const fifths = (((section.key - home) * 7) % 12 + 12) % 12;
	const away = fifths > 6 ? fifths - 12 : fifths;
	// the square root, so the nearest key is already a colour you can see
	return Math.sign(away) * Math.sqrt(Math.abs(away) / 6) * HUE_SWING;
}

// returns the lean to add to the album's hue, eased; `on = false` takes it back to none
export function createKeyHue() {
	let shift = 0;
	return (audio: TrackAudioData | null, progressSec: number, dt: number, on = true): number => {
		const target = on ? keyHueAt(audio, progressSec) : 0;
		const step = HUE_RATE * dt;
		shift += Math.max(-step, Math.min(step, target - shift));
		return shift;
	};
}

// glow over a picture redrawn whole every frame: bright parts blurred at two sizes and added back, a steady core and
// a wide halo driven by the caller. Rendered small (blurs). Not for a canvas that accumulates.
const GLOW_CORE_DIV = 4;
const GLOW_HALO_DIV = 12;

function fitReduced(canvas: HTMLCanvasElement, width: number, height: number, div: number): [number, number] {
	const w = Math.max(1, Math.ceil(width / div));
	const h = Math.max(1, Math.ceil(height / div));
	if (canvas.width !== w || canvas.height !== h) {
		canvas.width = w;
		canvas.height = h;
	}
	return [w, h];
}

export function createGlow() {
	let core: HTMLCanvasElement | null = null;
	let halo: HTMLCanvasElement | null = null;
	const glow = (ctx: CanvasRenderingContext2D, source: CanvasImageSource, width: number, height: number, scale: number, haloAlpha: number) => {
		if (typeof document === "undefined") return;
		core = core || document.createElement("canvas");
		halo = halo || document.createElement("canvas");
		const cx = core.getContext("2d")!;
		const hx = halo.getContext("2d")!;
		const [nw, nh] = fitReduced(core, width, height, GLOW_CORE_DIV);
		cx.clearRect(0, 0, nw, nh);
		// contrast is the bright-pass
		cx.filter = `contrast(1.6) brightness(1.2) blur(${Math.max(1, (scale * 0.006) / GLOW_CORE_DIV)}px)`;
		cx.drawImage(source, 0, 0, nw, nh);
		cx.filter = "none";
		const [hw, hh] = fitReduced(halo, width, height, GLOW_HALO_DIV);
		hx.clearRect(0, 0, hw, hh);
		hx.filter = `blur(${Math.max(1, (scale * 0.03) / GLOW_HALO_DIV)}px) brightness(2.2)`;
		hx.drawImage(core, 0, 0, hw, hh);
		hx.filter = "none";
		ctx.save();
		ctx.globalCompositeOperation = "lighter";
		ctx.globalAlpha = 0.7;
		ctx.drawImage(core, 0, 0, width, height);
		ctx.globalAlpha = Math.min(1, haloAlpha);
		ctx.drawImage(halo, 0, 0, width, height);
		ctx.restore();
	};
	// a canvas sized 0x0 gives its memory back now, not at the next garbage collection
	const dispose = () => {
		for (const c of [core, halo]) if (c) c.width = c.height = 0;
		core = halo = null;
	};
	return Object.assign(glow, { dispose });
}
