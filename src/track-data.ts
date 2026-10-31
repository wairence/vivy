import { loadTrackAudioData, loadTrackAudioFeatures, trackDataFromFeatures, TrackAudioData } from "./audio-data";
import { coverHues, hexToRgb, Rgb } from "./colours";
import { dumpAnalysis, report, warnIfNoHits } from "./dev";

export type Track = { name: string; artist: string; durationMs: number };

const ANALYSIS_TIMEOUT_MS = 10000;
export const DEFAULT_COVER: Rgb[] = Array.from({ length: 6 }, () => ({ r: 30, g: 215, b: 96 }));

// The playing track, its analysis and the cover's six colours (dark, vibrant, light, then the
// cover's own by area), kept current until dispose(). `quiet` skips the notifications.
export function watchTrackData(onTrack: (track: Track | null) => void = () => {}, quiet = false) {
	let audio: TrackAudioData | null = null;
	let cover = DEFAULT_COVER;
	const notify = (text: string) => {
		if (!quiet) Spicetify.showNotification(text);
	};

	// one request per track, shared by the prefetch and the track's arrival; a failure is forgotten so a retry asks again
	const analyses = new Map<string, Promise<TrackAudioData>>();
	let alive = true;
	const loadAnalysis = (uri: string) => {
		let pending = analyses.get(uri);
		if (!pending) {
			// a request that never answers would otherwise stay cached as pending for the session
			pending = Promise.race([
				loadTrackAudioData(uri),
				new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("timed out")), ANALYSIS_TIMEOUT_MS))
			]);
			analyses.set(uri, pending);
			pending.catch(() => analyses.delete(uri));
			if (analyses.size > 4) analyses.delete(analyses.keys().next().value as string);
		}
		return pending;
	};

	const updateTrack = (data: Spicetify.PlayerState | null | undefined) => {
		const item = data?.item;
		onTrack(item ? { name: item.name, artist: item.artists?.[0]?.name ?? "", durationMs: data?.duration ?? 0 } : null);
		audio = null;
		// the colours stay the last track's until the new cover's are known: no green flash between songs
		if (!item?.uri) return;
		const stillHere = () => alive && Spicetify.Player.data?.item?.uri === item.uri;

		// Without analysis every preset falls back to the same slow pulse, which looks like a bug,
		// so it is said out loud. The audio features still give the real tempo and loudness.
		const announceMissing = (why: string) => {
			if (!stillHere()) return;
			loadTrackAudioFeatures(item.uri)
				.then(features => {
					if (!stillHere()) return;
					audio = trackDataFromFeatures(features);
					report({ featuresFallback: item.name, tempo: features.tempo, loudness: features.loudness });
					notify(`No analysis for "${item.name}" - using its tempo (${Math.round(features.tempo)} BPM). No section dynamics.`);
				})
				.catch(featureErr => {
					if (!alive) return;
					report({ noAnalysis: item.name, why, features: String(featureErr?.message ?? featureErr) });
					notify(`No audio analysis for "${item.name}" - the picture follows a plain pulse.`);
				});
		};

		// getAudioData is an undocumented endpoint that fails transiently: one retry
		const attempt = (retriesLeft: number): void => {
			if (!stillHere()) return;
			loadAnalysis(item.uri)
				.then(data => {
					if (!stillHere()) return;
					if (data.segments.length === 0) {
						announceMissing("analysis is empty");
						return;
					}
					audio = data;
					if (!quiet) warnIfNoHits(data);
					if (!quiet) dumpAnalysis(item.name, data);
				})
				.catch(err => {
					if (retriesLeft > 0) {
						window.setTimeout(() => attempt(retriesLeft - 1), 1200);
						return;
					}
					announceMissing(String(err?.message || err || "request failed"));
				});
		};
		// local files, episodes and ads have no analysis, and asking ends in an error toast
		if (item.uri.startsWith("spotify:track:")) attempt(1);
		// the next track ahead of time, so a natural advance has no gap
		const next = (Spicetify.Queue?.nextTracks?.[0] as { contextTrack?: { uri?: unknown } } | undefined)?.contextTrack?.uri;
		if (typeof next === "string" && next.startsWith("spotify:track:")) loadAnalysis(next).catch(() => {});

		const coverIsCurrent = () => Spicetify.Player.data?.item?.uri === item.uri;
		// the cover's pixels at 48x48: which colours it has and how much of each
		const readCover = (shades: Rgb[]) => {
			const url = item.metadata.image_url;
			if (!url) return;
			const img = new Image();
			img.crossOrigin = "anonymous";
			img.onload = () => {
				try {
					const c = document.createElement("canvas");
					c.width = c.height = 48;
					const cx = c.getContext("2d", { willReadFrequently: true });
					if (!cx || !coverIsCurrent()) return;
					cx.drawImage(img, 0, 0, 48, 48);
					const hues = coverHues(cx.getImageData(0, 0, 48, 48).data);
					if (hues.length >= 2) cover = [...shades, hues[0], hues[1], hues[2] ?? hues[1]];
				} catch {
					// a tainted canvas: the shades stay
				}
			};
			img.src = url.startsWith("spotify:image:") ? "https://i.scdn.co/image/" + url.slice(14) : url;
		};
		// fallback: the one light colour Spotify gives for the cover, and the cover's own colours read from its pixels
		const single = () => {
			if (!item.metadata.image_url) return;
			Spicetify.extractColorPreset(item.metadata.image_url)
				.then(colors => {
					const rgb = colors[0]?.colorLight?.rgb;
					if (!rgb || !coverIsCurrent()) return;
					cover = Array.from({ length: 6 }, () => rgb);
					readCover([rgb, rgb, rgb]);
				})
				.catch(() => {});
		};
		Spicetify.colorExtractor(item.uri)
			.then(c => {
				const stops = [c.DARK_VIBRANT, c.VIBRANT, c.LIGHT_VIBRANT];
				if (!stops.every(hex => /^#[0-9a-f]{6}$/i.test(hex ?? ""))) return single();
				if (!coverIsCurrent()) return;
				const shades = stops.map(hexToRgb);
				cover = [...shades, ...shades];
				readCover(shades);
			})
			.catch(single);
	};

	const onSongChange = (event?: Event & { data: Spicetify.PlayerState }) => {
		window.clearInterval(waitForFirst);
		updateTrack(event?.data);
	};
	Spicetify.Player.addEventListener("songchange", onSongChange);
	updateTrack(Spicetify.Player.data);
	// loaded before the player knows its track: the first one may arrive without a songchange
	const waitForFirst = Spicetify.Player.data?.item
		? 0
		: window.setInterval(() => {
				if (!Spicetify.Player.data?.item) return;
				window.clearInterval(waitForFirst);
				updateTrack(Spicetify.Player.data);
			}, 500);
	return {
		audio: () => audio,
		cover: () => cover,
		dispose() {
			window.clearInterval(waitForFirst);
			alive = false;
			Spicetify.Player.removeEventListener("songchange", onSongChange as (event?: Event) => void);
		}
	};
}
