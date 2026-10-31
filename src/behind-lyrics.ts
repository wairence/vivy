// vivy behind Spicy Lyrics: on or off, which preset, how dark. Written by the knobs panel, read by
// the extension; they are separate bundles, so the state lives in storage and changes go by event.

export type BehindLyrics = { on: boolean; preset: string; dim: number };

export const BEHIND_LYRICS_DEFAULTS: BehindLyrics = { on: false, preset: "ridge", dim: 0.35 };

const STORAGE_KEY = "vivy:behind-lyrics";
const EVENT = "vivy-behind-lyrics";

export function behindLyrics(): BehindLyrics {
	try {
		const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
		return {
			on: typeof stored?.on === "boolean" ? stored.on : BEHIND_LYRICS_DEFAULTS.on,
			preset: typeof stored?.preset === "string" ? stored.preset : BEHIND_LYRICS_DEFAULTS.preset,
			dim: typeof stored?.dim === "number" && Number.isFinite(stored.dim) ? Math.max(0, Math.min(1, stored.dim)) : BEHIND_LYRICS_DEFAULTS.dim
		};
	} catch {
		return { ...BEHIND_LYRICS_DEFAULTS };
	}
}

export function setBehindLyrics(patch: Partial<BehindLyrics>) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...behindLyrics(), ...patch }));
	} catch {
		// not remembered, but the extension still hears the change below
	}
	window.dispatchEvent(new CustomEvent(EVENT, { detail: { ...behindLyrics(), ...patch } }));
}

export function onBehindLyricsChange(listener: (settings: BehindLyrics) => void) {
	const handler = (e: Event) => listener((e as CustomEvent<BehindLyrics>).detail);
	window.addEventListener(EVENT, handler);
	return () => window.removeEventListener(EVENT, handler);
}
