// ---- the colours --------------------------------------------------------------------------------------------
// Each preset has its own colour settings, set in the knobs panel and kept across restarts:
//   cover    the cover's own palette, three colours Spotify extracts from the art (dark, vibrant, light)
//   custom   two or three colours the listener picked
// and what moves a colour along that palette - the gradient. What a gradient can follow depends on what
// the preset is made of, so each preset names its own (Ridgeline: the height of a ridge, its depth, the
// sound; Drift: its layers, depth, the sound of each mark, the music). `harmony` is how far the key of
// each section turns the hue (0 keeps the colours exactly as picked).
//
// A preset declares its gradients once, at module scope, as it declares its knobs:
//     const COLOURS = colourSettings("ridge", [["height", "Height", "what it does"], ...]);
// and reads COLOURS.follows / COLOURS.mode, which the panel changes under it.
import { Hsl, rgbToHsl } from "./presets/flowfield-common";
import { bumpTune } from "./presets/tune";

export type Rgb = { r: number; g: number; b: number };
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

// The palette a preset draws with this frame, as HSL stops, first to last.
// The cover's three colours each keep their place in a band of lightness, dark to light, with enough
// colour to read. Pulled all into one band, as the single cover colour used to be, three different
// colours came out as one - and a gradient between them was no gradient at all.
// Picked colours are kept as picked, only kept off pure black and white, where there is no light left
// to shape anything with.
const COVER_BANDS = [
	[0.3, 0.44],
	[0.46, 0.58],
	[0.6, 0.74]
];
export function palette(colours: Colours, cover: Rgb[]): Hsl[] {
	if (colours.mode === "custom") {
		return colours.stops.map(hex => {
			const c = rgbToHsl(hexToRgb(hex));
			return { h: c.h, s: c.s, l: Math.max(0.18, Math.min(0.82, c.l)) };
		});
	}
	return cover.map((rgb, i) => {
		const c = rgbToHsl(rgb);
		const [lo, hi] = cover.length === 1 ? [0.45, 0.66] : COVER_BANDS[Math.round((i / (cover.length - 1)) * 2)];
		return { h: c.h, s: Math.max(0.45, Math.min(0.95, c.s)), l: Math.max(lo, Math.min(hi, c.l)) };
	});
}

// THE COVER'S OWN COLOURS, BY AREA, for a preset whose light adds up on black (Drift): there a
// difference in lightness hardly reads - a brighter stroke just looks nearer - and the dark, vibrant
// and light colour Spotify extracts are often three shades of one hue. So the cover itself is looked
// at: its coloured pixels, grouped by hue, and every group that covers a real part of the coloured
// area is a colour of the palette, dark to light. A speck of another colour (a red badge on a blue
// cover, 4% of it) is not a colour of that cover: blended into the gradient it turned blue to purple
// to red, which the cover is not. A cover with one such group, or none, gives [] - it is of one colour,
// and the extracted shades of it are used.
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
	return picked.map((c, i) => {
		const [lo, hi] = COVER_BANDS[i];
		return { h: c.h, s: Math.max(0.45, Math.min(0.95, c.s)), l: Math.max(lo, Math.min(hi, c.l)) };
	});
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
