// Brightness, contrast, saturation and transparency of the whole picture, applied as CSS on the canvas.
// At the defaults no style is set, so it costs nothing.

export type Picture = { brightness: number; contrast: number; saturation: number; transparency: number };

export const PICTURE_DEFAULTS: Picture = { brightness: 1, contrast: 1, saturation: 1, transparency: 0 };

const STORAGE_KEY = "vivy:picture";
export const PICTURE_RANGE: Record<keyof Picture, [number, number]> = { brightness: [0, 2], contrast: [0, 2], saturation: [0, 2], transparency: [0, 1] };

export function storedPicture(): Picture {
	try {
		const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
		const picture = { ...PICTURE_DEFAULTS };
		for (const key of Object.keys(picture) as (keyof Picture)[])
			if (typeof stored?.[key] === "number" && Number.isFinite(stored[key])) picture[key] = Math.max(PICTURE_RANGE[key][0], Math.min(PICTURE_RANGE[key][1], stored[key]));
		return picture;
	} catch {
		return { ...PICTURE_DEFAULTS };
	}
}

let picture = storedPicture();
let target: { canvas: HTMLCanvasElement; container: HTMLElement; backdrop: HTMLElement } | null = null;

export const currentPicture = () => picture;

export const isDefaultPicture = () => (Object.keys(picture) as (keyof Picture)[]).every(k => picture[k] === PICTURE_DEFAULTS[k]);

const CONTRAST_ID = "vivy-contrast";
const SVG_NS = "http://www.w3.org/2000/svg";

// CSS contrast() pivots on mid grey and turns black grey; a gamma curve keeps black and white and
// moves only the midtones. url() resolves in the canvas's own document, so the mini window gets a copy.
function setContrastFilter(doc: Document, exponent: number) {
	let filter: Element | null = doc.getElementById(CONTRAST_ID);
	if (!filter) {
		const svg = doc.createElementNS(SVG_NS, "svg");
		svg.setAttribute("style", "position:absolute;width:0;height:0");
		const created = doc.createElementNS(SVG_NS, "filter");
		created.id = CONTRAST_ID;
		created.setAttribute("color-interpolation-filters", "sRGB");
		const transfer = doc.createElementNS(SVG_NS, "feComponentTransfer");
		for (const channel of ["R", "G", "B"]) {
			const fn = doc.createElementNS(SVG_NS, `feFunc${channel}`);
			fn.setAttribute("type", "gamma");
			transfer.append(fn);
		}
		created.append(transfer);
		svg.append(created);
		doc.body.append(svg);
		filter = created;
	}
	for (const fn of filter.firstElementChild!.children) fn.setAttribute("exponent", String(exponent));
}

export function refreshPicture() {
	if (!target) return;
	const { brightness, contrast, saturation, transparency } = picture;
	const parts: string[] = [];
	if (brightness !== 1) parts.push(`brightness(${brightness})`);
	if (contrast !== 1) {
		setContrastFilter(target.canvas.ownerDocument, 2 ** (contrast - 1));
		parts.push(`url(#${CONTRAST_ID})`);
	}
	if (saturation !== 1) parts.push(`saturate(${saturation})`);
	target.canvas.style.filter = parts.join(" ");
	// screen adds the preset's light to what is behind and drops its black; only the black under it
	// thins out, so the lines stay at full strength over the theme
	target.canvas.style.mixBlendMode = transparency ? "screen" : "";
	target.container.style.background = transparency ? "transparent" : "";
	seeThroughPage(paintBackdrop(target.backdrop, transparency));
}

// Stock Spotify has nothing behind the page, so there the backdrop is the cover, blurred; a theme
// keeps its own picture under the window. The marketplace slot with no theme installed is stock too.
export function isStockTheme(): boolean {
	const theme = Spicetify.Config?.current_theme ?? "";
	if (theme === "" || theme === "SpicetifyDefault") return true;
	if (theme !== "marketplace") return false;
	try {
		return JSON.parse(localStorage.getItem("marketplace:installed-themes") ?? "[]").length === 0;
	} catch {
		return false;
	}
}

function coverUrl(): string | null {
	const meta = Spicetify.Player.data?.item?.metadata;
	// the medium size: blurred over the whole page, a large one looks the same
	const url = meta?.image_url || meta?.image_large_url;
	if (!url) return null;
	return url.startsWith("spotify:image:") ? "https://i.scdn.co/image/" + url.slice(14) : url;
}

// The cover the way the Hazy theme lays it under Spotify: soft, washed out, over black.
const COVER_LOOK = "blur(15px) contrast(0.5) saturate(0.7) brightness(1.2)";
const COVER_OPACITY = 0.55;

// What shows under a transparent preset: on the stock theme the cover over black, as strong as
// `transparency`; with a theme black thinned by it, and true says the theme's picture must show through.
export function paintBackdrop(el: HTMLElement, transparency: number): boolean {
	const cover = transparency && isStockTheme() ? coverUrl() : null;
	el.style.background = transparency && !cover ? `rgba(0, 0, 0, ${1 - transparency})` : "#000";
	let image = el.firstElementChild as HTMLElement | null;
	if (!cover) {
		image?.remove();
		return transparency > 0;
	}
	if (!image) {
		image = document.createElement("div");
		image.style.cssText = `position:absolute;inset:0;background-size:cover;background-position:center;filter:${COVER_LOOK}`;
		el.append(image);
	}
	image.style.backgroundImage = `url("${cover}")`;
	image.style.opacity = String(COVER_OPACITY * transparency);
	return false;
}

// A theme's picture sits under the whole window with the main view painted solid over it, and the
// page is isolated, so a blend never reaches it: while open, the page's wrappers go clear (.vivy-see-through).
const SEE_THROUGH = "vivy-see-through";
function seeThroughPage(on: boolean) {
	document.querySelectorAll(`.${SEE_THROUGH}`).forEach(el => el.classList.remove(SEE_THROUGH));
	if (!on || !target) return;
	for (let el = target.container.parentElement; el && !el.matches(".Root__top-container, body"); el = el.parentElement) el.classList.add(SEE_THROUGH);
}

export function showPictureOn(canvas: HTMLCanvasElement, container: HTMLElement, backdrop: HTMLElement) {
	target = { canvas, container, backdrop };
	refreshPicture();
	Spicetify.Player.addEventListener("songchange", refreshPicture);
	return () => {
		Spicetify.Player.removeEventListener("songchange", refreshPicture);
		seeThroughPage(false);
		target = null;
	};
}

export function setPicture(patch: Partial<Picture>) {
	picture = { ...picture, ...patch };
	try {
		if (isDefaultPicture()) localStorage.removeItem(STORAGE_KEY);
		else localStorage.setItem(STORAGE_KEY, JSON.stringify(picture));
	} catch {
		// not remembered: the defaults next time
	}
	refreshPicture();
}
