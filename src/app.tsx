import React, { useCallback, useEffect, useRef, useState } from "react";
import "./css/app.css";
import { loadTrackAudioData, loadTrackAudioFeatures, nearestBarStart, trackDataFromFeatures, TrackAudioData } from "./audio-data";
import { lastConducted } from "./presets/flowfield-common";
import { AudioSync, createSmoothClock } from "./audio-sync";
import { BUILD, DEV } from "./build-stamp";
import { Preset, PresetFrame, PRESETS } from "./presets";
import { Knob, movedText, resetKnobs, setKnob, tuningOf } from "./presets/tune";

// posts a diagnostic to the dev server (npm run live) so findings inside the Spotify client are
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

// Is the metrical grid actually regular? The bar tracker follows the music, so bar durations are
// not required to be equal - but how unequal they are in practice, and how sure the tracker was, is
// only answerable from real tracks. Reported once per track.
function reportGrid(name: string, data: TrackAudioData) {
	if (!DEV) return;
	try {
		reportGridOf(name, data);
	} catch {
		// a diagnostic must never cost the track its analysis
	}
}
function reportGridOf(name: string, data: TrackAudioData) {
	const durations = data.bars.map(b => b.duration);
	const mean = durations.reduce((s, x) => s + x, 0) / Math.max(1, durations.length);
	const variance = durations.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, durations.length);
	const spread = mean > 0 ? Math.sqrt(variance) / mean : 0;
	// how many beats land on a bar boundary - should be about 1/timeSignature if the two grids agree
	let onBar = 0;
	for (const beat of data.beats) {
		const near = nearestBarStart(data.bars, beat.start);
		if (near && near.distance < 0.07) onBar++;
	}
	const tempos = data.sections.map(x => Math.round(x.tempo));
	// the decisive number: how many boundaries in this track would ever brace-and-release? Zero
	// means the mechanic is silent for its whole length.
	let impacts = 0;
	for (let i = 1; i < data.sections.length; i++)
		if (
			data.sectionIntensity[i] - data.sectionIntensity[i - 1] >= 0.22 &&
			data.sections[i].loudness - data.sections[i - 1].loudness >= 0.5
		)
			impacts++;
	report({
		grid: name,
		bars: data.bars.length,
		barSeconds: Number(mean.toFixed(3)),
		// 0 = every bar identical, 0.1 = ten percent variation. THE answer to "is the rhythm even"
		barSpread: Number(spread.toFixed(3)),
		barConfidence: Number(
			(data.bars.reduce((s, b) => s + b.confidence, 0) / Math.max(1, data.bars.length)).toFixed(2)
		),
		beatsOnBar: data.beats.length ? Number((onBar / data.beats.length).toFixed(3)) : null,
		timeSignatures: Array.from(new Set(data.sections.map(x => x.time_signature))),
		sectionTempos: tempos.length ? `${Math.min(...tempos)}-${Math.max(...tempos)}` : null,
		sections: data.sections.length,
		sectionStarts: data.sections.map(x => Number(x.start.toFixed(1))),
		sectionLoudness: data.sections.map(x => Number(x.loudness.toFixed(1))),
		sectionIntensity: data.sectionIntensity.map(x => Number(x.toFixed(2))),
		energyRange: `${data.loudnessCurve.length ? Math.min(...data.loudnessCurve.map(p => p.y)).toFixed(2) : "-"}..${data.loudnessCurve.length ? Math.max(...data.loudnessCurve.map(p => p.y)).toFixed(2) : "-"}`,
		impactsInTrack: impacts,
		detected: data.moments.map((m: { t: number }) => `${Math.floor(Math.round(m.t) / 60)}:${String(Math.round(m.t) % 60).padStart(2, "0")}`)
	});
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

function IconButton({ label, icon, active, onClick }: { label: string; icon: React.ReactNode; active?: boolean; onClick: () => void }) {
	return (
		<button className={`vivy-icon${active ? " active" : ""}`} title={label} aria-label={label} aria-pressed={!!active} onClick={onClick}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
				{icon}
			</svg>
		</button>
	);
}

