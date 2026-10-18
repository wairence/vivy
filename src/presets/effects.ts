import { sectionIndexAt, segmentAt, TrackAudioData } from "../audio-data";

type Segment = SpotifyAudioAnalysis["segments"][number];

// a shimmering, iridescent tint for a hit (kick/snare) - rotates the base colour's channels through
// a slowly cycling phase (cheap, no HSL math) and blends it in proportional to `amount`, so each hit
// flashes a slightly different hue instead of one fixed accent colour
export function shimmerPhase(t: number): number {
	return (Math.sin(t * 2.4) + 1) / 2;
}
export function shimmerTint(
	base: { r: number; g: number; b: number },
	phase: number,
	amount: number
): { r: number; g: number; b: number } {
	if (amount < 0.02) return base;
	// callers pass c.pop straight through, which spikes to ~1 on a hard beat - at amount=1 this is a
	// full R/G/B channel swap, not a shimmer, and reads as a glitch flash rather than an iridescent
	// tint. Capping it keeps the hue nudge visible on every hit without ever fully overwriting colour
	const a = Math.min(0.4, amount);
	const rotA = { r: base.b, g: base.r, b: base.g };
	const rotB = { r: base.g, g: base.b, b: base.r };
	return {
		r: base.r + (rotA.r + (rotB.r - rotA.r) * phase - base.r) * a,
		g: base.g + (rotA.g + (rotB.g - rotA.g) * phase - base.g) * a,
		b: base.b + (rotA.b + (rotB.b - rotA.b) * phase - base.b) * a
	};
}

// paints a translucent layer over the whole frame instead of clearing it, so previous
// frames bleed through as fading trails - the canvas equivalent of a TouchDesigner feedback loop.
//
// The fade alone never reaches black, and this is arithmetic rather than tuning. Compositing
// rgba(0,0,0,a) is c -> c*(1-a), rounded back to 8 bits, so a pixel stops moving as soon as
// c*a < 0.5 - at alpha 0.045 that is c = 11, and the whole background settles on a permanent
// 11/255 (4.3%) grey no matter how long you wait. No multiplicative fade can clear it; the step
// has to be one that strictly decreases.
//
// `color-burn` against a near-white is exactly that step. It is 1 - (1 - dst)/src, which leaves
// bright pixels essentially untouched (a mid grey loses ~2%) but collapses anything near black to
// a true zero - 11/255 reaches 0 in three passes - and, once there, holds it at zero rather than
// oscillating. It needs an opaque canvas to behave, which is why the contexts that own a trail are
// created with `{ alpha: false }`; over a transparent backdrop a separable blend mode paints its
// own source colour instead of blending.
let floorTick = 0;

export function fadeTrail(ctx: CanvasRenderingContext2D, width: number, height: number, alpha: number) {
	ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
	ctx.fillRect(0, 0, width, height);

	// every fourth frame keeps the cost off the midtones (~0.5%/frame averaged) while still clearing
	// residue within about a fifth of a second
	if (++floorTick % 4 === 0) {
		ctx.save();
		ctx.globalCompositeOperation = "color-burn";
		ctx.fillStyle = "rgb(250, 250, 250)";
		ctx.fillRect(0, 0, width, height);
		ctx.restore();
	}
}

// smoothed 12-band chroma (pitch class energy) - eases towards the current segment's pitches so
// bands glide across segment boundaries instead of snapping, and holds still while paused.
//
// `rate` is PER SECOND, like every other time constant in this project. It used to be per FRAME -
// a bare `* 0.12` with no dt anywhere in it - which made this the one quantity here that moves at
// a different speed on a different machine: twice as fast on a 120 Hz screen, and slower every
// time a frame is dropped. It is not a decoration either; Layers II turns it into `melodyTilt`,
// which is geometry. 7.2/s reproduces the old 0.12-per-frame exactly at 60 fps.
export function createChromaTracker(rate = 7.2) {
	const bands = new Array<number>(12).fill(0.3);

	return (audio: TrackAudioData | null, progressSec: number, isPlaying: boolean, dt: number): number[] => {
		if (!isPlaying) return bands;
		const segment = audio ? segmentAt(audio.segments, progressSec) : null;
		const step = Math.min(1, rate * dt);

		for (let i = 0; i < 12; i++) {
			// no analysis for this track: a wave travelling across the bands keeps some structure
			const target = segment ? segment.pitches[i] || 0 : Math.sin(progressSec * 0.7 + i * 0.55) * 0.35 + 0.45;
			bands[i] += (target - bands[i]) * step;
		}
		return bands;
	};
}

