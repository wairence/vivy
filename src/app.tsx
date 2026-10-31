import React, { useCallback, useEffect, useRef, useState } from "react";
import "./css/app.css";
import { DEV } from "./build-stamp";
import { announceBuild, markMoment } from "./dev";
import { Preset, PRESETS } from "./presets";
import { IconButton, ICON_EXPAND, ICON_KNOBS, ICON_PIP, ICON_SHRINK } from "./ui/icons";
import { IDLE_HIDE_MS } from "./ui/mini-window";
import { showPictureOn } from "./ui/picture";
import { TrackOverlay } from "./ui/track-overlay";
import { TunePanel } from "./ui/tune-panel";
import { useFrameLoop } from "./ui/use-frame-loop";
import { useTrackData } from "./ui/use-track-data";

const PRESET_STORAGE_KEY = "vivy:preset";

const createPreset = (id: string) => PRESETS.find(p => p.id === id)!.create();

function loadStoredPresetId(): string {
	const stored = typeof localStorage !== "undefined" ? localStorage.getItem(PRESET_STORAGE_KEY) : null;
	return stored && PRESETS.some(p => p.id === stored) ? stored : PRESETS[0].id;
}

export default function App() {
	const containerRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [presetId, setPresetId] = useState(loadStoredPresetId);
	const [uiVisible, setUiVisible] = useState(true);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [isPip, setIsPip] = useState(false);
	const [tuneOpen, setTuneOpen] = useState(false);

	const presetRef = useRef<Preset>();
	if (!presetRef.current) presetRef.current = createPreset(presetId);
	// for the listeners registered once
	const presetIdRef = useRef(presetId);
	presetIdRef.current = presetId;

	const { track, audioRef, coverRef } = useTrackData();
	const toggleMiniWindow = useFrameLoop(canvasRef, presetRef, audioRef, coverRef, setIsPip);

	const choosePreset = (id: string) => {
		if (id === presetId) return;
		presetRef.current?.dispose();
		presetRef.current = createPreset(id);
		try {
			localStorage.setItem(PRESET_STORAGE_KEY, id);
		} catch {
			// not remembered: the first preset next time
		}
		// a preset that fades its last frame would start by fading the previous preset's picture
		const canvas = canvasRef.current;
		canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
		setPresetId(id);
	};

	const toggleFullscreen = useCallback(() => {
		// refused (no user gesture, or the client forbids it): the button just does nothing
		if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
		else containerRef.current?.requestFullscreen().catch(() => {});
	}, []);

	useEffect(announceBuild, []);
	useEffect(() => {
		if (canvasRef.current && containerRef.current) showPictureOn(canvasRef.current, containerRef.current);
	}, []);
	useEffect(
		() => () => {
			presetRef.current?.dispose();
			presetRef.current = undefined;
		},
		[]
	);

	// P mini window, T knobs, F fullscreen, 1-9 effects on or off; in dev builds B marks the moment
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.ctrlKey || e.altKey || e.metaKey) return;
			const key = e.key.toLowerCase();
			const digit = /^[1-9]$/.test(key);
			if ((key !== "b" || !DEV) && key !== "p" && key !== "t" && key !== "f" && !digit) return;
			const target = e.target as HTMLElement | null;
			// never steal a keystroke from a search box
			if (target && (target.isContentEditable || /^(input|textarea)$/i.test(target.tagName))) return;
			e.preventDefault();
			if (digit) window.dispatchEvent(new CustomEvent("visualizer-feature", { detail: { preset: presetIdRef.current, n: Number(key) } }));
			else if (key === "p") toggleMiniWindow();
			else if (key === "t") setTuneOpen(open => !open);
			else if (key === "f") toggleFullscreen();
			else markMoment(presetIdRef.current);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [toggleMiniWindow, toggleFullscreen]);

	useEffect(() => {
		let hideTimeout = 0;
		const onActivity = () => {
			setUiVisible(true);
			window.clearTimeout(hideTimeout);
			hideTimeout = window.setTimeout(() => setUiVisible(false), IDLE_HIDE_MS);
		};
		onActivity();
		window.addEventListener("mousemove", onActivity);
		window.addEventListener("mousedown", onActivity);
		return () => {
			window.clearTimeout(hideTimeout);
			window.removeEventListener("mousemove", onActivity);
			window.removeEventListener("mousedown", onActivity);
		};
	}, []);

	useEffect(() => {
		const onFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement);
		document.addEventListener("fullscreenchange", onFullscreenChange);
		return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
	}, []);

	return (
		<div className={`vivy-container${uiVisible ? "" : " vivy-idle"}`} ref={containerRef}>
			<canvas ref={canvasRef} className="vivy-canvas" />

			{tuneOpen ? <TunePanel presetId={presetId} onClose={() => setTuneOpen(false)} /> : null}
			<div className="vivy-chrome">
				{/* left, what is shown; right, what is done with the window */}
				<div className="vivy-top">
					<nav className="vivy-presets" aria-label="Presets">
						{PRESETS.map(preset => (
							<button
								key={preset.id}
								className={`vivy-preset${preset.id === presetId ? " active" : ""}`}
								aria-pressed={preset.id === presetId}
								onClick={() => choosePreset(preset.id)}
							>
								{preset.name}
								{preset.experimental ? <span className="vivy-tag" title="Experimental">exp</span> : null}
							</button>
						))}
					</nav>
					<div className="vivy-actions">
						<IconButton label="Knobs (T)" active={tuneOpen} onClick={() => setTuneOpen(open => !open)} icon={ICON_KNOBS} />
						<IconButton label={isPip ? "Close mini window (P)" : "Mini window (P)"} active={isPip} onClick={toggleMiniWindow} icon={ICON_PIP} />
						<IconButton label={isFullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"} onClick={toggleFullscreen} icon={isFullscreen ? ICON_SHRINK : ICON_EXPAND} />
					</div>
				</div>
				<TrackOverlay track={track} isFullscreen={isFullscreen} />
			</div>
		</div>
	);
}
