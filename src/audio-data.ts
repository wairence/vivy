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
	// the track's own structure, with each section's loudness in dB. This is what makes anticipating
	// a chorus possible at all - it is the only part of the analysis that describes the future
	sections: Section[];
	// the track's big moments and what the music does on the way into each - see track-structure.ts
	moments: Moment[];
	// the sub-beat grid, roughly two to four per beat. Carried but not used - see docs/DATA.md
	tatums: Bar[];
	// the audio's own onsets, from `rhythmstring` - see rhythm.ts. Empty when the track has no
	// rhythmstring (8 of 89 dumps) or the platform cannot inflate it; next-sound.ts then gives
	// every sound a breadth of 0
	hits: Hit[];
	// every segment's timbre[1] ("how bright/ringing did that sound"), sorted - the only per-event
	// scale with a usable spread. Raw it runs about -34..99 and sits differently on every track, so
	// it is normalised per track. Measured across 26k events: consecutive hits differ by 19% of the
	// range at the median, and any ten seconds covers 68% of it.
	// A mark's place on the axis is its rank here, not its value: the raw numbers are bell-shaped,
	// so a linear stretch leaves the marks bunched in the middle (about a third of the axis used).
	// A rank spreads them evenly by construction.
	timbreSorted: number[];
	// the analysis's own track-level summary, verbatim and untyped. What this object actually
	// contains from the internal endpoint is assumed from the public Web API's documentation, not
	// verified, so it is kept as-is rather than picked apart here
	trackInfo: Record<string, unknown>;
	// The amplitude a single hit is measured against: this track's own 98th-percentile segment.
	// Everything that asks "was that a big hit?" divides by this. A fixed scale against Spotify's
	// absolute amplitude, clamped to 1, fails on a modern master: most of a chorus is past the
	// clamp, every hit measures exactly 1.0, and anything built on beating the loudest recent hit
	// fires on nearly every beat (a star every 1.3s on the busiest track measured).
	hitScale: number;
};



const toAmplitude = (db: number) => Math.pow(10, db / 20);

// Where a track's own quiet and loud ends are mapped to. Every preset was tuned against Spotify's
// absolute amplitude scale, where a quiet passage reads about 0.06 and a big one about 0.6 - so
// those are the targets, and each track is stretched onto them individually.
const ENERGY_QUIET = 0.06;
const ENERGY_LOUD = 0.62;