// fast (~2s) vs slow (~20s) moving averages of energy - the gap between them says whether a section
// is building or settling right now, on a musical timescale rather than a per-frame one. `level` is
// "how loud is this whole stretch on average", `trend` is "rising" (+) or "falling" (-)
export function createEnergyTrend(fastRate = 0.6, slowRate = 0.05) {
	let fast = 0.5;
	let slow = 0.5;
	return (energy: number, dt: number) => {
		fast += (energy - fast) * Math.min(1, fastRate * dt);
		slow += (energy - slow) * Math.min(1, slowRate * dt);
		return { level: slow, trend: fast - slow };
	};
}

export type Ripple = { x: number; y: number; strength: number; held: boolean; reach: number };

// a click sends a real push through the flow, not a decoration drawn on top - `sign` +1 pushes
// outward (left click), -1 pulls inward (right click). `strength` (the amplitude) jumps to full
// instantly on a click so it still feels responsive, and decays to zero on its own once released;
// holding pins it at full and follows the cursor for as long as the button's down. `reach` (how far
// it currently extends) doesn't jump - it LAGS behind strength, chasing it up and back down on its
// own slower timer. That's the whole ripple: because reach trails strength instead of following it
// instantly, the area visibly spreads outward first (reach chasing strength up) and then visibly
// contracts as it fades (reach chasing strength back down) - one simple chase, not two clocks
// fighting over the same value
export function createRippleTracker() {
	const pos: Ripple = { x: 0, y: 0, strength: 0, held: false, reach: 0 };
	const neg: Ripple = { x: 0, y: 0, strength: 0, held: false, reach: 0 };
	const state = (sign: number) => (sign >= 0 ? pos : neg);

	return {
		trigger(x: number, y: number, sign = 1) {
			const s = state(sign);
			s.x = x;
			s.y = y;
			s.strength = 1;
		},
		// call every frame regardless of button state
		paint(x: number, y: number, down: boolean, sign = 1) {
			const s = state(sign);
			s.held = down;
			if (down) {
				s.x = x;
				s.y = y;
				s.strength = 1;
			}
		},
		update(dt: number) {
			const decayPerSec = 1.1; // ~0.9s to fade to nothing once released/clicked
			if (!pos.held) pos.strength = Math.max(0, pos.strength - decayPerSec * dt);
			if (!neg.held) neg.strength = Math.max(0, neg.strength - decayPerSec * dt);
			const chaseRate = 2.6; // ~0.4s to catch up - the visible spread-out/pull-in lag
			pos.reach += (pos.strength - pos.reach) * Math.min(1, chaseRate * dt);
			neg.reach += (neg.strength - neg.reach) * Math.min(1, chaseRate * dt);
		},
		get pos(): Ripple {
			return pos;
		},
		get neg(): Ripple {
			return neg;
		}
	};
}

// the ripple's actual live reach right now - see `reach` above, it's the one already doing all the
// work here
function rippleLiveRadius(r: Ripple, maxRadius: number): number {
	return maxRadius * r.reach;
}

// how hard, and in which direction, the push/pull is affecting the point (px, py) right now. Within
// its live reach it's a plain "closer = stronger" falloff. Bend a particle's angle toward the
// returned direction by `weight` (a lerpAngle fraction), the same bounded-bend treatment as every
// other gesture here - it nudges the flow, it never replaces it
export function rippleInfluence(pos: Ripple, neg: Ripple, px: number, py: number, maxRadius: number) {
	let wx = 0;
	let wy = 0;
	let weight = 0;
	for (const r of [pos, neg]) {
		if (r.strength <= 0.01) continue;
		const sign = r === pos ? 1 : -1;
		const dx = px - r.x;
		const dy = py - r.y;
		const dist = Math.hypot(dx, dy);
		if (dist < 1e-3) continue;
		const liveRadius = rippleLiveRadius(r, maxRadius);
		if (liveRadius <= 1e-3) continue;
		const falloff = Math.max(0, 1 - dist / liveRadius);
		if (falloff <= 0) continue;
		const w = falloff * r.strength * sign;
		wx += (dx / dist) * w;
		wy += (dy / dist) * w;
		weight += Math.abs(w);
	}
	return { angle: Math.atan2(wy, wx), weight: Math.min(1, weight * 1.4) };
}

