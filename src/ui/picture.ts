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

function apply() {
	if (!target) return;
	const { brightness, contrast, saturation, transparency } = picture;
	const filtered = brightness !== 1 || contrast !== 1 || saturation !== 1;
	target.canvas.style.filter = filtered ? `brightness(${brightness}) contrast(${contrast}) saturate(${saturation})` : "";
	target.canvas.style.opacity = transparency ? String(1 - transparency) : "";
	// the container's black would show through instead of the Spotify theme behind the page
	target.container.style.background = transparency ? "transparent" : "";
}

export function showPictureOn(canvas: HTMLCanvasElement, container: HTMLElement) {
	target = { canvas, container };
	apply();
}

export function setPicture(patch: Partial<Picture>) {
	picture = { ...picture, ...patch };
	try {
		if (isDefaultPicture()) localStorage.removeItem(STORAGE_KEY);
		else localStorage.setItem(STORAGE_KEY, JSON.stringify(picture));
	} catch {
		// not remembered: the defaults next time
	}
	apply();
}
