import { createNoise3D } from "simplex-noise";
import { createDensityGrid, fadeTrail, resizeToCount } from "../effects";
import { createBloomLayer, createConductor, createGestureLayer, lerpAngle, particleTargetCount } from "../flowfield-common";
import { Preset, PresetDefinition, rgbString } from "../types";

const PARTICLE_COUNT = 1200;
// alt+scroll can push the count up towards this, but never past it - the finite-difference gradient
// here samples noise 8 times per particle, the most expensive per-particle cost in this file
const MAX_PARTICLE_COUNT = 1500;
// long-lived trails: this field never bunches particles up, so the picture stays legible even with
// a lot of history on screen - and long history is the whole point of a laminar smoke look. Still
// asymptotically fades to nothing, just slowly - never a permanent residue
const TRAIL_ALPHA = 0.07;

type FlowParticle = { x: number; y: number; life: number; brightness: number };

// Curl Smoke. The other Flow Fields read a noise value AS an angle, which makes a compressible
// field: it has sources and sinks, so particles pile up along certain lines and thin out elsewhere.
// This one instead treats noise as a scalar stream function (a "potential") and takes the
// perpendicular of its gradient - angle = atan2(-dP/dx, dP/dy). That field is divergence-free by
// construction, exactly like an incompressible fluid: density stays even everywhere, nothing clots,
// and the motion reads as slow rolling smoke rather than as lines snapping onto noise contours.
//
// The potential is a sum of two fixed-frequency octaves. Order/chaos changes their relative
// WEIGHTS, never their frequencies - live-rescaling a noise field's sampling frequency
// discontinuously moves every particle's neighbourhood and makes the picture jump even when the
// parameter driving it is perfectly smooth.
//
// The octave balance also responds to more than the cursor now: `trend`/`level` (a fast-vs-slow
// energy average, see createEnergyTrend) let a building or settling section shift it on its own,
// `wander` keeps it from ever sitting still even through a flat stretch, and repeated flicking
// leaves a slow-decaying `chaosTotal`/`orderTotal` baseline instead of the pulse's effect fully
// evaporating the instant the flick ends - so the resting look isn't the same all song long.
function create(): Preset {
	const noise = createNoise3D();
	let particles: FlowParticle[] = [];
	const bloom = createBloomLayer();
	const conduct = createConductor();
	const gesture = createGestureLayer();
	const density = createDensityGrid(24, 24);
	let fieldTime = 0;

	const spawnRandom = (width: number, height: number): FlowParticle => ({
		x: Math.random() * width,
		y: Math.random() * height,
		life: 0.5 + Math.random() * 0.5,
		brightness: 0.35 + Math.random() * 0.65
	});

	return {
		draw(frame) {
			const { ctx, width, height, isPlaying, colorRgb, mouse } = frame;
			if (!isPlaying) return; // freeze on the last frame instead of fading it to black while paused

			const c = conduct(frame);
			const pctx = bloom.begin(width, height);
			fadeTrail(ctx, width, height, TRAIL_ALPHA);

			resizeToCount(particles, particleTargetCount(mouse, PARTICLE_COUNT, MAX_PARTICLE_COUNT), () =>
				spawnRandom(width, height)
			);

			const scale = c.scale;
			// chaos leans on the fine octave (curling, turbulent eddies), order leans on the coarse one
			// (huge slow rolls). Both octaves are always sampled at their own fixed frequency
			const coarseWeight = 1;
			const fineWeight = Math.max(
				0,
				0.42 + c.trend * 0.6 + (c.level - 0.5) * 0.4 + c.wander * 0.15 + c.chaosTotal * 0.9 - c.orderTotal * 0.38
			);
			// order also lets the pattern hold still long enough to actually read
			fieldTime += (0.05 + c.brightness * 0.13) * Math.max(0.1, 1 + c.chaosTotal * 0.5 - c.orderTotal * 0.85) * c.dt;
			gesture.begin(frame, c, fieldTime);

			// scalar stream function, sampled in field units (canvas px / scale)
			const potential = (fx: number, fy: number) =>
				noise(fx * 1.7, fy * 1.7, fieldTime) * coarseWeight +
				noise(fx * 4.6 + 31, fy * 4.6 + 31, fieldTime * 1.5) * fineWeight;

			const eps = 0.004; // finite-difference step, in field units
			// `c.loudness`, not `c.energy`. The loudness curve is a per-segment attack-decay ramp - it
			// reverses 3.8 times a second - so a speed wired to it accelerates and brakes several times
			// a second all song, which the eye reads as the particles racing rather than as the music
			// being loud (DESIGN-RULES §5a). The centred window keeps the mean and drops only the ripple:
			// verse-to-chorus speed measures the same 1.68x either way. Fixed in Layers 2026-08-29 and
			// here 2026-09-16.
			const baseSpeed = (24 + c.loudness * 58 + c.momentum * 200) * c.speedFader;
			const influenceRadius = scale * 0.32;

			density.begin(width, height);
			for (const p of particles) density.add(p.x, p.y);

			pctx.lineCap = "round";
			for (const p of particles) {
				const fx = p.x / scale;
				const fy = p.y / scale;
				// central differences -> gradient of the potential; the perpendicular of a gradient has
				// zero divergence, which is what keeps the flow incompressible
				const dPdx = potential(fx + eps, fy) - potential(fx - eps, fy);
				const dPdy = potential(fx, fy + eps) - potential(fx, fy - eps);
				let angle = Math.atan2(-dPdx, dPdy);

				const dx = mouse.x - p.x;
				const dy = mouse.y - p.y;
				const dist = Math.hypot(dx, dy);
				const proximity = Math.max(0, 1 - dist / influenceRadius);

				const gustWeight = proximity * Math.min(1, c.gustStrength);
				if (gustWeight > 0.01) angle = lerpAngle(angle, c.gustAngle, gustWeight * 0.4);

				const vortexWeight = proximity * Math.abs(c.yAttraction);
				if (vortexWeight > 0.01) {
					const aim = Math.atan2(dy, dx);
					angle = lerpAngle(angle, c.yAttraction >= 0 ? aim : aim + Math.PI, vortexWeight * 0.3);
				}

				const rip = gesture.bendTowardRipple(angle, p.x, p.y);
				angle = rip.angle;

				const speed = baseSpeed * (1 + gustWeight * Math.min(3, c.gustStrength)) * (1 + rip.weight * 0.5);
				const nx = p.x + Math.cos(angle) * speed * c.dt;
				const ny = p.y + Math.sin(angle) * speed * c.dt;

				pctx.beginPath();
				pctx.moveTo(p.x, p.y);
				pctx.lineTo(nx, ny);
				// brightness is audio + life + local density + a small cursor/ripple glow - all of it
				// only ever lights up a particle that's actually there, never a shape drawn on its own
				const densityFactor = density.at(p.x, p.y);
				const { cursorGlow, rippleGlow } = gesture.glowAt(p.x, p.y, mouse, scale, c.gustStrength);
				pctx.strokeStyle = rgbString(
					gesture.tint(colorRgb, c.pop),
					Math.min(
						1,
						Math.max(
							0,
							(0.16 + densityFactor * 0.32 + cursorGlow * 0.18 + rippleGlow * 0.9 + c.pop * 0.4 + p.brightness * 0.55 * p.life) *
								(1 + c.orderTotal * 0.5 - c.chaosTotal * 0.15)
						)
					)
				);
				pctx.lineWidth = Math.max(0.6, scale * 0.0019 * (0.7 + c.glow) * (1 + c.chaosTotal * 0.9));
				pctx.stroke();

				p.x = nx;
				p.y = ny;
				p.life -= c.dt * 0.12;

				if (p.life <= 0 || p.x < 0 || p.x > width || p.y < 0 || p.y > height)
					Object.assign(p, spawnRandom(width, height));
			}

			bloom.flush(frame, c, 0.012);
		}
	};
}

export const flowFieldCurlPreset: PresetDefinition = { id: "flowfield-curl", name: "Curl Smoke", create };
