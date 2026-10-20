import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import "./css/app.css";
import { loadTrackAudioData, loadTrackAudioFeatures, trackDataFromFeatures, TrackAudioData } from "./audio-data";
import { lastConducted } from "./presets/conductor";
import { AudioSync, createSmoothClock } from "./audio-sync";
import { BUILD, DEV } from "./build-stamp";
import { coverHues, hexToRgb } from "./colours";
import { ColourSection } from "./colour-panel";
import { Preset, PresetFrame, PRESETS } from "./presets";
import { Knob, movedText, resetKnobs, setKnob, tuningOf } from "./presets/tune";

// posts a diagnostic to the dev server (npm run preview) so findings inside the Spotify client are
// readable from outside it; silently ignored when nothing is listening, which is every normal run
function report(what: object) {
	if (!DEV) return;
	console.warn("[visualizer]", what);
	void fetch("http://localhost:8790/log", {
		method: "POST",
		headers: { "Content-Type": "text/plain" },
		body: JSON.stringify(what)
	}).catch(() => {});
}

const PRESET_STORAGE_KEY = "vivy:preset";
// said once per session, not once per track
let hitsWarned = false;
const IDLE_HIDE_MS = 2500;
const ANALYSIS_TIMEOUT_MS = 10000;
const DEFAULT_RGB = { r: 30, g: 215, b: 96 }; // spotify green, used until a track's color loads

