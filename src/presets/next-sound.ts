// The sound that is about to happen, and everything the analysis knows about it.
//
// Not the one happening: the one about to. A mark peaks some time after it is lit and an event is
// read at its peak, so the response has to start early; the analysis is a timeline, so the next
// segment is already in memory with its loudness, its attack and how far it falls. Every preset that
// puts one mark on screen per sound reads it from here, so they all answer the same sounds the same way.
import { rankOf, TrackAudioData } from "../audio-data";

export type NextSound = {
	// true on exactly one frame per sound, `lead` seconds before it, so a response that needs that
	// long to reach full strength lands on the sound
	fired: boolean;
	// its amplitude over what a big hit is on THIS track - unclamped, a per-track scale and never a
	// constant: loudness is a property of the mastering
	amp: number;
	// dull against ringing, ranked within the track (timbre[1]) - the nearest honest thing to a register
	ringing: number;
	// how long its light should take to rise, s - from loudness_max_time, never under three frames
	rise: number;
	// how long it holds, s - short if it is gone before the next sound, long if it rings under it.
	// Bounded in beats: a fifth of one to a beat and a half
	decay: number;
	// 0 for a slow swell, 1 for an attack that peaks at once
	sharp: number;
	// 0 for a vowel, 1 for a full-spectrum crack - how many rhythm bands its onset lit
	breadth: number;
	// how far ahead it is answered, s
	lead: number;
	// louder than a running average of the hits around here - a property of the sound, not of a bar line
	standout: boolean;
};

// how far above a typical recent hit one has to reach to stand out
const STANDOUT_OVER = 1.1;

export function createNextSound() {
	let nextSeg = 0;
	let lastScan = -1;
	let lastStart: number | null = null;
	// what a hit sounds like around here, updated once per sound
	let average = 0;

	// `beat` is this track's beat in seconds; `fallbackAmp` is what to report when there is no analysis
	return (audio: TrackAudioData | null, progressSec: number, beat: number, fallbackAmp: number): NextSound => {
		const segs = audio?.segments;
		if (segs && segs.length > 0) {
			// a seek, or the first frame: binary search. Otherwise walk forward
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

		// judged against the average before this sound joins it
		const standout = average > 1e-3 && amp > average * STANDOUT_OVER;
		const fired = coming !== null && coming.start !== lastStart && coming.start - progressSec <= lead;
		if (fired && coming) {
			lastStart = coming.start;
			average += (amp - average) * 0.2;
		}
		return { fired, amp, ringing, rise, decay, sharp, breadth, lead, standout };
	};
}
