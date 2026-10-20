import { MutableRefObject, RefObject, useCallback, useEffect, useRef } from "react";
import { TrackAudioData } from "../audio-data";
import { AudioSync, createSmoothClock } from "../audio-sync";
import { DEV } from "../build-stamp";
import { Rgb } from "../colours";
import { createFramePacer, frameRate } from "../frame-rate";
import { Preset, PresetFrame } from "../presets";
import { createMiniWindow } from "./mini-window";

// The canvas and its frame loop: size, colours on their way to the new cover's, the clock, and
// preset.draw once per animation frame of the window the canvas is in. Returns the mini window toggle.
export function useFrameLoop(
	canvasRef: RefObject<HTMLCanvasElement>,
	presetRef: MutableRefObject<Preset | undefined>,
	audioRef: MutableRefObject<TrackAudioData | null>,
	coverRef: MutableRefObject<Rgb[]>,
	setMiniOpen: (open: boolean) => void
) {
	const toggleRef = useRef(() => {});

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		// opaque: never composited against anything behind it
		const ctx = canvas.getContext("2d", { alpha: false });
		if (!ctx) return;

		// Spotify's window, or the mini window
		const host = () => canvas.ownerDocument.defaultView ?? window;
		const resize = () => {
			const w = Math.max(1, Math.floor(canvas.clientWidth * host().devicePixelRatio));
			const h = Math.max(1, Math.floor(canvas.clientHeight * host().devicePixelRatio));
			// setting a canvas's size wipes it, even to the size it already has
			if (w === canvas.width && h === canvas.height) return;
			// paused, nothing redraws: carry the picture over, stretched, instead of leaving black
			let kept: HTMLCanvasElement | null = null;
			if (!Spicetify.Player.isPlaying() && canvas.width > 1) {
				kept = document.createElement("canvas");
				kept.width = canvas.width;
				kept.height = canvas.height;
				kept.getContext("2d")?.drawImage(canvas, 0, 0);
			}
			canvas.width = w;
			canvas.height = h;
			if (kept) ctx.drawImage(kept, 0, 0, w, h);
		};
		resize();
		if (DEV) Spicetify.showNotification(`Visualizer canvas ${canvas.width}x${canvas.height}`);
		window.addEventListener("resize", resize);
		const boxWatch = typeof ResizeObserver === "function" ? new ResizeObserver(() => resize()) : null;
		boxWatch?.observe(canvas);

		const audioSync = new AudioSync();
		const smoothClock = createSmoothClock();
		let shown = coverRef.current.slice();
		let lastColourAt = performance.now();
		let requestId = 0;
		let requestWindow: Window = window;
		let disposed = false;
		let drawFailed = false;
		const pace = createFramePacer();

		const render = () => {
			if (!pace(performance.now(), frameRate())) return schedule();
			const target = coverRef.current;
			// by the clock, not the frame, so a new cover takes as long at 240 Hz as at 60
			const wall = performance.now();
			const colourStep = 1 - Math.exp(-Math.min(0.1, (wall - lastColourAt) / 1000) / 0.6);
			lastColourAt = wall;
			shown = shown.map((d, i) => ({
				r: d.r + (target[i].r - d.r) * colourStep,
				g: d.g + (target[i].g - d.g) * colourStep,
				b: d.b + (target[i].b - d.b) * colourStep
			}));

			const isPlaying = Spicetify.Player.isPlaying();
			const frame: PresetFrame = {
				ctx,
				width: canvas.width,
				height: canvas.height,
				progressSec: smoothClock(Spicetify.Player.getProgress() / 1000, isPlaying, performance.now() / 1000) - audioSync.getLatencySec(),
				isPlaying,
				audio: audioRef.current,
				colorRgb: shown[1],
				palette: shown.slice(0, 3),
				coverColours: shown
			};
			try {
				presetRef.current!.draw(frame);
			} catch (err) {
				// said once; the next frame tries again
				if (!drawFailed) console.error("[visualizer] draw failed", err);
				drawFailed = true;
			}
			schedule();
		};
		// a window nobody can see gets no animation frames, so the frame clock is the canvas's window
		const schedule = () => {
			if (disposed) return;
			requestWindow = host();
			requestId = requestWindow.requestAnimationFrame(render);
		};
		const reschedule = () => {
			requestWindow.cancelAnimationFrame(requestId);
			schedule();
		};
		schedule();

		const mini = createMiniWindow(canvas, {
			onResize: resize,
			onMove: open => {
				resize();
				reschedule();
				setMiniOpen(open);
			}
		});
		toggleRef.current = mini.toggle;

		return () => {
			window.removeEventListener("resize", resize);
			boxWatch?.disconnect();
			toggleRef.current = () => {};
			disposed = true;
			mini.close();
			requestWindow.cancelAnimationFrame(requestId);
			audioSync.dispose();
		};
	}, []);

	return useCallback(() => toggleRef.current(), []);
}
