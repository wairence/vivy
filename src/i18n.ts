// The text vivy shows, by language. The app's own text is in ui/text.ts; here are the few strings that code
// shared with the Spicy Lyrics extension shows, so that bundle carries only these (each locale's `shared`).
// A language is a table of the same ids, keyed by the language part of the locale ("pt" is Brazilian);
// a missing entry falls back to English.
import { shared as de } from "./locales/de";
import { shared as es } from "./locales/es";
import { shared as ja } from "./locales/ja";
import { shared as pt } from "./locales/pt";
import { shared as ru } from "./locales/ru";
import { shared as turkish } from "./locales/tr";

export const EN = {
	"lyrics.toggleOn": "vivy behind the lyrics: {preset}. Click to turn off",
	"lyrics.toggleOff": "vivy behind the lyrics: off. Click to turn on",
	"notice.tempoOnly": 'No analysis for "{track}" - using its tempo ({bpm} BPM). No section dynamics.',
	"notice.noAnalysis": 'No audio analysis for "{track}" - the picture follows a plain pulse.',
	"notice.noWebgl": "Drift needs WebGL, and this client has it switched off",
	"drift.noWebgl": "Drift needs WebGL. Turn on hardware acceleration in Spotify's settings."
};

type Vars = Record<string, string | number>;

// Spotify's own language, then the system's; read on every call, since Spicetify.Locale may come up after this module
export function language(): string {
	let locale = "";
	try {
		locale = (typeof Spicetify !== "undefined" && Spicetify.Locale?.getLocale?.()) || "";
	} catch {
		// not ready yet
	}
	if (!locale && typeof navigator !== "undefined") locale = navigator.language ?? "";
	return locale.toLowerCase().split(/[-_]/)[0] || "en";
}

const fill = (text: string, vars?: Vars) => (vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text);

export const translator =
	<Id extends string>(english: Record<Id, string>, languages: Record<string, Record<string, string>>) =>
	(id: Id, vars?: Vars) =>
		fill(languages[language()]?.[id] ?? english[id], vars);

export const LANGUAGES: Record<string, Record<string, string>> = { ru, es, pt, de, ja, tr: turkish };

export const t = translator(EN, LANGUAGES);
