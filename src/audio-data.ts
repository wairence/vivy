import { decodeHits, Hit } from "./rhythm";
import { findMoments, Moment } from "./track-structure";

export type CurvePoint = { t: number; y: number };
export type { Moment };

export type Bar = { start: number; duration: number; confidence: number };
export type Section = {
	start: number;
	duration: number;
	confidence: number;
	loudness: number;
	// each section carries its own tempo and metre - a track is not obliged to keep either
	tempo: number;
	time_signature: number;
	key: number;
	mode: number;
};

export type TrackAudioData = {
	beats: SpotifyAudioAnalysis["beats"];
	segments: SpotifyAudioAnalysis["segments"];
	loudnessCurve: CurvePoint[];
	tempo: number;
	// the metrical grid: which beats start a bar. Empty when the track has none
	bars: Bar[];
	// the track's own structure; each section carries its loudness in dB
	sections: Section[];
	// the track's big moments and what the music does on the way into each - see track-structure.ts
	moments: Moment[];
	// the sub-beat grid, roughly two to four per beat. Carried but not used - see docs/DATA.md
	tatums: Bar[];
	// the audio's own onsets (rhythm.ts); empty without a rhythmstring (8 of 89 dumps) or inflate support
	hits: Hit[];
	// every segment's timbre[1] ("how bright/ringing"), sorted. A mark's place on the axis is its rank here:
	// the raw values are bell-shaped and a linear stretch bunches them in the middle.
	timbreSorted: number[];
	// the analysis's track-level summary, verbatim; its shape is assumed from the public Web API docs
	trackInfo: Record<string, unknown>;
	// amplitude a single hit is measured against: this track's 98th-percentile segment (docs/DATA.md 3.1)
	hitScale: number;
};

const toAmplitude = (db: number) => Math.pow(10, db / 20);

// the track's quiet and loud ends are mapped onto the amplitudes the presets were tuned against
const ENERGY_QUIET = 0.06;
const ENERGY_LOUD = 0.62;

// Normalised onto the track's own 5th and 95th percentiles (not min and max: one silent outro would define the scale).
// Exported so harnesses apply the same stretch as the client.
export function normaliseCurve(curve: CurvePoint[]) {
	const sorted = curve.map(p => p.y).filter(y => Number.isFinite(y)).sort((a, b) => a - b);
	if (sorted.length < 8) return;
	const at = (q: number) => sorted[Math.floor((sorted.length - 1) * q)];
	const lo = at(0.05);
	const hi = at(0.95);
	if (hi - lo < 1e-4) return;
	const scale = (ENERGY_LOUD - ENERGY_QUIET) / (hi - lo);
	// blended 70/30 with the raw value: full normalisation makes a quiet song move like a loud one
	for (const point of curve) {
		const stretched = ENERGY_QUIET + (point.y - lo) * scale;
		point.y = Math.max(0, Math.min(1, stretched * 0.7 + point.y * 0.3));
	}
}

// "how ringing was that sound" for every segment, sorted, so a value can be turned into its rank
function sortedTimbre(segments: SpotifyAudioAnalysis["segments"]): number[] {
	return segments
		.map(s => s.timbre[1])
		.filter(v => Number.isFinite(v))
		.sort((a, b) => a - b);
}

// where a value sits within that, 0..1
export function rankOf(sorted: number[] | undefined, value: number): number {
	if (!sorted || sorted.length < 16 || !Number.isFinite(value)) return 0.5;
	let lo = 0;
	let hi = sorted.length - 1;
	if (value <= sorted[0]) return 0;
	if (value >= sorted[hi]) return 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (sorted[mid] <= value) lo = mid;
		else hi = mid;
	}
	return lo / (sorted.length - 1);
}

// 98th percentile, not the maximum: one clipped transient must not define the scale
function hitScaleOf(segments: SpotifyAudioAnalysis["segments"]): number {
	const sorted = segments
		.map(s => toAmplitude(s.loudness_max))
		.filter(y => Number.isFinite(y))
		.sort((a, b) => a - b);
	if (sorted.length < 8) return 0.56;
	return Math.max(0.02, sorted[Math.floor((sorted.length - 1) * 0.98)]);
}

