import { sectionIndexAt, TrackAudioData } from "../audio-data";

type Segment = SpotifyAudioAnalysis["segments"][number];

// a shimmering, iridescent tint for a hit (kick/snare) - rotates the base colour's channels through
// a slowly cycling phase (cheap, no HSL math) and blends it in proportional to `amount`, so each hit
// flashes a slightly different hue instead of one fixed accent colour
export function shimmerPhase(t: number): number {
	return (Math.sin(t * 2.4) + 1) / 2;
}
export function shimmerTint(
	base: { r: number; g: number; b: number },
	phase: number,
	amount: number
): { r: number; g: number; b: number } {
	if (amount < 0.02) return base;
	// callers pass c.pop straight through, which spikes to ~1 on a hard beat - at amount=1 this is a
	// full R/G/B channel swap, not a shimmer, and reads as a glitch flash rather than an iridescent
	// tint. Capping it keeps the hue nudge visible on every hit without ever fully overwriting colour
	const a = Math.min(0.4, amount);
	const rotA = { r: base.b, g: base.r, b: base.g };
	const rotB = { r: base.g, g: base.b, b: base.r };
	return {
		r: base.r + (rotA.r + (rotB.r - rotA.r) * phase - base.r) * a,
		g: base.g + (rotA.g + (rotB.g - rotA.g) * phase - base.g) * a,
		b: base.b + (rotA.b + (rotB.b - rotA.b) * phase - base.b) * a
	};
}

// fast (~2s) vs slow (~20s) moving averages of energy - the gap between them says whether a section
// is building or settling right now, on a musical timescale rather than a per-frame one. `level` is
// "how loud is this whole stretch on average", `trend` is "rising" (+) or "falling" (-)
export function createEnergyTrend(fastRate = 0.6, slowRate = 0.05) {
	let fast = 0.5;
	let slow = 0.5;
	return (energy: number, dt: number) => {
		fast += (energy - fast) * Math.min(1, fastRate * dt);
		slow += (energy - slow) * Math.min(1, slowRate * dt);
		return { level: slow, trend: fast - slow };
	};
}

// timbre[1] is roughly "brightness" in Spotify's timbre basis and spans about +-100
export function timbreBrightness(segment: Segment | null): number {
	if (!segment) return 0;
	return Math.max(-1, Math.min(1, (segment.timbre[1] || 0) / 100));
}

// THE HARMONY'S COLOUR: each section of the track has its own key in the analysis, and the palette
// leans off the album's hue by how far that key sits from the track's home key on the circle of
// fifths. In the home key the colour is the album's own. Measured over 105 tracks: a section's key
// differs from the last one 1.6 times a minute, and half of all playing time is away from home - so
// the picture re-tints about as often as the song changes part, and holds still in between.
// (The first version followed the chroma's tonal centre: that wobbled +-15 degrees every second on
// every track measured, which is both invisible and not a statement about the music.)
// The lean at the far side of the circle, in turns of hue, and how fast it may move per second
const HUE_SWING = 0.26;
const HUE_RATE = 0.05;

// the lean the section playing at `t` asks for - what a preset that can see the future draws it in
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

// THE GLOW over a picture that is redrawn whole every frame: what is already bright, blurred at two
// sizes and added back - a tight core that is steady, and a wide halo whose strength is the caller's
// to drive (it is where an event is SEEN). Both are rendered small: they are blurs, so resolution is
// wasted on them. Never for a canvas that accumulates - that is re-blurring history (DESIGN-RULES §4).
const GLOW_CORE_DIV = 4;
const GLOW_HALO_DIV = 12;

export function createGlow() {
	let core: HTMLCanvasElement | null = null;
	let halo: HTMLCanvasElement | null = null;
	return (ctx: CanvasRenderingContext2D, source: CanvasImageSource, width: number, height: number, scale: number, haloAlpha: number) => {
		if (typeof document === "undefined") return;
		core = core || document.createElement("canvas");
		halo = halo || document.createElement("canvas");
		const cx = core.getContext("2d")!;
		const hx = halo.getContext("2d")!;
		const nw = Math.max(1, Math.ceil(width / GLOW_CORE_DIV));
		const nh = Math.max(1, Math.ceil(height / GLOW_CORE_DIV));
		if (core.width !== nw || core.height !== nh) {
			core.width = nw;
			core.height = nh;
		}
		cx.clearRect(0, 0, nw, nh);
		// contrast is the bright-pass
		cx.filter = `contrast(1.6) brightness(1.2) blur(${Math.max(1, (scale * 0.006) / GLOW_CORE_DIV)}px)`;
		cx.drawImage(source, 0, 0, nw, nh);
		cx.filter = "none";
		const hw = Math.max(1, Math.ceil(width / GLOW_HALO_DIV));
		const hh = Math.max(1, Math.ceil(height / GLOW_HALO_DIV));
		if (halo.width !== hw || halo.height !== hh) {
			halo.width = hw;
			halo.height = hh;
		}
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
}