// how much extra brightness the push/pull should lend to a particle at (px, py) right now - same
// spreading, shrinking-radius falloff as rippleInfluence, as a brightness contribution instead of a
// direction. Only ever lights up a particle that's actually there, never draws a shape of its own
export function rippleGlowAt(pos: Ripple, neg: Ripple, px: number, py: number, maxRadius: number): number {
	let glow = 0;
	for (const r of [pos, neg]) {
		if (r.strength <= 0.01) continue;
		const dist = Math.hypot(px - r.x, py - r.y);
		const liveRadius = rippleLiveRadius(r, maxRadius);
		if (liveRadius <= 1e-3) continue;
		const falloff = Math.max(0, 1 - dist / liveRadius);
		glow += falloff * r.strength;
	}
	return Math.min(1, glow * 1.4);
}

// grows/shrinks an array towards targetCount in place - used to let alt+scroll adjust how many
// particles a preset runs with without rebuilding the whole array from scratch every frame
export function resizeToCount<T>(arr: T[], targetCount: number, spawn: () => T) {
	while (arr.length < targetCount) arr.push(spawn());
	if (arr.length > targetCount) arr.length = targetCount;
}

// crude but cheap local-density estimate: bins positions into a coarse grid once per frame, then
// looks each one back up - O(n) each way, no pairwise distance checks. Lets clustered particles read
// as brighter than lone ones, like light actually accumulating, without an O(n^2) neighbour search
export function createDensityGrid(cols: number, rows: number) {
	const counts = new Uint16Array(cols * rows);
	let width = 1;
	let height = 1;

	const cellIndex = (x: number, y: number) => {
		const cx = Math.min(cols - 1, Math.max(0, Math.floor((x / width) * cols)));
		const cy = Math.min(rows - 1, Math.max(0, Math.floor((y / height) * rows)));
		return cy * cols + cx;
	};

	return {
		begin(w: number, h: number) {
			width = w;
			height = h;
			counts.fill(0);
		},
		add(x: number, y: number) {
			counts[cellIndex(x, y)]++;
		},
		// 0 for a lone occupant of its cell, ramping to 1 by `denseAt` neighbours sharing it.
		//
		// BILINEAR, because a particle crossing a cell border used to see its own density jump by a
		// whole neighbour - a step of 0.25 at the default - and every particle crosses borders
		// constantly. Read straight into a brightness that is the flicker reported as "the layers
		// step". Four cells and two lerps make the field continuous in space, so a particle's
		// reading now changes as smoothly as its position does.
		at(x: number, y: number, denseAt = 5): number {
			const fx = Math.min(cols - 1, Math.max(0, (x / width) * cols - 0.5));
			const fy = Math.min(rows - 1, Math.max(0, (y / height) * rows - 0.5));
			const x0 = Math.floor(fx);
			const y0 = Math.floor(fy);
			const x1 = Math.min(cols - 1, x0 + 1);
			const y1 = Math.min(rows - 1, y0 + 1);
			const tx = fx - x0;
			const ty = fy - y0;
			const top = counts[y0 * cols + x0] * (1 - tx) + counts[y0 * cols + x1] * tx;
			const bottom = counts[y1 * cols + x0] * (1 - tx) + counts[y1 * cols + x1] * tx;
			return Math.max(0, Math.min(1, (top * (1 - ty) + bottom * ty - 1) / (denseAt - 1)));
		}
	};
}

// timbre[1] is roughly "brightness" in Spotify's timbre basis and spans about +-100
export function timbreBrightness(segment: Segment | null): number {
	if (!segment) return 0;
	return Math.max(-1, Math.min(1, (segment.timbre[1] || 0) / 100));
}

