// The text vivy shows. English is the source: here for the shell, and in the presets' own declarations
// (knobs and hints in tune(), gradients in colourSettings(), Ridgeline's switches), whose ids are
// `<preset>.<KNOB>`, `<preset>.<KNOB>.hint`, `group.<group>`, `<preset>.<key 1-9>`, `<preset>.follows.<id>` and `.hint`.
// A language is a table of the same ids; a missing entry falls back to English.
import de from "./locales/de";
import es from "./locales/es";
import ja from "./locales/ja";
import pt from "./locales/pt";
import ru from "./locales/ru";
import turkish from "./locales/tr";

export const EN = {
	presets: "Presets",
	experimental: "Experimental",
	exp: "exp",
	"button.knobs": "Knobs (T)",
	"button.pip": "Mini window (P)",
	"button.pipClose": "Close mini window (P)",
	"button.fullscreen": "Fullscreen (F)",
	"button.fullscreenExit": "Exit fullscreen (F)",

	"track.none": "Start playing a song",
	"track.seek": "Seek",
	"track.previous": "Previous",
	"track.play": "Play",
	"track.pause": "Pause",
	"track.next": "Next",
	"track.like": "Save to Liked Songs",
	"track.unlike": "Remove from Liked Songs",

	"panel.title": "Knobs",
	"panel.copy": "Copy moved values",
	"panel.reset": "Reset all to defaults",
	"panel.close": "Close (T)",
	"tab.preset": "Preset",
	"tab.colour": "Colour",
	"tab.picture": "Picture",
	"tab.lyrics": "Lyrics",
	"panel.noKnobs": "This preset has no knobs yet.",
	"panel.more": "More settings",
	"panel.fewer": "Fewer settings",
	"panel.effects": "effects",
	"panel.knobFoot": "default {value} · double-click the name to reset",
	"panel.copied": "Moved knobs copied",
	"panel.nothingMoved": "Nothing moved yet",

	"fps.title": "frame rate",
	"fps.monitor": "Monitor",
	"fps.hint":
		"Pictures drawn per second. Lower takes load off the graphics card on a fast monitor; movement keeps its speed, only smoothness changes. Monitor draws every frame the screen shows.",
	"fps.foot": "applies to every preset",

	"mode.cover": "Cover",
	"mode.cover.hint": "The colours come from the album cover and change with every track.",
	"mode.custom": "Custom",
	"mode.custom.hint": "Your own two or three colours, the same for every track.",
	"colour.change": "Change this colour",
	"colour.n": "Colour {n}: {hex}",
	"colour.add": "Add a colour",
	"colour.remove": "Remove",
	"colour.follows": "gradient follows",
	"colour.harmony": "the song's key turns the hue",
	"colour.harmony.hint":
		"Each part of a song has its own key, and the colours lean round the wheel with it. Zero keeps them exactly as they are. Double-click the name to reset.",

	"picture.brightness": "brightness",
	"picture.brightness.hint": "Darker or lighter, the whole picture.",
	"picture.contrast": "contrast",
	"picture.contrast.hint": "Lifts or deepens the midtones; black stays black and white stays white.",
	"picture.saturation": "saturation",
	"picture.saturation.hint": "From grey to stronger colour.",
	"picture.transparency": "transparency",
	"picture.transparency.hint":
		"Thins the black under the lines. With a theme that has a picture, the picture shows through; with Spotify's own look, the cover, blurred.",
	"picture.foot": "Applies to every preset. Double-click the name to reset.",
	"picture.reset": "Reset picture",

	"lyrics.note":
		"A preset in place of Spicy Lyrics' own background, on its page and in its fullscreen. Needs the Spicy Lyrics extension; the button with vivy's mark in its controls turns it on and off.",
	"lyrics.title": "behind the lyrics",
	"lyrics.off": "Off",
	"lyrics.dim": "darkness",
	"lyrics.dim.hint": "How dark the picture behind the lyrics is, so the words stay readable. Double-click the name to reset.",
	"lyrics.toggleOn": "vivy behind the lyrics: {preset}. Click to turn off",
	"lyrics.toggleOff": "vivy behind the lyrics: off. Click to turn on",

	"notice.tempoOnly": 'No analysis for "{track}" - using its tempo ({bpm} BPM). No section dynamics.',
	"notice.noAnalysis": 'No audio analysis for "{track}" - the picture follows a plain pulse.',
	"notice.feature": "{preset} {n}: {name} {state}",
	"notice.featureOn": "ON",
	"notice.featureOff": "off",
	"notice.noWebgl": "Drift needs WebGL, and this client has it switched off",
	"drift.noWebgl": "Drift needs WebGL. Turn on hardware acceleration in Spotify's settings.",

	"pip.unsupported": "This Spotify build has no picture-in-picture window",
	"pip.failed": "Picture-in-picture: {error}",
	"pip.drag": "Drag to move. Wheel, + and - resize. Esc closes.",
	"pip.close": "Close (Esc)",
	"pip.bigger": "Bigger (+ or wheel up)",
	"pip.smaller": "Smaller (- or wheel down)"
};

export type TextId = keyof typeof EN;
type Vars = Record<string, string | number>;

// keyed by the language part of the locale: "pt" is written in Brazilian Portuguese
export const LANGUAGES: Record<string, Record<string, string>> = { ru, es, pt, de, ja, tr: turkish };

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

export const t = (id: TextId, vars?: Vars) => fill(LANGUAGES[language()]?.[id] ?? EN[id], vars);

// for what a preset declares: its English stays in the declaration
export const tr = (id: string, english: string) => LANGUAGES[language()]?.[id] ?? english;
