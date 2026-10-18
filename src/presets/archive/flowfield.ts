// ARCHIVED 2026-09-20, the day after it was rebuilt, on the listener's verdict and one measurement.
//
// The verdict: "it is basically Aurora, not Flow Field, and with no new features at all - it does
// not stand at the same level as Layers". Both halves are true and the second one is measurable.
//
// The skeleton IS Aurora's: one shared wind, a bounded per-particle deviation from it, sampled in
// the wind's own rotated frame for the sheets variant. That is the same preset, rebuilt.
//
// The one thing that was new - a band of light across the wind at each sound's register - was
// measured afterwards at **26% of all the light in the picture**, so it was not too small to see.
// It was too diffuse to ATTRIBUTE: a quarter of the picture spent brightening a stripe of a moving
// field, which the eye reads as "it is brighter over there" and never as "that was a sound". The
// lesson is the one conducting already taught this project - a change with no author is not an
// event - and it is worth more than the preset was.
//
// What is worth taking, if a calm counterpart to Layers II is ever wanted again: not this. Start
// from a different MECHANISM, because a second noise field will always be a worse Layers II.
// FLOW FIELD, rebuilt 2026-09-17. The other pole from Layers II.
//
// Layers II is the busy one: three groups, a mark for every sound, events flying across the wind.
// This is the opposite and is meant to stay that way - ONE population, ONE wind, and weather rather
// than events. What it had been until now was the oldest code in the repository: speed wired to the
// per-segment sawtooth, a vector-share blend between the field and two cursor terms that have not
// existed since the gesture layer came out, `chaos`/`order` in the line width, and a life measured
// in seconds. All of that is gone.
//
// The thing it does that Layers II does not: THE MUSIC ARRIVES AS LIGHT, NOT AS OBJECTS. A sound
// lights a band across the wind at its own register, and the field flows through that band. Same
// measurements as a mark in Layers II - the same register axis, the same per-sound attack and
// decay, the same answered-before-it-happens lead - in a different medium. Nothing is born, nothing
// is thrown; the wind was already blowing and the light falls on it.
//
// Three variants on V, because the shape this should take is a question for an eye, not a
// description (DESIGN-RULES §9, and every round of this project's history). They are parameter sets
// over one mechanism, not three implementations. If they turn out to be genuinely different
// pictures rather than three settings of one, that is the signal to split them into separate
// presets - and that decision is made by looking.
import { createNoise3D } from "simplex-noise";
import { createDensityGrid, fadeTrail, resizeToCount } from "../effects";
import {
	albumHsl,
	createBloomLayer,
	createConductor,
	getVariant,
	hslToRgb,
	particleTargetCount
} from "../flowfield-common";
import { rankOf } from "../../audio-data";
import { Preset, PresetDefinition, rgbString } from "../types";

// THE CANVAS THIS IS WRITTEN FOR. Same reference as Layers II, and for the same reason: what gets
// tuned by eye is a DENSITY (how many strokes are in view) and a CROSSING TIME (how long one takes
// to cross the picture), and neither survives being handed four times the area with the same
// numbers. Counts scale by area, speeds by linear size.
const REF_W = 1080;
const REF_H = 1024;

// LONG, because in this preset the trail IS the filament. A stroke is one frame of travel - at the
// speeds here that is one or two pixels - so everything the eye reads as a line is accumulation on
// the trail canvas, and how long that canvas remembers is literally how long the lines are.
//
// Measured in the browser rather than reasoned about: at 0.055 a stroke of alpha 0.15 survived 0.18s
// and one of 0.3 survived 0.28s, so a particle moving at 60 px/s drew a 15-pixel dash and the
// picture was a field of dots. The black-floor pass (effects.ts) is what does most of that killing,
// and it does it hardest to exactly the dim strokes this preset is made of - it is tuned to collapse
// near-black to a true zero, which a faint filament is indistinguishable from.
const TRAIL_ALPHA = 0.015;

