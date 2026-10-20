import { TrackAudioData } from "./audio-data";
import { BUILD, DEV } from "./build-stamp";
import { lastConducted } from "./presets/conductor";

// Dev builds only. Everything goes to the server of `npm run preview` (perf-serve.js); in a normal
// run nothing listens there and the requests fail silently.
const SERVER = "http://localhost:8790";

const post = (path: string, body: object) =>
	fetch(SERVER + path, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body) });

export function report(what: object) {
	if (!DEV) return;
	console.warn("[visualizer]", what);
	void post("/log", what).catch(() => {});
}

// `spicetify apply` writes the bundle, but the client reads it once at startup: this says which build runs
export function announceBuild() {
	if (DEV) Spicetify.showNotification(`Visualizer build ${BUILD}`);
}

let hitsWarned = false;
// once per session, and only when the track had a rhythmstring that failed to decode
export function warnIfNoHits(data: TrackAudioData) {
	if (!DEV || hitsWarned || data.hits.length > 0 || typeof data.trackInfo.rhythmstring !== "string") return;
	hitsWarned = true;
	Spicetify.showNotification("Visualizer: rhythm onsets unavailable, hits fall back to segments", true);
}

const fixed = (x: number, digits: number) => Number(x.toFixed(digits));

// the whole analysis, for the offline lab scripts (analysis-dumps/)
export function dumpAnalysis(name: string, data: TrackAudioData) {
	if (!DEV) return;
	// codestring and echoprintstring are acoustic fingerprints: 24k characters of no use here
	const track: Record<string, unknown> = {};
	for (const k of Object.keys(data.trackInfo)) if (k !== "codestring" && k !== "echoprintstring") track[k] = data.trackInfo[k];
	post("/dump", {
		name,
		track,
		tempo: data.tempo,
		beats: data.beats.map(b => [fixed(b.start, 3), fixed(b.duration, 3), b.confidence]),
		tatums: data.tatums.map(b => [fixed(b.start, 3), fixed(b.duration, 3), b.confidence]),
		sections: data.sections.map(x => [fixed(x.start, 2), fixed(x.duration, 2), x.confidence, x.loudness, x.tempo, x.key, x.mode, x.time_signature]),
		bars: data.bars.map(b => [fixed(b.start, 2), fixed(b.duration, 2), b.confidence]),
		curve: data.loudnessCurve.map(c => [fixed(c.t, 2), fixed(c.y, 4)]),
		segments: data.segments.map(g => [
			fixed(g.start, 2),
			fixed(g.duration, 2),
			g.loudness_max,
			g.loudness_max_time,
			g.pitches.map(v => fixed(v, 3)),
			g.timbre.map(v => fixed(v, 1)),
			g.loudness_start,
			g.loudness_end,
			g.confidence ?? null
		])
	})
		.then(res => {
			if (res.ok) Spicetify.showNotification(`Analysis dumped: ${name}`);
		})
		.catch(() => {});
}

// B: what the visualiser believed at this moment, sent to the marks log
export function markMoment(preset: string) {
	const item = Spicetify.Player.data?.item;
	const mark: Record<string, unknown> = {
		at: Spicetify.Player.getProgress() / 1000,
		track: item?.name ?? "?",
		uri: item?.uri ?? "?",
		preset,
		build: BUILD
	};
	if (lastConducted)
		for (const [k, v] of Object.entries(lastConducted)) if (typeof v === "number") mark[k] = fixed(v, 4);
	post("/mark", mark)
		.then(res => Spicetify.showNotification(res.ok ? `marked ${mark.at as number}s` : "mark failed", !res.ok))
		.catch(() => Spicetify.showNotification("mark failed: dev server not running", true));
}
