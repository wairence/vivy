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
import { angleCoherence, createTelemetryRecorder } from "../telemetry";
import { Preset, PresetDefinition, rgbString } from "../types";

const PARTICLE_COUNT = 700;
const MAX_PARTICLE_COUNT = 1000;
const TRAIL_ALPHA = 0.05;
const HUE_STEPS = 24; // hue lookup, rebuilt once per frame instead of per particle

type FlowParticle = { x: number; y: number; life: number; brightness: number };

// ctrl+click toggles recording mouse/audio/field state to a JSON file for offline analysis - a
// custom event dispatched from app.tsx's own mousedown handler (a keydown-based shortcut risked
// getting eaten by Electron's native menu-accelerator system before reaching page JS at all).
// Module-level, not inside create() - create() reruns every time the tab is switched to Aurora, and
// a listener registered in there would leak a fresh duplicate on every visit with nothing ever
// removing the old ones, so ctrl+click could fire several stale listeners at once and export
// whichever one happened to still be sitting empty. This way there's exactly one, for the module's
// whole lifetime. Guarded so the headless check harness (no real DOM events, no Spicetify global)
// can't trip on it
const telemetry = createTelemetryRecorder();
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
	window.addEventListener("flowfield-dev-toggle", (event: Event) => {
		if ((event as CustomEvent<string | null>).detail !== flowFieldAuroraPreset.id) return;
		if (telemetry.recording) {
			const n = telemetry.export("aurora");
			Spicetify.showNotification(`Telemetry exported (${n} frames)`);
			telemetry.stop();
		} else {
			telemetry.start();
			Spicetify.showNotification("Telemetry recording - ctrl+click again to stop & export");
		}
	});
}

