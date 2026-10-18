interface SpotifyAudioAnalysis {
	track: { tempo: number; duration: number };
	beats: { start: number; duration: number; confidence: number }[];
	// The endpoint has always returned these; they were simply never declared, so the whole timeline
	// structure - which beat starts a bar, where the sections are and how loud each one is - arrived
	// with every track and was thrown away. Optional because a track can legitimately lack them.
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
		// documented by the public Web API, never checked against what the internal endpoint sends -
		// which is the point of dumping it
		confidence?: number;
	}[];
}