function formatTime(ms: number): string {
	const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function loadStoredPresetId(): string {
	const stored = typeof localStorage !== "undefined" ? localStorage.getItem(PRESET_STORAGE_KEY) : null;
	return stored && PRESETS.some(p => p.id === stored) ? stored : PRESETS[0].id;
}

// ---- the chrome's icons: drawn here, 24 units square, in the text's colour -----------------------------
const ICON_KNOBS = (
	<>
		<path d="M4 7h16M4 12h16M4 17h16" />
		<circle cx="15" cy="7" r="2.2" fill="currentColor" />
		<circle cx="8" cy="12" r="2.2" fill="currentColor" />
		<circle cx="13" cy="17" r="2.2" fill="currentColor" />
	</>
);
const ICON_PIP = (
	<>
		<rect x="3" y="5" width="18" height="14" rx="2" />
		<rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" stroke="none" />
	</>
);
const ICON_EXPAND = <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />;
const ICON_SHRINK = <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />;

const ICON_COPY = (
	<>
		<rect x="8" y="8" width="12" height="12" rx="2" />
		<path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
	</>
);
const ICON_RESET = (
	<>
		<path d="M4 12a8 8 0 1 0 2.4-5.7" />
		<path d="M4 4v4.5h4.5" />
	</>
);
const ICON_CLOSE = <path d="M6 6l12 12M18 6L6 18" />;
const ICON_PLAY = <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />;
const ICON_PAUSE = <path d="M8.5 5.5v13M15.5 5.5v13" strokeWidth="2.6" />;
const ICON_BACK = (
	<>
		<path d="M6.5 5.5v13" strokeWidth="2.2" />
		<path d="M18.5 5.5v13L9 12z" fill="currentColor" />
	</>
);
const ICON_NEXT = (
	<>
		<path d="M17.5 5.5v13" strokeWidth="2.2" />
		<path d="M5.5 5.5v13L15 12z" fill="currentColor" />
	</>
);

function IconButton({ label, icon, active, small, onClick }: { label: string; icon: React.ReactNode; active?: boolean; small?: boolean; onClick: () => void }) {
	return (
		<button className={`vivy-icon${small ? " small" : ""}${active ? " active" : ""}`} title={label} aria-label={label} aria-pressed={!!active} onClick={onClick}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
				{icon}
			</svg>
		</button>
	);
}

// The knob panel (T): every number the preset on screen offers, as a slider, turned while it plays.
// Double-click a name to put that one back; "Copy" puts what was moved on the clipboard, to be written
// back into the code as the new defaults.
function TunePanel({ presetId, onClose }: { presetId: string; onClose: () => void }) {
	const [, redraw] = useState(0);
	// the hint of the knob under the pointer (or in focus), drawn beside the panel rather than in it,
	// where the panel's scrolling would cut it off
	const [hint, setHint] = useState<{ text: string; foot: string; top: number; right: number } | null>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	// The scrollbar is our own, a hairline beside the content: Spotify styles every scrollbar in the
	// client, and its fat white bar wins over anything set on the panel's
	const [bar, setBar] = useState<{ top: number; height: number; right: number } | null>(null);
	const measureBar = () => {
		const p = panelRef.current;
		const parent = p?.offsetParent;
		if (!p || !parent || p.scrollHeight <= p.clientHeight + 1) return setBar(b => (b ? null : b));
		const box = parent.getBoundingClientRect();
		const r = p.getBoundingClientRect();
		const height = Math.max(24, (p.clientHeight / p.scrollHeight) * (r.height - 16));
		const top = r.top - box.top + 8 + (p.scrollTop / (p.scrollHeight - p.clientHeight)) * (r.height - 16 - height);
		const right = box.right - r.right + 3;
		setBar(b => (b && Math.abs(b.top - top) < 0.5 && Math.abs(b.height - height) < 0.5 && b.right === right ? b : { top, height, right }));
	};
	useLayoutEffect(measureBar);
	useEffect(() => {
		window.addEventListener("resize", measureBar);
		return () => window.removeEventListener("resize", measureBar);
	}, []);
	// the few settings most people want, and the rest behind "More"; which one is open is remembered
	const [more, setMore] = useState(() => {
		try {
			return localStorage.getItem("vivy:more") === "1";
		} catch {
			return false;
		}
	});
	const toggleMore = () => {
		setHint(null);
		setMore(open => {
			try {
				localStorage.setItem("vivy:more", open ? "0" : "1");
			} catch {
				// storage denied: it opens closed next time
			}
			return !open;
		});
	};
	const t = tuningOf(presetId);
	const refresh = () => redraw(n => n + 1);
	// a feature flipped with its number key shows here too (the preset's own listener runs first)
	useEffect(() => {
		window.addEventListener("visualizer-feature", refresh);
		return () => window.removeEventListener("visualizer-feature", refresh);
	}, []);
	const copy = () => {
		const text = movedText(presetId);
		navigator.clipboard?.writeText(text || "nothing moved").catch(() => {});
		Spicetify.showNotification(text ? "Moved knobs copied" : "Nothing moved yet");
	};
	// any row of the panel can explain itself here: a knob, or one of the colour choices
	const explain = (text: string, foot: string, row: HTMLElement) => {
		const panel = panelRef.current;
		const parent = panel?.offsetParent;
		if (!text || !panel || !parent) return;
		const p = parent.getBoundingClientRect();
		setHint({ text, foot, top: row.getBoundingClientRect().top - p.top, right: p.right - panel.getBoundingClientRect().left + 10 });
	};
	const showHint = (knob: Knob, row: HTMLElement) =>
		explain(knob.hint, `default ${+knob.def.toPrecision(3)} · double-click the name to reset`, row);
	// a run of knobs under their group names; each run starts its own headings
	const knobs = (list: Knob[]) => {
		let group = "";
		return list.map(k => {
			const value = t!.values[k.key];
			const head = k.group !== group ? <div className="vivy-tune-group">{(group = k.group)}</div> : null;
			return (
				<React.Fragment key={k.key}>
					{head}
					<div
						className={`vivy-tune-knob${value !== k.def ? " moved" : ""}`}
						onMouseEnter={e => showHint(k, e.currentTarget)}
						onMouseLeave={() => setHint(null)}
						onFocus={e => showHint(k, e.currentTarget)}
						onBlur={() => setHint(null)}
					>
						<div className="vivy-tune-label" onDoubleClick={() => (setKnob(presetId, k.key, k.def), refresh())}>
							<span>{k.label}</span>
							<span>{+value.toPrecision(3)}</span>
						</div>
						<input
							type="range"
							min={k.min}
							max={k.max}
							step={(k.max - k.min) / 400}
							value={value}
							onChange={e => (setKnob(presetId, k.key, Number(e.target.value)), refresh())}
						/>
					</div>
				</React.Fragment>
			);
		});
	};
	return (
		<>
		<div className="vivy-tune" ref={panelRef} onMouseDown={e => e.stopPropagation()} onScroll={() => (setHint(null), measureBar())}>
			<div className="vivy-tune-head">
				<b>Knobs</b>
				<IconButton small label="Copy moved values" icon={ICON_COPY} onClick={copy} />
				<IconButton small label="Reset all to defaults" icon={ICON_RESET} onClick={() => (resetKnobs(presetId), refresh())} />
				<IconButton small label="Close (T)" icon={ICON_CLOSE} onClick={onClose} />
			</div>
			<ColourSection key={presetId} presetId={presetId} panel={panelRef} explain={(text, row) => explain(text, "", row)} unexplain={() => setHint(null)} />
			{!t || (t.knobs.length === 0 && t.features.length === 0) ? (
				<div className="vivy-tune-none">This preset has no knobs yet.</div>
			) : null}
			{t ? knobs(t.knobs.filter(k => k.basic)) : null}
			{t && (t.features.length > 0 || t.knobs.some(k => !k.basic)) ? (
				<button className={`vivy-more${more ? " on" : ""}`} aria-expanded={more} onClick={toggleMore}>
					<span>{more ? "Fewer settings" : "More settings"}</span>
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M6 9l6 6 6-6" />
					</svg>
				</button>
			) : null}
			{t && more ? (
				<>
					{t.features.length > 0 ? <div className="vivy-tune-group">effects</div> : null}
					{t.features.map((f, i) => (
						<label key={f.name} className="vivy-tune-feature">
							<input type="checkbox" checked={f.on} onChange={() => ((f.on = !f.on), refresh())} />
							{i + 1}. {f.name}
						</label>
					))}
					{knobs(t.knobs.filter(k => !k.basic))}
				</>
			) : null}
		</div>
		{bar ? <div className="vivy-tune-bar" style={{ top: bar.top, height: bar.height, right: bar.right }} /> : null}
		{hint ? (
			<div className="vivy-tune-hint" style={{ top: hint.top, right: hint.right }}>
				<div>{hint.text}</div>
				{hint.foot ? <small>{hint.foot}</small> : null}
			</div>
		) : null}
		</>
	);
}

export default function App() {
	const containerRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);

	const [track, setTrack] = useState<{ name: string; artist: string; durationMs: number } | null>(null);
	const [presetId, setPresetId] = useState(loadStoredPresetId);
	const [uiVisible, setUiVisible] = useState(true);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [isPip, setIsPip] = useState(false);
	const [tuneOpen, setTuneOpen] = useState(false);
	// set by the effect that owns the canvas and its loop - the only place that can move them
	const togglePipRef = useRef<() => void>(() => {});
	const toggleFullscreenRef = useRef<() => void>(() => {});

	// audio/visual data is only read from the rAF loop, doesn't need to trigger a re-render
	const audioDataRef = useRef<TrackAudioData | null>(null);
	// the cover's palette, dark to light: what the new cover gives, and what is on screen on its way there
	// (dark, vibrant, light as Spotify extracts them; then the cover's own colours by area, or those
	// three again for a cover of one colour - see coverHues)
	const targetColorRef = useRef(Array.from({ length: 6 }, () => DEFAULT_RGB));
	const displayColorRef = useRef(Array.from({ length: 6 }, () => DEFAULT_RGB));
	const presetRef = useRef<Preset>();
	const presetMadeFor = useRef("");
	if (!presetRef.current) {
		presetRef.current = PRESETS.find(p => p.id === presetId)!.create();
		presetMadeFor.current = presetId;
	}

	// Which build is actually running. `spicetify apply` writes index.js to disk, and the client
	// reads it once, at startup, so tuning can go on against a client still executing the previous
	// bundle. There is no way to tell from inside the picture, and "nothing changed" is the same
	// sentence whether the change failed or never loaded.
	useEffect(() => {
		if (DEV) Spicetify.showNotification(`Visualizer build ${BUILD}`);
	}, []);

	useEffect(() => {
		if (presetMadeFor.current !== presetId) {
			presetRef.current = PRESETS.find(p => p.id === presetId)!.create();
			presetMadeFor.current = presetId;
		}
		try {
			localStorage.setItem(PRESET_STORAGE_KEY, presetId);
		} catch {
			// not remembered: the first preset next time
		}

		// clear what the previous preset left, or a preset that fades its last frame starts by fading
		// that out, which reads as a stuck afterimage for a second or more
		const canvas = canvasRef.current;
		canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
	}, [presetId]);

	useEffect(() => {
		// one request per track, shared by the prefetch and the track's own arrival. A failure is
		// forgotten, so the retry asks again
		const analyses = new Map<string, Promise<TrackAudioData>>();
		let alive = true;
		const loadAnalysis = (uri: string) => {
			let pending = analyses.get(uri);
			if (!pending) {
				// a request that never answers would otherwise stay cached as "pending" for good, and that
				// track would never get its analysis this session
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
			setTrack(
				item
					? {
							name: item.name,
							artist: item.artists?.[0]?.name ?? "",
							durationMs: data?.duration ?? 0
						}
					: null
			);

			audioDataRef.current = null;
			// the colour stays the last track's until the new cover's is known: going by way of the
			// default would flash green between every two songs
			if (!item?.uri) return;

			// Spicetify.getAudioData is an undocumented internal endpoint and fails transiently often
			// enough to be worth one retry before giving up on the track.
			//
			// A track without analysis degrades in a way that looks like a bug rather than like a
			// missing feature, so it says so out loud: `currentEnergy` falls back to a plain sine, no
			// beats means beatHit never fires, and no segments means attackSharpness/harmonicShift/
			// brightness all sit at zero. The result is the same slow drift on every preset, because
			// the cause is upstream of all of them. Silently looking broken is worse than saying "no
			// analysis for this one".
			const announceMissing = (why: string) => {
				if (!alive || Spicetify.Player.data?.item?.uri !== item.uri) return;
				// No timeline for this track. Its audio features may still exist on the sibling endpoint,
				// which is enough for the real tempo and the real loudness - a genuine pulse instead of
				// the plain sine the presets otherwise fall back to
				loadTrackAudioFeatures(item.uri)
					.then(features => {
						if (!alive || Spicetify.Player.data?.item?.uri !== item.uri) return;
						audioDataRef.current = trackDataFromFeatures(features);
						report({ featuresFallback: item.name, tempo: features.tempo, loudness: features.loudness });
						Spicetify.showNotification(
							`No analysis for "${item.name}" - using its tempo (${Math.round(features.tempo)} BPM). No section dynamics.`
						);
					})
					.catch(featureErr => {
						if (!alive) return;
						report({ noAnalysis: item.name, why, features: String(featureErr?.message ?? featureErr) });
						Spicetify.showNotification(`No audio analysis for "${item.name}" - the picture follows a plain pulse.`);
					});
			};

			const attempt = (retriesLeft: number): void => {
				if (!alive || Spicetify.Player.data?.item?.uri !== item.uri) return;
				loadAnalysis(item.uri)
					.then(data => {
						if (!alive || Spicetify.Player.data?.item?.uri !== item.uri) return;
						if (data.segments.length === 0) {
							announceMissing("analysis is empty");
							return;
						}
						audioDataRef.current = data;
						// beats can legitimately be sparse; none at all is still a timeline worth more than the
						// tempo-only stand-in, so it is kept
						// The hits come from inflating `rhythmstring` in the browser, and `strike` falls
						// back to the segment rule when that cannot be done. That must not happen
						// silently, or a bug gets looked for in code that was never running. Said once
						// per session, and only when the track had a rhythmstring to decode.
						if (DEV && !hitsWarned && data.hits.length === 0 && typeof data.trackInfo.rhythmstring === "string") {
							hitsWarned = true;
							Spicetify.showNotification("Visualizer: rhythm onsets unavailable, hits fall back to segments", true);
						}
						// the full analysis, for building the structure detector against real music
						if (DEV) void fetch("http://localhost:8790/dump", {
							method: "POST",
							headers: { "Content-Type": "text/plain" },
							body: JSON.stringify({
								name: item.name,
								// everything the endpoint gives, not just what a preset happens to read today, so
								// offline probes see the beats, sections, tatums and the track-level summary
								// minus the fingerprints. `codestring` and `echoprintstring` are acoustic IDs for
								// matching a recording against a database - 24k characters of no use to a
								// visualiser - while `rhythmstring` and `synchstring` are timing data and are kept
								track: (() => {
									const kept: Record<string, unknown> = {};
									for (const k of Object.keys(data.trackInfo))
										if (k !== "codestring" && k !== "echoprintstring") kept[k] = data.trackInfo[k];
									return kept;
								})(),
								tempo: data.tempo,
								beats: data.beats.map(b => [Number(b.start.toFixed(3)), Number(b.duration.toFixed(3)), b.confidence]),
								tatums: data.tatums.map(b => [Number(b.start.toFixed(3)), Number(b.duration.toFixed(3)), b.confidence]),
								sections: data.sections.map(x => [
									Number(x.start.toFixed(2)),
									Number(x.duration.toFixed(2)),
									x.confidence,
									x.loudness,
									x.tempo,
									x.key,
									x.mode,
									x.time_signature
								]),
								bars: data.bars.map(b => [Number(b.start.toFixed(2)), Number(b.duration.toFixed(2)), b.confidence]),
								curve: data.loudnessCurve.map(c => [Number(c.t.toFixed(2)), Number(c.y.toFixed(4))]),
								segments: data.segments.map(g => [
									Number(g.start.toFixed(2)),
									Number(g.duration.toFixed(2)),
									g.loudness_max,
									g.loudness_max_time,
									g.pitches.map(v => Number(v.toFixed(3))),
									g.timbre.map(v => Number(v.toFixed(1))),
									g.loudness_start,
									g.loudness_end,
									g.confidence ?? null
								])
							})
						})
							// The POST failing is the normal case - the dev server is usually not running - so a
							// failure is swallowed. A confirmation only on success costs nothing when nobody is
							// collecting and is the whole signal when somebody is.
							.then(res => {
								if (res.ok) Spicetify.showNotification(`Analysis dumped: ${item.name}`);
							})
							.catch(() => {});
					})
					.catch(err => {
						if (retriesLeft > 0) {
							window.setTimeout(() => attempt(retriesLeft - 1), 1200);
							return;
						}
						announceMissing(String(err?.message || err || "request failed"));
					});
			};
			// only a Spotify track has an analysis: a local file's "id" is its length, an episode or an ad has
			// none, and asking costs six requests and ends in an error toast
			if (item.uri.startsWith("spotify:track:")) attempt(1);
			// The next track's analysis, ahead of time, so that when the player moves on by itself there is
			// no gap for the picture to wait through. A skip to anywhere else still waits.
			const next = (Spicetify.Queue?.nextTracks?.[0] as { contextTrack?: { uri?: unknown } } | undefined)?.contextTrack?.uri;
			if (typeof next === "string" && next.startsWith("spotify:track:")) loadAnalysis(next).catch(() => {});

			// The cover's palette: three colours Spotify extracts from the art, dark to light. Where that
			// fails, the one light colour it gives for the cover, three times
			const stillHere = () => Spicetify.Player.data?.item?.uri === item.uri;
			// the cover's pixels, small: what colours it has and how much of each (the image CDN allows it)
			const readCover = (shades: { r: number; g: number; b: number }[]) => {
				const url = item.metadata.image_url;
				if (!url) return;
				const img = new Image();
				img.crossOrigin = "anonymous";
				img.onload = () => {
					try {
						const c = document.createElement("canvas");
						c.width = c.height = 48;
						const cx = c.getContext("2d", { willReadFrequently: true });
						if (!cx || !stillHere()) return;
						cx.drawImage(img, 0, 0, 48, 48);
						const hues = coverHues(cx.getImageData(0, 0, 48, 48).data);
						if (hues.length >= 2) targetColorRef.current = [...shades, hues[0], hues[1], hues[2] ?? hues[1]];
					} catch {
						// a tainted canvas or no canvas: the shades stay
					}
				};
				img.src = url.startsWith("spotify:image:") ? "https://i.scdn.co/image/" + url.slice(14) : url;
			};
			const single = () => {
				if (!item.metadata.image_url) return;
				Spicetify.extractColorPreset(item.metadata.image_url)
					.then(colors => {
						const rgb = colors[0]?.colorLight?.rgb;
						if (rgb && stillHere()) targetColorRef.current = Array.from({ length: 6 }, () => rgb);
					})
					.catch(() => {
						// keep the last colours
					});
			};
			Spicetify.colorExtractor(item.uri)
				.then(c => {
					const stops = [c.DARK_VIBRANT, c.VIBRANT, c.LIGHT_VIBRANT];
					if (!stops.every(hex => /^#[0-9a-f]{6}$/i.test(hex ?? ""))) return single();
					if (!stillHere()) return;
					const shades = stops.map(hexToRgb);
					targetColorRef.current = [...shades, ...shades];
					readCover(shades);
				})
				.catch(single);
		};

		const songChangeListener = (event?: Event & { data: Spicetify.PlayerState }) => updateTrack(event?.data);
		Spicetify.Player.addEventListener("songchange", songChangeListener);
		updateTrack(Spicetify.Player.data);

		return () => {
			alive = false;
			Spicetify.Player.removeEventListener("songchange", songChangeListener as (event?: Event) => void);
		};
	}, []);

	// ---- keys -----------------------------------------------------------------------------------
	// P mini window, T knobs, F fullscreen, 1-9 effects on or off; in dev builds B marks the moment as
	// wrong.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.ctrlKey || e.altKey || e.metaKey) return;
			const key = e.key.toLowerCase();
			// 1-9 switch one feature of the preset on screen on or off: "is the picture better
			// without this?" is answered by looking
			const digit = /^[1-9]$/.test(key);
			if ((key !== "b" || !DEV) && key !== "p" && key !== "t" && key !== "f" && !digit) return;
			const target = e.target as HTMLElement | null;
			// never steal a keystroke from a search box
			if (target && (target.isContentEditable || /^(input|textarea)$/i.test(target.tagName))) return;
			e.preventDefault();

			if (digit) {
				window.dispatchEvent(
					new CustomEvent("visualizer-feature", { detail: { preset: localStorage.getItem(PRESET_STORAGE_KEY), n: Number(key) } })
				);
				return;
			}
			if (key === "p") {
				togglePipRef.current();
				return;
			}
			if (key === "t") {
				setTuneOpen(open => !open);
				return;
			}
			if (key === "f") {
				toggleFullscreenRef.current();
				return;
			}

			// what the visualiser believed at the moment it was marked
			const c = lastConducted;
			const item = Spicetify.Player.data?.item;
			const mark: Record<string, unknown> = {
				at: Spicetify.Player.getProgress() / 1000,
				track: item?.name ?? "?",
				uri: item?.uri ?? "?",
				preset: localStorage.getItem(PRESET_STORAGE_KEY) ?? "?",
				build: BUILD
			};
			if (c) for (const k of Object.keys(c)) {
				const v = (c as unknown as Record<string, unknown>)[k];
				if (typeof v === "number") mark[k] = Number(v.toFixed(4));
			}
			void fetch("http://localhost:8790/mark", {
				method: "POST",
				headers: { "Content-Type": "text/plain" },
				body: JSON.stringify(mark)
			})
				.then(res => {
					// said out loud either way: a marker you cannot tell landed is worse than none
					Spicetify.showNotification(res.ok ? `marked ${mark.at as number}s` : "mark failed", !res.ok);
				})
				.catch(() => Spicetify.showNotification("mark failed: dev server not running", true));
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, []);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		// opaque: the canvas is never composited against anything behind it
		const ctx = canvas.getContext("2d", { alpha: false });
		if (!ctx) return;

		// the window the canvas is in right now: Spotify's, or the picture-in-picture one
		const host = () => canvas.ownerDocument.defaultView ?? window;
		const resize = () => {
			const w = Math.max(1, Math.floor(canvas.clientWidth * host().devicePixelRatio));
			const h = Math.max(1, Math.floor(canvas.clientHeight * host().devicePixelRatio));
			// setting a canvas's size wipes it, even to the size it already has
			if (w === canvas.width && h === canvas.height) return;
			// paused, nothing draws the picture again: carry it over, stretched, instead of leaving black
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
		// The presets are written for one canvas size and scaled to whatever they are given, so the
		// size is reported from inside the client: it is the number the tuning is relative to.
		if (DEV) Spicetify.showNotification(`Visualizer canvas ${canvas.width}x${canvas.height}`);
		window.addEventListener("resize", resize);
		const boxWatch = typeof ResizeObserver === "function" ? new ResizeObserver(() => resize()) : null;
		boxWatch?.observe(canvas);

		const audioSync = new AudioSync();
		const smoothClock = createSmoothClock();

		let requestId = 0;
		let requestWindow: Window = window;
		let disposed = false;
		let drawFailed = false;
		let lastColourAt = performance.now();
		const render = () => {
			const target = targetColorRef.current;
			// the palette comes round to a new cover over a couple of seconds - by the clock, not by the
			// frame, so it takes as long on a 240 Hz screen as at 60
			const wall = performance.now();
			const colourStep = 1 - Math.exp(-Math.min(0.1, (wall - lastColourAt) / 1000) / 0.6);
			lastColourAt = wall;
			displayColorRef.current = displayColorRef.current.map((d, i) => ({
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
				audio: audioDataRef.current,
				colorRgb: displayColorRef.current[1],
				palette: displayColorRef.current.slice(0, 3),
				coverColours: displayColorRef.current
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
		// The frame clock is that of the window the canvas is in. A window nobody can see gets no
		// animation frames, and the little window exists for when Spotify itself is behind another app.
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

		// ---- the little window ----------------------------------------------------------------------
		// Document Picture-in-Picture: a real always-on-top window (the thing Spotify's own miniplayer
		// is made of), and the canvas itself is moved into it rather than copied - so the preset draws
		// at the window's own size, once. It sits above other windows and borderless-fullscreen apps;
		// a game in exclusive fullscreen owns the screen and nothing of ours can be put over that.
		//
		// The window has no frame in this client - no title bar to drag, no visible edge to pull. It is
		// moved and sized the way Spotify's miniplayer does it: a region of the page marked
		// `-webkit-app-region: drag`, and `resizeTo` / `moveTo` on the window. Without them it could
		// be opened but not put anywhere.
		let pip: Window | null = null;
		const container = canvas.parentElement;
		const PLACE_KEY = "vivy:pip-place";
		const SMALLEST = 200;
		// a size by its inside: resizeTo takes the outside
		const sizeTo = (w: Window, width: number, height: number) => {
			const limitW = Math.max(SMALLEST, (w.screen?.availWidth ?? 1920) * 0.9);
			const limitH = Math.max(SMALLEST, (w.screen?.availHeight ?? 1080) * 0.9);
			const k = Math.min(1, limitW / width, limitH / height);
			try {
				w.resizeTo(
					Math.round(Math.max(SMALLEST, width * k) + (w.outerWidth - w.innerWidth)),
					Math.round(Math.max(SMALLEST * 0.5625, height * k) + (w.outerHeight - w.innerHeight))
				);
			} catch {
				// a client that will not be resized from the page still has its edges
			}
		};
		const remember = (w: Window) => {
			if (w.innerWidth < 50) return;
			try {
				localStorage.setItem(PLACE_KEY, JSON.stringify({ w: w.innerWidth, h: w.innerHeight, x: w.screenX, y: w.screenY }));
			} catch {
				// storage full or denied: it opens at the default next time
			}
		};
		const comeBack = () => {
			// (closing is asynchronous: this can arrive after the page has gone, and must not start a loop)
			if (!pip || disposed) return;
			pip.removeEventListener("resize", resize);
			pip = null;
			canvas.style.cssText = "";
			container?.prepend(canvas);
			resize();
			reschedule();
			setIsPip(false);
		};
		togglePipRef.current = () => {
			if (pip) {
				pip.close();
				return;
			}
			const api = (window as unknown as { documentPictureInPicture?: { requestWindow: (o: { width: number; height: number }) => Promise<Window> } })
				.documentPictureInPicture;
			if (!api) {
				Spicetify.showNotification("This Spotify build has no picture-in-picture window", true);
				return;
			}
			// where it was left last time
			let place: { w: number; h: number; x: number; y: number } | null = null;
			try {
				place = JSON.parse(localStorage.getItem(PLACE_KEY) ?? "null");
			} catch {
				place = null;
			}
			api.requestWindow({ width: Math.max(SMALLEST, place?.w ?? 480), height: Math.max(SMALLEST * 0.5625, place?.h ?? 270) })
				.then(opened => {
					// asked for, then the page went away before it came
					if (disposed) {
						opened.close();
						return;
					}
					pip = opened;
					const doc = opened.document;
					doc.title = "vivy";
					doc.body.style.cssText = "margin:0;background:#000;overflow:hidden";
					// the stylesheet stays behind in Spotify's document, so the size is said here
					canvas.style.cssText = "display:block;width:100vw;height:100vh";
					doc.body.append(canvas);
					if (place && Number.isFinite(place.x) && Number.isFinite(place.y)) {
						try {
							opened.moveTo(place.x, place.y);
						} catch {
							// it opens where the client puts it
						}
					}

					// Moving: the whole picture is the handle - grab it anywhere. All but a rim: a drag
					// region that reaches the border takes the border's resize grip with it.
					const handle = doc.createElement("div");
					handle.style.cssText = "position:fixed;inset:10px;-webkit-app-region:drag;app-region:drag;cursor:grab";
					handle.title = "Drag to move. Wheel, + and - resize. Esc closes.";
					doc.body.append(handle);

					// Sizing: the wheel and + / - scale it about its own shape; the corner buttons are for a
					// mouse that would rather click. (The rim and the client's own edges still work too.)
					const scaleBy = (factor: number) => sizeTo(opened, opened.innerWidth * factor, opened.innerHeight * factor);
					opened.addEventListener(
						"wheel",
						event => {
							event.preventDefault();
							scaleBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
						},
						{ passive: false }
					);
					// the same round icon buttons as the main view's, drawn as icons: a text "+" or "x" sits on
					// the font's baseline, not in the middle of its circle
					const button = (path: string, right: number, hint: string, act: () => void) => {
						const b = doc.createElement("div");
						b.title = hint;
						b.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="${path}"/></svg>`;
						b.style.cssText =
							`position:fixed;top:8px;right:${right}px;width:28px;height:28px;box-sizing:border-box;border-radius:50%;` +
							"display:grid;place-items:center;color:rgba(255,255,255,0.8);background:rgba(0,0,0,0.45);" +
							"border:1px solid rgba(255,255,255,0.12);backdrop-filter:blur(12px);" +
							"opacity:0;transition:opacity 0.4s ease,background 0.2s ease,color 0.2s ease;cursor:pointer;user-select:none;-webkit-app-region:no-drag;app-region:no-drag;z-index:2";
						b.addEventListener("mouseenter", () => {
							wake();
							b.style.opacity = "1";
							b.style.color = "#fff";
							b.style.background = "rgba(255,255,255,0.16)";
						});
						b.addEventListener("mouseleave", () => {
							b.style.color = "rgba(255,255,255,0.8)";
							b.style.background = "rgba(0,0,0,0.45)";
							wake();
						});
						b.addEventListener("click", act);
						doc.body.append(b);
						buttons.push(b);
					};
					// The buttons go out when nothing is happening, like the bar in the main view, and come
					// back on any sign of a hand. A faded button still takes the mouse, so the corner
					// answers even if the drag handle over the picture keeps mouse moves to itself.
					const buttons: HTMLElement[] = [];
					let idle = 0;
					const wake = () => {
						for (const b of buttons) b.style.opacity = "0.5";
						opened.clearTimeout(idle);
						idle = opened.setTimeout(() => {
							for (const b of buttons) b.style.opacity = "0";
						}, IDLE_HIDE_MS);
					};
					for (const sign of ["mousemove", "mousedown", "wheel", "keydown", "focus"]) opened.addEventListener(sign, wake, true);
					doc.documentElement.addEventListener("mouseenter", wake);
					button("M6 6l12 12M18 6L6 18", 8, "Close (Esc)", () => opened.close());
					button("M12 5v14M5 12h14", 42, "Bigger (+ or wheel up)", () => scaleBy(1.25));
					button("M5 12h14", 76, "Smaller (- or wheel down)", () => scaleBy(0.8));
					wake();

					// Keys: its own, and everything else goes to the visualizer as if typed there
					opened.addEventListener("keydown", event => {
						if (event.key === "Escape") opened.close();
						else if (event.key === "+" || event.key === "=") scaleBy(1.25);
						else if (event.key === "-" || event.key === "_") scaleBy(0.8);
						else window.dispatchEvent(new KeyboardEvent("keydown", { key: event.key }));
					});

					opened.addEventListener("resize", resize);
					opened.addEventListener("resize", () => remember(opened));
					// closed with its own button, or by Spotify opening its miniplayer in the same slot
					opened.addEventListener("pagehide", () => remember(opened), { once: true });
					opened.addEventListener("pagehide", comeBack, { once: true });
					resize();
					reschedule();
					setIsPip(true);
				})
				.catch(err => Spicetify.showNotification(`Picture-in-picture: ${String(err?.message ?? err)}`, true));
		};

		return () => {
			window.removeEventListener("resize", resize);
			boxWatch?.disconnect();
			// leaving the visualizer page takes the little window with it: its canvas has no loop left
			togglePipRef.current = () => {};
			disposed = true;
			const leaving = pip as Window | null;
			pip = null;
			leaving?.close();
			requestWindow.cancelAnimationFrame(requestId);
			audioSync.dispose();
		};
	}, []);

	useEffect(() => {
		let hideTimeout: number;
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

	const toggleFullscreen = useCallback(() => {
		// refused (no user gesture, or the client forbids it): nothing to say, the button just did nothing
		if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
		else containerRef.current?.requestFullscreen().catch(() => {});
	}, []);
	toggleFullscreenRef.current = toggleFullscreen;

	const [progressDisplay, setProgressDisplay] = useState(0);
	const [playing, setPlaying] = useState(false);
	// while the bar is held, where it would seek to (shown, not yet sought)
	const [scrub, setScrub] = useState<number | null>(null);
	useEffect(() => {
		const tick = () => {
			setProgressDisplay(Spicetify.Player.getProgress());
			setPlaying(Spicetify.Player.isPlaying());
		};
		tick();
		const id = window.setInterval(tick, 500);
		Spicetify.Player.addEventListener("onplaypause", tick);
		return () => {
			window.clearInterval(id);
			Spicetify.Player.removeEventListener("onplaypause", tick);
		};
	}, []);
	// IN FULLSCREEN THE PLAYER IS HIDDEN, so the overlay is one: the bar seeks (click, or drag and let
	// go), and back / play / next sit under it. Outside fullscreen Spotify's own player is right there.
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
			setProgressDisplay(ms);
			setScrub(null);
		};
		bar.addEventListener("pointermove", move);
		bar.addEventListener("pointerup", up);
	};
	const shownMs = scrub !== null && track ? scrub * track.durationMs : progressDisplay;

	return (
		<div className={`vivy-container${uiVisible ? "" : " vivy-idle"}`} ref={containerRef}>
			<canvas ref={canvasRef} className="vivy-canvas" />

			{tuneOpen ? <TunePanel presetId={presetId} onClose={() => setTuneOpen(false)} /> : null}
			<div className="vivy-chrome">
				{/* left, what is shown; right, what is done with the window. Never one row of look-alike buttons */}
				<div className="vivy-top">
					<nav className="vivy-presets" aria-label="Presets">
						{PRESETS.map(preset => (
							<button
								key={preset.id}
								className={`vivy-preset${preset.id === presetId ? " active" : ""}`}
								aria-pressed={preset.id === presetId}
								onClick={() => setPresetId(preset.id)}
							>
								{preset.name}
								{preset.experimental ? <span className="vivy-tag" title="Experimental">exp</span> : null}
							</button>
						))}
					</nav>
					<div className="vivy-actions">
						<IconButton label="Knobs (T)" active={tuneOpen} onClick={() => setTuneOpen(open => !open)} icon={ICON_KNOBS} />
						<IconButton label={isPip ? "Close mini window (P)" : "Mini window (P)"} active={isPip} onClick={() => togglePipRef.current()} icon={ICON_PIP} />
						<IconButton label={isFullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"} onClick={toggleFullscreen} icon={isFullscreen ? ICON_SHRINK : ICON_EXPAND} />
					</div>
				</div>

				<div className="vivy-overlay">
					{track ? (
						<>
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
								</div>
							) : null}
						</>
					) : (
						<div className="vivy-track-name">Start playing a song</div>
					)}
				</div>
			</div>
		</div>
	);
}
