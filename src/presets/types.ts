import { TrackAudioData, sampleCurve } from "../audio-data";

export type PresetFrame = {
	ctx: CanvasRenderingContext2D;
	width: number;
	height: number;
	progressSec: number;
	isPlaying: boolean;
	audio: TrackAudioData | null;
	colorRgb: { r: number; g: number; b: number };
	// the cover's palette, dark to light (colorRgb is its middle); absent in the test harnesses
	palette?: { r: number; g: number; b: number }[];
	// all six colours Spotify extracts from the cover (the palette's three first)
	coverColours?: { r: number; g: number; b: number }[];
};

export type Preset = {
	draw: (frame: PresetFrame) => void;
};

export type PresetDefinition = {
	id: string;
	name: string;
	// shown, but marked as not finished
	experimental?: boolean;
	create: () => Preset;
};

export function rgbString({ r, g, b }: { r: number; g: number; b: number }, alpha = 1): string {
	return alpha === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// energy in [0, 1]: continuous loudness where we have analysis, a gentle wave otherwise
// (e.g. local files/podcasts have no audio-analysis at all)
export function currentEnergy(frame: PresetFrame): number {
	if (!frame.audio) return frame.isPlaying ? Math.sin(frame.progressSec) * 0.5 + 0.5 : 0.5;
	if (!frame.isPlaying) return 0.5;

	return sampleCurve(frame.audio.loudnessCurve, frame.progressSec);
}

// What a simulation reports about itself, for the headless check to assert on.
//
// A preset that draws strokes is fully checked by the fake canvas: every number it hands over is
// seen. A preset that draws pixels is not - a Uint8ClampedArray turns a NaN into 0 on the way in,
// so by the time a bad value reaches an ImageData the evidence has been destroyed. Any preset with
// state that is not visible in its draw calls (a camera, a simulation) publishes it here once a
// frame, and `check-presets.js` asserts every number in it is finite and within the range the
// preset declares.
export let lastDiagnostics: { label: string; values: Record<string, number> } | null = null;
export function publishDiagnostics(label: string, values: Record<string, number>): void {
	lastDiagnostics = { label, values };
}
