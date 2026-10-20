interface SpotifyAudioAnalysis {
	track: { tempo: number; duration: number };
	beats: { start: number; duration: number; confidence: number }[];
	// optional: a track can lack them
	bars?: { start: number; duration: number; confidence: number }[];
	tatums?: { start: number; duration: number; confidence: number }[];
	sections?: {
		start: number;
		duration: number;
		confidence: number;
		loudness: number;
		tempo: number;
		key: number;
		mode: number;
		time_signature: number;
	}[];
	segments: {
		start: number;
		duration: number;
		loudness_start: number;
		loudness_max: number;
		loudness_max_time: number;
		loudness_end: number;
		pitches: number[];
		timbre: number[];
		// from the public Web API docs, not verified against the internal endpoint
		confidence?: number;
	}[];
}
