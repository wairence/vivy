// Per-preset colour settings (knobs panel, kept across restarts): `cover` palette from the art or `custom` picked colours,
// the gradient the colour follows (named by each preset), and `harmony`, how far each section's key turns the hue (0 = as picked).
// Usage, at module scope: const COLOURS = colourSettings("ridge", [["height", "Height", "what it does"], ...]); read COLOURS.follows / .mode.
import { bumpTune } from "./presets/tune";

export type Rgb = { r: number; g: number; b: number };
export type Hsl = { h: number; s: number; l: number };
export type ColourMode = "cover" | "custom";
export type Gradient = readonly [id: string, name: string, what: string];
export type Colours = { mode: ColourMode; stops: string[]; follows: string; harmony: number };

const STORE = "vivy:colours:";
const HEX = /^#[0-9a-f]{6}$/i;
const settings = new Map<string, { colours: Colours; gradients: readonly Gradient[] }>();

const load = (preset: string, gradients: readonly Gradient[]): Colours => {
	const fallback: Colours = { mode: "cover", stops: ["#1e3a8a", "#5de6f0"], follows: gradients[0][0], harmony: 1 };
	try {
		const c = JSON.parse(localStorage.getItem(STORE + preset) ?? "null");
		if (!c || typeof c !== "object") return fallback;
		const stops = Array.isArray(c.stops) ? c.stops.filter((s: unknown) => typeof s === "string" && HEX.test(s)).slice(0, 3) : [];
		return {
			mode: c.mode === "custom" ? "custom" : "cover",
			stops: stops.length >= 2 ? stops : fallback.stops,
			follows: gradients.some(g => g[0] === c.follows) ? c.follows : fallback.follows,
			harmony: Number.isFinite(c.harmony) ? Math.min(1, Math.max(0, c.harmony)) : 1
		};
	} catch {
		return fallback;
	}
};

// the live settings of one preset: the panel writes here, the next frame reads them
export function colourSettings(preset: string, gradients: readonly Gradient[]): Colours {
	const colours = load(preset, gradients);
	settings.set(preset, { colours, gradients });
	return colours;
}

export const coloursOf = (preset: string) => settings.get(preset);

export function setColours(preset: string, patch: Partial<Colours>) {
	const s = settings.get(preset);
	if (!s) return;
	Object.assign(s.colours, patch);
	bumpTune();
	try {
		localStorage.setItem(STORE + preset, JSON.stringify(s.colours));
	} catch {
		// storage denied: the colours still apply, they are just forgotten on restart
	}
}

export const hexToRgb = (hex: string): Rgb => {
	const n = parseInt(hex.slice(1), 16);
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};
export const rgbToHex = ({ r, g, b }: Rgb) =>
	"#" + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

// The palette a preset draws with this frame, as HSL stops. Cover colours keep their own band of lightness (pulled into one
// band they collapse into a single colour); picked colours are kept as picked, only off pure black and white.
const COVER_BANDS = [
	[0.3, 0.44],
	[0.46, 0.58],
	[0.6, 0.74]
];
// below this saturation a colour reads as grey: its hue is noise and is never boosted or relied on
export const GREY = 0.12;
const coverStop = (c: Hsl, [lo, hi]: number[]): Hsl => ({
	h: c.h,
	s: c.s < GREY ? c.s : Math.max(0.45, Math.min(0.95, c.s)),
	l: Math.max(lo, Math.min(hi, c.l))
});
export function palette(colours: Colours, cover: Rgb[]): Hsl[] {
	if (colours.mode === "custom") {
		return colours.stops.map(hex => {
			const c = rgbToHsl(hexToRgb(hex));
			return { h: c.h, s: c.s, l: Math.max(0.18, Math.min(0.82, c.l)) };
		});
	}
	return cover.map((rgb, i) =>
		coverStop(rgbToHsl(rgb), cover.length === 1 ? [0.45, 0.66] : COVER_BANDS[Math.round((i / (cover.length - 1)) * 2)])
	);
}

