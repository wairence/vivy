import { TrackAudioData, sampleCurve } from "../audio-data";

// Mouse state is passed to presets, but neither current preset reads it.
export type MouseState = {
	x: number;
	y: number;
	// smoothed frame-to-frame movement speed in canvas px/frame - 0 when the mouse is still
	speed: number;
	// cumulative click count - watch for it increasing rather than reading a one-shot flag,
	// so a click is never missed between frames
	clicks: number;
	// same idea, right mouse button
	rightClicks: number;
	// true while the button is held down
	down: boolean;
	rightDown: boolean;
	// persistent 0..1 knob nudged by the scroll wheel, not a per-frame delta
	scroll: number;
	// persistent 0..1 knob nudged by alt+scroll wheel - how many particles to run with.
	// 0.5 is the neutral/default count
	particleScale: number;
};

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
	mouse: MouseState;
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
