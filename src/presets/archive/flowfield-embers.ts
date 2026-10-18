import { createNoise3D } from "simplex-noise";
import { createDensityGrid, fadeTrail, resizeToCount } from "../effects";
import {
	albumHsl,
	createBloomLayer,
	createConductor,
	createGestureLayer,
	hslToRgb,
	lerpAngle,
	particleTargetCount
} from "../flowfield-common";
import { Preset, PresetDefinition, rgbString } from "../types";

const PARTICLE_COUNT = 340;
// each ember builds its own radial gradient every frame - keep the ceiling modest
const MAX_PARTICLE_COUNT = 550;
// slow drift plus a long fade: each ember leaves a soft smudge of where it has been, which is what
// makes 340 dots read as a whole moving volume rather than as 340 separate dots
const TRAIL_ALPHA = 0.045;

type Ember = { x: number; y: number; life: number; size: number; hot: number };

// Embers. No strokes at all - the field is drawn by soft round motes rather than by filaments, so
// what you read is the *density* of the flow instead of its streamlines. Each mote is a small
// filled core with a wider faint halo around it, sized from the current segment's loudness_max, so
// hits swell the whole population briefly instead of flashing it.
//
// The field is layered fBm (three fixed octaves at their own drift rates) rather than one noise
// lookup: large slow eddies with finer curl riding on top, which gives motes a wandering,
// dust-in-a-sunbeam path instead of a clean laminar sweep. Two-tone: on a beat a small random share
// of motes are marked "hot" and fade in over to an accent hue - a colour change and a slight swell
// only, never a velocity kick, because this is a conductor's gesture surface, not a firework.
function create(): Preset {
	const noise = createNoise3D();
	let embers: Ember[] = [];
	const bloom = createBloomLayer();
	const conduct = createConductor();
	const gesture = createGestureLayer();
	const density = createDensityGrid(14, 14);
	let fieldTime = 0;

	const spawnRandom = (width: number, height: number): Ember => ({
		x: Math.random() * width,
		y: Math.random() * height,
		life: 0.4 + Math.random() * 0.6,
		size: 0.45 + Math.random() * 0.55,
		hot: 0
	});

	return {
		draw(frame) {
			const { ctx, width, height, isPlaying, colorRgb, mouse } = frame;
			if (!isPlaying) return;

			const c = conduct(frame);
			const pctx = bloom.begin(width, height);
			fadeTrail(ctx, width, height, TRAIL_ALPHA);

			resizeToCount(embers, particleTargetCount(mouse, PARTICLE_COUNT, MAX_PARTICLE_COUNT), () =>
				spawnRandom(width, height)
			);

			const scale = c.scale;
			fieldTime += (0.05 + c.brightness * 0.11) * Math.max(0.1, 1 + c.chaos * 0.8 - c.order * 0.85) * c.dt;
			gesture.begin(frame, c, fieldTime);

			const base = albumHsl(colorRgb);
			const accent = hslToRgb(base.h + 0.09, Math.min(1, base.s + 0.1), Math.min(0.72, base.l + 0.08));

			// deliberately slow - embers hang in the air, they don't streak
			// `c.loudness`, not `c.energy`. The loudness curve is a per-segment attack-decay ramp - it
			// reverses 3.8 times a second - so a speed wired to it accelerates and brakes several times
			// a second all song, which the eye reads as the particles racing rather than as the music
			// being loud (DESIGN-RULES §5a). The centred window keeps the mean and drops only the ripple:
			// verse-to-chorus speed measures the same 1.68x either way. Fixed in Layers 2026-08-29 and
			// here 2026-09-16.
			const baseSpeed = (10 + c.loudness * 26 + c.momentum * 85) * c.speedFader;
			const influenceRadius = scale * 0.33;
			// segment.loudness_max is a dB value; as linear amplitude it is a direct "how hard is the
			// sound right now" number, which here becomes physical size rather than brightness
			const hitAmp = c.segment ? Math.min(1.2, Math.pow(10, c.segment.loudness_max / 20) * 2.4) : c.energy;
			const coreRadius = scale * 0.0022 * (0.75 + hitAmp * 0.7 + c.glow * 0.5);

			density.begin(width, height);
			for (const e of embers) density.add(e.x, e.y);

			for (const e of embers) {
				const fx = e.x / scale;
				const fy = e.y / scale;
				// three fixed octaves, summed - only their weights ever change, never their frequencies
				const fbm =
					noise(fx * 1.2, fy * 1.2, fieldTime) +
					noise(fx * 3.1 + 17, fy * 3.1 + 17, fieldTime * 1.7) * (0.5 + c.chaos * 0.5 - c.order * 0.25) +
					noise(fx * 7.3 + 91, fy * 7.3 + 91, fieldTime * 2.6) * (0.22 + c.chaos * 0.55 - c.order * 0.18);
				let angle = (fbm / 1.72) * Math.PI * 2;

				const dx = mouse.x - e.x;
				const dy = mouse.y - e.y;
				const dist = Math.hypot(dx, dy);
				const proximity = Math.max(0, 1 - dist / influenceRadius);

				const gustWeight = proximity * Math.min(1, c.gustStrength);
				if (gustWeight > 0.01) angle = lerpAngle(angle, c.gustAngle, gustWeight * 0.4);

				const vortexWeight = proximity * Math.abs(c.yAttraction);
				if (vortexWeight > 0.01) {
					const aim = Math.atan2(dy, dx);
					angle = lerpAngle(angle, c.yAttraction >= 0 ? aim : aim + Math.PI, vortexWeight * 0.3);
				}

				const rip = gesture.bendTowardRipple(angle, e.x, e.y);
				angle = rip.angle;

				const speed = baseSpeed * (1 + gustWeight * Math.min(3, c.gustStrength) * 1.4) * (1 + rip.weight * 0.5);
				e.x += Math.cos(angle) * speed * c.dt;
				e.y += Math.sin(angle) * speed * c.dt;
				e.life -= c.dt * 0.09;

				if (c.beatHit && Math.random() < 0.14) e.hot = 1;
				e.hot *= Math.pow(0.12, c.dt); // eases back to the base colour over roughly a second

				const hotTint =
					e.hot > 0.01
						? {
								r: colorRgb.r + (accent.r - colorRgb.r) * e.hot,
								g: colorRgb.g + (accent.g - colorRgb.g) * e.hot,
								b: colorRgb.b + (accent.b - colorRgb.b) * e.hot
							}
						: colorRgb;
				const tint = gesture.tint(hotTint, c.pop);
				const radius = Math.max(0.5, coreRadius * e.size * (1 + e.hot * 0.45));
				// lone embers dimmer than before, clustered (or cursor/ripple-lit) ones brighter - a real
				// accumulation of light on the embers themselves, never a shape drawn on its own
				const densityFactor = density.at(e.x, e.y);
				const { cursorGlow, rippleGlow } = gesture.glowAt(e.x, e.y, mouse, scale, c.gustStrength);
				const alpha = Math.min(
					1,
					Math.max(
						0,
						(0.2 + densityFactor * 0.28 + cursorGlow * 0.18 + rippleGlow * 0.9 + c.pop * 0.4 + c.glow * 0.4) *
							(0.35 + e.life * 0.65) *
							(1 + c.order * 0.35 - c.chaos * 0.15)
					)
				);

				// a real radial gradient falloff instead of two flat-alpha circles - a filled circle has
				// a hard cutoff at its edge (visible as a cheap-looking disc no matter how faint), a
				// gradient actually fades continuously to nothing
				const haloRadius = radius * 2.6;
				const glowGradient = pctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, haloRadius);
				glowGradient.addColorStop(0, rgbString(tint, alpha));
				glowGradient.addColorStop(0.32, rgbString(tint, alpha * 0.55));
				glowGradient.addColorStop(1, rgbString(tint, 0));
				pctx.fillStyle = glowGradient;
				pctx.beginPath();
				pctx.arc(e.x, e.y, haloRadius, 0, Math.PI * 2);
				pctx.fill();

				if (e.life <= 0 || e.x < 0 || e.x > width || e.y < 0 || e.y > height) Object.assign(e, spawnRandom(width, height));
			}

			bloom.flush(frame, c, 0.014);
		}
	};
}

export const flowFieldEmbersPreset: PresetDefinition = { id: "flowfield-embers", name: "Embers", create };