type Variant = {
	name: string;
	count: number;
	max: number;
	// how many BEATS of this track a particle lives. Not seconds: a streak is speed x persistence,
	// so on a slow song the same number of seconds is a different picture
	lifeBeats: number;
	// px/s at the reference size: the floor, and how much the loudness adds on top. The range opens
	// DOWNWARD (DESIGN-RULES §13) - the floor is deliberately a small share of the total, so that a
	// quiet passage genuinely moves less instead of everything sitting at one rate all song
	speedFloor: number;
	speedRange: number;
	// how far a particle's heading may sit from the wind, in radians. Bounded well under PI: this is
	// an OFFSET from one shared direction, never a direction of its own (§1c)
	spread: number;
	// noise sampling frequency, along the wind and across it. Equal for the isotropic variants;
	// stretched for the sheets
	freqAlong: number;
	freqAcross: number;
	// sample the noise in the WIND'S OWN ROTATED FRAME. This is Aurora's trick and the whole reason
	// its sheets hold together: low frequency along the direction of travel (coherent over long
	// distances) and high frequency across it (separating into distinct sheets side by side). It
	// only works in the rotated frame - sampled in screen coordinates the sheets are coherent only
	// while the wind happens to point horizontally.
	anisotropic: boolean;
	width: number;
};

// What V flips between. The question these exist to answer is "which of these is Flow Field", and
// it cannot be answered from a description.
const VARIANTS: Variant[] = [
	// the quiet pole: few, slow, long-lived, wide and faint. A wash that takes a minute to change
	{ name: "calm", count: 520, max: 900, lifeBeats: 16, speedFloor: 10, speedRange: 110, spread: 0.55, freqAlong: 0.5, freqAcross: 0.7, anisotropic: false, width: 0.0023 },
	// the legible one: many, quicker, short-lived hairlines. Closest to what Flow Field has been
	{ name: "dense", count: 1300, max: 2000, lifeBeats: 6, speedFloor: 14, speedRange: 190, spread: 0.42, freqAlong: 1.1, freqAcross: 1.4, anisotropic: false, width: 0.0014 },
	// Aurora's look, carried forward now that Aurora itself is archived: long parallel sheets
	{ name: "sheets", count: 900, max: 1500, lifeBeats: 10, speedFloor: 30, speedRange: 330, spread: 0.3, freqAlong: 0.55, freqAcross: 2.9, anisotropic: true, width: 0.0016 }
];

// The alpha ceiling. Above the measured p95 and never through the distribution (§3b): a layer that
// cannot get brighter cannot visibly get dimmer either, and the last time a cap sat at p50 every
// modulation underneath it was being flattened out of existence.
const ALPHA_CAP = 0.85;

// How many bands of light can be in the air at once. A sound lights one; they overlap and fade.
// Generous, because running out is a ceiling on the population in exactly the way a clamped alpha
// is a ceiling on brightness - at saturation a busier passage cannot show as busier.
const MAX_BANDS = 28;

type Particle = { x: number; y: number; life: number; brightness: number };

// A sound, as light across the wind. `at` is its place on the register axis (0..1 across the wind),
// `rise`/`decay` are that sound's own measured attack and fall, in seconds, and `born` is when its
// envelope starts - which is BEFORE the sound, by as much as its own rise needs (§5b).
type Band = { at: number; width: number; power: number; born: number; rise: number; decay: number };

