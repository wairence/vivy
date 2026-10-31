// The frame rate cap, shared by both presets. 0 draws every frame the monitor gives. Presets move by
// the clock, not by the frame, so a cap changes smoothness, never speed.
export const FRAME_RATES = [30, 60, 120, 0] as const;
export type FrameRate = (typeof FRAME_RATES)[number];

const STORE = "vivy:fps";

let cap: FrameRate = (() => {
	try {
		const stored = Number(localStorage.getItem(STORE));
		return FRAME_RATES.find(r => r === stored) ?? 0;
	} catch {
		return 0;
	}
})();

export const frameRate = () => cap;

export function setFrameRate(fps: FrameRate) {
	cap = fps;
	try {
		localStorage.setItem(STORE, String(fps));
	} catch {
		// back to the monitor's rate next time
	}
}

const MAX_PIXELS = 1920 * 1080;

// Device pixels to draw a canvas at. Fills cost by area: above 1080p it renders smaller and CSS stretches it.
export function renderSize(canvas: HTMLCanvasElement, ratio: number) {
	const shrink = Math.min(1, Math.sqrt(MAX_PIXELS / Math.max(1, canvas.clientWidth * ratio * canvas.clientHeight * ratio)));
	return { w: Math.max(1, Math.floor(canvas.clientWidth * ratio * shrink)), h: Math.max(1, Math.floor(canvas.clientHeight * ratio * shrink)) };
}

// Whether the animation frame at `now` (ms) is drawn under the cap. The schedule advances by whole
// intervals, so 60 on a 240 Hz monitor is exactly every fourth frame.
export function createFramePacer() {
	let next = -Infinity;
	return (now: number, fps: number) => {
		if (fps <= 0) return true;
		const interval = 1000 / fps;
		// 1 ms of slack for rAF jitter; a schedule far ahead (the cap was raised) is dropped
		if (now < next - 1 && next - now < interval * 2) return false;
		next = (Math.abs(now - next) > interval ? now : next) + interval;
		return true;
	};
}