// continuous loudness curve from segments (dB -> linear amplitude), so visuals have a
// sense of the track's energy between beats, not just the beat attack itself
function buildLoudnessCurve(segments: SpotifyAudioAnalysis["segments"]): CurvePoint[] {
	const curve: CurvePoint[] = [];

	for (const segment of segments) {
		curve.push({ t: segment.start, y: toAmplitude(segment.loudness_start) });
		if (segment.loudness_max_time > 0)
			curve.push({ t: segment.start + segment.loudness_max_time, y: toAmplitude(segment.loudness_max) });
	}
	const last = segments[segments.length - 1];
	if (last) curve.push({ t: last.start + last.duration, y: toAmplitude(last.loudness_end) });

	return curve;
}

export function sampleCurve(curve: CurvePoint[], t: number): number {
	if (curve.length === 0) return 0;
	if (t <= curve[0].t) return curve[0].y;
	if (t >= curve[curve.length - 1].t) return curve[curve.length - 1].y;

	let lo = 0;
	let hi = curve.length - 1;
	while (hi - lo > 1) {
		const mid = Math.floor((lo + hi) / 2);
		if (curve[mid].t <= t) lo = mid;
		else hi = mid;
	}

	const a = curve[lo];
	const b = curve[hi];
	return a.y + ((t - a.t) / (b.t - a.t)) * (b.y - a.y);
}

// the current section plus the ones after it, so a preset can see what is coming
export function sectionIndexAt(sections: Section[], t: number): number {
	if (sections.length === 0 || sections[0].start > t) return -1;
	let lo = 0;
	let hi = sections.length - 1;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (sections[mid].start <= t) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

// the segment covering time `t`, or null before the first segment
export function segmentAt(segments: SpotifyAudioAnalysis["segments"], t: number): SpotifyAudioAnalysis["segments"][number] | null {
	let lo = 0;
	let hi = segments.length - 1;
	if (hi < 0 || segments[0].start > t) return null;

	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (segments[mid].start <= t) lo = mid;
		else hi = mid - 1;
	}

	return segments[lo];
}

// Fetched directly because Spicetify.getAudioData picks its transport with a version test that only understands 1.2.x
// (`a[1] >= 2 && a[2] < 31`), so on Spotify 1.3.0 it takes the legacy path. getAudioData is still tried first.
type CosmosFailure = { code?: number; error?: string; message?: string };

const looksLikeAnalysis = (x: unknown): x is SpotifyAudioAnalysis =>
	!!x && Array.isArray((x as SpotifyAudioAnalysis).segments);

const describeFailure = (x: unknown): string => {
	const f = x as CosmosFailure;
	const detail = [f?.code, f?.error, f?.message].filter(Boolean).join(" ");
	return detail || "the response had no segments";
};

async function fetchWithToken(url: string): Promise<Response | null> {
	const platform = (Spicetify as unknown as {
		Platform?: {
			version?: string;
			PlatformData?: { app_platform?: string };
			AuthorizationAPI?: { getState: () => { token?: { accessToken?: string } } };
		};
	}).Platform;
	const token = platform?.AuthorizationAPI?.getState()?.token?.accessToken;
	if (!token) return null;
	return fetch(url, {
		headers: {
			Authorization: `Bearer ${token}`,
			"Spotify-App-Version": platform?.version ?? "",
			"App-Platform": platform?.PlatformData?.app_platform ?? ""
		}
	});
}

async function fetchAnalysisDirectly(uri: string): Promise<unknown> {
	const id = uri.split(":").pop();
	if (!id) throw new Error("no track id in " + uri);
	const response = await fetchWithToken(`https://spclient.wg.spotify.com/audio-attributes/v1/audio-analysis/${id}?format=json`);
	if (!response) throw new Error("no access token available");
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
	return await response.json();
}

