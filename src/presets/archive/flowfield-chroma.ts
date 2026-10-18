import { createNoise3D } from "simplex-noise";
import { createChromaTracker, createDensityGrid, fadeTrail, resizeToCount } from "../effects";
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

const PARTICLE_COUNT = 950;
// the 12-zone loop runs per particle, so the ceiling stays a bit tighter than the simpler presets
const MAX_PARTICLE_COUNT = 1300;
const TRAIL_ALPHA = 0.09;

type FlowParticle = { x: number; y: number; life: number; brightness: number };

// Chroma Bloom. The field itself is built out of the music's harmony instead of out of noise alone:
// twelve zones sit on a ring, one per pitch class, and each one bends the flow into a slow orbit
// around itself with a strength equal to that pitch's current energy (segment.pitches[12], real
// Spotify analysis). So a track sitting on one chord grows two or three persistent gyres, and a
// key change visibly re-shapes where the eddies are, over a couple of seconds.
//
// Zones bend, they never attract: all twelve tangential directions are summed as vectors and
// applied as ONE bounded angle lerp, so no zone can ever win outright and pull particles into a
// clot. Colour is spatial too - a stroke is tinted by a continuous blend of every zone touching it,
// spread around the extracted album hue rather than replacing it.
function create(): Preset {
	const noise = createNoise3D();
	const chroma = createChromaTracker(5.4);
	let particles: FlowParticle[] = [];
	const bloom = createBloomLayer();
	const conduct = createConductor();
	const gesture = createGestureLayer();
	const density = createDensityGrid(22, 22);
	let fieldTime = 0;
	// a real "key/chord change" event: which pitch zone has been dominant, and for how long the
	// current leader has held that spot (hysteresis, so noisy per-segment pitches don't flicker it)
	let dominantZone = -1;
	let candidateZone = -1;
	let candidateTime = 0;
	let keyChangeFlash = 0;

	// per-frame scratch: the twelve zone positions and their tint, rebuilt each frame
	const zoneX = new Array<number>(12).fill(0);
	const zoneY = new Array<number>(12).fill(0);
	const zoneTint = Array.from({ length: 12 }, () => ({ r: 255, g: 255, b: 255 }));

	const spawnRandom = (width: number, height: number): FlowParticle => ({
		x: Math.random() * width,
		y: Math.random() * height,
		life: 0.5 + Math.random() * 0.5,
		brightness: 0.3 + Math.random() * 0.7
	});

	return {
		draw(frame) {
			const { ctx, width, height, progressSec, isPlaying, audio, colorRgb, mouse } = frame;
			if (!isPlaying) return;

			const c = conduct(frame);
			const pctx = bloom.begin(width, height);
			fadeTrail(ctx, width, height, TRAIL_ALPHA);

			resizeToCount(particles, particleTargetCount(mouse, PARTICLE_COUNT, MAX_PARTICLE_COUNT), () =>
				spawnRandom(width, height)
			);

			const scale = c.scale;
			fieldTime += (0.04 + c.brightness * 0.12) * Math.max(0.1, 1 + c.chaosTotal * 0.8 - c.orderTotal * 0.85 + c.wander * 0.1) * c.dt;
			gesture.begin(frame, c, fieldTime);

			const bands = chroma(audio, progressSec, isPlaying, c.dt);

			// which pitch is leading right now, and has it been leading long enough to count as a
			// real change rather than one noisy segment
			let leadIdx = 0;
			let leadVal = -1;
			for (let i = 0; i < 12; i++) {
				if (bands[i] > leadVal) {
					leadVal = bands[i];
					leadIdx = i;
				}
			}
			if (leadIdx === candidateZone) candidateTime += c.dt;
			else {
				candidateZone = leadIdx;
				candidateTime = 0;
			}
			if (candidateTime > 1.5 && candidateZone !== dominantZone) {
				if (dominantZone !== -1) keyChangeFlash = 1; // skip the flash on the very first lock-in
				dominantZone = candidateZone;
			}
			keyChangeFlash *= Math.pow(0.15, c.dt); // a graceful ~2s swell, not a snap
			const base = albumHsl(colorRgb);
			const cx = width / 2;
			const cy = height / 2;
			// breathes with how loud this whole stretch has been, and widens briefly on a real key change
			const ringRadius = scale * 0.36 * (0.85 + c.level * 0.3) * (1 + keyChangeFlash * 0.18);
						// rotates very slowly so the gyres drift instead of being nailed to the screen - a building
			// section speeds the drift up a little, a settling one slows it, never quite to a stop
			const ringPhase = fieldTime * Math.max(0.12, 0.35 + c.trend * 0.6);
			for (let i = 0; i < 12; i++) {
				const a = (i / 12) * Math.PI * 2 + ringPhase;
				zoneX[i] = cx + Math.cos(a) * ringRadius;
				zoneY[i] = cy + Math.sin(a) * ringRadius;
				// hue spread around the album colour: a fifth of the wheel total, centred on it - a key change
				// nudges the spread and lifts the lightness for its brief sweep
				zoneTint[i] = hslToRgb(
					base.h + ((i / 12) - 0.5) * 0.2 + keyChangeFlash * 0.05,
					base.s,
					Math.min(0.85, base.l + keyChangeFlash * 0.15)
				);
			}

			const zoneRadius = scale * 0.3;
			// `c.loudness`, not `c.energy`. The loudness curve is a per-segment attack-decay ramp - it
			// reverses 3.8 times a second - so a speed wired to it accelerates and brakes several times
			// a second all song, which the eye reads as the particles racing rather than as the music
			// being loud (DESIGN-RULES §5a). The centred window keeps the mean and drops only the ripple:
			// verse-to-chorus speed measures the same 1.68x either way. Fixed in Layers 2026-08-29 and
			// here 2026-09-16.
			const baseSpeed = (16 + c.loudness * 46 + c.momentum * 180) * c.speedFader;
			const influenceRadius = scale * 0.3;

			density.begin(width, height);
			for (const p of particles) density.add(p.x, p.y);

			pctx.lineCap = "round";
			for (const p of particles) {
				// a calm low-frequency noise bed - the harmony provides the structure, this only keeps
				// the space between the gyres alive
				let angle = noise((p.x / scale) * 1.4, (p.y / scale) * 1.4, fieldTime) * Math.PI * 2;

				// sum every zone's tangential (orbiting) direction as vectors, then bend once
				let sx = 0;
				let sy = 0;
				let total = 0;
				// continuous colour blend across every zone touching this particle, weighted by
				// influence - picking a single "nearest" zone snapped hard the instant two zones'
				// weights crossed over, which read as an abrupt colour jump rather than a transition
				let tr = 0;
				let tg = 0;
				let tb = 0;
				for (let i = 0; i < 12; i++) {
					const dzx = p.x - zoneX[i];
					const dzy = p.y - zoneY[i];
					const d = Math.hypot(dzx, dzy);
					if (d > zoneRadius || d < 1e-3) continue;
					const w = (1 - d / zoneRadius) * (bands[i] || 0);
					if (w <= 0) continue;
					// perpendicular to the zone->particle vector: an orbit, not a target
					sx += (-dzy / d) * w;
					sy += (dzx / d) * w;
					total += w;
					tr += zoneTint[i].r * w;
					tg += zoneTint[i].g * w;
					tb += zoneTint[i].b * w;
				}
				if (total > 0.01) {
					// bounded well under 1: the gyres curve the flow, they never own it
					angle = lerpAngle(angle, Math.atan2(sy, sx), Math.min(0.45, total * 0.7));
				}

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
				// blended tint from every zone touching this particle, falling back to the plain album
				// colour where none reach - continuous, not a snap between one zone and the next
				const tint = total > 0.01 ? { r: tr / total, g: tg / total, b: tb / total } : colorRgb;
				const densityFactor = density.at(p.x, p.y);
				const { cursorGlow, rippleGlow } = gesture.glowAt(p.x, p.y, mouse, scale, c.gustStrength);
				pctx.strokeStyle = rgbString(
					gesture.tint(tint, c.pop),
					Math.min(
						1,
						Math.max(
							0,
							(0.15 + densityFactor * 0.3 + cursorGlow * 0.18 + rippleGlow * 0.9 + c.pop * 0.4 + p.brightness * 0.62 * p.life) *
								(1 + c.orderTotal * 0.4 - c.chaosTotal * 0.2)
						)
					)
				);
				pctx.lineWidth = Math.max(0.6, scale * 0.002 * (0.6 + c.glow) * (1 + c.chaosTotal * 1.2 - c.orderTotal * 0.25));
				pctx.stroke();

				p.x = nx;
				p.y = ny;
				p.life -= c.dt * 0.15;

				if (p.life <= 0 || p.x < 0 || p.x > width || p.y < 0 || p.y > height)
					Object.assign(p, spawnRandom(width, height));
			}

			bloom.flush(frame, c, 0.01);
		}
	};
}

export const flowFieldChromaPreset: PresetDefinition = { id: "flowfield-chroma", name: "Chroma Bloom", create };
