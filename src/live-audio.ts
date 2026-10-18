import { TrackAudioData } from "./audio-data";

// Live analysis of whatever the computer is playing, shaped as the exact same TrackAudioData the
// Spotify path produces - beats, segments, a loudness curve - only grown one frame at a time
// instead of arriving precomputed. That is the whole trick here: the conductor and all eight
// presets read that structure and nothing else, so none of them need to know the audio is now
// coming from a movie instead of from a track with a known future.
//
// What is genuinely lost is the future. ARCHITECTURE §1 lists "the whole track's structure is known
// in advance" as the reason the motion can anticipate rather than react; live, there is nothing to
// anticipate with. Everything here is causal and therefore slightly behind the sound, by about one
// analysis window (~85 ms).

type Segment = SpotifyAudioAnalysis["segments"][number];

const FFT_SIZE = 4096; // ~85ms at 48kHz - long enough to resolve low notes into distinct semitones
const CHROMA_LO = 65; // C2. Below this the bins are wider than the semitones they would separate
const CHROMA_HI = 5000;
// how much history to keep. The binary-search lookups in audio-data.ts do not care that the arrays
// are trimmed from the front, and nothing ever asks about a time that old
const KEEP_SEGMENTS = 400;
const KEEP_BEATS = 400;
const KEEP_CURVE = 1200;

const MIN_ONSET_GAP = 0.07; // two onsets closer than this are one event
const MIN_BEAT_GAP = 0.22; // ~270bpm ceiling
const FLUX_WINDOW = 43; // ~0.7s of flux history for the adaptive threshold

export type LiveAnalyser = {
	audio: TrackAudioData;
	/** seconds on the audio clock - pass as PresetFrame.progressSec */
	now: () => number;
	/** call once per rendered frame, before drawing */
	update: () => void;
	/** 0..1 per pitch class, for anything that wants colour from harmony */
	chroma: Float32Array;
	/** true while the stream is actually carrying sound */
	live: boolean;
	stop: () => void;
};

