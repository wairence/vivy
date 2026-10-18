import { nearestBarStart } from "../../audio-data";
import { Conductor, createConductor } from "../flowfield-common";
import { Preset, PresetDefinition, PresetFrame, rgbString } from "../types";

// An instrument, not a picture. Every other preset turns the conductor's signals into weather, and
// weather is exactly the wrong thing to read a number off: when a chorus lands flat you cannot tell
// whether the signal missed it or the movement swallowed it. This draws the signals themselves,
// against the track's own beats and segments, so "does the system actually react" becomes something
// you look at rather than something you argue about.
//
// It is also the only place the FUTURE is visible. The whole star mechanic depends on `lookAhead`
// reporting the next hit correctly, and until now the only evidence for that was the star turning up
// on time - which is a test of two things at once. The strip at the top draws the hits that have not
// happened yet, with the size and the sharpness the system is reading off them.

const HISTORY_SEC = 6;
const AHEAD_SEC = 2.5;
const FPS_ASSUMED = 60;
const SAMPLES = HISTORY_SEC * FPS_ASSUMED;

type Lane = {
	name: string;
	// 0..1 unless `signed`, in which case -1..1 and the trace is drawn around a centre line
	read: (c: Conductor) => number;
	signed?: boolean;
	hue: number;
};

// Grouped by the question each one answers, because that is how they are read: the first column is
// "what is happening right now", the second is "where are we in the song".
const LANES: Lane[] = [
	{ name: "energy", read: c => c.energy, hue: 0.12 },
	// beside it on purpose: `energy` is the per-segment sawtooth and `loudness` is the same curve
	// through a centred window, and every speed in the picture reads the second one. The instrument
	// had no lane for it at all, which meant the signal that drives all three layers' motion was
	// the one thing that could not be seen here
	{ name: "loudness", read: c => c.loudness, hue: 0.14 },
	{ name: "pop", read: c => c.pop, hue: 0.08 },
	{ name: "strike", read: c => c.strike, hue: 0.04 },
	{ name: "beatStrength", read: c => c.beatStrength, hue: 0.0 },
	{ name: "attackSharp", read: c => c.attackSharpness, hue: 0.95 },
	{ name: "glow", read: c => c.glow, hue: 0.16 },
	{ name: "level", read: c => c.level, hue: 0.45 },
	{ name: "trend", read: c => c.trend, signed: true, hue: 0.5 },
	{ name: "sectionRank", read: c => c.sectionIntensity, hue: 0.55 },
	{ name: "anticipation", read: c => c.anticipation, hue: 0.62 },
	{ name: "impact", read: c => c.impact, hue: 0.68 },
	// the other half of the brace: anticipation takes the light down, windup takes the speed up,
	// and the two are only legible against each other
	{ name: "windup", read: c => c.windup, hue: 0.65 },
	{ name: "harmonicShift", read: c => c.harmonicShift, hue: 0.75 },
	// the hand, both envelopes. One input, a bar and a beat, so that what the two drive stays two
	// things - which is only checkable if both are drawn
	{ name: "baton", read: c => c.baton, hue: 0.85 },
	{ name: "hand", read: c => c.hand, hue: 0.9 }
];

const COLUMNS = 2;