// THE KNOB PANEL (T): every number the preset on screen offers, as a slider, turned while it plays.
// Double-click a name to put that one back; "Copy" puts what was moved on the clipboard, to be written
// back into the code as the new defaults.
function TunePanel({ presetId, onClose }: { presetId: string; onClose: () => void }) {
	const [, redraw] = useState(0);
	// the hint of the knob under the pointer (or in focus), drawn beside the panel rather than in it,
	// where the panel's scrolling would cut it off
	const [hint, setHint] = useState<{ knob: Knob; top: number; right: number } | null>(null);
	const panelRef = useRef<HTMLDivElement>(null);
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
	const showHint = (knob: Knob, row: HTMLElement) => {
		const panel = panelRef.current;
		const parent = panel?.offsetParent;
		if (!knob.hint || !panel || !parent) return;
		const p = parent.getBoundingClientRect();
		setHint({ knob, top: row.getBoundingClientRect().top - p.top, right: p.right - panel.getBoundingClientRect().left + 10 });
	};
	let group = "";
	return (
		<>
		<div className="vivy-tune" ref={panelRef} onMouseDown={e => e.stopPropagation()} onScroll={() => setHint(null)}>
			<div className="vivy-tune-head">
				<b>Knobs</b>
				<button onClick={copy}>Copy</button>
				<button onClick={() => (resetKnobs(presetId), refresh())}>Reset</button>
				<button onClick={onClose}>{"×"}</button>
			</div>
			{!t || (t.knobs.length === 0 && t.features.length === 0) ? (
				<div className="vivy-tune-none">This preset has no knobs yet.</div>
			) : null}
			{t?.features.map((f, i) => (
				<label key={f.name} className="vivy-tune-feature">
					<input type="checkbox" checked={f.on} onChange={() => ((f.on = !f.on), refresh())} />
					{i + 1}. {f.name}
				</label>
			))}
			{t?.knobs.map(k => {
				const value = t.values[k.key];
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
			})}
		</div>
		{hint ? (
			<div className="vivy-tune-hint" style={{ top: hint.top, right: hint.right }}>
				<div>{hint.knob.hint}</div>
				<small>
					default {+hint.knob.def.toPrecision(3)} · double-click the name to reset
				</small>
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
	const targetColorRef = useRef(DEFAULT_RGB);
	const displayColorRef = useRef(DEFAULT_RGB);
	const mousePosRef = useRef({ x: 0, y: 0 });
	const mouseClicksRef = useRef(0);
	const mouseRightClicksRef = useRef(0);
	const mouseDownRef = useRef(false);
	const mouseRightDownRef = useRef(false);
	const mouseScrollRef = useRef(0.5);
	const mouseParticleScaleRef = useRef(0.5);
	const presetRef = useRef<Preset>();
	const presetMadeFor = useRef("");
	if (!presetRef.current) {
		presetRef.current = PRESETS.find(p => p.id === presetId)!.create();
		presetMadeFor.current = presetId;
	}

	// Which build is actually running. Twice now a session has been spent tuning against a client
	// that was still executing the previous bundle: `spicetify apply` writes index.js to disk, and
	// the client reads it once, at startup. There is no way to tell from inside the picture, and
	// "nothing changed" is the same sentence whether the change failed or never loaded.
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

		// otherwise a trail-based preset starts by fading out whatever the previous preset left
		// on screen, which reads as a stuck afterimage for a second or more
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
			// default was a flash of green between every two songs
			if (!item?.uri) return;

			// Spicetify.getAudioData is an undocumented internal endpoint and fails transiently often
			// enough to be worth one retry before giving up on the track.
			//
			// A track WITHOUT analysis degrades in a way that looks like a bug rather than like a
			// missing feature, which is why it now says so out loud: `currentEnergy` falls back to a
			// plain sine, no beats means beatHit never fires so percussion never appears at all, and
			// no segments means attackSharpness/harmonicShift/brightness all sit at zero. The result
			// is small particles drifting in slow waves - identical on every preset, because the
			// cause is upstream of all of them. Silently looking broken is worse than saying "no
			// analysis for this one".
			const announceMissing = (why: string) => {
				if (!alive || Spicetify.Player.data?.item?.uri !== item.uri) return;
				// No timeline for this track. Its audio FEATURES may still exist on the sibling endpoint,
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
						// back to the old segment rule when that cannot be done. Silently - which is the
						// one thing that must not happen here, since "nothing changed" has already cost
						// several rounds of looking for a bug in code that was never running. Said once
						// per session, and only when the track HAD a rhythmstring to decode.
						if (DEV && !hitsWarned && data.hits.length === 0 && typeof data.trackInfo.rhythmstring === "string") {
							hitsWarned = true;
							Spicetify.showNotification("Visualizer: rhythm onsets unavailable, hits fall back to segments", true);
						}
						reportGrid(item.name, data);
						// the full analysis, for building the structure detector against real music
						if (DEV) void fetch("http://localhost:8790/dump", {
							method: "POST",
							headers: { "Content-Type": "text/plain" },
							body: JSON.stringify({
								name: item.name,
								// everything the endpoint gives, not just what a preset happens to read today. The
								// dumps were missing beats, sections and tatums entirely, so every offline probe
								// that asked for beats silently got BARS instead - a quarter of the real pulse -
								// and no measurement of the track-level summary was possible at all
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
							// Silence was the bug here. The POST failing is the normal case - the dev server is
							// usually not running - so it was swallowed, and a collecting session that produced
							// nothing looked exactly like one that worked. A confirmation only on SUCCESS costs
							// nothing when nobody is collecting and is the whole signal when somebody is.
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
			// THE NEXT TRACK'S ANALYSIS, AHEAD OF TIME, so that when the player moves on by itself there is
			// no gap for the picture to wait through. A skip to anywhere else still waits.
			const next = (Spicetify.Queue?.nextTracks?.[0] as { contextTrack?: { uri?: unknown } } | undefined)?.contextTrack?.uri;
			if (typeof next === "string" && next.startsWith("spotify:track:")) loadAnalysis(next).catch(() => {});

			if (item.metadata.image_url) {
				Spicetify.extractColorPreset(item.metadata.image_url)
					.then(colors => {
						if (Spicetify.Player.data?.item?.uri !== item.uri) return;
						const rgb = colors[0]?.colorLight?.rgb;
						if (rgb) targetColorRef.current = rgb;
					})
					.catch(() => {
						// keep the default color
					});
			}
		};

		const songChangeListener = (event?: Event & { data: Spicetify.PlayerState }) => updateTrack(event?.data);
		Spicetify.Player.addEventListener("songchange", songChangeListener);
		updateTrack(Spicetify.Player.data);

		return () => {
			alive = false;
			Spicetify.Player.removeEventListener("songchange", songChangeListener as (event?: Event) => void);
		};
	}, []);

	// ---- looking, rather than describing --------------------------------------------------------
	// B marks the moment as wrong. V flips between parameter sets, live.
	//
	// Every round so far has gone: build, deploy, restart, watch, DESCRIBE IN WORDS, mis-read the
	// description, repeat - half an hour a turn, and the words are the part that fails. Nobody can
	// specify a picture that has never existed. Recognising one is easy, so these two make
	// recognition the only thing being asked for.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.ctrlKey || e.altKey || e.metaKey) return;
			const key = e.key.toLowerCase();
			// 1-9 switch one feature of the preset on screen on or off, for the same reason V exists:
			// "is the picture better without this?" is answered by looking, not by describing
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

			// what the machine believed at the instant the eye disagreed with it
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
		// opaque: the trail canvas is never composited against anything behind it, and fadeTrail's
		// black-floor pass needs a real backdrop to blend against (see effects.ts)
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
		// size itself has to be readable from inside the client - it is the only number the tuning
		// is relative to, and it is invisible from the outside.
		if (DEV) Spicetify.showNotification(`Visualizer canvas ${canvas.width}x${canvas.height}`);
		mousePosRef.current = { x: canvas.width / 2, y: canvas.height / 2 };
		window.addEventListener("resize", resize);
		const boxWatch = typeof ResizeObserver === "function" ? new ResizeObserver(() => resize()) : null;
		boxWatch?.observe(canvas);

		const onMouseMove = (event: MouseEvent) => {
			const rect = canvas.getBoundingClientRect();
			mousePosRef.current = {
				x: ((event.clientX - rect.left) / rect.width) * canvas.width,
				y: ((event.clientY - rect.top) / rect.height) * canvas.height
			};
		};
		canvas.addEventListener("mousemove", onMouseMove);

		const onMouseDown = (event: MouseEvent) => {
			if (event.button === 2) {
				mouseRightClicksRef.current++;
				mouseRightDownRef.current = true;
			} else {
				mouseClicksRef.current++;
				mouseDownRef.current = true;
			}
		};
		canvas.addEventListener("mousedown", onMouseDown);

		// holding the button "paints" a trail of the same gesture instead of just one press - both
		// released together on mouseup/leaving the canvas/losing focus, so a stuck "held" state can't
		// survive the cursor leaving the window mid-drag
		const onMouseUp = (event: MouseEvent) => {
			if (event.button === 2) mouseRightDownRef.current = false;
			else mouseDownRef.current = false;
		};
		window.addEventListener("mouseup", onMouseUp);
		const onMouseLeave = () => {
			mouseDownRef.current = false;
			mouseRightDownRef.current = false;
		};
		canvas.addEventListener("mouseleave", onMouseLeave);
		window.addEventListener("blur", onMouseLeave);

		// right click drives its own gesture instead of opening Spotify's context menu
		const onContextMenu = (event: MouseEvent) => event.preventDefault();
		canvas.addEventListener("contextmenu", onContextMenu);

		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			// alt+wheel: how many particles a preset runs with, instead of the speed fader
			if (event.altKey) {
				mouseParticleScaleRef.current = Math.max(
					0,
					Math.min(1, mouseParticleScaleRef.current - event.deltaY * 0.0006)
				);
			} else {
				mouseScrollRef.current = Math.max(0, Math.min(1, mouseScrollRef.current - event.deltaY * 0.0006));
			}
		};
		canvas.addEventListener("wheel", onWheel, { passive: false });

		let prevMouseX = mousePosRef.current.x;
		let prevMouseY = mousePosRef.current.y;
		let mouseSpeed = 0;
		const audioSync = new AudioSync();
		const smoothClock = createSmoothClock();

		let requestId = 0;
		let requestWindow: Window = window;
		let disposed = false;
		let drawFailed = false;
		let lastColourAt = performance.now();
		const render = () => {
			const target = targetColorRef.current;
			const display = displayColorRef.current;
			// the palette comes round to a new cover over a couple of seconds - by the clock, not by the
			// frame: `* 0.05` a frame was a quarter of a second on a 240 Hz screen and a whole one at 60
			const wall = performance.now();
			const colourStep = 1 - Math.exp(-Math.min(0.1, (wall - lastColourAt) / 1000) / 0.6);
			lastColourAt = wall;
			displayColorRef.current = {
				r: display.r + (target.r - display.r) * colourStep,
				g: display.g + (target.g - display.g) * colourStep,
				b: display.b + (target.b - display.b) * colourStep
			};

			const mousePos = mousePosRef.current;
			const rawSpeed = Math.hypot(mousePos.x - prevMouseX, mousePos.y - prevMouseY);
			mouseSpeed = mouseSpeed * 0.8 + rawSpeed * 0.2;
			prevMouseX = mousePos.x;
			prevMouseY = mousePos.y;

			const isPlaying = Spicetify.Player.isPlaying();
			const frame: PresetFrame = {
				ctx,
				width: canvas.width,
				height: canvas.height,
				progressSec: smoothClock(Spicetify.Player.getProgress() / 1000, isPlaying, performance.now() / 1000) - audioSync.getLatencySec(),
				isPlaying,
				audio: audioDataRef.current,
				colorRgb: displayColorRef.current,
				mouse: {
					x: mousePos.x,
					y: mousePos.y,
					speed: mouseSpeed,
					clicks: mouseClicksRef.current,
					rightClicks: mouseRightClicksRef.current,
					down: mouseDownRef.current,
					rightDown: mouseRightDownRef.current,
					scroll: mouseScrollRef.current,
					particleScale: mouseParticleScaleRef.current
				}
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
		// THE FRAME CLOCK IS THE WINDOW'S THE CANVAS IS IN. A window nobody can see gets no animation
		// frames - and the whole point of the little window is that Spotify itself is behind a game.
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
		// a game in EXCLUSIVE fullscreen owns the screen and nothing of ours can be put over that.
		//
		// THE WINDOW HAS NO FRAME in this client - no title bar to drag, no visible edge to pull. It is
		// moved and sized the way Spotify's miniplayer does it, read out of its own code: a region of
		// the page marked `-webkit-app-region: drag`, and `resizeTo` / `moveTo` on the window. With
		// neither, it could be opened and then could not be put anywhere.
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

					// MOVING: the whole picture is the handle - grab it anywhere. All but a rim: a drag
					// region that reaches the border takes the border's resize grip with it.
					const handle = doc.createElement("div");
					handle.style.cssText = "position:fixed;inset:10px;-webkit-app-region:drag;app-region:drag;cursor:grab";
					handle.title = "Drag to move. Wheel, + and - resize. Esc closes.";
					doc.body.append(handle);

					// SIZING: the wheel and + / - scale it about its own shape; the corner buttons are for a
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
					const button = (label: string, right: number, hint: string, act: () => void) => {
						const b = doc.createElement("div");
						b.textContent = label;
						b.title = hint;
						b.style.cssText =
							`position:fixed;top:6px;right:${right}px;width:22px;height:22px;border-radius:11px;` +
							"font:600 14px/22px system-ui,sans-serif;text-align:center;color:#fff;background:rgba(255,255,255,0.14);" +
							"opacity:0;transition:opacity 0.4s ease;cursor:pointer;user-select:none;-webkit-app-region:no-drag;app-region:no-drag;z-index:2";
						b.addEventListener("mouseenter", () => {
							wake();
							b.style.opacity = "1";
						});
						b.addEventListener("mouseleave", wake);
						b.addEventListener("click", act);
						doc.body.append(b);
						buttons.push(b);
					};
					// THE BUTTONS GO OUT WHEN NOTHING IS HAPPENING, like the bar in the main view, and come
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
					button("\u00d7", 6, "Close (Esc)", () => opened.close());
					button("+", 34, "Bigger (+ or wheel up)", () => scaleBy(1.25));
					button("\u2212", 62, "Smaller (- or wheel down)", () => scaleBy(0.8));
					wake();

					// KEYS: its own, and everything else goes to the visualizer as if typed there
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
			canvas.removeEventListener("mousemove", onMouseMove);
			canvas.removeEventListener("mousedown", onMouseDown);
			window.removeEventListener("mouseup", onMouseUp);
			canvas.removeEventListener("mouseleave", onMouseLeave);
			window.removeEventListener("blur", onMouseLeave);
			canvas.removeEventListener("contextmenu", onContextMenu);
			canvas.removeEventListener("wheel", onWheel);
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
	useEffect(() => {
		const id = window.setInterval(() => setProgressDisplay(Spicetify.Player.getProgress()), 500);
		return () => window.clearInterval(id);
	}, []);

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
							<div className="vivy-progress-track">
								<div
									className="vivy-progress-fill"
									style={{ width: `${track.durationMs ? (progressDisplay / track.durationMs) * 100 : 0}%` }}
								/>
							</div>
							<div className="vivy-time">
								{formatTime(progressDisplay)} / {formatTime(track.durationMs)}
							</div>
						</>
					) : (
						<div className="vivy-track-name">Start playing a song</div>
					)}
				</div>
			</div>
		</div>
	);
}
