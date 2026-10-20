// outputLatency is the gap between queued and audible; Player.getProgress() reports the former.
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

// The player's clock is whole milliseconds (position steps 4, 4, 4, 5 ms at 240 Hz), so `position - last` shivers.
// The wall clock is slewed onto the player's (a twentieth of the error per frame); a seek, pause or stall is taken at once.
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
