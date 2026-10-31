import React, { useEffect, useState } from "react";
import { IconButton, ICON_BACK, ICON_HEART, ICON_HEART_FILLED, ICON_NEXT, ICON_PAUSE, ICON_PLAY } from "./icons";
import { Track } from "./use-track-data";

function formatTime(ms: number): string {
	const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
	return `${Math.floor(totalSeconds / 60)}:${(totalSeconds % 60).toString().padStart(2, "0")}`;
}

// Its own component so the twice-a-second progress tick re-renders only this.
// In fullscreen Spotify's player is hidden, so the bar seeks and the transport buttons appear.
export function TrackOverlay({ track, isFullscreen }: { track: Track | null; isFullscreen: boolean }) {
	const [progressMs, setProgressMs] = useState(0);
	const [playing, setPlaying] = useState(false);
	const [liked, setLiked] = useState(false);
	// while the bar is held: where it would seek to
	const [scrub, setScrub] = useState<number | null>(null);
	useEffect(() => {
		const tick = () => {
			setProgressMs(Spicetify.Player.getProgress());
			setPlaying(Spicetify.Player.isPlaying());
			setLiked(Spicetify.Player.getHeart());
		};
		tick();
		const id = window.setInterval(tick, 500);
		Spicetify.Player.addEventListener("onplaypause", tick);
		Spicetify.Player.addEventListener("songchange", tick);
		return () => {
			window.clearInterval(id);
			Spicetify.Player.removeEventListener("onplaypause", tick);
			Spicetify.Player.removeEventListener("songchange", tick);
		};
	}, []);

	const seekFrom = (e: React.PointerEvent<HTMLDivElement>) => {
		const bar = e.currentTarget;
		const at = (x: number) => {
			const r = bar.getBoundingClientRect();
			return Math.max(0, Math.min(1, (x - r.left) / r.width));
		};
		bar.setPointerCapture(e.pointerId);
		setScrub(at(e.clientX));
		const move = (ev: PointerEvent) => setScrub(at(ev.clientX));
		const up = (ev: PointerEvent) => {
			bar.removeEventListener("pointermove", move);
			bar.removeEventListener("pointerup", up);
			const ms = at(ev.clientX) * (track?.durationMs ?? 0);
			Spicetify.Player.seek(ms);
			setProgressMs(ms);
			setScrub(null);
		};
		bar.addEventListener("pointermove", move);
		bar.addEventListener("pointerup", up);
	};

	if (!track)
		return (
			<div className="vivy-overlay">
				<div className="vivy-track-name">Start playing a song</div>
			</div>
		);
	const shownMs = scrub !== null ? scrub * track.durationMs : progressMs;
	return (
		<div className="vivy-overlay">
			<div className="vivy-track-name">{track.name}</div>
			<div className="vivy-track-artist">{track.artist}</div>
			<div
				className={`vivy-progress-track${isFullscreen ? " seek" : ""}${scrub !== null ? " held" : ""}`}
				onPointerDown={isFullscreen ? seekFrom : undefined}
				role={isFullscreen ? "slider" : undefined}
				aria-label={isFullscreen ? "Seek" : undefined}
				aria-valuemin={0}
				aria-valuemax={Math.round(track.durationMs / 1000)}
				aria-valuenow={Math.round(shownMs / 1000)}
			>
				<div className="vivy-progress-fill" style={{ width: `${track.durationMs ? (shownMs / track.durationMs) * 100 : 0}%` }} />
			</div>
			<div className="vivy-time">
				{formatTime(shownMs)} / {formatTime(track.durationMs)}
			</div>
			{isFullscreen ? (
				<div className="vivy-controls">
					<IconButton label="Previous" icon={ICON_BACK} onClick={() => Spicetify.Player.back()} />
					<IconButton label={playing ? "Pause" : "Play"} icon={playing ? ICON_PAUSE : ICON_PLAY} onClick={() => Spicetify.Player.togglePlay()} />
					<IconButton label="Next" icon={ICON_NEXT} onClick={() => Spicetify.Player.next()} />
					<IconButton
						label={liked ? "Remove from Liked Songs" : "Save to Liked Songs"}
						icon={liked ? ICON_HEART_FILLED : ICON_HEART}
						active={liked}
						onClick={() => {
							Spicetify.Player.toggleHeart();
							setLiked(!liked);
						}}
					/>
				</div>
			) : null}
		</div>
	);
}
