import { fadeTrail } from "../effects";
import { albumHsl, createBloomLayer, createConductor, hslToRgb } from "../flowfield-common";
import { Preset, PresetDefinition, PresetFrame, rgbString } from "../types";

// The simple one. Every other preset here is a flow field: hundreds of particles whose individual
// behaviour has to be inferred from the shape of the crowd. That is what makes them beautiful and
// also what makes them impossible to read - when a chorus lands flat you cannot say whether the
// music was missed or the crowd absorbed it.
//
// This has one mapping and it is visible: **one hit, one ring.** A core that breathes with how loud
// this stretch of the song is, rings leaving it on the beats, thicker and further for a bigger hit,
// and the whole thing pulling in and going dark before a drop so the drop has somewhere to arrive.
// Nothing is inferred and nothing is random.
//
// It reads no gesture signals at all - not the cursor, not the ripples, not chaos/order. The base is
// the product, and the conductor's gesture half is being reworked; a preset built on it now would
// have to be rebuilt with it.

const RING_MAX = 56;
// Long, because rings are the only geometry here: the wake they leave IS the texture, and a short
// trail turns concentric rings into separate hard circles with black between them.
const TRAIL_ALPHA = 0.055;
// how far a ring gets, as a fraction of the half-diagonal. Over 1 so a big one leaves the frame
// rather than stopping politely at the corner
const REACH = 1.15;
// a ring's rise, as a fraction of its life. Nothing appears at full strength (DESIGN-RULES §5c),
// but a ring is an impact, so its rise is short enough to still read as one
const RING_RISE = 0.07;
// how far above a typical recent hit one has to reach to get the bigger ring. Same test the drum
// layer's middle rank uses, and for the same reason: measured against a decaying peak instead,
// almost every hit qualifies and the rank stops meaning anything
const RANK_OVER = 1.12;

type Ring = {
	// seconds lived, and how long it gets. Dead rings sit in the pool with age >= life
	age: number;
	life: number;
	// the hit that made it, over the track's own scale for a big hit
	power: number;
	// 0 ordinary, 1 the bigger rank, 2 a section boundary
	rank: number;
	// radius it left the core at, so it never appears out of nothing in the middle of the screen
	born: number;
};