function hue(h: number, light = 0.62): { r: number; g: number; b: number } {
	// small local HSL: the album-colour helper in flowfield-common pulls saturation and lightness
	// into a band that suits a field of particles and would flatten a legend
	const c = (1 - Math.abs(2 * light - 1)) * 0.75;
	const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
	const m = light - c / 2;
	const [r, g, b] =
		h < 1 / 6
			? [c, x, 0]
			: h < 2 / 6
				? [x, c, 0]
				: h < 3 / 6
					? [0, c, x]
					: h < 4 / 6
						? [0, x, c]
						: h < 5 / 6
							? [x, 0, c]
							: [c, 0, x];
	return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

export const signalScopePreset: PresetDefinition = {
	id: "signal-scope",
	name: "Scope",
	create(): Preset {
		const conduct = createConductor();
		const history = LANES.map(() => new Float32Array(SAMPLES));
		let cursor = 0;
		let filled = 0;
		// A replica of the star's rarity test, not a share of it: the gate lives inside the layers
		// preset entangled with per-particle state, and an instrument that called into the mechanic it
		// is meant to be watching would agree with it by construction. Same two lines, kept here
		// deliberately - if they drift apart, that is a thing worth seeing.
		let recentPeak = 0;

		return {
			draw(frame: PresetFrame) {
				const { ctx, width, height, isPlaying, audio, progressSec } = frame;
				if (!isPlaying) return;

				const c = conduct(frame);
				const px = Math.min(width, height) / 90;

				for (let i = 0; i < LANES.length; i++) history[i][cursor] = LANES[i].read(c);
				cursor = (cursor + 1) % SAMPLES;
				filled = Math.min(SAMPLES, filled + 1);

				recentPeak *= Math.pow(0.86, c.dt);
				const nowAmp = c.segment ? Math.pow(10, c.segment.loudness_max / 20) / (audio?.hitScale || 0.56) : 0;
				if (c.strike > 0.05 && nowAmp > recentPeak) recentPeak = nowAmp;

				ctx.fillStyle = "rgb(6, 7, 10)";
				ctx.fillRect(0, 0, width, height);
				ctx.textBaseline = "middle";
				ctx.lineCap = "butt";

				// ---- the strip: what the music is doing, and what it is about to do -------------------
				const stripTop = px * 3;
				const stripHeight = height * 0.24;
				const stripBottom = stripTop + stripHeight;
				const span = HISTORY_SEC + AHEAD_SEC;
				const xAt = (t: number) => px * 12 + ((t - (progressSec - HISTORY_SEC)) / span) * (width - px * 16);
				const nowX = xAt(progressSec);
				// the strip's own right edge. A segment that starts just inside the window still runs its
				// full duration, so without this the last bar every frame is drawn off the canvas
				const stripRight = xAt(progressSec + AHEAD_SEC);

				if (audio && (audio.segments?.length ?? 0) > 0) {
					// every segment in view, as tall as it is loud on this track's own scale. Past ones
					// are filled, future ones outlined - the system has read the outlined ones already
					for (const s of audio.segments ?? []) {
						if (s.start + s.duration < progressSec - HISTORY_SEC) continue;
						if (s.start > progressSec + AHEAD_SEC) break;
						const amp = Math.pow(10, s.loudness_max / 20) / (audio.hitScale || 0.56);
						const h = Math.min(1, amp) * (stripHeight - px * 4);
						const x0 = xAt(s.start);
						// a hair of a gap between segments, or a run of them reads as one solid block and the
						// thing this strip exists to show - how the music is divided up - disappears
						const w = Math.max(1, Math.min(stripRight, xAt(s.start + s.duration)) - x0 - Math.max(1, px * 0.25));
						const future = s.start > progressSec;
						// what the star's gate is looking at: big enough, sharp enough, on a bar line
						const sharp = 1 - s.loudness_max_time / 0.25 > 0.4;
						const near = nearestBarStart(audio.bars ?? [], s.start);
						const onBar = near === null || near.distance < 0.09;
						const qualifies = future && amp > recentPeak && sharp && onBar;
						const tone = qualifies ? hue(0.14, 0.7) : future ? hue(0.55, 0.5) : hue(0.55, 0.32);
						ctx.fillStyle = rgbString(tone, future ? 0.35 : 0.85);
						ctx.fillRect(x0, stripBottom - h, w, h);
						if (qualifies) {
							ctx.fillStyle = rgbString(hue(0.14, 0.8), 0.9);
							ctx.fillRect(x0, stripBottom - h - px * 1.2, w, px * 0.7);
						}
					}

					// the recent peak the next hit has to beat, as a line across the strip
					const peakY = stripBottom - Math.min(1, recentPeak) * (stripHeight - px * 4);
					ctx.strokeStyle = rgbString(hue(0.14, 0.6), 0.5);
					ctx.lineWidth = 1;
					ctx.beginPath();
					ctx.moveTo(xAt(progressSec - HISTORY_SEC), peakY);
					ctx.lineTo(xAt(progressSec + AHEAD_SEC), peakY);
					ctx.stroke();

					for (const b of audio.beats ?? []) {
						if (b.start < progressSec - HISTORY_SEC || b.start > progressSec + AHEAD_SEC) continue;
						ctx.fillStyle = rgbString({ r: 150, g: 160, b: 180 }, 0.55);
						ctx.fillRect(xAt(b.start), stripBottom, Math.max(1, px * 0.12), px * 1.1);
					}
					for (const b of audio.bars ?? []) {
						if (b.start < progressSec - HISTORY_SEC || b.start > progressSec + AHEAD_SEC) continue;
						ctx.fillStyle = rgbString({ r: 210, g: 220, b: 240 }, 0.7);
						ctx.fillRect(xAt(b.start), stripBottom, 1.5, px * 1.8);
					}
					const sections = audio.sections ?? [];
					for (let i = 0; i < sections.length; i++) {
						const s = sections[i];
						if (s.start < progressSec - HISTORY_SEC || s.start > progressSec + AHEAD_SEC) continue;
						ctx.fillStyle = rgbString(hue(0.68, 0.7), 0.8);
						ctx.fillRect(xAt(s.start), stripTop, 1.5, stripHeight + px * 2);
						ctx.font = `${px * 1.2}px ui-monospace, monospace`;
						ctx.fillText(`section ${(audio.sectionIntensity?.[i] ?? 0.5).toFixed(2)}`, xAt(s.start) + px * 0.5, stripTop + px);
					}
				} else {
					ctx.fillStyle = rgbString({ r: 200, g: 120, b: 120 }, 0.9);
					ctx.font = `${px * 2}px ui-monospace, monospace`;
					ctx.fillText("no analysis for this track", px * 12, stripTop + stripHeight / 2);
				}

				// now, and the window that everything to the right of it is a prediction in
				ctx.fillStyle = rgbString({ r: 255, g: 255, b: 255 }, 0.85);
				ctx.fillRect(nowX, stripTop - px, 1.5, stripHeight + px * 3);
				ctx.font = `${px * 1.2}px ui-monospace, monospace`;
				ctx.fillStyle = rgbString({ r: 255, g: 255, b: 255 }, 0.45);
				ctx.fillText("now", nowX + px * 0.6, stripTop - px * 0.6);
				const ahead = c.lookAhead(AHEAD_SEC);
				ctx.fillText(
					ahead === null
						? "lookAhead: nothing within 2.5s"
						: `lookAhead: +${ahead.inSeconds.toFixed(2)}s  power ${ahead.power.toFixed(2)}  sharp ${ahead.sharpness.toFixed(2)}  ${ahead.downbeat ? "on bar" : "off bar"}`,
					px * 12,
					stripBottom + px * 3.4
				);

				// ---- the lanes ------------------------------------------------------------------------
				const laneTop = stripBottom + px * 5;
				const perColumn = Math.ceil(LANES.length / COLUMNS);
				const columnWidth = (width - px * 16) / COLUMNS;
				const laneHeight = (height - laneTop - px * 3) / perColumn;
				// the label gets a band of its own above the trace. Sharing the space meant a signal
				// sitting near its ceiling - beatStrength on a downbeat, say - drew straight through its
				// own readout, which is a nuisance exactly on the frames worth reading
				const labelBand = px * 2.2;
				const traceHeight = laneHeight - labelBand - px * 0.8;

				ctx.font = `${px * 1.4}px ui-monospace, monospace`;
				for (let i = 0; i < LANES.length; i++) {
					const lane = LANES[i];
					const col = Math.floor(i / perColumn);
					const row = i % perColumn;
					const x0 = px * 12 + col * columnWidth;
					const y0 = laneTop + row * laneHeight;
					const base = y0 + labelBand + traceHeight;
					const mid = lane.signed ? base - traceHeight / 2 : base;
					const traceWidth = columnWidth - px * 7;

					ctx.fillStyle = rgbString({ r: 255, g: 255, b: 255 }, 0.06);
					ctx.fillRect(x0, mid, traceWidth, 1);

					const tone = hue(lane.hue);
					const value = lane.read(c);
					ctx.strokeStyle = rgbString(tone, 0.95);
					ctx.lineWidth = Math.max(1, px * 0.12);
					ctx.beginPath();
					for (let k = 0; k < filled; k++) {
						// oldest first: the ring's write cursor is the oldest sample once it has wrapped
						const idx = (cursor - filled + k + SAMPLES * 2) % SAMPLES;
						const v = history[i][idx];
						// pinned to the RIGHT edge, so the newest sample is always in the same place and a
						// half-filled history grows backwards into the lane instead of sitting in a stripe
						// at the left with the present somewhere in the middle of it
						const x = x0 + traceWidth - ((filled - 1 - k) / (SAMPLES - 1)) * traceWidth;
						const y = lane.signed ? mid - v * (traceHeight / 2) : base - Math.max(0, Math.min(1, v)) * traceHeight;
						if (k === 0) ctx.moveTo(x, y);
						else ctx.lineTo(x, y);
					}
					ctx.stroke();

					// name and value on the same line above the trace they belong to, the value right-aligned
					// so the numbers form a column that can be read down rather than hunted for
					const labelY = y0 + labelBand * 0.45;
					ctx.fillStyle = rgbString(tone, 0.6);
					ctx.fillText(lane.name, x0, labelY);
					ctx.textAlign = "right";
					ctx.fillStyle = rgbString({ r: 235, g: 240, b: 250 }, 0.9);
					ctx.fillText(value.toFixed(3), x0 + traceWidth, labelY);
					ctx.textAlign = "left";
				}
			}
		};
	}
};
