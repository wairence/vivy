// ---- the colours --------------------------------------------------------------------------------------------
// Where a preset's colours come from, set in the knobs panel and kept across restarts:
//   cover    the cover's own palette, three colours Spotify extracts from the art (dark, vibrant, light)
//   custom   two or three colours the listener picked
// and what moves a colour along that palette - the gradient - in Ridgeline:
//   height   a valley is the first colour, a peak the last: the louder a moment, the further along
//   depth    the far rows (what is coming) are the first colour, "now" the last
//   sound    the whole picture slides along the palette with how loud the music is, on its own envelope
// `harmony` is how far the key of each section turns the hue (0 keeps the colours exactly as picked).
import { albumHsl, Hsl, rgbToHsl } from "./presets/flowfield-common";
import { bumpTune } from "./presets/tune";

export type Rgb = { r: number; g: number; b: number };
export type ColourMode = "cover" | "custom";
export type Follows = "height" | "depth" | "sound";
export type Colours = { mode: ColourMode; stops: string[]; follows: Follows; harmony: number };

const STORE = "vivy:colours";
const DEFAULTS: Colours = { mode: "cover", stops: ["#1e3a8a", "#5de6f0"], follows: "height", harmony: 1 };

const load = (): Colours => {
	try {
		const c = JSON.parse(localStorage.getItem(STORE) ?? "null");
		if (!c || typeof c !== "object") return { ...DEFAULTS };
		const stops = Array.isArray(c.stops) ? c.stops.filter((s: unknown) => typeof s === "string" && HEX.test(s)).slice(0, 3) : [];
		return {
			mode: c.mode === "custom" ? "custom" : "cover",
			stops: stops.length >= 2 ? stops : DEFAULTS.stops.slice(),
			follows: c.follows === "depth" || c.follows === "sound" ? c.follows : "height",
			harmony: Number.isFinite(c.harmony) ? Math.min(1, Math.max(0, c.harmony)) : 1
		};
	} catch {
		return { ...DEFAULTS };
	}
};

// the live settings: the panel writes here, the next frame reads them
export const colours: Colours = load();

export function setColours(patch: Partial<Colours>) {
	Object.assign(colours, patch);
	bumpTune();
	try {
		localStorage.setItem(STORE, JSON.stringify(colours));
	} catch {
		// storage denied: the colours still apply, they are just forgotten on restart
	}
}

const HEX = /^#[0-9a-f]{6}$/i;
export const hexToRgb = (hex: string): Rgb => {
	const n = parseInt(hex.slice(1), 16);
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};
export const rgbToHex = ({ r, g, b }: Rgb) =>
	"#" + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

// The palette a preset draws with this frame, as HSL stops. The cover's colours are pulled into the
// band the presets' lighting was tuned for (a near-grey or near-black cover would be mud); picked
// colours are kept as picked, only kept off pure black and white, where there is no light left to
// shape a ridge with.
export function palette(cover: Rgb[]): Hsl[] {
	if (colours.mode === "custom") {
		return colours.stops.map(hex => {
			const c = rgbToHsl(hexToRgb(hex));
			return { h: c.h, s: c.s, l: Math.max(0.18, Math.min(0.82, c.l)) };
		});
	}
	return cover.map(albumHsl);
}

// a point along the palette, 0 = the first colour, 1 = the last; hue the short way round
export function paletteAt(p: Hsl[], t: number): Hsl {
	if (p.length === 1) return { ...p[0] };
	const x = Math.max(0, Math.min(1, t)) * (p.length - 1);
	const i = Math.min(p.length - 2, Math.floor(x));
	const f = x - i;
	const a = p[i];
	const b = p[i + 1];
	let dh = b.h - a.h;
	if (dh > 0.5) dh -= 1;
	else if (dh < -0.5) dh += 1;
	// a grey stop has no hue of its own: take the other one's, or a fade to grey swings round the wheel
	const h = a.s < 0.05 ? b.h : b.s < 0.05 ? a.h : a.h + dh * f;
	return { h, s: a.s + (b.s - a.s) * f, l: a.l + (b.l - a.l) * f };
}
