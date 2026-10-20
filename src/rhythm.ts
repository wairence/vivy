// `track.rhythmstring`: zlib-deflated URL-safe base64 of `sampleRate hopSize bandCount (count delta delta ...) x bandCount`,
// the audio's own onsets (8 bands, 11025 Hz, hop 32). No single band is a hit detector; a hit is where 3 or more bands
// agree within CLUSTER_SEC (docs/DATA.md 2.5).

export type Hit = {
	t: number;
	// bands that fired together, 3..8: the size of the hit itself, not of the segment it falls in
	bands: number;
};

// onsets of different bands within this window are one hit
const CLUSTER_SEC = 0.025;
const MIN_BANDS = 3;

function base64ToBytes(text: string): Uint8Array {
	const normalised = text.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(normalised);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

// platform DecompressionStream, so no inflate dependency; a missing one yields no hits
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
		// no DecompressionStream, or a malformed string
		return [];
	}
}
