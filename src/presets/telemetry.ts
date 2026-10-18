// Dev-only diagnostic recorder. Gesture tuning on Flow Field has gone through many blind rounds -
// I can't see the live client or watch the user's mouse, so every fix has been a guess from a
// verbal description. This records exactly what happened - mouse input, every audio-derived signal,
// and a summary of what the particles actually did - so a session can be replayed and analyzed
// after the fact instead of guessed at again.
export type TelemetryFrame = {
	t: number;
	mouseX: number;
	mouseY: number;
	mouseDown: boolean;
	mouseRightDown: boolean;
	gustAngle: number;
	gustStrength: number;
	energy: number;
	momentum: number;
	pop: number;
	chaos: number;
	order: number;
	trend: number;
	level: number;
	brightness: number; // timbre-derived spectral brightness
	loudnessMax: number | null; // current segment's loudness_max, dB
	pitches: number[] | null; // current segment's 12-band chroma - the closest thing we have to "loudness by frequency"
	// per-preset extras, e.g. sweepAngle/spread/angleCoherence for Aurora
	extra: Record<string, number>;
};

export function createTelemetryRecorder(maxFrames = 3600) {
	let frames: TelemetryFrame[] = [];
	let recording = false;

	return {
		get recording() {
			return recording;
		},
		get frameCount() {
			return frames.length;
		},
		start() {
			recording = true;
			frames = [];
		},
		stop() {
			recording = false;
		},
		record(frame: TelemetryFrame) {
			if (!recording) return;
			frames.push(frame);
			if (frames.length > maxFrames) frames.shift();
		},
		// triggers a real file download (standard browser Blob + <a download>, no special
		// permissions needed) - lands in the OS's default Downloads folder
		export(label: string) {
			const blob = new Blob([JSON.stringify(frames)], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `flowfield-telemetry-${label}-${Date.now()}.json`;
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
			return frames.length;
		}
	};
}

// circular variance of a set of angles, 0..1 - 0 means every particle is pointed the same way
// (coherent), close to 1 means they're pointing in totally random directions (scattered). This is
// the direct, measurable version of "particles get pushed apart" / "no ripple itself" complaints
export function angleCoherence(angles: number[]): number {
	if (angles.length === 0) return 0;
	let sx = 0;
	let sy = 0;
	for (const a of angles) {
		sx += Math.cos(a);
		sy += Math.sin(a);
	}
	const meanResultantLength = Math.hypot(sx, sy) / angles.length; // 1 = all aligned, 0 = uniform random
	return 1 - meanResultantLength;
}
