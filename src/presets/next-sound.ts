// The sound about to happen, read from the analysis timeline so marks can be lit before it.
import { rankOf, TrackAudioData } from "../audio-data";

export type NextSound = {
	// true on one frame per sound, `lead` seconds before it
	fired: boolean;
	// amplitude over this track's big-hit scale; deliberately unclamped
	amp: number;
	// dull against ringing, ranked within the track (timbre[1])
	ringing: number;
	// seconds for its light to rise, from loudness_max_time
	rise: number;
	// seconds it holds, bounded to 0.4-1.6 beats
	decay: number;
	// 0 for a slow swell, 1 for an attack that peaks at once
	sharp: number;
	// 0 for a vowel, 1 for a full-spectrum crack: rhythm bands lit at its onset
	breadth: number;
	// how far ahead it is answered, s
	lead: number;
	// louder than a running average of recent hits
	standout: boolean;
};

const STANDOUT_OVER = 1.1;

export function createNextSound() {
	let nextSeg = 0;
	let lastScan = -1;
	let lastStart: number | null = null;
	let average = 0;

	// `beat` in seconds; `fallbackAmp` is reported without analysis
	return (audio: TrackAudioData | null, progressSec: number, beat: number, fallbackAmp: number): NextSound => {
		const segs = audio?.segments;
		if (segs && segs.length > 0) {
			// binary search after a seek, otherwise walk forward
			if (progressSec < lastScan || progressSec - lastScan > 0.5) {
				let lo = 0;
				let hi = segs.length - 1;
				while (lo < hi) {
					const mid = (lo + hi) >> 1;
					if (segs[mid].start < progressSec) lo = mid + 1;
					else hi = mid;
				}
				nextSeg = lo;
			}
			lastScan = progressSec;
			while (nextSeg < segs.length && segs[nextSeg].start < progressSec - 0.02) nextSeg++;
		}
		const coming = segs && nextSeg < segs.length ? segs[nextSeg] : null;
		const amp = coming ? Math.pow(10, coming.loudness_max / 20) / (audio?.hitScale || 0.56) : fallbackAmp;
		const ringing = coming && audio ? rankOf(audio.timbreSorted, coming.timbre[1]) : 0.5;

		let rise = 0.06;
		let decay = 0.22;
		let sharp = 0.6;
		let breadth = 0;
		if (coming && audio && audio.hits && audio.hits.length > 0) {
			const h = audio.hits;
			let lo = 0;
			let hi = h.length - 1;
			while (lo < hi) {
				const mid = Math.ceil((lo + hi) / 2);
				if (h[mid].t <= coming.start + 0.06) lo = mid;
				else hi = mid - 1;
			}
			if (Math.abs(h[lo].t - coming.start) < 0.07) breadth = (h[lo].bands - 3) / 5;
		}
		if (coming && segs) {
			const after = segs[nextSeg + 1];
			const fall = after ? coming.loudness_max - after.loudness_start : 8;
			sharp = 1 - Math.min(1, coming.loudness_max_time / 0.12);
			rise = Math.max(0.05, Math.min(0.55, coming.loudness_max_time * 2.4 + 0.04));
			decay = Math.max(beat * 0.4, Math.min(beat * 1.6, 3.4 / Math.max(3, fall)));
		}
		const lead = Math.min(0.4, rise * 0.9);

		const standout = average > 1e-3 && amp > average * STANDOUT_OVER;
		const fired = coming !== null && coming.start !== lastStart && coming.start - progressSec <= lead;
		if (fired && coming) {
			lastStart = coming.start;
			average += (amp - average) * 0.2;
		}
		return { fired, amp, ringing, rise, decay, sharp, breadth, lead, standout };
	};
}
