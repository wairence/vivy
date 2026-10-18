import { createNoise3D } from "simplex-noise";
import { createDensityGrid, fadeTrail, resizeToCount } from "../effects";
import { createBloomLayer, createConductor, createGestureLayer, lerpAngle, particleTargetCount } from "../flowfield-common";
import { Preset, PresetDefinition, rgbString } from "../types";

const PARTICLE_COUNT = 900;
const MAX_PARTICLE_COUNT = 1400;
// slower fade than the original Flow Field - segments need to overlap into visible connected
// lines instead of fading before the next one lands next to it and reading as separate dots
const TRAIL_ALPHA = 0.1;

type FlowParticle = { x: number; y: number; life: number; brightness: number };

// second take on Flow Field. The first version's mouse/gesture handling computed a separate
// direction vector per particle (pull-toward-cursor, gust, repel) and blended it in as its own
// share of the particle's motion - technically smooth, but it reads as "each particle individually
// steered toward a target", which shows up as particles clustering into dots around the cursor
// instead of flowing lines. Here every influence (vortex, gust, chaos/order) is instead a bounded
// *bend* applied to the field's own noise-driven angle - the particle never stops following the
// field, gestures just curve it locally. Same DJ-deck control surface as before: cursor never
// spawns anything, only bends the existing flow.
function create(): Preset {
	const noise = createNoise3D();
	let particles: FlowParticle[] = [];
	const bloom = createBloomLayer();
	let curlTime = 0;

	const spawn = (x: number, y: number): FlowParticle => ({
		x,
		y,
		life: 0.5 + Math.random() * 0.5,
		brightness: 0.3 + Math.random() * 0.7
	});
	const spawnRandom = (width: number, height: number) => spawn(Math.random() * width, Math.random() * height);

	const conduct = createConductor();
	const gesture = createGestureLayer();
	const density = createDensityGrid(22, 22);

	return {
		draw(frame) {
			const { ctx, width, height, isPlaying, colorRgb, mouse } = frame;
			if (!isPlaying) return;

			const pctx = bloom.begin(width, height);
			fadeTrail(ctx, width, height, TRAIL_ALPHA);

			resizeToCount(particles, particleTargetCount(mouse, PARTICLE_COUNT, MAX_PARTICLE_COUNT), () =>
				spawnRandom(width, height)
			);

			const c = conduct(frame);
			const scale = c.scale;
			// a bit brisker at idle than the original - short segments at low speed are exactly what
			// reads as disconnected dots once the trail has faded a touch
			const idleSpeed = 14;
			// `c.loudness`, not `c.energy`. The loudness curve is a per-segment attack-decay ramp - it
			// reverses 3.8 times a second - so a speed wired to it accelerates and brakes several times
			// a second all song, which the eye reads as the particles racing rather than as the music
			// being loud (DESIGN-RULES §5a). The centred window keeps the mean and drops only the ripple:
			// verse-to-chorus speed measures the same 1.68x either way. Fixed in Layers 2026-08-29 and
			// here 2026-09-16.
			const baseSpeed = (idleSpeed + c.loudness * 50 + c.momentum * 200) * c.speedFader;
			const mouseInfluenceRadius = scale * 0.3;

			// order slows the field's own churn almost to a stop, so its swirl pattern holds still
			// long enough to actually read as a clear line; chaos speeds it up a little on top of the
			// turbulence blend below. Deliberately reads the raw pulses, not chaosTotal/orderTotal - no
			// baseline persistence here, unlike the other presets
			const curlRateMod = Math.max(0.08, 1 + c.chaos * 0.6 - c.order * 0.88);
			curlTime += (0.04 + c.brightness * 0.14) * curlRateMod * c.dt;
			gesture.begin(frame, c, curlTime);

			density.begin(width, height);
			for (const p of particles) density.add(p.x, p.y);

			pctx.lineCap = "round";
			for (const p of particles) {
				const fieldAngle = noise((p.x / scale) * 2.2, (p.y / scale) * 2.2, curlTime) * Math.PI * 2;

				const dx = mouse.x - p.x;
				const dy = mouse.y - p.y;
				const dist = Math.hypot(dx, dy);
				const proximity = Math.max(0, 1 - dist / mouseInfluenceRadius);

				// bend towards a second, higher-frequency but still coherent noise layer - a real
				// different field blended in, not per-particle randomness, so it stays organic even
				// as it gets busier
				let angle = fieldAngle;
				if (c.chaos > 0.01) {
					const turbulenceAngle = noise((p.x / scale) * 8 + 500, (p.y / scale) * 8 + 500, curlTime * 2.2) * Math.PI * 2;
					angle = lerpAngle(angle, turbulenceAngle, c.chaos * 0.85);
				}

				// bend towards the swipe direction, tapering with distance from the cursor - never
				// overrides the field outright, at most a firm nudge
				const gustWeight = proximity * Math.min(1, c.gustStrength);
				if (gustWeight > 0.01) angle = lerpAngle(angle, c.gustAngle, gustWeight * 0.4);

				// bend towards (attract) or away from (repel) the cursor - same bounded-bend
				// treatment, so particles curve past/around it like a vortex instead of converging
				// into a point
				const vortexWeight = proximity * Math.abs(c.yAttraction);
				if (vortexWeight > 0.01) {
					const aimAngle = Math.atan2(dy, dx);
					const vortexTarget = c.yAttraction >= 0 ? aimAngle : aimAngle + Math.PI;
					angle = lerpAngle(angle, vortexTarget, vortexWeight * 0.3);
				}

				// a click's push/pull: a real bend applied to nearby particles, not a decoration drawn on top
				const rip = gesture.bendTowardRipple(angle, p.x, p.y);
				angle = rip.angle;

				const speed = baseSpeed * (1 + gustWeight * Math.min(3, c.gustStrength) * 1) * (1 + rip.weight * 0.5);
				const nx = p.x + Math.cos(angle) * speed * c.dt;
				const ny = p.y + Math.sin(angle) * speed * c.dt;

				pctx.beginPath();
				pctx.moveTo(p.x, p.y);
				pctx.lineTo(nx, ny);
				// order: clean, bright, sharp lines. chaos: hazier and thicker, reads as a smear
				// lone particles are dimmer than before, clustered (or cursor/ripple-lit) ones brighter -
				// light reads as actually accumulating on the particles themselves, never a shape drawn
				// on its own regardless of whether a particle is even there
				const densityFactor = density.at(p.x, p.y);
				const { cursorGlow, rippleGlow } = gesture.glowAt(p.x, p.y, mouse, scale, c.gustStrength);
				pctx.strokeStyle = rgbString(
					gesture.tint(colorRgb, c.pop),
					// brightness comes from audio + density + a small cursor/ripple glow, never raw
					// gesture weights - those compound with the bloom blur into a hot blob that sticks
					// out right at the cursor
					Math.min(
						1,
						(0.14 + densityFactor * 0.3 + cursorGlow * 0.18 + rippleGlow * 0.9 + c.pop * 0.4 + p.brightness * 0.6 * p.life) *
							(1 + c.order * 0.4 - c.chaos * 0.2)
					)
				);
				pctx.lineWidth = Math.max(1, scale * 0.0022 * (0.6 + c.glow) * (1 + c.chaos * 1.6 - c.order * 0.25));
				pctx.stroke();

				p.x = nx;
				p.y = ny;
				p.life -= c.dt * 0.15;

				if (p.life <= 0 || p.x < 0 || p.x > width || p.y < 0 || p.y > height)
					Object.assign(p, spawnRandom(width, height));
			}

			bloom.flush(frame, c);
		}
	};
}

export const flowField2Preset: PresetDefinition = { id: "flowfield2", name: "Flow Field 2", create };