export async function loadTrackAudioData(uri: string): Promise<TrackAudioData> {
	let analysis: SpotifyAudioAnalysis;
	let viaWrapper: unknown = null;
	try {
		viaWrapper = await Spicetify.getAudioData(uri);
	} catch (err) {
		viaWrapper = { message: String((err as Error)?.message ?? err) };
	}
	if (looksLikeAnalysis(viaWrapper)) {
		analysis = viaWrapper;
	} else {
		// what the wrapper said, kept so the error can name both failures
		const wrapperSaid = describeFailure(viaWrapper);
		let direct: unknown;
		try {
			direct = await fetchAnalysisDirectly(uri);
		} catch (err) {
			throw new Error(`${wrapperSaid}; direct: ${String((err as Error)?.message ?? err)}`);
		}
		if (!looksLikeAnalysis(direct)) throw new Error(`${wrapperSaid}; direct: ${describeFailure(direct)}`);
		analysis = direct;
	}

	// both paths resolve with an error object rather than rejecting, so the shape is checked before anything reads it
	const sections: Section[] = Array.isArray(analysis.sections) ? analysis.sections : [];
	const bars = Array.isArray(analysis.bars) ? analysis.bars : [];
	const curve = buildLoudnessCurve(analysis.segments);
	normaliseCurve(curve);

	return {
		beats: analysis.beats,
		segments: analysis.segments,
		loudnessCurve: curve,
		tempo: analysis.track.tempo,
		bars,
		sections,
		moments: findMoments(curve, bars),
		hitScale: hitScaleOf(analysis.segments),
		tatums: Array.isArray(analysis.tatums) ? analysis.tatums : [],
		hits: await decodeHits((analysis.track as unknown as { rhythmstring?: unknown })?.rhythmstring),
		timbreSorted: sortedTimbre(analysis.segments),
		trackInfo: (analysis.track ?? {}) as unknown as Record<string, unknown>
	};
}

// Fallback for tracks the analysis 404s on: audio-features still answers with tempo, loudness and key.
// The loudness curve is left flat on purpose; an invented envelope would be a made-up heuristic.

export type TrackAudioFeatures = {
	tempo: number;
	duration_ms: number;
	loudness: number;
	energy: number;
	key: number;
	mode: number;
	time_signature: number;
};

export async function loadTrackAudioFeatures(uri: string): Promise<TrackAudioFeatures> {
	const id = uri.split(":").pop();
	const url = `https://spclient.wg.spotify.com/audio-attributes/v1/audio-features/${id}?format=json`;
	// same two paths as the analysis: CosmosAsync alone breaks on Spotify 1.3 for the same reason
	let body: unknown = null;
	try {
		body = await Spicetify.CosmosAsync.get(url);
	} catch {
		body = null;
	}
	const ok = (x: unknown): x is TrackAudioFeatures => !!x && typeof (x as TrackAudioFeatures).tempo === "number" && (x as TrackAudioFeatures).tempo > 0;
	if (ok(body)) return body;
	const response = await fetchWithToken(url);
	if (!response) throw new Error(`no audio features (${describeFailure(body)}; no access token)`);
	if (!response.ok) throw new Error(`no audio features (${describeFailure(body)}; direct: ${response.status} ${response.statusText})`);
	const direct = (await response.json()) as unknown;
	if (!ok(direct)) throw new Error(`no audio features (${describeFailure(direct)})`);
	return direct;
}

export function trackDataFromFeatures(features: TrackAudioFeatures): TrackAudioData {
	// no length given: ten minutes of pulse rather than one second of it
	const duration = features.duration_ms ? Math.max(1, features.duration_ms / 1000) : 600;
	const beatDuration = 60 / features.tempo;
	const beats: TrackAudioData["beats"] = [];
	// generated from Spotify's own measured tempo, so the pulse is the track's real one; there is no
	// phase information anywhere in the features, so it starts at zero and drifts against the mix
	for (let t = 0; t < duration; t += beatDuration) beats.push({ start: t, duration: beatDuration, confidence: 0.6 });

	const amplitude = toAmplitude(Math.max(-40, Math.min(0, features.loudness)));
	return {
		beats,
		segments: [],
		loudnessCurve: [
			{ t: 0, y: amplitude },
			{ t: duration, y: amplitude }
		],
		tempo: features.tempo,
		bars: [],
		sections: [],
		moments: [],
		hitScale: amplitude,
		tatums: [],
		hits: [],
		timbreSorted: [],
		trackInfo: {}
	};
}
