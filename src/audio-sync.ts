// AudioContext.outputLatency is the real gap (seconds) between "queued for playback" and "actually
// audible through the speakers" - Spicetify.Player.getProgress() reports the former, so anything
// driven directly by it runs slightly ahead of what's actually heard. Compensates for it here.
// Adapted from Konsl/spicetify-visualizer's AudioSyncManager (MIT).
export class AudioSync {
	private audioContext: AudioContext;
	private stableLatency = 0;

	constructor() {
		this.audioContext = new AudioContext();

		// an inaudible tone keeps the context from being auto-suspended when idle - a suspended
		// context reports stale/zero outputLatency, which would silently disable the correction
		const oscillator = this.audioContext.createOscillator();
		const gain = this.audioContext.createGain();
		oscillator.frequency.value = 20000;
		gain.gain.value = 0.0001;
		oscillator.connect(gain).connect(this.audioContext.destination);
		oscillator.start();
	}

	getLatencySec(): number {
		const current = this.audioContext.outputLatency;
		// only move if the change is real, not float jitter from frame to frame
		if (Math.abs(this.stableLatency - current) > 0.02) this.stableLatency = current;
		return this.stableLatency;
	}

	dispose() {
		this.audioContext.close();
	}
}

// The player's clock is whole milliseconds. Measured in the client: frames arrive every 4.2 ms
// (a 240 Hz screen) and the track's position steps 4, 4, 4, 5 ms - so a preset that moves by
// `position - lastPosition` moves 20% further on one frame in six than on the others. Under an
// accumulating trail that is invisible; under a camera that redraws the scene every frame it is a
// shiver in everything at once.
//
// So the position a preset is handed is the wall clock's, slewed gently onto the player's: it advances
// by real elapsed time and takes back a twentieth of its error each frame, which follows the player's
// own rate and passes on a fortieth of its rounding. A seek, a pause or a stall is a real
// discontinuity and is taken at once.
export function createSmoothClock() {
	let position = 0;
	let lastWall: number | null = null;
	return (playerSec: number, isPlaying: boolean, wallSec: number): number => {
		if (isPlaying && lastWall !== null) {
			const predicted = position + (wallSec - lastWall);
			const error = playerSec - predicted;
			position = Math.abs(error) > 0.05 ? playerSec : predicted + error * 0.05;
		} else position = playerSec;
		lastWall = wallSec;
		return position;
	};
}
