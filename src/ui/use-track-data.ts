import { useEffect, useRef, useState } from "react";
import { TrackAudioData } from "../audio-data";
import { Rgb } from "../colours";
import { DEFAULT_COVER, Track, watchTrackData } from "../track-data";

export type { Track };

// The track for the overlay; analysis and colours are read by the frame loop through the refs.
export function useTrackData() {
	const [track, setTrack] = useState<Track | null>(null);
	const watcher = useRef<ReturnType<typeof watchTrackData>>();
	const audioRef = useRef({ get current(): TrackAudioData | null { return watcher.current?.audio() ?? null; } }).current;
	const coverRef = useRef({ get current(): Rgb[] { return watcher.current?.cover() ?? DEFAULT_COVER; } }).current;

	useEffect(() => {
		watcher.current = watchTrackData(setTrack);
		return () => watcher.current?.dispose();
	}, []);

	return { track, audioRef, coverRef };
}