// Aurora Drift. Every other Flow Field samples an isotropic noise field, so its flow curls equally
// in all directions and fills the frame evenly. This one is deliberately anisotropic: there is a
// single global sweep direction that wanders very slowly, and each particle only deviates from it
// by a bounded amount taken from a noise field sampled with stretched coordinates (wide in x,
// narrow in y). The result is long parallel sheets that ripple and fold past each other like a
// curtain, rather than an even carpet of eddies. An up-flick (order) collapses the deviation almost
// to zero and the sheets go glassy and laminar; a down-flick opens it up into folds.
//
// Colour shifts along each particle's OWN trail: hue is a function of the particle's age, and since
// the trail is what the particle has already painted onto the accumulation canvas, an old streak is
// literally a gradient from its birth hue at the tail to its current hue at the head. No per-stroke
// canvas gradients needed - the history does it for free.
function create(): Preset {
	const noise = createNoise3D();
	let particles: FlowParticle[] = [];
	const bloom = createBloomLayer();
	const conduct = createConductor();
	const gesture = createGestureLayer();
	const density = createDensityGrid(18, 18);
	let fieldTime = 0;
	let prevGustStrength = 0;
	// persistent now, not recomputed fresh each frame - it's what actually gets turned, at a capped
	// rate, towards wherever the wander+gesture want it to point
	let sweepAngle = 0;
	const hueLut = Array.from({ length: HUE_STEPS }, () => ({ r: 255, g: 255, b: 255 }));

	const spawnRandom = (width: number, height: number): FlowParticle => ({
		x: Math.random() * width,
		y: Math.random() * height,
		life: 1,
		brightness: 0.35 + Math.random() * 0.65
	});

	return {
		draw(frame) {
			const { ctx, width, height, isPlaying, colorRgb, mouse } = frame;
			if (!isPlaying) return;

			const c = conduct(frame);
			const pctx = bloom.begin(width, height);
			fadeTrail(ctx, width, height, TRAIL_ALPHA);

			resizeToCount(particles, particleTargetCount(mouse, PARTICLE_COUNT, MAX_PARTICLE_COUNT), () =>
				spawnRandom(width, height)
			);

			const scale = c.scale;
			fieldTime += (0.05 + c.brightness * 0.1) * Math.max(0.1, 1 + c.chaos * 0.7 - c.order * 0.88) * c.dt;
			gesture.begin(frame, c, fieldTime);

			// the sweep the whole curtain travels along - one global noise lookup, wandering slowly
			// around the FULL circle (not clamped to a rightward cone any more), so the curtain can
			// end up drifting any direction over the course of a song, not just rightish-with-detours.
			//
			// Passive cursor influence here is direction+acceleration, not position: every other
			// preset uses "Y position attracts/repels", a per-particle bend toward/away from a point -
			// but Aurora's particles already share nearly the same heading, so any point-bend measurably
			// aligns whichever ones pass close, and their long-lived trails paint that as a bright seam.
			// Gust used to be exactly that (a per-particle bend near the cursor) and is folded in here
			// instead - a burst of cursor acceleration (a real flick/swipe starting, not steady motion
			// or position) leans the one shared sweep angle towards the swipe direction. Global, so
			// nothing to converge onto.
			const wanderAngle = noise(fieldTime * 0.4, 3.7, 0) * Math.PI;
			const gustAccel = Math.max(0, (c.gustStrength - prevGustStrength) / Math.max(c.dt, 1e-3));
			prevGustStrength = c.gustStrength;
			// gustAccel alone missed sustained fast circular motion - swirling the cursor keeps speed
			// roughly constant while direction spins continuously, so its speed *derivative* stays near
			// zero the whole time. Weighting gustStrength itself much more means steady vigorous motion
			// engages this properly, not just the initial jolt. But gustStrength saturates to its cap
			// during ANY vigorous movement, deliberate or not - real telemetry showed it pinned near max
			// for a sustained 1.5s+ stretch of ordinary "moving to the music", which meant the sweep was
			// getting yanked around almost continuously rather than only on a real gesture. gustCoherence
			// (how consistent the direction has actually been, not just how fast) gates that out: fast
			// but erratic motion barely moves the sweep, a real confident swipe still does
			const motionKick = Math.min(0.9, (gustAccel * 0.05 + c.gustStrength * 0.18) * c.gustCoherence);
			const desiredAngle = motionKick > 0.01 ? lerpAngle(wanderAngle, c.gustAngle, motionKick) : wanderAngle;
			// the curtain can only turn so fast, no matter how far the desired direction jumps - a real
			// turn instead of snap-blending toward the new heading. But a FIXED cap can't keep up with a
			// fast circular swirl either (the target itself is spinning faster than the cap allows), and
			// then it's chasing a moving target with the wrong sign half the time, which reads as
			// scattered/confused rather than following. So the ceiling itself rises with how vigorously
			// the cursor is actually moving: a slow deliberate reversal stays a graceful ~2s turn, a fast
			// swirl unlocks enough turn rate to genuinely keep pace with it
			const maxTurnRate = 1.4 + c.gustStrength * 3.5;
			const turnDiff = ((desiredAngle - sweepAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
			const maxStep = maxTurnRate * c.dt;
			sweepAngle += Math.max(-maxStep, Math.min(maxStep, turnDiff));
			// how far an individual particle may stray from the sweep. Order flattens it into glass,
			// chaos opens it into folds; loud passages widen it a little on their own
			const spread = Math.max(0.05, (0.5 + c.energy * 0.35 + c.chaos * 0.9 - c.order * 0.42) * 0.9);

			const base = albumHsl(colorRgb);
			// hue walks about a fifth of the wheel over a particle's life, tugged by spectral brightness
			// widens briefly on a real harmonic change (the chroma itself actually moving, not just a
			// beat/segment ticking over) - a chord change reads as a wider spread of colour, not just louder
			const hueSpan = 0.17 + c.brightness * 0.08 + c.harmonicShift * 0.1;
			for (let i = 0; i < HUE_STEPS; i++) hueLut[i] = hslToRgb(base.h + (i / HUE_STEPS) * hueSpan, base.s, base.l);

			// fast: long streaks are the point, short ones would just read as a grainy wash
			const baseSpeed = (70 + c.energy * 120 + c.momentum * 260) * c.speedFader;
			const influenceRadius = scale * 0.32;
			// the deviation noise below is stretched (low-frequency one way, high the other) to build
			// long coherent sheets - but that only works if "one way" means "along the current direction
			// of travel". It used to just mean "along screen X" back when the sweep was clamped to a
			// rightward cone, so it lined up for free; now the sweep can point anywhere, so the sampling
			// frame has to rotate with it, or the sheets only stay coherent while it happens to be
			// pointing roughly horizontal and fall apart (visually unanchored, lopsided) the rest of the time
			const sweepCos = Math.cos(sweepAngle);
			const sweepSin = Math.sin(sweepAngle);

			density.begin(width, height);
			for (const p of particles) density.add(p.x, p.y);

			const frameAngles: number[] | null = telemetry.recording ? [] : null;

			pctx.lineCap = "round";
			for (const p of particles) {
				// stretched sampling coordinates, rotated into the sweep's own frame: low-frequency
				// ALONG the direction of travel (coherent over long distances), high-frequency ACROSS
				// it (separates into distinct sheets side by side) - regardless of which way the sweep
				// currently points
				const dx = mouse.x - p.x;
				const dy = mouse.y - p.y;
				const dist = Math.hypot(dx, dy);
				const proximity = Math.max(0, 1 - dist / influenceRadius);

				// scalar-only cursor presence, no direct angle target. Every attempt this session at
				// bending individual particles' heading toward the cursor/gust - point-bend, spin-rate,
				// even a proximity-gated lean toward the shared gustAngle - kept reading as un-smooth no
				// matter how it was tuned, because a trail is a literal recording of its particle's angle
				// history: proximity is recomputed raw from mouse position every frame with no easing of
				// its own, so any target-angle response bakes a kink into the trail the instant a particle
				// enters/leaves range. Direction stays sweep+noise only (both already eased); the cursor
				// instead turns up how hard the existing noise deviation swings (turbulence), which can
				// never point a particle somewhere the field itself isn't already going
				const gustWeight = proximity * Math.min(1, c.gustStrength) * c.gustCoherence;

				const along = (p.x * sweepCos + p.y * sweepSin) / scale;
				const across = (-p.x * sweepSin + p.y * sweepCos) / scale;
				const deviation = noise(along * 0.55, across * 2.9, fieldTime) * (spread + gustWeight * 0.6);
				let angle = sweepAngle + deviation;

				// tight radius + low strength: a real localized pulse near the click, not a point-bend at
				// full reach - keeps the "a ripple happened right here" feeling without the outsized
				// alignment risk a stronger/wider one has on particles that already share a heading
				const rip = gesture.bendTowardRipple(angle, p.x, p.y, 0.12, scale * 0.35);
				angle = rip.angle;
				if (frameAngles) frameAngles.push(angle);

				const speed = baseSpeed * (1 + gustWeight * Math.min(3, c.gustStrength) * 0.7) * (1 + rip.weight * 0.15);
				const nx = p.x + Math.cos(angle) * speed * c.dt;
				const ny = p.y + Math.sin(angle) * speed * c.dt;

				const age = Math.min(0.999, Math.max(0, 1 - p.life));
				pctx.beginPath();
				pctx.moveTo(p.x, p.y);
				pctx.lineTo(nx, ny);
				// lone streaks dimmer than before, clustered (or cursor/ripple-lit) ones brighter -
				// everything fades in/out with the same life envelope so it never creates a hard edge
				// at a streak's start or end
				const densityFactor = density.at(p.x, p.y);
				const { cursorGlow, rippleGlow } = gesture.glowAt(p.x, p.y, mouse, scale, c.gustStrength);
				const lifeEnvelope = Math.sin(p.life * Math.PI);
				pctx.strokeStyle = rgbString(
					gesture.tint(hueLut[Math.floor(age * HUE_STEPS)], c.pop),
					Math.min(
						1,
						Math.max(
							0,
							0.1 +
								(p.brightness * 0.6 + densityFactor * 0.32 + cursorGlow * 0.2 + rippleGlow * 0.95 + c.pop * 0.4) *
									lifeEnvelope *
									(1 + c.order * 0.4 - c.chaos * 0.15)
						)
					)
				);
				// a sharp/percussive hit (this segment's own attack character, real data) gets a crisper
				// width kick on the beat than a soft swelling one does - the stroke's hit response
				// actually distinguishes a pluck from a pad instead of treating every hit the same
				pctx.lineWidth = Math.max(
					0.6,
					scale * 0.0019 * (0.6 + c.glow + c.pop * c.attackSharpness * 0.5) * (1 + c.chaos * 0.9 - c.order * 0.2)
				);
				pctx.stroke();

				p.x = nx;
				p.y = ny;
				// decay races to 0 as a particle nears any edge, so by the time it's actually out of
				// bounds its alpha (which follows life through the sin envelope above) has already
				// faded to nothing - the respawn teleport below then lands on an invisible particle
				// instead of popping a still-bright streak straight to a new position
				const edgeMargin = scale * 0.18;
				const edgeDist = Math.min(p.x, width - p.x, p.y, height - p.y);
				const edgeDecayBoost = edgeDist < edgeMargin ? (1 - edgeDist / edgeMargin) * 2.2 : 0;
				p.life -= c.dt * (0.3 + edgeDecayBoost); // roughly three seconds of travel per particle

				if (p.life <= 0 || p.x < 0 || p.x > width || p.y < 0 || p.y > height)
					Object.assign(p, spawnRandom(width, height));
			}

			if (frameAngles) {
				telemetry.record({
					t: frame.progressSec,
					mouseX: mouse.x,
					mouseY: mouse.y,
					mouseDown: mouse.down,
					mouseRightDown: mouse.rightDown,
					gustAngle: c.gustAngle,
					gustStrength: c.gustStrength,
					energy: c.energy,
					momentum: c.momentum,
					pop: c.pop,
					chaos: c.chaos,
					order: c.order,
					trend: c.trend,
					level: c.level,
					brightness: c.brightness,
					loudnessMax: c.segment ? c.segment.loudness_max : null,
					pitches: c.segment ? c.segment.pitches : null,
					extra: {
						sweepAngle,
						spread,
						gustCoherence: c.gustCoherence,
						motionKick,
						coherence: angleCoherence(frameAngles),
						attackSharpness: c.attackSharpness,
						harmonicShift: c.harmonicShift
					}
				});
			}

			bloom.flush(frame, c, 0.011);
		}
	};
}

export const flowFieldAuroraPreset: PresetDefinition = { id: "flowfield-aurora", name: "Aurora Drift", create };
