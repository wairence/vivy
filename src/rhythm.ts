// `track.rhythmstring` - the only part of the analysis that describes the audio's own onsets rather
// than a grid fitted over them. zlib-deflated, URL-safe base64, and it decodes to plain text:
//
//     sampleRate hopSize bandCount  (count delta delta delta ...) x bandCount
//
// Each band is a list of frame-index deltas, so a running sum times hop/sampleRate gives the times.
// Eight bands at 11025 Hz with a 32-sample hop - 2.9ms resolution.
//
// It is not a drum track. Measured across 81 dumps, every band's own event rate is pinned near 3
// per second whatever the tempo or the music is doing, so no single band can be a hit detector.
// What is usable is where the bands agree: a real drum is broadband and lights several at once,
// while a band's own steady chatter does not line up with the others. Nothing rate-limits the
// agreement, so it follows the music.
//
// Measured against the beat grid, +-50ms, 81 tracks, median:
//
//     a segment-based detector (sharp, prominent)   28% precision   51% beat recall   3.5/s
//     >= 3 bands agreeing                           44%             63%               3.1/s
//     >= 4 bands agreeing                           49%             43%               1.8/s
//
// Three bands beats the segment-based detector on precision, recall and downbeat recall at a
// slightly lower rate, so that is the threshold. (Precision is
// measured against beats because that is the only annotation the analysis carries; a genuine
// off-beat drum counts against it, so 44% is a floor, not the true figure.)

export type Hit = {
	t: number;
	// how many of the eight bands fired together, 3..8. A broadband hit is a kick or a snare; a
	// thin one is a hat or a pick. This is the only measure of a hit's size that comes from the
	// onset itself rather than from the segment it happens to fall in
	bands: number;
};

// how far apart two bands' onsets can be and still be the same hit. One frame of video is 16ms and
// the analysis resolves 2.9ms, so this is generous by design: bands do not agree to the sample
const CLUSTER_SEC = 0.025;
const MIN_BANDS = 3;

function base64ToBytes(text: string): Uint8Array {
	const normalised = text.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(normalised);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

// DecompressionStream is a platform feature (Chrome 80+, and this runs inside Spotify's Electron),
// so there is no inflate implementation in this project and no dependency for one. If it is ever
// missing the caller falls back to the segment-based detector rather than failing.
async function inflate(bytes: Uint8Array): Promise<string> {
	const stream = new (window as unknown as { DecompressionStream: new (format: string) => unknown }).DecompressionStream(
		"deflate"
	);
	const response = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream as ReadableWritablePair));
	return response.text();
}

function clustersOf(bands: number[][]): Hit[] {
	const all: { t: number; b: number }[] = [];
	for (let b = 0; b < bands.length; b++) for (const t of bands[b]) all.push({ t, b });
	all.sort((x, y) => x.t - y.t);

	const hits: Hit[] = [];
	let i = 0;
	while (i < all.length) {
		let j = i;
		let mask = 0;
		let sum = 0;
		// everything within one cluster window of the first onset, so a long roll breaks into
		// separate hits instead of merging into one wide smear
		while (j < all.length && all[j].t - all[i].t <= CLUSTER_SEC) {
			mask |= 1 << all[j].b;
			sum += all[j].t;
			j++;
		}
		let count = 0;
		for (let b = 0; b < bands.length; b++) if (mask & (1 << b)) count++;
		if (count >= MIN_BANDS) hits.push({ t: sum / (j - i), bands: count });
		// a cluster that qualified consumes its onsets; one that did not gives up only its first, so
		// a hit whose bands straggle in is still found from the next onset along
		i = count >= MIN_BANDS ? j : i + 1;
	}
	return hits;
}

export async function decodeHits(rhythmstring: unknown): Promise<Hit[]> {
	if (typeof rhythmstring !== "string" || rhythmstring.length < 16) return [];
	try {
		const text = await inflate(base64ToBytes(rhythmstring));
		const v = text.trim().split(/\s+/);
		if (v.length < 4) return [];
		const sampleRate = Number(v[0]);
		const hop = Number(v[1]);
		const bandCount = Number(v[2]);
		if (!(sampleRate > 0) || !(hop > 0) || !(bandCount > 0) || bandCount > 64) return [];

		const perSecond = hop / sampleRate;
		const bands: number[][] = [];
		let i = 3;
		for (let b = 0; b < bandCount; b++) {
			const n = Number(v[i++]);
			if (!Number.isFinite(n) || n < 0 || i + n > v.length) return [];
			const times: number[] = [];
			let frame = 0;
			for (let k = 0; k < n; k++) {
				frame += Number(v[i++]);
				times.push(frame * perSecond);
			}
			bands.push(times);
		}
		return clustersOf(bands);
	} catch {
		// no DecompressionStream, or the string was not what we think it is
		return [];
	}
}