export function createLiveAnalyser(stream: MediaStream): LiveAnalyser {
	const audioCtx = new AudioContext();
	const source = audioCtx.createMediaStreamSource(stream);
	const analyser = audioCtx.createAnalyser();
	analyser.fftSize = FFT_SIZE;
	// a little smoothing on the spectrum, none on the level: the spectrum feeds chroma and centroid
	// where jitter is noise, while the level feeds onset detection where jitter is the signal
	analyser.smoothingTimeConstant = 0.5;
	source.connect(analyser);
	// deliberately NOT connected to audioCtx.destination - this is a tap, and routing it onward
	// would play the system's own audio back through it

	const bins = analyser.frequencyBinCount;
	const spectrumDb = new Float32Array(bins);
	const samples = new Float32Array(analyser.fftSize);
	const prevMagnitude = new Float32Array(bins);
	const chroma = new Float32Array(12);

	// bin -> pitch class, worked out once
	const binPitchClass = new Int8Array(bins);
	const binHz = new Float32Array(bins);
	for (let i = 0; i < bins; i++) {
		const hz = (i * audioCtx.sampleRate) / analyser.fftSize;
		binHz[i] = hz;
		binPitchClass[i] =
			hz >= CHROMA_LO && hz <= CHROMA_HI ? ((Math.round(69 + 12 * Math.log2(hz / 440)) % 12) + 12) % 12 : -1;
	}

	const beats: TrackAudioData["beats"] = [];
	const segments: Segment[] = [];
	const loudnessCurve: { t: number; y: number }[] = [];
	// no bars and no sections: a live tap hears the present only, and both of those describe
	// structure that is only knowable from the whole track at once
	const audio: TrackAudioData = { beats, segments, loudnessCurve, tempo: 120, bars: [], sections: [], sectionIntensity: [], moments: [], hitScale: 0.56, tatums: [], hits: [], timbreSorted: [], trackInfo: {} };

	const fluxHistory: number[] = [];
	let lastOnset = -1;
	let lastBeat = -1;
	let open: Segment | null = null;
	let openPeakDb = -60;
	let live = false;
	// Slow auto-gain. Spotify reports absolute loudness; a live tap reports whatever the Windows
	// volume slider left, and RMS additionally sits 10-14dB under the peak-ish loudness_max the
	// presets were tuned against. Without this the whole thing would render a permanent quiet
	// passage whenever the system volume was low - and the preset tuning now leans hard on energy.
	// A decaying recent peak is mapped to roughly -7dB, which makes the picture depend on the music
	// rather than on the volume knob.
	let peakDb = -30;
	let lastT = -1;

	const push = <T>(arr: T[], item: T, keep: number) => {
		arr.push(item);
		if (arr.length > keep) arr.splice(0, arr.length - keep);
	};

	function update() {
		const t = audioCtx.currentTime;
		analyser.getFloatFrequencyData(spectrumDb);
		analyser.getFloatTimeDomainData(samples);

		// ---- level ------------------------------------------------------------------------------
		// RMS in dB, then the same dB -> linear amplitude conversion buildLoudnessCurve uses on
		// Spotify's numbers, so `energy` lands on the scale every preset was tuned against rather
		// than on some other 0..1 of its own
		let sumSquares = 0;
		for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
		const rms = Math.sqrt(sumSquares / samples.length);
		const rawDb = Math.max(-90, Math.min(0, 20 * Math.log10(Math.max(rms, 1e-7))));
		live = rawDb > -55;

		const dt = lastT < 0 ? 0 : Math.max(0, Math.min(0.25, t - lastT));
		lastT = t;
		// rises instantly to a new peak and falls only 0.25dB/s. Deliberately slower than the
		// structure it must not flatten: this exists to cancel the volume slider, not the music, and
		// a faster decay would re-normalise a long quiet passage back up to bright within half a
		// minute - undoing exactly the drop-vs-interlude range the presets were opened up for.
		// Floored so silence cannot wind the gain up and start amplifying hiss
		peakDb = Math.max(rawDb, Math.max(-30, peakDb - 0.25 * dt));
		const gain = Math.max(0, Math.min(24, -7 - peakDb));
		const db = Math.max(-60, Math.min(0, rawDb + gain));

		push(loudnessCurve, { t, y: Math.pow(10, db / 20) }, KEEP_CURVE);

		// ---- spectrum, chroma, brightness --------------------------------------------------------
		let flux = 0;
		let centroidNum = 0;
		let centroidDen = 0;
		chroma.fill(0);
		for (let i = 0; i < bins; i++) {
			const mag = Math.pow(10, spectrumDb[i] / 20);
			// spectral flux: only the RISES count. An onset is energy appearing, and counting the
			// falls as well would let a note ending look exactly like a note starting
			const rise = mag - prevMagnitude[i];
			if (rise > 0) flux += rise;
			prevMagnitude[i] = mag;

			const pc = binPitchClass[i];
			if (pc >= 0) chroma[pc] += mag;
			centroidNum += binHz[i] * mag;
			centroidDen += mag;
		}
		let chromaMax = 0;
		for (let i = 0; i < 12; i++) if (chroma[i] > chromaMax) chromaMax = chroma[i];
		if (chromaMax > 0) for (let i = 0; i < 12; i++) chroma[i] /= chromaMax; // Spotify normalises to peak 1

		const centroidHz = centroidDen > 1e-9 ? centroidNum / centroidDen : 500;
		// Spotify's timbre[1] spans about +-100 and reads as spectral brightness; only that one
		// coefficient is ever used (effects.ts/timbreBrightness), so only that one is reproduced.
		// Log-scaled, because pitch and brightness are both perceived logarithmically
		const brightness = Math.max(-100, Math.min(100, (Math.log2(centroidHz / 900) / 2.6) * 100));

		// ---- onsets -> segments ------------------------------------------------------------------
		fluxHistory.push(flux);
		if (fluxHistory.length > FLUX_WINDOW) fluxHistory.shift();
		const fluxMean = fluxHistory.reduce((s, x) => s + x, 0) / fluxHistory.length;
		// adaptive, because there is no fixed loudness a "hit" happens at - a quiet dialogue scene
		// and a loud mix need the same relative sensitivity
		const threshold = fluxMean * 1.6 + 1e-4;
		const isOnset = live && flux > threshold && t - lastOnset > MIN_ONSET_GAP;

		if (open) {
			if (db > openPeakDb) openPeakDb = db;
			open.duration = Math.max(0.02, t - open.start);
			open.loudness_max = openPeakDb;
			open.loudness_end = db;
		}

		if (isOnset) {
			lastOnset = t;
			// How percussive this attack is, measured rather than assumed: a transient dumps a lot of
			// flux relative to the level that was already there, a swell barely any. The conductor
			// reads attack character out of `loudness_max_time` (§4.6), so the measurement is encoded
			// back into that field - 0 means "peaked instantly", 0.25 means "took a quarter second"
			const sharpness = Math.max(0, Math.min(1, flux / (threshold * 2.2)));
			const segment: Segment = {
				start: t,
				duration: 0.05,
				loudness_start: db - 6,
				loudness_max: db,
				loudness_max_time: (1 - sharpness) * 0.25,
				loudness_end: db,
				pitches: Array.from(chroma),
				timbre: [Math.max(0, db + 60), brightness, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
			};
			// the scale a hit is measured against, kept as a slowly-decaying peak. Offline this is the
			// track's 98th percentile, which a live tap cannot know: it hears the present only, so it
			// learns the loudest thing it has heard lately and forgets it over roughly a minute.
			audio.hitScale = Math.max(0.02, audio.hitScale * 0.99, Math.pow(10, db / 20) * 0.9);
			push(segments, segment, KEEP_SEGMENTS);
			open = segment;
			openPeakDb = db;

			// the strong onsets are the beats. No tempo tracking: a film has hits without a pulse,
			// and the conductor already degrades gracefully when beats are sparse or absent
			if (flux > threshold * 1.9 && t - lastBeat > MIN_BEAT_GAP) {
				push(beats, { start: t, duration: Math.min(2, t - lastBeat), confidence: Math.min(1, flux / (threshold * 3)) }, KEEP_BEATS);
				lastBeat = t;
			}
		}
	}

	return {
		audio,
		now: () => audioCtx.currentTime,
		update,
		chroma,
		get live() {
			return live;
		},
		stop: () => {
			stream.getTracks().forEach(track => track.stop());
			void audioCtx.close();
		}
	};
}