function create(): Preset {
	const noise = createNoise3D();
	const bloom = createBloomLayer();
	const conduct = createConductor();
	const density = createDensityGrid(20, 20);

	let particles: Particle[] = [];
	let fieldTime = 0;
	let clock = 0;
	// the wind: persistent and rate-capped, never recomputed fresh. It is a frame of reference, and
	// a frame of reference that jumps is worse than useless
	let windAngle = 0;
	// eased harmonic movement - the conductor's own `harmonicShift` rises 42% in a single frame,
	// which is right for a pulse and wrong for anything that shapes geometry
	let harm = 0;
	// the release, eased. `impact` is already a shape in time and cannot step, but it multiplies
	// both light and width here, and the two want slightly different clocks from the envelope
	let flash = 0;
	const bands: Band[] = [];
	// the segment this preset last lit, so one new sound is one band
	let lastSegStart: number | null = null;
	let nextSeg = 0;
	let lastScan = -1;

	const spawn = (width: number, height: number): Particle => ({
		x: Math.random() * width,
		y: Math.random() * height,
		life: 1,
		brightness: 0.35 + Math.random() * 0.65
	});

	return {
		draw(frame) {
			const { ctx, width, height, isPlaying, colorRgb, audio, progressSec, mouse } = frame;
			if (!isPlaying) return; // freeze on the last frame rather than fading it to black

			const c = conduct(frame);
			const v = VARIANTS[getVariant() % VARIANTS.length];
			const pctx = bloom.begin(width, height);
			fadeTrail(ctx, width, height, TRAIL_ALPHA);

			const scale = c.scale;
			const dens = Math.min(6, (width * height) / (REF_W * REF_H));
			const pace = Math.min(width, height) / Math.min(REF_W, REF_H);
			resizeToCount(
				particles,
				particleTargetCount(mouse, Math.round(v.count * dens), Math.round(v.max * dens)),
				() => spawn(width, height)
			);

			// ---- this track's own clock ------------------------------------------------------------
			// Every time constant below is in beats. A fade that takes 0.6s is a different musical
			// length at 90bpm and at 160, and the picture is supposed to belong to the song.
			const beat = audio?.tempo && audio.tempo > 40 ? 60 / audio.tempo : 0.5;
			clock += c.dt;
			harm += (c.harmonicShift - harm) * Math.min(1, 6 * c.dt);
			flash += ((c.timeToImpact !== null && c.timeToImpact > 0 ? 0 : c.impact) - flash) * Math.min(1, (c.impact > flash ? 11 : 3) * c.dt);

			// ---- the wind ---------------------------------------------------------------------------
			// It wanders on its own, very slowly, and a real harmonic move - the chroma actually
			// changing, not a beat ticking over - unlocks its turn rate for a second or two. Rare,
			// large, slow: the opposite envelope from anything that fires on a hit, which is what keeps
			// the two readable as different things (§11).
			const wanderTarget = noise(fieldTime * 0.12, 9.1, 0) * Math.PI;
			const turnStep = (0.18 + harm * 1.2) * c.dt;
			const turnDiff = ((wanderTarget - windAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
			windAngle += Math.max(-turnStep, Math.min(turnStep, turnDiff));
			const windCos = Math.cos(windAngle);
			const windSin = Math.sin(windAngle);
			fieldTime += (0.035 + c.brightness * 0.09) * c.dt;

			// ---- the brace and the release ----------------------------------------------------------
			// The brace has to be EARLY or it arrives at the same instant as the release it is meant to
			// make room for: `anticipation` is 0.03 one second out. `windup` spans the moment's own
			// measured run-in, so the brace borrows its span and keeps anticipation's shape on top.
			// (The run-in measurement itself was fixed on 2026-09-16 - see SIGNALS.md.)
			const braceEarly = Math.max(c.anticipation, Math.min(1, c.windup * 0.8));
			// darker and faster on the way in, which is what a build-up is. The brace takes the LIGHT
			// down and the wind-up takes the SPEED up; they are never in the same channel, or they
			// subtract from each other and the whole run-in reads as flat until the last half second.
			const dim = 1 - braceEarly * 0.38 * Math.max(0.12, c.runInDip);
			const windUp = 1 + c.windup * (0.1 + c.runInBuild * 0.8);
			// CONTRACTION. A build-up is stored energy, not spent energy: the field goes laminar, which
			// the eye reads as gathering, and the release lets it open again. It costs no light and no
			// speed, so it works in a passage that has neither.
			const contraction = 1 - braceEarly * 0.5;

			const speed = (v.speedFloor + c.loudness * v.speedRange) * windUp * pace;
			const spread = Math.max(0.05, v.spread * contraction * (1 + harm * 0.35));

			// ---- the sound that is about to happen ---------------------------------------------------
			// The analysis is a timeline, so the next segment is already in memory with its loudness and
			// its attack. A band needs its own rise to reach full strength, so it is lit BEFORE its
			// sound by exactly that much and peaks on it (§5b).
			const segs = audio?.segments;
			if (segs && segs.length > 0) {
				if (progressSec < lastScan || progressSec - lastScan > 0.5) {
					let lo = 0;
					let hi = segs.length - 1;
					while (lo < hi) {
						const mid = (lo + hi) >> 1;
						if (segs[mid].start < progressSec) lo = mid + 1;
						else hi = mid;
					}
					nextSeg = lo;
				}
				lastScan = progressSec;
				while (nextSeg < segs.length && segs[nextSeg].start < progressSec - 0.02) nextSeg++;
			}
			const coming = segs && nextSeg < segs.length ? segs[nextSeg] : null;
			if (coming && coming.start !== lastSegStart) {
				// never under three frames: below that a rise is a step whatever the arithmetic says
				const rise = Math.max(0.05, Math.min(0.55, coming.loudness_max_time * 2.4 + 0.04));
				if (coming.start - progressSec <= Math.min(0.4, rise * 0.9)) {
					lastSegStart = coming.start;
					const amp = Math.pow(10, coming.loudness_max / 20) / (audio?.hitScale || 0.56);
					const after = segs ? segs[nextSeg + 1] : undefined;
					const fall = after ? coming.loudness_max - after.loudness_start : 8;
					bands.push({
						// WHERE, across the wind: how ringing the sound was, as its rank among this
						// track's own segments. Not a pitch - `pitches` has no octave in it, and the
						// rhythm bands cannot do register either, because a broadband hit touches the
						// lowest band and the highest at once. Dull-versus-ringing is the nearest
						// honest thing the analysis has (MEASUREMENTS §6).
						//
						// IN THE SAME UNITS THE PARTICLES ARE MEASURED IN, which is the whole of what
						// went wrong the first time this ran: the rank is 0..1 and a particle's
						// distance across the wind runs about -1.4..+1.4, so the bands sat in a strip
						// off to one side of the picture and half the field could never be lit by
						// anything. Centred and normalised to the same half-width Layers II places its
						// marks on, so 0 is the middle of the picture and +-1 its edge.
						at: (audio ? rankOf(audio.timbreSorted, coming.timbre[1]) : 0.5) * 2 - 1,
						// a soft sound is a wide gentle band, a crack is a narrow bright one
						width: 0.1 + (1 - Math.min(1, coming.loudness_max_time / 0.12)) * -0.05 + Math.min(0.2, 0.14 / Math.max(0.35, amp)),
						power: Math.min(1.25, amp),
						born: clock,
						rise,
						// bounded in BEATS: a band may not outlive about a beat and a half of the song it
						// belongs to, and may not be shorter than a fifth of one. A big fall means the
						// sound is gone before anything else happens; a small one means it is still
						// ringing under the next event, so its light should still be there too
						decay: Math.max(beat * 0.4, Math.min(beat * 1.6, 3.4 / Math.max(3, fall)))
					});
					while (bands.length > MAX_BANDS) bands.shift();
				}
			}
			for (let i = bands.length - 1; i >= 0; i--)
				if (clock - bands[i].born > bands[i].rise + bands[i].decay * 6) bands.splice(i, 1);
			// how much light the bands are putting out right now, for the duck below
			let bandTotal = 0;
			for (const b of bands) {
				const age = clock - b.born;
				const envelope = age < b.rise ? (t => t * t * (3 - 2 * t))(Math.max(0, age) / b.rise) : Math.exp(-(age - b.rise) / b.decay);
				bandTotal = Math.max(bandTotal, envelope * b.power);
			}
			// A hit does not get brighter; everything around it gets dimmer. That is how a mix makes a
			// kick punch and it is the only way to add emphasis without adding light to a bloom pass
			// (§11). Applied as the contrast between the band and the field it sits in, never as
			// magnitude - raising the band alone only drives the whole picture onto its ceiling.
			//
			// SMALL, and that is measured. At 0.45 the duck was a brightness SINK that deepened with
			// event density: it took half the light off the whole field while the bands put it back
			// only along a narrow stripe, so a busy loud passage came out darker than a sparse quiet
			// one and the light measured r = 0.12 against the music. A duck has to be contrast at
			// constant mean, or it is a second, inverted loudness channel.
			const duck = Math.min(0.18, bandTotal * 0.2);

			// how brightly the bands light a particle at this position across the wind
			const bandLightAt = (across: number) => {
				let sum = 0;
				for (const b of bands) {
					const d = Math.abs(across - b.at);
					if (d > b.width * 3) continue;
					const age = clock - b.born;
					if (age < 0) continue;
					const envelope =
						age < b.rise ? (t => t * t * (3 - 2 * t))(age / b.rise) : Math.exp(-(age - b.rise) / b.decay);
					// gaussian across the axis, so a particle crossing a band reads a curve rather than
					// an edge - and the band never has a boundary to draw
					const shape = Math.exp(-(d * d) / (2 * b.width * b.width));
					sum += envelope * shape * b.power;
				}
				return Math.min(1.4, sum);
			};

			// ---- colour ------------------------------------------------------------------------------
			const base = albumHsl(colorRgb);
			// the hue walks a little over a particle's life, so a long streak is not one flat colour.
			// Widened by real harmonic movement: a chord change reads as a wider spread of colour
			const hueSpan = 0.1 + c.brightness * 0.06 + harm * 0.08;
			const fieldRgb = hslToRgb(base.h, base.s * 0.85, base.l * 0.9);
			const litRgb = hslToRgb(base.h + hueSpan, Math.min(1, base.s + 0.1), Math.min(0.8, base.l + 0.16));

			density.begin(width, height);
			for (const p of particles) density.add(p.x, p.y);

			pctx.lineCap = "round";
			const lifeDrain = c.dt / (v.lifeBeats * beat);
			// WIDTH CARRIES ITS SHARE OF THE DYNAMICS TOO (§13). It was `0.75 + brightness * 0.5`, i.e.
			// timbre alone - and measured against the music that came out at r = -0.50: on a track
			// whose loud passages are duller than its quiet ones, the width was actively arguing with
			// the loudness while alpha and length were agreeing with it. Timbre stays, as the small
			// character term it should have been; the loudness gets the larger share.
			const widthPx = Math.max(0.7, scale * v.width * (0.82 + c.loudness * 0.22 + c.brightness * 0.16) * (1 + flash * 0.18));

			// the half-width of the register axis, in pixels: the same 0.46 of the short side Layers II
			// spreads its marks over
			const acrossReach = Math.min(width, height) * 0.46;
			for (const p of particles) {
				const along = (p.x * windCos + p.y * windSin) / scale;
				const across = (-p.x * windSin + p.y * windCos) / scale;
				// the same axis, centred on the picture and normalised, for the bands to be read on
				const acrossUnit = ((p.x - width / 2) * -windSin + (p.y - height / 2) * windCos) / acrossReach;
				// THE HAND IS AN AMPLITUDE, NEVER AN ANGLE. `trailAt` is a ribbon along the pointer's
				// recent path, so it is raw position by construction - the one thing §1b forbids in
				// geometry. It is allowed to make the field stir harder where the hand is working it
				// (turbulence is an amplitude on the noise that already sets the angle) and to hurry
				// what is passing, and nothing else. A still hand lays no ribbon and so does nothing.
				const hand = c.trailAt(p.x, p.y) * (0.35 + c.baton * 0.65);
				// the ring is LIGHT ONLY. It is a narrow band travelling at about 1100 px/s, so anything
				// reading it changes fast: brightness may do that, an angle may not (measured - putting
				// the ripple in the turbulence produced the only turns over 0.3 rad this project has
				// recorded in a year of these presets)
				const ring = c.rippleAt(p.x, p.y);

				const deviation = v.anisotropic
					? noise(along * v.freqAlong, across * v.freqAcross, fieldTime) * (spread + hand * 0.7)
					: noise(along * v.freqAlong, across * v.freqAcross, fieldTime) * (spread + hand * 0.9);
				const angle = windAngle + deviation;

				const step = speed * (1 + hand * 0.8) * c.dt;
				const nx = p.x + Math.cos(angle) * step;
				const ny = p.y + Math.sin(angle) * step;

				// A particle must be invisible before a respawn teleports it (§5), and this is a fade BY
				// DISTANCE, not an acceleration of its life: the light here is a bell over the life, so
				// racing the life to zero walks the particle straight over the top of its own curve and
				// the thing meant to hide the respawn becomes the brightest event on screen. Measured in
				// Layers II, where it was 100% of the bass layer's sudden brightenings.
				const edge = Math.min(p.x, width - p.x, p.y, height - p.y) / (scale * 0.16);
				const lit = bandLightAt(acrossUnit);
				// LOUDNESS IS THE DRIVER HERE AND EVERYTHING ELSE IS A DETAIL ON IT (§12). Measured on
				// Borderline, the first build had alpha at r = 0.12 against the music with the widest
				// range of the three channels - the light was being set by how many sounds a passage
				// held rather than by how loud it was, because the band term and the duck together
				// outweighed the loudness term by two to one. A channel with three comparable drivers
				// has no driver.
				const alpha = Math.min(
					ALPHA_CAP,
					Math.max(
						0,
						(0.13 +
							p.brightness * 0.1 +
							density.at(p.x, p.y) * 0.1 +
							c.loudness * 0.85 +
							lit * 0.4 +
							flash * 0.05 +
							hand * 1.1 +
							ring * 1.0) *
							Math.sin(p.life * Math.PI) *
							Math.max(0, Math.min(1, edge)) *
							// the duck is CANCELLED where a band is passing: everything around the light
							// gets out of its way and the lit line does not. The two separate without
							// either of them changing its own budget (§3b)
							(1 - duck * (1 - Math.min(1, lit))) *
							dim *
							0.95
					)
				);

				pctx.beginPath();
				pctx.moveTo(p.x, p.y);
				pctx.lineTo(nx, ny);
				// colour is the one place the band is allowed to differ in kind rather than in amount:
				// lit strokes lean towards the brighter, more saturated end of the album's own family
				const mix = Math.min(1, lit * 0.8);
				pctx.strokeStyle = rgbString(
					{
						r: Math.round(fieldRgb.r + (litRgb.r - fieldRgb.r) * mix),
						g: Math.round(fieldRgb.g + (litRgb.g - fieldRgb.g) * mix),
						b: Math.round(fieldRgb.b + (litRgb.b - fieldRgb.b) * mix)
					},
					alpha
				);
				pctx.lineWidth = widthPx;
				pctx.stroke();

				p.x = nx;
				p.y = ny;
				p.life -= lifeDrain;
				if (p.life <= 0 || p.x < 0 || p.x > width || p.y < 0 || p.y > height) Object.assign(p, spawn(width, height));
			}

			bloom.flush(frame, c, 0.011);
		}
	};
}

export const flowFieldPreset: PresetDefinition = { id: "flowfield", name: "Flow Field", create };
