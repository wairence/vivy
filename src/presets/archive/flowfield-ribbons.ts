import { createNoise3D } from "simplex-noise";
import { createDensityGrid, fadeTrail, resizeToCount } from "../effects";
import { createBloomLayer, createConductor, createGestureLayer, lerpAngle, particleTargetCount } from "../flowfield-common";
import { Preset, PresetDefinition, rgbString } from "../types";

const RIBBON_COUNT = 120;
// each ribbon redraws up to 30 segments every frame, so the ceiling stays tight
const MAX_RIBBON_COUNT = 180;
const TRAIL_POINTS = 30;
// the canvas accumulation here is only a faint bed of haze behind the ribbons, which draw their own
// bodies every frame and don't need it to stay connected - still faster than the hairline presets'
const TRAIL_ALPHA = 0.21;

type Ribbon = { x: number; y: number; hist: number[]; life: number; width: number };

// Ribbons. Every other Flow Field draws a one-frame line segment and relies on the canvas fade to
// glue consecutive segments into something that reads as a continuous stroke - which means the look
// lives or dies on fade-vs-speed tuning, and goes to disconnected dots the moment either drifts.
//
// EXPERIMENT (deliberately bending the "tune the trail fade" lesson, flagged as such): here each
// ribbon keeps its own short position history and redraws itself every frame as a single tapered
// polyline - thick and bright at the head, thinning to nothing at the tail. Connectivity is then a
// property of the geometry rather than of the fade timing, so it cannot break; the fade is kept
// only as a soft residue behind the ribbons. Far fewer, far bolder elements than the ~900 hairline
// filaments of the originals: this is calligraphy, not smoke.
function create(): Preset {
	const noise = createNoise3D();
	let ribbons: Ribbon[] = [];
	const bloom = createBloomLayer();
	const conduct = createConductor();
	const gesture = createGestureLayer();
	const density = createDensityGrid(8, 8);
	let fieldTime = 0;

	const spawnRandom = (width: number, height: number): Ribbon => ({
		x: Math.random() * width,
		y: Math.random() * height,
		hist: [],
		life: 0.6 + Math.random() * 0.4,
		width: 0.5 + Math.random() * 0.5
	});

	return {
		draw(frame) {
			const { ctx, width, height, isPlaying, colorRgb, mouse } = frame;
			if (!isPlaying) return;

			const c = conduct(frame);
			const pctx = bloom.begin(width, height);
			fadeTrail(ctx, width, height, TRAIL_ALPHA);

			resizeToCount(ribbons, particleTargetCount(mouse, RIBBON_COUNT, MAX_RIBBON_COUNT), () =>
				spawnRandom(width, height)
			);

			const scale = c.scale;
			fieldTime += (0.05 + c.brightness * 0.12) * Math.max(0.1, 1 + c.chaos * 0.7 - c.order * 0.85) * c.dt;
			gesture.begin(frame, c, fieldTime);
			const shimmerColor = gesture.tint(colorRgb, c.pop);

			// ribbons are long, so they need real travel per frame or the polyline collapses on itself
			// `c.loudness`, not `c.energy`. The loudness curve is a per-segment attack-decay ramp - it
			// reverses 3.8 times a second - so a speed wired to it accelerates and brakes several times
			// a second all song, which the eye reads as the particles racing rather than as the music
			// being loud (DESIGN-RULES §5a). The centred window keeps the mean and drops only the ripple:
			// verse-to-chorus speed measures the same 1.68x either way. Fixed in Layers 2026-08-29 and
			// here 2026-09-16.
			const baseSpeed = (55 + c.loudness * 90 + c.momentum * 220) * c.speedFader;
			const influenceRadius = scale * 0.34;
			const headWidth = scale * 0.011 * (0.55 + c.glow * 0.9);

			density.begin(width, height);
			for (const r of ribbons) density.add(r.x, r.y);

			pctx.lineCap = "round";
			for (const r of ribbons) {
				const fieldAngle = noise((r.x / scale) * 1.9, (r.y / scale) * 1.9, fieldTime) * Math.PI * 2;

				let angle = fieldAngle;
				if (c.chaos > 0.01) {
					// a second, independently sampled but still spatially coherent field - never
					// per-particle randomness, which reads as flickery static rather than a smear
					const turbulence = noise((r.x / scale) * 7 + 500, (r.y / scale) * 7 + 500, fieldTime * 2.2) * Math.PI * 2;
					angle = lerpAngle(angle, turbulence, c.chaos * 0.8);
				}

				const dx = mouse.x - r.x;
				const dy = mouse.y - r.y;
				const dist = Math.hypot(dx, dy);
				const proximity = Math.max(0, 1 - dist / influenceRadius);

				const gustWeight = proximity * Math.min(1, c.gustStrength);
				if (gustWeight > 0.01) angle = lerpAngle(angle, c.gustAngle, gustWeight * 0.4);

				const vortexWeight = proximity * Math.abs(c.yAttraction);
				if (vortexWeight > 0.01) {
					const aim = Math.atan2(dy, dx);
					angle = lerpAngle(angle, c.yAttraction >= 0 ? aim : aim + Math.PI, vortexWeight * 0.3);
				}

				const rip = gesture.bendTowardRipple(angle, r.x, r.y);
				angle = rip.angle;

				const speed = baseSpeed * (1 + gustWeight * Math.min(3, c.gustStrength) * 0.8) * (1 + rip.weight * 0.5);
				r.x += Math.cos(angle) * speed * c.dt;
				r.y += Math.sin(angle) * speed * c.dt;
				r.life -= c.dt * 0.1;

				r.hist.push(r.x, r.y);
				if (r.hist.length > TRAIL_POINTS * 2) r.hist.splice(0, r.hist.length - TRAIL_POINTS * 2);

				const points = r.hist.length / 2;
				// lone ribbons dimmer than before, ones overlapping others (or near the cursor/ripple) brighter
				const densityFactor = density.at(r.x, r.y);
				const { cursorGlow, rippleGlow } = gesture.glowAt(r.x, r.y, mouse, scale, c.gustStrength);
				const alpha = Math.min(
					1,
					Math.max(
						0,
						(0.16 + densityFactor * 0.28 + cursorGlow * 0.16 + rippleGlow * 0.85 + c.pop * 0.4 + r.life * 0.4) *
							(1 + c.order * 0.35 - c.chaos * 0.15)
					)
				);
				for (let i = 1; i < points; i++) {
					// t: 0 at the tail, 1 at the head - drives both the taper and the fade-out
					const t = i / (points - 1);
					pctx.beginPath();
					pctx.moveTo(r.hist[(i - 1) * 2], r.hist[(i - 1) * 2 + 1]);
					pctx.lineTo(r.hist[i * 2], r.hist[i * 2 + 1]);
					pctx.lineWidth = Math.max(0.5, headWidth * r.width * Math.pow(t, 0.85));
					pctx.strokeStyle = rgbString(shimmerColor, alpha * Math.pow(t, 1.4));
					pctx.stroke();
				}

				if (r.life <= 0 || r.x < -scale * 0.1 || r.x > width + scale * 0.1 || r.y < -scale * 0.1 || r.y > height + scale * 0.1)
					Object.assign(r, spawnRandom(width, height));
			}

			bloom.flush(frame, c, 0.008);
		}
	};
}

export const flowFieldRibbonsPreset: PresetDefinition = { id: "flowfield-ribbons", name: "Ribbons", create };