function create(): Preset {
	const conduct = createConductor();
	const bloom = createBloomLayer();
	const rings: Ring[] = [];
	for (let i = 0; i < RING_MAX; i++) rings.push({ age: 1, life: 1, power: 0, rank: 0, born: 0 });
	let next = 0;
	// what a hit sounds like around here, updated once per hit rather than once per frame
	let hitAverage = 0;
	let wasStriking = false;
	// the core's radius is a state, not a formula: it eases towards what the music asks for so a
	// section boundary is a swell rather than a step
	let core = 0;
	let coreLight = 0;
	let lastImpact = 0;

	const emit = (power: number, rank: number, born: number, life: number) => {
		const ring = rings[next];
		next = (next + 1) % RING_MAX;
		ring.age = 0;
		ring.life = life;
		ring.power = power;
		ring.rank = rank;
		ring.born = born;
	};

	return {
		draw(frame: PresetFrame) {
			const { ctx, width, height, isPlaying, colorRgb, audio } = frame;
			if (!isPlaying) return;

			const c = conduct(frame);
			const scale = c.scale;
			const reach = REACH * 0.5 * Math.hypot(width, height);
			const cx = width / 2;
			const cy = height / 2;

			const pctx = bloom.begin(width, height);
			fadeTrail(ctx, width, height, TRAIL_ALPHA);

			// ---- what the music is doing --------------------------------------------------------------
			const hitAmp = c.segment ? Math.pow(10, c.segment.loudness_max / 20) / (audio?.hitScale || 0.56) : c.energy;
			const striking = c.strike > 0.05;
			// the rising edge only: `strike` stays above the threshold for several frames, and one hit
			// has to mean one ring or a long segment emits a smear of them
			const hitNow = striking && !wasStriking;
			wasStriking = striking;
			if (hitNow) hitAverage += (hitAmp - hitAverage) * 0.2;

			// pulling in before a boundary, and thrown out at it. The brace is the whole reason this
			// reads as music rather than as a metronome: a drop that arrives out of a steady pulse is
			// just another ring, and one that arrives out of a contraction is an event
			const brace = Math.max(c.anticipation, Math.max(0, Math.min(1, -c.trend * 7)) * 0.5);
			const release = Math.max(c.impact, c.pop * 0.35);

			// ---- the core -----------------------------------------------------------------------------
			// how big this part of the song is, held as size. sectionIntensity rather than energy: size
			// is a structural statement and should not twitch on every beat
			const coreTarget =
				scale * (0.055 + c.level * 0.075 + c.sectionIntensity * 0.05 + c.energy * 0.03) * (1 - brace * 0.35);
			core += (coreTarget - core) * Math.min(1, 2.6 * c.dt);
			const coreLightTarget = (0.22 + c.glow * 0.45 + c.level * 0.5 + c.sectionIntensity * 0.4) * (1 - brace * 0.55);
			coreLight += (coreLightTarget - coreLight) * Math.min(1, (coreLightTarget > coreLight ? 7 : 2.5) * c.dt);

			const base = albumHsl(colorRgb);
			// a chorus is a different colour from a verse, by a hair. Enough that the eye notices the
			// section changed without it becoming a different visualiser
			const hue = base.h + c.sectionIntensity * 0.06 + c.harmonicShift * 0.04;
			const bodyRgb = hslToRgb(hue, base.s, base.l);
			const hotRgb = hslToRgb(hue + 0.05, Math.min(1, base.s + 0.12), Math.min(0.78, base.l + 0.16));

			// drawn as a soft disc: a hard-edged circle in the middle of the screen is a logo, and a
			// gradient that fades to nothing at its rim is a source of light
			const glowRadius = Math.max(1, core * (1.6 + release * 0.5));
			// The core is the one thing here drawn in the SAME place every frame, and the trail canvas
			// keeps what is drawn on it: a steady contribution settles at contribution/fade, eighteen
			// times its per-frame value at this fade. So it is painted at a fraction and allowed to
			// accumulate to strength - which also gives it a soft two-tenths-of-a-second attack for
			// free. The rings need no such thing: each is only ever at a given radius for one frame.
			const held = 7 * TRAIL_ALPHA;
			const grad = pctx.createRadialGradient(cx, cy, 0, cx, cy, glowRadius);
			grad.addColorStop(0, rgbString(hotRgb, Math.min(0.95, coreLight + release * 0.35) * held));
			grad.addColorStop(0.45, rgbString(bodyRgb, Math.min(0.8, coreLight * 0.7) * held));
			grad.addColorStop(1, rgbString(bodyRgb, 0));
			pctx.fillStyle = grad;
			pctx.beginPath();
			pctx.arc(cx, cy, glowRadius, 0, Math.PI * 2);
			pctx.fill();

			// ---- rings ---------------------------------------------------------------------------------
			if (hitNow) {
				// The rank rides the same hit rather than firing a ring of its own: two rings leaving
				// together read as one thick smudge, not as a hit and an emphasis.
				const standout = hitAverage > 1e-3 && hitAmp > hitAverage * RANK_OVER;
				// Held down under the brace, and that is the point of the brace: a run-up that keeps
				// ticking out full-size rings is a run-up nobody can see coming. Scaled rather than
				// skipped - dropping hits at random would break the one thing this preset promises,
				// that every hit is a ring, and at two hits a second the gaps would read as stutter.
				emit(Math.min(1.4, hitAmp) * (1 - brace * 0.75), standout ? 1 : 0, core, standout ? 2.6 : 1.8);
			}
			// the boundary itself: one ring, wider and longer-lived than any beat can make, leaving
			// from the core's own edge at the instant the section changes
			if (c.impact > 0.25 && lastImpact <= 0.25) emit(1.3, 2, core, 3.4);
			lastImpact = c.impact;

			for (const ring of rings) {
				if (ring.age >= ring.life) continue;
				ring.age += c.dt;
				const u = Math.min(1, ring.age / ring.life);
				// decelerating: a ring leaves fast and coasts, which is what an expanding shell of sound
				// looks like and, unlike a constant rate, gives the eye something to follow
				const eased = 1 - Math.pow(1 - u, 2.2);
				const radius = ring.born + eased * reach * (0.55 + ring.power * 0.35 + ring.rank * 0.12);
				if (radius <= 0) continue;
				const rise = Math.min(1, u / RING_RISE);
				const grow = rise * rise * (3 - 2 * rise);
				const fade = Math.pow(1 - u, 1.7);
				const alpha = Math.min(0.9, grow * fade * (0.16 + ring.power * 0.4 + ring.rank * 0.22));
				if (alpha < 0.004) continue;
				pctx.strokeStyle = rgbString(ring.rank > 0 ? hotRgb : bodyRgb, alpha);
				pctx.lineWidth = Math.max(
					0.8,
					scale * 0.0035 * (0.3 + ring.power * 0.9 + ring.rank * 0.55) * (0.3 + 0.7 * fade)
				);
				pctx.beginPath();
				pctx.arc(cx, cy, radius, 0, Math.PI * 2);
				pctx.stroke();
			}

			bloom.flush(frame, c, 0.014);
		}
	};
}

export const pulsePreset: PresetDefinition = {
	id: "pulse",
	name: "Pulse",
	create
};