// The cover's own colours by area, for Drift, where light adds up on black and lightness hardly reads: pixel hues are grouped
// and groups covering a real share of the coloured area become the palette. Fewer than two such groups gives [].
const SHARE = 0.1;
export function coverHues(px: Uint8ClampedArray): Rgb[] {
	const BINS = 36;
	const count = new Float64Array(BINS);
	const sum = new Float64Array(BINS * 3);
	let coloured = 0;
	for (let i = 0; i + 3 < px.length; i += 4) {
		const c = rgbToHsl({ r: px[i], g: px[i + 1], b: px[i + 2] });
		if (c.s < 0.35 || c.l < 0.15 || c.l > 0.85) continue;
		const k = Math.floor(c.h * BINS) % BINS;
		coloured++;
		count[k]++;
		sum[k * 3] += px[i];
		sum[k * 3 + 1] += px[i + 1];
		sum[k * 3 + 2] += px[i + 2];
	}
	const used = new Uint8Array(BINS);
	const found: Rgb[] = [];
	while (found.length < 3 && coloured > 0) {
		let peak = -1;
		for (let k = 0; k < BINS; k++) if (!used[k] && (peak < 0 || count[k] > count[peak])) peak = k;
		if (peak < 0) break;
		// a group is its peak and a bin to each side (30 degrees of hue); two more to each side are kept
		// out of the next group, so one hue does not come back as two
		let n = 0;
		let r = 0;
		let g = 0;
		let b = 0;
		for (let d = -2; d <= 2; d++) {
			const k = (peak + d + BINS) % BINS;
			if (Math.abs(d) <= 1 && !used[k]) {
				n += count[k];
				r += sum[k * 3];
				g += sum[k * 3 + 1];
				b += sum[k * 3 + 2];
			}
			used[k] = 1;
		}
		if (n / coloured < SHARE) break;
		found.push({ r: r / n, g: g / n, b: b / n });
	}
	return found.length >= 2 ? found : [];
}

// Drift's palette: the cover's own colours by area when it has two or more, otherwise its shades
// (slots 3..5 of the cover colours hold the former, or a copy of the latter)
export function distinctCover(colours: Colours, cover: Rgb[]): Hsl[] {
	if (colours.mode === "custom" || cover.length < 6) return palette(colours, cover.slice(0, 3));
	const picked = cover.slice(3, 6).map(rgbToHsl).sort((a, b) => a.l - b.l);
	return picked.map((c, i) => coverStop(c, COVER_BANDS[i]));
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
	let h = a.h + dh * f;
	if (a.s < GREY) h = b.h;
	else if (b.s < GREY) h = a.h;
	return { h, s: a.s + (b.s - a.s) * f, l: a.l + (b.l - a.l) * f };
}

// the furthest a drawn hue may end from the palette, in turns; past it a red cover drew green lines
export const HUE_REACH = 30 / 360;
const wrapTurn = (d: number) => (((d % 1) + 1.5) % 1) - 0.5;

// the hue to draw: `base` (a point on the palette) leaned by `lean` and turned towards the palette's other colours by
// `turn` (0..1), never further than HUE_REACH off. Each other colour pulls by its distance, fading out at its own hue and
// opposite it, so the pull has no step as the base moves; a palette of one hue has nothing to turn to.
export function familyHue(pal: Hsl[], base: Hsl, lean: number, turn = 0): number {
	let pull = 0;
	if (turn > 0)
		for (const c of pal) {
			const d = wrapTurn(c.h - base.h);
			pull += d * (1 - 4 * d * d) ** 2 * Math.max(0, Math.min(1, (c.s - GREY) / 0.1));
		}
	return base.h + Math.max(-HUE_REACH, Math.min(HUE_REACH, lean + pull * turn));
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const d = max - min;
	const l = (max + min) / 2;
	let h = 0;
	if (d > 1e-6) {
		if (max === rn) h = ((gn - bn) / d) % 6;
		else if (max === gn) h = (bn - rn) / d + 2;
		else h = (rn - gn) / d + 4;
		h = (((h / 6) % 1) + 1) % 1;
	}
	return { h, s: d < 1e-6 ? 0 : d / (1 - Math.abs(2 * l - 1)), l };
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
	const hue = (((h % 1) + 1) % 1) * 6;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs((hue % 2) - 1));
	const m = l - c / 2;
	let rgb: number[];
	switch (Math.floor(hue) % 6) {
		case 0: rgb = [c, x, 0]; break;
		case 1: rgb = [x, c, 0]; break;
		case 2: rgb = [0, c, x]; break;
		case 3: rgb = [0, x, c]; break;
		case 4: rgb = [x, 0, c]; break;
		default: rgb = [c, 0, x];
	}
	return { r: Math.round((rgb[0] + m) * 255), g: Math.round((rgb[1] + m) * 255), b: Math.round((rgb[2] + m) * 255) };
}