// THE HARMONY'S COLOUR: each section of the track has its own key in the analysis, and the palette
// leans off the album's hue by how far that key sits from the track's home key on the circle of
// fifths. In the home key the colour is the album's own. Measured over 105 tracks: a section's key
// differs from the last one 1.6 times a minute, and half of all playing time is away from home - so
// the picture re-tints about as often as the song changes part, and holds still in between.
// (The first version followed the chroma's tonal centre: that wobbled +-15 degrees every second on
// every track measured, which is both invisible and not a statement about the music.)
// The lean at the far side of the circle, in turns of hue, and how fast it may move per second
const HUE_SWING = 0.26;
const HUE_RATE = 0.05;

// the lean the section playing at `t` asks for - what a preset that can see the future draws it in
export function keyHueAt(audio: TrackAudioData | null, t: number): number {
	// (a track without analysis, or a harness, may carry neither sections nor track info)
	const section = audio?.sections ? audio.sections[sectionIndexAt(audio.sections, t)] : undefined;
	const home = audio?.trackInfo?.key;
	if (!section || typeof home !== "number" || !(section.key >= 0) || !(home >= 0)) return 0;
	const fifths = (((section.key - home) * 7) % 12 + 12) % 12;
	const away = fifths > 6 ? fifths - 12 : fifths;
	// the square root, so the nearest key is already a colour you can see
	return Math.sign(away) * Math.sqrt(Math.abs(away) / 6) * HUE_SWING;
}

// returns the lean to add to the album's hue, eased; `on = false` takes it back to none
export function createKeyHue() {
	let shift = 0;
	return (audio: TrackAudioData | null, progressSec: number, dt: number, on = true): number => {
		const target = on ? keyHueAt(audio, progressSec) : 0;
		const step = HUE_RATE * dt;
		shift += Math.max(-step, Math.min(step, target - shift));
		return shift;
	};
}

// THE GLOW over a picture that is redrawn whole every frame: what is already bright, blurred at two
// sizes and added back - a tight core that is steady, and a wide halo whose strength is the caller's
// to drive (it is where an event is SEEN). Both are rendered small: they are blurs, so resolution is
// wasted on them. Never for a canvas that accumulates - that is re-blurring history (DESIGN-RULES §4).
const GLOW_CORE_DIV = 4;
const GLOW_HALO_DIV = 12;

export function createGlow() {
	let core: HTMLCanvasElement | null = null;
	let halo: HTMLCanvasElement | null = null;
	return (ctx: CanvasRenderingContext2D, source: CanvasImageSource, width: number, height: number, scale: number, haloAlpha: number) => {
		if (typeof document === "undefined") return;
		core = core || document.createElement("canvas");
		halo = halo || document.createElement("canvas");
		const cx = core.getContext("2d")!;
		const hx = halo.getContext("2d")!;
		const nw = Math.max(1, Math.ceil(width / GLOW_CORE_DIV));
		const nh = Math.max(1, Math.ceil(height / GLOW_CORE_DIV));
		if (core.width !== nw || core.height !== nh) {
			core.width = nw;
			core.height = nh;
		}
		cx.clearRect(0, 0, nw, nh);
		// contrast is the bright-pass
		cx.filter = `contrast(1.6) brightness(1.2) blur(${Math.max(1, (scale * 0.006) / GLOW_CORE_DIV)}px)`;
		cx.drawImage(source, 0, 0, nw, nh);
		cx.filter = "none";
		const hw = Math.max(1, Math.ceil(width / GLOW_HALO_DIV));
		const hh = Math.max(1, Math.ceil(height / GLOW_HALO_DIV));
		if (halo.width !== hw || halo.height !== hh) {
			halo.width = hw;
			halo.height = hh;
		}
		hx.clearRect(0, 0, hw, hh);
		hx.filter = `blur(${Math.max(1, (scale * 0.03) / GLOW_HALO_DIV)}px) brightness(2.2)`;
		hx.drawImage(core, 0, 0, hw, hh);
		hx.filter = "none";
		ctx.save();
		ctx.globalCompositeOperation = "lighter";
		ctx.globalAlpha = 0.7;
		ctx.drawImage(core, 0, 0, width, height);
		ctx.globalAlpha = Math.min(1, haloAlpha);
		ctx.drawImage(halo, 0, 0, width, height);
		ctx.restore();
	};
}