// A track mastered at -13dB would sit at 0.22 for its entire length and render as a permanent
// interlude: dim, slow, nothing happening. Loudness is a property of the mastering, not of the
// music, so the curve is normalised onto the track's own 5th and 95th percentiles. Percentiles
// rather than min and max because a single silent outro would otherwise define the whole scale.
// Exported, because every harness that builds a curve of its own has to apply the same stretch as
// the client, or it shows a preset at the bottom of its dynamic range.
export function normaliseCurve(curve: CurvePoint[]) {
	const sorted = curve.map(p => p.y).filter(y => Number.isFinite(y)).sort((a, b) => a - b);
	if (sorted.length < 8) return;
	const at = (q: number) => sorted[Math.floor((sorted.length - 1) * q)];
	const lo = at(0.05);
	const hi = at(0.95);
	if (hi - lo < 1e-4) return;
	const scale = (ENERGY_LOUD - ENERGY_QUIET) / (hi - lo);
	// Blended with the untouched value rather than replacing it. Full normalisation gives every
	// track the same dynamic range, which makes a chorus register on a compressed master but also
	// makes a quiet, gentle song move like a loud one. Most of the weight is on the track's own
	// dynamics; the remainder keeps a quiet track quieter than a loud one.
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

// The 98th percentile rather than the maximum: one clipped transient must not define the scale for
// the whole track, and the point of the number is "what does a big hit sound like here".
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

// The analysis endpoint, fetched directly rather than only through `Spicetify.getAudioData`.
//
// Why: spicetify's wrapper picks how to make the request from the
// client's version string, and the test is
//
//     const a = Spicetify.Platform.version.split(".").map(Number);
//     return a[1] >= 2 && a[2] < 31 ? nativeCosmos : fetchWithAuthHeaders;
//
// which reads "1.2.30 and below use the internal cosmos, 1.2.31 and above use a real fetch with the
// authorization headers". On Spotify **1.3.0** that test says `3 >= 2 && 0 < 31` - true - so the
// wrapper falls back to the legacy path that the fetch shim was written to replace, on every
// request, for every track. The version comparison only ever understood 1.2.x.
//
// So this does what the shim does, independent of which branch the version check takes: the same
// URL, the same three headers, and the same treatment of a non-OK response.
// `Spicetify.getAudioData` is still tried first, because when it works it is the supported path.
type CosmosFailure = { code?: number; error?: string; message?: string };

const looksLikeAnalysis = (x: unknown): x is SpotifyAudioAnalysis =>
	!!x && Array.isArray((x as SpotifyAudioAnalysis).segments);

const describeFailure = (x: unknown): string => {
	const f = x as CosmosFailure;
	const detail = [f?.code, f?.error, f?.message].filter(Boolean).join(" ");
	return detail || "the response had no segments";
};

async function fetchAnalysisDirectly(uri: string): Promise<unknown> {
	const id = uri.split(":").pop();
	if (!id) throw new Error("no track id in " + uri);
	const platform = (Spicetify as unknown as {
		Platform?: {
			version?: string;
			PlatformData?: { app_platform?: string };
			AuthorizationAPI?: { getState: () => { token?: { accessToken?: string } } };
		};
	}).Platform;
	const token = platform?.AuthorizationAPI?.getState()?.token?.accessToken;
	if (!token) throw new Error("no access token available");
	const response = await fetch(`https://spclient.wg.spotify.com/audio-attributes/v1/audio-analysis/${id}?format=json`, {
		headers: {
			Authorization: `Bearer ${token}`,
			"Spotify-App-Version": platform?.version ?? "",
			"App-Platform": platform?.PlatformData?.app_platform ?? ""
		}
	});
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

	// Both paths above resolve with an error object rather than rejecting - `{ code, error, message }`
	// is what the wrapper returns for a non-OK response - so the shape is checked before anything
	// reads it. Checked after `buildLoudnessCurve(analysis.segments)` it would only ever report
	// "segments is not iterable", never the real reason.
	const sections: Section[] = Array.isArray(analysis.sections) ? analysis.sections : [];
	const curve = buildLoudnessCurve(analysis.segments);
	normaliseCurve(curve);

	return {
		beats: analysis.beats,
		segments: analysis.segments,
		loudnessCurve: curve,
		tempo: analysis.track.tempo,
		bars: Array.isArray(analysis.bars) ? analysis.bars : [],
		sections,
		moments: findMoments(curve, Array.isArray(analysis.bars) ? analysis.bars : []),
		hitScale: hitScaleOf(analysis.segments),
		tatums: Array.isArray(analysis.tatums) ? analysis.tatums : [],
		hits: await decodeHits((analysis.track as unknown as { rhythmstring?: unknown })?.rhythmstring),
		timbreSorted: sortedTimbre(analysis.segments),
		trackInfo: (analysis.track ?? {}) as unknown as Record<string, unknown>
	};
}

// ---------------------------------------------------------------------------------------------
// Fallback for tracks the analysis has nothing for.
//
// `getAudioData` hits an internal client endpoint - audio-attributes/v1/audio-analysis/{id} - and
// some tracks genuinely 404 there. Its sibling on the same path, audio-features, still answers for
// them: one summary row per track, with Spotify's own measured tempo, loudness and key. (The public
// Web API equivalent is closed to applications and returns a flat 429; this internal one does not.)
//
// That is enough for a real pulse and nothing more. There are no segments, so no attack character,
// no harmonic movement and no verse-versus-chorus dynamics - `loudnessCurve` is flat at the track's
// measured loudness, and it is left flat on purpose. An invented envelope would be a made-up
// heuristic: better a picture that pulses honestly at the right tempo than one that pretends to
// hear a structure it cannot.

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
	// the same two paths, in the same order, for the same reason as the analysis above: a fallback
	// that goes only through `Spicetify.CosmosAsync` fails for the same reason as the thing it falls
	// back from (the version check breaks on Spotify 1.3).
	let body: unknown = null;
	try {
		body = await Spicetify.CosmosAsync.get(url);
	} catch {
		body = null;
	}
	const ok = (x: unknown): x is TrackAudioFeatures => !!x && typeof (x as TrackAudioFeatures).tempo === "number" && (x as TrackAudioFeatures).tempo > 0;
	if (ok(body)) return body;
	const platform = (Spicetify as unknown as {
		Platform?: {
			version?: string;
			PlatformData?: { app_platform?: string };
			AuthorizationAPI?: { getState: () => { token?: { accessToken?: string } } };
		};
	}).Platform;
	const token = platform?.AuthorizationAPI?.getState()?.token?.accessToken;
	if (!token) throw new Error(`no audio features (${describeFailure(body)}; no access token)`);
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${token}`,
			"Spotify-App-Version": platform?.version ?? "",
			"App-Platform": platform?.PlatformData?.app_platform ?? ""
		}
	});
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
