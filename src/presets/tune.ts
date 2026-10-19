// ---- live knobs -----------------------------------------------------------------------------------------
// A preset's numbers, turned while the music plays (T in the client opens the panel). The loop was:
// change a constant, build, apply, restart Spotify, find the place in the song, look - minutes a
// number. With a slider it is a second, and the number that looked right is copied out of the panel
// and written back into the code as the new default.
//
// A preset declares its knobs once, at module scope:
//     const K = tune("ridge", { HORIZON: [0.3, 0.1, 0.5, "horizon height", "view"], ... });
// and reads `K.HORIZON` where it read `HORIZON`. The object IS the live value: the panel writes into
// it, the next frame reads it. A value moved off its default is kept across restarts - but only while
// the code's default is still the one it was moved from, so a default changed in code wins.
export type KnobSpec = readonly [def: number, min: number, max: number, label: string, group?: string];
// `basic`: one of the few shown by default; the rest wait behind "More"
export type Knob = { key: string; def: number; min: number; max: number; label: string; group: string; hint: string; basic: boolean };
export type Feature = { name: string; on: boolean };
export type Tuning = { knobs: Knob[]; values: Record<string, number>; features: Feature[] };

// (everything moved under the older keys was written into the code on 2026-10-18)
const STORE = "vivy:tune:";
const tunings = new Map<string, Tuning>();
// bumped on every change, so a preset that caches what a knob shaped (a row, a table) knows to redo it
let version = 0;
export const tuneVersion = () => version;
// something else a preset caches from changed (the colours)
export const bumpTune = () => void version++;

const load = (preset: string): Record<string, [number, number]> => {
	try {
		return JSON.parse(localStorage.getItem(STORE + preset) ?? "{}") ?? {};
	} catch {
		return {};
	}
};
const save = (preset: string) => {
	const t = tunings.get(preset);
	if (!t) return;
	const moved: Record<string, [number, number]> = {};
	for (const k of t.knobs) if (t.values[k.key] !== k.def) moved[k.key] = [t.values[k.key], k.def];
	try {
		localStorage.setItem(STORE + preset, JSON.stringify(moved));
	} catch {
		// storage denied: the knob still works, it is just forgotten on restart
	}
};

// `hints`: what each knob does, in words for the person moving it - shown next to the panel on hover
export function tune<T extends Record<string, KnobSpec>>(
	preset: string,
	spec: T,
	hints: { [K in keyof T]?: string } = {},
	basic?: (keyof T & string)[]
): { [K in keyof T]: number } {
	const saved = load(preset);
	const values: Record<string, number> = {};
	const knobs: Knob[] = [];
	let group = "";
	let stale = false;
	for (const key of Object.keys(spec)) {
		const [def, min, max, label, g] = spec[key];
		group = g ?? group;
		const s = saved[key];
		const kept = Array.isArray(s) && s[1] === def && Number.isFinite(s[0]);
		// moved from a default the code no longer has: forgotten now, or it would come back the day the
		// default happens to return to what it was
		if (s !== undefined && !kept) stale = true;
		values[key] = kept ? Math.min(max, Math.max(min, s[0])) : def;
		knobs.push({ key, def, min, max, label, group, hint: hints[key] ?? "", basic: !basic || basic.includes(key) });
	}
	tunings.set(preset, { knobs, values, features: tunings.get(preset)?.features ?? [] });
	if (stale) save(preset);
	return values as { [K in keyof T]: number };
}

// on/off switches a preset already has (its number keys) shown in the panel too
export function tuneFeatures(preset: string, features: Feature[]) {
	const t = tunings.get(preset) ?? { knobs: [], values: {}, features: [] };
	t.features = features;
	tunings.set(preset, t);
}

export const tuningOf = (preset: string) => tunings.get(preset);

export function setKnob(preset: string, key: string, value: number) {
	const t = tunings.get(preset);
	const k = t?.knobs.find(k => k.key === key);
	if (!t || !k || !Number.isFinite(value)) return;
	t.values[key] = Math.min(k.max, Math.max(k.min, value));
	version++;
	save(preset);
}

export function resetKnobs(preset: string) {
	const t = tunings.get(preset);
	if (!t) return;
	for (const k of t.knobs) t.values[k.key] = k.def;
	version++;
	save(preset);
}

// what was moved, as lines to paste back: "FOG_START = 2.4 (was 1.9)"
export function movedText(preset: string) {
	const t = tunings.get(preset);
	if (!t) return "";
	return t.knobs
		.filter(k => t.values[k.key] !== k.def)
		.map(k => `${preset} ${k.key} = ${+t.values[k.key].toPrecision(4)} (was ${k.def})`)
		.join("\n");
}
