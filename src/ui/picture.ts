// Brightness, contrast, saturation and transparency of the whole picture, applied as CSS on the canvas.
// At the defaults no style is set, so it costs nothing.

export type Picture = { brightness: number; contrast: number; saturation: number; transparency: number };

export const PICTURE_DEFAULTS: Picture = { brightness: 1, contrast: 1, saturation: 1, transparency: 0 };

const STORAGE_KEY = "vivy:picture";

function load(): Picture {
	try {
		const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
		const picture = { ...PICTURE_DEFAULTS };
		for (const key of Object.keys(picture) as (keyof Picture)[])
			if (typeof stored?.[key] === "number" && Number.isFinite(stored[key])) picture[key] = stored[key];
		return picture;
	} catch {
		return { ...PICTURE_DEFAULTS };
	}
}

let picture = load();
let target: { canvas: HTMLCanvasElement; container: HTMLElement } | null = null;

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
	target.canvas.style.opacity = transparency ? String(1 - transparency) : "";
	// the container's black would show through instead of the Spotify theme behind the page
	target.container.style.background = transparency ? "transparent" : "";
}

export function showPictureOn(canvas: HTMLCanvasElement, container: HTMLElement) {
	target = { canvas, container };
	refreshPicture();
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
