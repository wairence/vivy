// Ridgeline: the whole song as a terrain flying at the viewer. A row is one sound (height: loudness,
// shape: harmony in fifths), depth is time, the bright line is "now", echoes are afterimages of sounds.
// Seven extras toggle with keys 1-7 (FEATURES); each is one block in draw().
// Ridgeline plot: rows drawn far to near, each filled so it hides what is behind it.
import { createNoise2D } from "simplex-noise";
import { createGlow, createKeyHue, keyHueAt } from "./effects";
import { createConductor } from "./conductor";
import { accentLightness, colourSettings, familyHue, GREY, hslToRgb, palette, paletteAt } from "../colours";
import { sampleCurve, segmentAt, TrackAudioData } from "../audio-data";
import { Preset, PresetDefinition, rgbString } from "./types";
import { tune, tuneFeatures, tuneVersion } from "./tune";

// ---- the extras, in the order of their keys ---------------------------------------------------------
const FEATURES = {
	horizon: { name: "horizon glow", on: true },
	grid: { name: "bars and section gates", on: true },
	height: { name: "colour by height", on: true },
	lit: { name: "lit mountains", on: true },
	camera: { name: "camera", on: true },
	dust: { name: "dust", on: true },
	accents: { name: "rows on accents", on: true }
};
const FEATURE_KEYS = Object.values(FEATURES);
tuneFeatures("ridge", FEATURE_KEYS);
// module scope: create() reruns on every preset switch and would leave a listener behind each time
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
	window.addEventListener("visualizer-feature", (event: Event) => {
		const detail = (event as CustomEvent<{ preset: string | null; n: number } | null>).detail;
		const feature = detail && detail.preset === ridgePreset.id ? FEATURE_KEYS[detail.n - 1] : undefined;
		if (!feature) return;
		feature.on = !feature.on;
		if (typeof Spicetify !== "undefined") Spicetify.showNotification(`Ridgeline ${detail!.n}: ${feature.name} ${feature.on ? "ON" : "off"}`);
	});
}

// ---- time, in beats of the track ------------------------------------------------------------------------
// how much of the future is on screen, how much of the past, and how many rows a beat is cut into
const FUTURE_BEATS = 6.34;
const PAST_BEATS = 1.42;
const ROWS_PER_BEAT = 2;
// rows on accents, in beats: minimum spacing, and longest stretch of ground without a row
const ROW_GAP_MIN = 0.09037;
const ROW_GAP_MAX = 0.9988;

// ---- the view -------------------------------------------------------------------------------------------
// depth is 1 at the front edge of the picture; "now" sits here, so the past has this much room to sink in
const Z_NOW = 1.637;
// the horizon, and how far below it the ground is at depth 1, as fractions of the height
const HORIZON = 0.3429;
const GROUND = 0.6375;
// a full-height ridge at depth 1, and half the terrain's width at depth 1 (wider than the screen: the
// front rows run off both sides)
const RIDGE = 0.34;
const HALF_WIDTH = 0.834;
// camera height as a multiple of the ground drop, quietest to loudest; LATELY_* is the measured level range
// (5th to 95th percentile), LEAD_FULL a real build (about the 97th)
const CAMERA_LOW = 0.3463;
const CAMERA_HIGH = 1.53;
const LATELY_QUIET = 0.154;
const LATELY_LOUD = 0.4899;
const LEAD_FULL = 0.15;
// a row's line runs out flat this far to both sides (in half-widths) and fades there
const SIDE = 1.62;
// rows nearer than this are drawn with every point; beyond it they are small enough for half of them
const FINE_UNTIL = 3.6;

// ---- a row's shape ----------------------------------------------------------------------------------------
const POINTS = 96;
// a row carries its loudness and the colour of its section after its points
const LEVEL = POINTS;
const HUE = POINTS + 1;
// how far across the outermost pitch lanes sit, and how wide one note's hill is (in half-widths)
const LANE_SPAN = 0.6152;
const HILL = 0.07583;
// how tall a ridge may get before it is rounded off
const RIDGE_LIMIT = 0.855;
// jaggedness of a sharp sound, and smoothing radius along the line in points (of 96)
const JAG = 0.35;
const SMOOTH = 1.5;
// echo: lifetime in beats, swell by the end for the quietest sound and for a big hit, max alive
const ECHO_BEATS = 0.9685;
const ECHO_SWELL_SOFT = 0.1825;
const ECHO_SWELL_HARD = 1.058;
const ECHO_MAX = 12;
// how many specks of dust are in the air
const DUST = 70;
// horizon glow: height above the far edge (of picture height), width (of picture width), peak brightness
const SKY_HEIGHT = 0.2252;
const SKY_WIDTH = 1.146;
const SKY_BRIGHT = 0.425;

const K = tune("ridge", {
	FUTURE_BEATS: [FUTURE_BEATS, 4, 40, "beats of the future on screen", "time"],
	PAST_BEATS: [PAST_BEATS, 1, 8, "beats of the past"],
	ROW_GAP_MIN: [ROW_GAP_MIN, 0.05, 1, "rows no closer than, beats"],
	ROW_GAP_MAX: [ROW_GAP_MAX, 0.5, 4, "no gap longer than, beats"],
	Z_NOW: [Z_NOW, 1.1, 3, "how deep now stands", "view"],
	HORIZON: [HORIZON, 0.05, 0.6, "horizon height"],
	GROUND: [GROUND, 0.2, 1.2, "ground drop"],
	RIDGE: [RIDGE, 0.05, 1, "ridge height"],
	HALF_WIDTH: [HALF_WIDTH, 0.3, 1.5, "terrain width"],
	SIDE: [SIDE, 1.05, 3, "flat run-out to the sides"],
	FINE_UNTIL: [FINE_UNTIL, 1, 20, "full detail nearer than"],
	CAMERA_LOW: [CAMERA_LOW, 0.2, 1.5, "camera height, quiet", "camera"],
	CAMERA_HIGH: [CAMERA_HIGH, 0.5, 2.5, "camera height, loud"],
	LATELY_QUIET: [LATELY_QUIET, 0, 0.4, "level that counts as quiet"],
	LATELY_LOUD: [LATELY_LOUD, 0.45, 1, "level that counts as loud"],
	LEAD_FULL: [LEAD_FULL, 0.02, 0.5, "build that crouches it fully"],
	LANE_SPAN: [LANE_SPAN, 0.1, 1, "how wide the pitch lanes spread", "shape"],
	HILL: [HILL, 0.03, 0.5, "width of one note hill"],
	RIDGE_LIMIT: [RIDGE_LIMIT, 0.3, 4, "tallest before rounding off"],
	JAG: [JAG, 0, 1, "how jagged a sharp sound is"],
	SMOOTH: [SMOOTH, 0, 8, "smoothing along the line"],
	ECHO_BEATS: [ECHO_BEATS, 0.2, 6, "echo lasts, beats", "echo"],
	ECHO_SWELL_SOFT: [ECHO_SWELL_SOFT, 0, 1, "swell of a soft sound"],
	ECHO_SWELL_HARD: [ECHO_SWELL_HARD, 0, 3, "swell of a big hit"],
	SKY_HEIGHT: [SKY_HEIGHT, 0.03, 0.6, "glow height", "horizon glow"],
	SKY_WIDTH: [SKY_WIDTH, 0.2, 1.5, "glow width"],
	SKY_BRIGHT: [SKY_BRIGHT, 0, 1, "glow brightness"],
	GLOW: [1, 0, 2.5, "halo strength", "look"],
	LINE: [1, 0.4, 3, "thickness of the bright line"],
	DUST_LIGHT: [1, 0, 3, "dust brightness"],
	SWAY: [1, 0, 3, "camera sway"]
	},
	// what each one does, shown beside the panel on hover
	{
		FUTURE_BEATS: "How much of the song ahead is on screen. Higher shows further into the future, rows get packed tighter.",
		PAST_BEATS: "How much of the song just played stays visible in front of the bright line before it sinks away. Higher keeps it longer.",
		ROW_GAP_MIN: "Smallest spacing between rows. Higher drops rows on fast sounds, so the terrain gets sparser; lower keeps every sound as its own row.",
		ROW_GAP_MAX: "Longest stretch without a row. Lower fills quiet gaps with flat filler rows, so the terrain looks denser; higher leaves holes.",
		Z_NOW: "How far back the bright line stands. Higher moves it away from the front edge, smaller and lower, with more room for the past to sink.",
		HORIZON: "Where the far edge of the terrain sits. Higher moves the horizon up the screen and squeezes the terrain into less space.",
		GROUND: "How far the front of the ground drops below the horizon. Higher spreads the rows out vertically; lower flattens them together.",
		RIDGE: "How tall the mountains are. Higher makes loud sounds tower; lower makes the whole landscape flatter.",
		HALF_WIDTH: "How wide the terrain is. Higher spreads the mountains out wider; lower packs them toward the middle.",
		SIDE: "How far the flat ground continues to the left and right of the mountains before fading out. Higher gives longer flat lines at the edges.",
		FINE_UNTIL: "Distance up to which rows are drawn in full detail. Higher keeps more rows smooth; lower makes far rows slightly coarser.",
		CAMERA_LOW: "How high the view floats over quiet music. Higher looks down on the terrain more; lower sits near the ground and flattens the rows.",
		CAMERA_HIGH: "How high the view floats over loud music. Higher lifts it further up and opens the rows apart as the song gets louder.",
		LATELY_QUIET: "How loud the last few seconds must be before the view starts to rise. Higher keeps the view low for longer.",
		LATELY_LOUD: "How loud the last few seconds must be for the view to reach its top. Higher means only the loudest parts lift it all the way.",
		LEAD_FULL: "How big a coming build must be to make the view crouch fully before it. Lower makes it crouch for small builds too.",
		LANE_SPAN: "How wide apart the notes are spread across a row. Higher spreads the mountains across the width; lower bunches them in the middle.",
		HILL: "How wide each note's hill is. Higher makes broad, rolling mountains that merge; lower makes thin, separate spikes.",
		RIDGE_LIMIT: "Height at which tall peaks start to flatten off. Lower rounds off loud peaks sooner; higher lets them shoot up sharper.",
		JAG: "How rough a sharp sound makes its ridge. Higher gives jagged, noisy edges on hits; zero keeps every ridge smooth.",
		SMOOTH: "How much each row's line is blurred along its length. Higher gives soft, rounded hills; zero shows every little spike.",
		ECHO_BEATS: "How long the afterimage of each sound lingers. Higher leaves it hanging for longer before it fades out.",
		ECHO_SWELL_SOFT: "How far the afterimage of a quiet sound lifts off the line as it fades. Higher makes even soft sounds throw an echo.",
		ECHO_SWELL_HARD: "How far the afterimage of a big hit lifts off the line as it fades. Higher makes hits throw a taller, wider echo.",
		SKY_HEIGHT: "How high the glow on the horizon reaches. Higher makes a taller band of light above the far edge.",
		SKY_WIDTH: "How far the horizon glow spreads sideways. Higher makes it stretch across the whole screen and beyond.",
		SKY_BRIGHT: "How bright the horizon glow is at its centre. Zero turns it off.",
		GLOW: "The soft halo around everything bright. Zero is a clean, sharp picture; higher is hazier and dreamier.",
		LINE: "How thick the bright line of the current moment is.",
		DUST_LIGHT: "How bright the specks flying past are. Zero hides them; higher makes a snowstorm of light on loud parts.",
		SWAY: "How far the view drifts from side to side. Zero keeps it dead centre; higher swings it wider and the terrain bends with it."
	},
	// shown without "More"; the rest is for whoever wants to dig
	["FUTURE_BEATS", "HORIZON", "RIDGE", "HALF_WIDTH", "SMOOTH", "ECHO_BEATS", "SKY_BRIGHT", "GLOW"]
);

// what the gradient can follow here (see colours.ts)
const COLOURS = colourSettings("ridge", [
	["height", "Height", "Valleys take the first colour, peaks the last: the louder a moment, the further along"],
	["depth", "Depth", "Far away, what is coming, takes the first colour; now, up close, the last"],
	["sound", "Sound", "The whole landscape slides along the colours with how loud the music is"]
]);

const smoothstep = (t: number) => {
	const u = Math.max(0, Math.min(1, t));
	return u * u * (3 - 2 * u);
};
const beatOf = (audio: TrackAudioData | null) => (audio?.tempo && audio.tempo > 40 ? 60 / audio.tempo : 0.5);
const BLACK = { r: 0, g: 0, b: 0 };

// where each point of a row sits across the terrain, -1..1, and each pitch class's hill over those points
const ACROSS = new Float32Array(POINTS);
const BLUR = new Float32Array(POINTS);
const HILLS = new Float32Array(12 * POINTS);
for (let i = 0; i < POINTS; i++) ACROSS[i] = -1 + (2 * i) / (POINTS - 1);
// a function: turning a knob redoes the table
const setHills = () => {
	for (let k = 0; k < 12; k++) {
		// in fifths: C G D A E B F# C# G# D# A# F, so a triad is three neighbouring lanes
		const lane = -K.LANE_SPAN + (2 * K.LANE_SPAN * ((k * 7) % 12)) / 11;
		for (let i = 0; i < POINTS; i++) {
			const d = (ACROSS[i] - lane) / K.HILL;
			HILLS[k * POINTS + i] = Math.exp(-d * d);
		}
	}
};
setHills();

function create(): Preset {
	const noise = createNoise2D();
	const conduct = createConductor();
	const keyHue = createKeyHue();
	const glow = createGlow();

	// rows keyed by index on the beat grid, cached while on screen; gates sit at section boundaries
	const rows = new Map<number, Float32Array>();
	const gates = new Map<number, Float32Array>();
	const live = new Float32Array(POINTS + 2);
	const target = new Float32Array(POINTS + 2);
	// where each point of the line is on screen this frame
	const xs = new Float32Array(POINTS);
	// track on screen and the time it is shown at; they lag the player across a track change or seek
	let shown: TrackAudioData | null = null;
	let viewTime = 0;
	let presence = 0;
	let swayClock = 0;
	// per row: time, weight of the sound it stands on (0..1), whether a bar begins there
	let rowTimes: number[] = [];
	let rowWeights: number[] = [];
	let rowBars: boolean[] = [];
	let onAccents = FEATURES.accents.on;
	let tuned = tuneVersion();
	// echoes, and sounds played by the last frame (-1: unknown, nothing echoes across a change or seek)
	const echoes: { data: Float32Array; age: number; amp: number }[] = [];
	let played = -1;
	// what the frame drawn while paused showed
	let pausedFor: TrackAudioData | null | undefined;
	let pausedAt = "";
	// eased: recent loudness, upcoming loudness, camera height
	let lately = 0.3;
	let ahead = 0.3;
	// where on the palette the music has the picture, when the colour follows the sound
	let soundAt = 0.5;
	// the horizon's lean towards the coming section's key, eased so a new key is joined, not jumped to
	let skyLean = NaN;
	let camera = 1;
	// the dust: across (half-widths), above the ground (ridges), its place in the passing stretch (0..1), its own light
	const dust = new Float32Array(DUST * 4);
	for (let i = 0; i < DUST; i++) {
		dust[i * 4] = (Math.random() * 2 - 1) * 2.4;
		dust[i * 4 + 1] = 1.1 + Math.random() * 2.6;
		dust[i * 4 + 2] = Math.random();
		dust[i * 4 + 3] = 0.4 + Math.random() * 0.6;
	}

	// the song at time `t`, averaged over one row's worth of it, into `out`
	const shape = (out: Float32Array, audio: TrackAudioData | null, t: number, span: number) => {
		out.fill(0);
		const segs = audio?.segments;
		const end = segs && segs.length > 0 ? segs[segs.length - 1].start + segs[segs.length - 1].duration : 0;
		if (!audio || t < 0 || t > end) return;
		out[HUE] = keyHueAt(audio, t);
		let sharp = 0;
		for (let s = -1; s <= 1; s++) {
			const at = t + (s * span) / 3;
			const loud = sampleCurve(audio.loudnessCurve, at);
			const seg = segmentAt(audio.segments, at);
			const amp = (Math.pow(loud, 0.8) * 1.5) / 3;
			out[LEVEL] += loud / 3;
			if (seg) sharp += (1 - Math.min(1, seg.loudness_max_time / 0.12)) / 3;
			for (let k = 0; k < 12; k++) {
				// with no notes to go by, one broad hill
				const w = seg ? Math.pow(seg.pitches[k], 1.5) : 0.35;
				if (w < 0.02) continue;
				for (let i = 0; i < POINTS; i++) out[i] += w * HILLS[k * POINTS + i] * amp;
			}
		}
		// jagged where the sound was sharp, in proportion to the ridge
		for (let i = 0; i < POINTS; i++) out[i] *= 1 + noise(ACROSS[i] * 9, t * 2.2) * sharp * K.JAG;
		// gaussian smoothing along the line; the ends hold their value
		const radius = K.SMOOTH;
		if (radius > 0.05) {
			const reach = Math.ceil(radius * 2);
			for (let i = 0; i < POINTS; i++) {
				let sum = 0;
				let weight = 0;
				for (let d = -reach; d <= reach; d++) {
					const w = Math.exp((-d * d) / (2 * radius * radius));
					sum += out[Math.max(0, Math.min(POINTS - 1, i + d))] * w;
					weight += w;
				}
				BLUR[i] = sum / weight;
			}
			for (let i = 0; i < POINTS; i++) out[i] = BLUR[i];
		}
		for (let i = 0; i < POINTS; i++) out[i] = K.RIDGE_LIMIT * Math.tanh(Math.max(0, out[i]) / K.RIDGE_LIMIT);
	};

	// ---- the grid: where the rows are ----------------------------------------------------------------------
	// 7. rows on accents: a row per segment onset, weighted by its confidence; onsets closer than ROW_GAP_MIN
	// merge, gaps get weightless rows, every bar start is a row. Off: rows on beats and midpoints, equal weight.
	const setGrid = (audio: TrackAudioData | null) => {
		onAccents = FEATURES.accents.on;
		const beat = beatOf(audio);
		const segs = audio?.segments ?? [];
		const beats = audio?.beats ?? [];
		const end = segs.length > 0 ? segs[segs.length - 1].start + segs[segs.length - 1].duration : 600;
		const rows: { t: number; w: number; bar: boolean }[] = [];
		if (onAccents && segs.length > 0) {
			for (const seg of segs) {
				const w = Math.max(0, Math.min(1, seg.confidence ?? 0.5));
				const last = rows[rows.length - 1];
				if (last && seg.start - last.t < beat * K.ROW_GAP_MIN) {
					if (w > last.w) {
						last.t = seg.start;
						last.w = w;
					}
				} else rows.push({ t: seg.start, w, bar: false });
			}
		} else if (beats.length > 1) {
			for (let k = 0; k < beats.length; k++) {
				rows.push({ t: beats[k].start, w: 0.5, bar: false });
				if (k + 1 < beats.length) rows.push({ t: (beats[k].start + beats[k + 1].start) / 2, w: 0.5, bar: false });
			}
		}
		// the bars: the row a bar begins on, or one put there
		let j = 0;
		for (const bar of audio?.bars ?? []) {
			while (j + 1 < rows.length && Math.abs(rows[j + 1].t - bar.start) <= Math.abs(rows[j].t - bar.start)) j++;
			if (rows.length > 0 && Math.abs(rows[j].t - bar.start) < beat * K.ROW_GAP_MIN) rows[j].bar = true;
			else rows.push({ t: bar.start, w: 0.35, bar: true });
		}
		rows.sort((a, b) => a.t - b.t);
		// no holes: before the first row, after the last, and across any stretch with nothing in it
		const filled: typeof rows = [];
		let from = Math.min(0, rows.length > 0 ? rows[0].t : 0) - beat * (K.PAST_BEATS + 1);
		const fill = (to: number) => {
			const n = Math.ceil((to - from) / (beat * K.ROW_GAP_MAX));
			for (let k = 1; k < n; k++) filled.push({ t: from + ((to - from) * k) / n, w: 0, bar: false });
		};
		filled.push({ t: from, w: 0, bar: false });
		for (const r of rows) {
			fill(r.t);
			filled.push(r);
			from = r.t;
		}
		fill(end + beat * (K.FUTURE_BEATS + 1));
		rowTimes = filled.map(r => r.t);
		rowWeights = filled.map(r => r.w);
		rowBars = filled.map(r => r.bar);
	};
	// the last row at or before `t` (-1 if there is none)
	const rowBefore = (t: number) => {
		let lo = -1;
		let hi = rowTimes.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (rowTimes[mid] <= t) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	};
	const showTrack = (audio: TrackAudioData | null) => {
		shown = audio;
		rows.clear();
		gates.clear();
		setGrid(shown);
		played = -1;
	};

	return {
		draw(frame) {
			const { ctx, width, height, isPlaying, colorRgb, audio, progressSec } = frame;
			// paused: draw one frame, then nothing until the track, position, size, a knob or a feature changes
			// (Spotify opens paused). The terrain is placed at the paused moment directly, without the rise.
			const still = isPlaying ? "" : [progressSec, width, height, tuneVersion(), FEATURE_KEYS.map(f => +f.on).join("")].join("|");
			if (!isPlaying) {
				if (audio === pausedFor && still === pausedAt) return;
				pausedFor = audio;
				pausedAt = still;
				if (audio !== shown || Math.abs(progressSec - viewTime) > 0.5) showTrack(audio);
				viewTime = progressSec;
				presence = shown ? 1 : 0;
			} else pausedAt = "";
			const c = conduct(frame);
			const scale = c.scale;

			// ---- which song, and when --------------------------------------------------------------------
			// a new track or a seek sinks the old terrain flat on its own clock, then the new one rises
			if (audio !== shown || Math.abs(progressSec - viewTime) > 0.5) {
				presence += (0 - presence) * Math.min(1, 6 * c.dt);
				viewTime += c.dt;
				if (presence < 0.02) {
					showTrack(audio);
					viewTime = progressSec;
				}
			} else {
				viewTime = progressSec;
				presence += ((shown ? 1 : 0) - presence) * Math.min(1, 1.2 * c.dt);
			}

			// the grid kind was toggled (key 7) or a knob moved: rows made with the old values are stale
			if (onAccents !== FEATURES.accents.on || rowTimes.length === 0 || tuned !== tuneVersion()) {
				if (tuned !== tuneVersion()) setHills();
				tuned = tuneVersion();
				setGrid(shown);
				rows.clear();
				gates.clear();
			}

			const beat = beatOf(shown);
			const step = beat / ROWS_PER_BEAT;
			const zPerSec = (K.Z_NOW - 1) / (K.PAST_BEATS * beat);
			const zFar = K.Z_NOW + K.FUTURE_BEATS * beat * zPerSec;

			// ---- what is coming, measured: the next stretch against the last ----------------------------------
			// loudness of the next twelve beats read off the timeline, not a detector; eased
			lately += (c.loudness - lately) * Math.min(1, 0.35 * c.dt);
			let coming = 0;
			if (shown) for (let k = 0; k < 8; k++) coming += sampleCurve(shown.loudnessCurve, viewTime + beat * (4 + (k * 12) / 7)) / 8;
			ahead += (coming - ahead) * Math.min(1, 2 * c.dt);

			// ---- 5. the camera --------------------------------------------------------------------------------
			// high over loud passages, low over quiet ones, crouching before a build; the horizon moves with it so the
			// move reads. Reads only the two measured levels (geometry never reads the moment detector); eased over ~1.5 s.
			const loud = Math.max(0, Math.min(1, (lately - K.LATELY_QUIET) / (K.LATELY_LOUD - K.LATELY_QUIET)));
			const crouch = Math.max(0, Math.min(1, (ahead - lately) / K.LEAD_FULL));
			const cameraTarget = FEATURES.camera.on ? Math.max(K.CAMERA_LOW, K.CAMERA_LOW + loud * (K.CAMERA_HIGH - K.CAMERA_LOW) - crouch * 0.3) : 1;
			camera += (cameraTarget - camera) * Math.min(1, 0.7 * c.dt);

			// ---- the view ----------------------------------------------------------------------------------
			swayClock += c.dt;
			const cx = width / 2;
			const hy = height * (K.HORIZON + (1 - camera) * 0.2);
			const ground = height * K.GROUND * camera;
			// sizes come from the 16:9 picture that fits the screen; at 16:9 this is exactly width and height
			const ridge = Math.min(height, (width * 9) / 16) * K.RIDGE;
			const half = Math.min(width, (height * 16) / 9) * K.HALF_WIDTH;
			// the camera drifts a little from side to side, which the depth answers with parallax
			const sway = Math.sin(swayClock * 0.2) * width * (FEATURES.camera.on ? 0.085 : 0.05) * K.SWAY;
			const midAt = (z: number) => cx + sway * (1 / z - 1 / K.Z_NOW);
			const baseAt = (z: number) => hy + ground / z;
			// far rows rise out of the fog from flat, not just fade; played rows sink and leave by the front edge
			const farAt = (z: number) => smoothstep((zFar - z) / 0.9);
			const playedAt = (z: number) => (z >= K.Z_NOW ? 1 : smoothstep((z - 1) / (K.Z_NOW - 1)));
			// most of the way down within a beat of being played
			const sunkAt = (tau: number) => (tau >= 0 ? 1 : Math.exp(tau / (beat * 0.7)));

			// ---- colour ------------------------------------------------------------------------------------
			// loudness is read against the band the camera uses (LATELY_*), not 0..1, where most of the palette is never reached
			const pal = palette(COLOURS, frame.palette ?? [colorRgb]);
			const rel = (level: number) => smoothstep((level - K.LATELY_QUIET) / (K.LATELY_LOUD - K.LATELY_QUIET));
			// its own envelope, slower than the line's: the colour follows the passage, not every hit
			soundAt += (rel(c.energy) - soundAt) * Math.min(1, c.dt / 0.8);
			const tint = (loud: number, near: number) => {
				if (COLOURS.follows === "height") return paletteAt(pal, loud);
				if (COLOURS.follows === "depth") return paletteAt(pal, near);
				return paletteAt(pal, soundAt);
			};
			// with a cover palette the line and section rows turn towards the cover's other colours; picked colours as picked
			const grey = pal.every(p => p.s < GREY);
			const turn = COLOURS.mode === "cover" ? 1 : 0;
			const liveHue = keyHue(shown, viewTime, c.dt) * COLOURS.harmony;
			const lit = tint(rel(live[LEVEL]), 1);
			const liveS = grey ? lit.s : Math.min(1, lit.s + 0.08);
			const liveRgb = hslToRgb(familyHue(pal, lit, liveHue, turn), liveS, accentLightness(liveS, Math.min(0.8, lit.l + 0.16)));

			ctx.fillStyle = "rgb(0, 0, 0)";
			ctx.fillRect(0, 0, width, height);
			ctx.lineJoin = "round";
			ctx.lineCap = "round";

			// ---- 1. the glow on the horizon ---------------------------------------------------------------------
			// brightness follows the next twelve beats, colour the coming section. Drawn first so far rows silhouette
			// against it; kept dim because the glow pass blooms whatever is bright.
			const yFar = baseAt(zFar);
			if (FEATURES.horizon.on) {
				const strength = smoothstep((ahead - 0.1) / 0.45) * presence;
				if (strength > 0.01) {
					const far = tint(rel(ahead), 0);
					const lean = FEATURES.grid.on ? keyHueAt(shown, viewTime + K.FUTURE_BEATS * beat * 0.8) * COLOURS.harmony : liveHue;
					skyLean = Number.isNaN(skyLean) || !isPlaying ? lean : skyLean + (lean - skyLean) * Math.min(1, c.dt / 0.6);
					const sky = hslToRgb(familyHue(pal, far, skyLean, turn * 0.3), far.s * 0.85, Math.min(0.7, far.l + 0.05));
					// a low wide band, not a disc: SKY_HEIGHT above the far edge, a third of that below, brightest along the edge
					const across = width * K.SKY_WIDTH;
					for (const up of [height * K.SKY_HEIGHT, -height * K.SKY_HEIGHT * 0.33]) {
						ctx.save();
						ctx.translate(midAt(zFar), yFar);
						ctx.scale(across, up);
						const dawn = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
						const a = K.SKY_BRIGHT * strength;
						dawn.addColorStop(0, rgbString(sky, a));
						dawn.addColorStop(0.2, rgbString(sky, a * 0.6));
						dawn.addColorStop(0.45, rgbString(sky, a * 0.25));
						dawn.addColorStop(0.7, rgbString(sky, a * 0.07));
						dawn.addColorStop(1, rgbString(sky, 0));
						ctx.fillStyle = dawn;
						ctx.fillRect(-1, -1, 2, 1);
						ctx.restore();
					}
				}
			}

			// ---- 6. the dust ------------------------------------------------------------------------------------
			// specks carried at the terrain's speed on the track's clock: short streaks along the line of flight,
			// above the tallest ridge so the terrain never hides one
			if (FEATURES.dust.on && presence > 0.02) {
				const span = K.PAST_BEATS + K.FUTURE_BEATS;
				const light = presence * (0.1 + c.energy * 0.5) * K.DUST_LIGHT;
				ctx.lineWidth = Math.max(1, scale * 0.0011);
				// one stroke per speck: a path's GPU cost goes by the area it spans
				for (let i = 0; i < DUST; i++) {
					const along = (((dust[i * 4 + 2] * span - viewTime / beat) % span) + span) % span;
					const z = K.Z_NOW + (along - K.PAST_BEATS) * beat * zPerSec;
					if (z < 1.02) continue;
					const a = farAt(z) * playedAt(z) * light * dust[i * 4 + 3];
					if (a < 0.015) continue;
					const z2 = z + 0.08;
					ctx.beginPath();
					ctx.moveTo(midAt(z) + (dust[i * 4] * half) / z, baseAt(z) - (dust[i * 4 + 1] * ridge) / z);
					ctx.lineTo(midAt(z2) + (dust[i * 4] * half) / z2, baseAt(z2) - (dust[i * 4 + 1] * ridge) / z2);
					ctx.strokeStyle = rgbString(liveRgb, Math.min(0.42, a * 1.2));
					ctx.stroke();
				}
			}

			// ---- one row: its body, so it hides what is behind, then its line -----------------------------------
			// one path serves both: fill() closes it along the baseline, stroke() leaves the line without a bottom edge.
			// The flat ground to either side is two straight lines.
			//   flat     how much of its height it still has (what has been played sinks)
			//   alpha    the line's strength
			//   glint    how brightly its body is lit from "now" (4)
			const row = (data: Float32Array, z: number, flat: number, alpha: number, lineWidth: number, lean: number, level: number, glint: number, turned = 0) => {
				const yBase = baseAt(z);
				const lift = (ridge / z) * flat * presence;
				const mid = midAt(z);
				const kx = half / z;
				// the mountains live between these two; outside them the row is flat ground
				const x0 = mid - kx;
				const x1 = mid + kx;
				// beyond FINE_UNTIL every other point is drawn
				const stride = z > K.FINE_UNTIL ? 2 : 1;
				ctx.beginPath();
				ctx.moveTo(x0, yBase);
				for (let i = 0; i < POINTS; i += stride) ctx.lineTo(mid + ACROSS[i] * kx, yBase - data[i] * lift);
				ctx.lineTo(x1, yBase);

				// ---- 3. colour by height, the row's own colour ----
				// hue is the section's, depth removes saturation (haze), the row's loudness sets lightness
				const far = Math.max(0, Math.min(1, (z - K.Z_NOW) / (zFar - K.Z_NOW)));
				const base = tint(rel(level), 1 - far);
				const sat = base.s * 0.9 * (FEATURES.height.on ? 1 - far * 0.45 : 1);
				const hue = familyHue(pal, base, lean, turned);
				const rgb = hslToRgb(hue, sat, base.l * (FEATURES.height.on ? 0.42 + level * 0.5 : 0.55 + level * 0.6));

				// ---- 4. lit mountains ----
				// body faintly lit from the ridge down: the light goes in the colour, never the alpha, or it stops hiding
				// the rows behind. Kept dim so the glow pass leaves it alone.
				const solid = Math.min(1, flat * 1.5);
				if (FEATURES.lit.on && glint > 0.03 && lift > 3) {
					const body = ctx.createLinearGradient(0, yBase - lift * 1.1, 0, yBase);
					body.addColorStop(0, rgbString({ r: rgb.r * glint, g: rgb.g * glint, b: rgb.b * glint }, solid));
					body.addColorStop(1, rgbString(BLACK, solid));
					ctx.fillStyle = body;
				} else ctx.fillStyle = rgbString(BLACK, solid);
				ctx.fill();
				if (alpha < 0.004) return;

				// ---- 3. colour by height, the peaks ----
				// one gradient stroke up the screen (a second stroke costs a quarter of the frame); no height, flat colour
				ctx.lineWidth = lineWidth;
				if (FEATURES.height.on && lift > 3) {
					const pale = hslToRgb(hue, sat * 0.55, Math.min(0.9, base.l + 0.26));
					const up = ctx.createLinearGradient(0, yBase, 0, yBase - lift * 1.15);
					up.addColorStop(0, rgbString(rgb, alpha));
					up.addColorStop(1, rgbString(pale, Math.min(1, alpha * 1.7)));
					ctx.strokeStyle = up;
				} else ctx.strokeStyle = rgbString(rgb, alpha);
				ctx.stroke();

				// flat ground to either side: two straight pieces that run out and fade, so the terrain has no cut ends
				const left = mid - K.SIDE * kx;
				const right = mid + K.SIDE * kx;
				ctx.beginPath();
				ctx.moveTo(left, yBase);
				ctx.lineTo(x0, yBase);
				ctx.moveTo(x1, yBase);
				ctx.lineTo(right, yBase);
				const fade = ctx.createLinearGradient(left, 0, right, 0);
				fade.addColorStop(0, rgbString(rgb, 0));
				fade.addColorStop((K.SIDE - 1) / (K.SIDE * 2), rgbString(rgb, alpha));
				fade.addColorStop((K.SIDE + 1) / (K.SIDE * 2), rgbString(rgb, alpha));
				fade.addColorStop(1, rgbString(rgb, 0));
				ctx.strokeStyle = fade;
				ctx.stroke();
			};

			// ---- the line at "now" --------------------------------------------------------------------------
			shape(target, shown, viewTime, step);
			const chase = Math.min(1, 14 * c.dt);
			// (paused, it is simply where it would have got to)
			for (let i = 0; i < POINTS + 2; i++) live[i] += (target[i] - live[i]) * (isPlaying ? chase : 1);
			// the body takes its place in the terrain; the line is drawn last, over the rows in front of it
			const drawLive = () => row(live, K.Z_NOW, 1, 0, 1, liveHue, live[LEVEL], 0.14 + c.energy * 0.3, turn);

			// ---- a sound has just been played: the mountains as they stand now are its echo ---------------------
			const segs = shown?.segments;
			let count = 0;
			if (segs && segs.length > 0 && segs[0].start <= viewTime) {
				let lo = 0;
				let hi = segs.length - 1;
				while (lo < hi) {
					const mid = (lo + hi + 1) >> 1;
					if (segs[mid].start <= viewTime) lo = mid;
					else hi = mid - 1;
				}
				count = lo + 1;
			}
			if (played >= 0 && count > played && count - played <= 3 && segs) {
				const seg = segs[count - 1];
				const echo = echoes.length < ECHO_MAX ? { data: new Float32Array(POINTS), age: 0, amp: 0 } : echoes.shift()!;
				// `target`, not the eased line: the shape this sound has
				echo.data.set(target.subarray(0, POINTS));
				echo.age = 0;
				echo.amp = Math.min(1.2, Math.pow(10, seg.loudness_max / 20) / (shown?.hitScale || 0.56));
				echoes.push(echo);
			}
			played = count;

			// ---- 2. bars and section gates, the gates -------------------------------------------------------------
			// a row exactly on each section boundary, in the pale colour of the section it opens: a line and a colour only,
			// since sections are a timbral segmentation that can miss choruses; unsure boundaries are fainter.
			const sections = FEATURES.grid.on ? shown?.sections : undefined;
			let gate = -1;
			if (sections) for (let i = sections.length - 1; i >= 1; i--) if (sections[i].start <= viewTime + K.FUTURE_BEATS * beat) {
				gate = i;
				break;
			}
			const gatesBehind = (time: number) => {
				while (sections && gate >= 1 && sections[gate].start >= time) {
					const at = sections[gate].start;
					const tau = at - viewTime;
					const z = K.Z_NOW + tau * zPerSec;
					if (z >= 1 && z <= zFar) {
						let data = gates.get(gate);
						if (!data) {
							data = new Float32Array(POINTS + 2);
							shape(data, shown, at, step);
							gates.set(gate, data);
						}
						const sure = 0.35 + Math.min(1, sections[gate].confidence) * 0.65;
						row(data, z, playedAt(z) * sunkAt(tau) * farAt(z), farAt(z) * playedAt(z) * 0.85 * sure, Math.max(1.2, (scale * 0.003 * K.Z_NOW) / z), data[HUE] * COLOURS.harmony, 1, 0, turn);
					}
					gate--;
				}
			};

			// ---- the terrain, far to near ------------------------------------------------------------------------
			const nearest = Math.max(0, rowBefore(viewTime - K.PAST_BEATS * beat));
			const furthest = Math.min(rowTimes.length - 1, rowBefore(viewTime + K.FUTURE_BEATS * beat) + 1);
			for (const n of rows.keys()) if (n < nearest || n > furthest) rows.delete(n);
			let liveDrawn = false;
			for (let n = furthest; n >= nearest; n--) {
				const time = rowTimes[n];
				const tau = time - viewTime;
				if (!liveDrawn && tau < 0) {
					gatesBehind(viewTime);
					drawLive();
					liveDrawn = true;
				}
				const z = K.Z_NOW + tau * zPerSec;
				if (z < 1 || z > zFar) continue;
				let data = rows.get(n);
				if (!data) {
					data = new Float32Array(POINTS + 2);
					// averaged over the row's own stretch: half the way to its neighbours, at most a half-beat
					const reach = Math.min(step, (rowTimes[Math.min(rowTimes.length - 1, n + 1)] - rowTimes[Math.max(0, n - 1)]) / 2);
					shape(data, shown, time, Math.max(0.03, reach));
					rows.set(n, data);
				}
				gatesBehind(time);
				const seen = farAt(z) * playedAt(z);
				// a row brightens as it comes under the playhead: the beat, crossing "now"
				const crossing = Math.exp(-Math.pow(tau / (beat * 0.35), 2));
				const level = data[LEVEL];
				// ---- 2. bars and section gates, the bars ----
				// the first beat of a bar is a little brighter and heavier
				const bar = FEATURES.grid.on && rowBars[n];
				// an accent is heavier and brighter; a filler row is faintest
				const weight = rowWeights[n];
				// how near "now" it is: what lights its body (4)
				const near = Math.exp(-Math.pow(tau / (beat * 2), 2));
				row(
					data,
					z,
					playedAt(z) * sunkAt(tau) * farAt(z),
					seen * (0.07 + level * 0.42 + weight * 0.3 + crossing * 0.3 + (bar ? 0.2 : 0)),
					Math.max(1, (scale * (bar ? 0.0028 : 0.0012 + weight * 0.0012) * K.Z_NOW) / z),
					FEATURES.grid.on ? data[HUE] * COLOURS.harmony : liveHue,
					level,
					near * (0.06 + c.energy * 0.22)
				);
			}
			if (!liveDrawn) {
				gatesBehind(viewTime);
				drawLive();
			}
			gatesBehind(-1e9);

			// ---- the echoes: a skin stretched between the line and where the mountains stood ---------------------
			// never below the line nor apart from it: it lifts off only where the mountain was
			const yNow = baseAt(K.Z_NOW);
			const liftNow = (ridge / K.Z_NOW) * presence;
			const life = K.ECHO_BEATS * beat;
			for (let i = 0; i < POINTS; i++) xs[i] = midAt(K.Z_NOW) + (ACROSS[i] * half) / K.Z_NOW;
			ctx.save();
			ctx.globalCompositeOperation = "lighter";
			for (let e = echoes.length - 1; e >= 0; e--) {
				const echo = echoes[e];
				echo.age += c.dt;
				const t = echo.age / life;
				if (t >= 1) {
					echoes.splice(e, 1);
					continue;
				}
				// it arrives over a few frames rather than appearing, and leaves slower than it came
				const a = smoothstep(echo.age / 0.04) * (1 - t) * (1 - t) * Math.min(1, 0.2 + echo.amp * 0.6) * presence;
				if (a < 0.01) continue;
				const swell = 1 + (1 - (1 - t) * (1 - t)) * (K.ECHO_SWELL_SOFT + Math.min(1, echo.amp) * (K.ECHO_SWELL_HARD - K.ECHO_SWELL_SOFT));
				// the skin: from the echo down to the line
				ctx.beginPath();
				for (let i = 0; i < POINTS; i++) {
					const y = yNow - Math.max(echo.data[i] * swell, live[i]) * liftNow;
					if (i === 0) ctx.moveTo(xs[i], y);
					else ctx.lineTo(xs[i], y);
				}
				for (let i = POINTS - 1; i >= 0; i--) ctx.lineTo(xs[i], yNow - live[i] * liftNow);
				ctx.closePath();
				ctx.fillStyle = rgbString(liveRgb, a * 0.22);
				ctx.fill();
				// its edge: only where it stands off the line, leaving the line and coming back to it
				ctx.beginPath();
				let off = false;
				for (let i = 0; i < POINTS; i++) {
					const h = echo.data[i] * swell;
					if (h > live[i] + 0.004) {
						if (!off) ctx.moveTo(xs[Math.max(0, i - 1)], yNow - live[Math.max(0, i - 1)] * liftNow);
						ctx.lineTo(xs[i], yNow - h * liftNow);
						off = true;
					} else if (off) {
						ctx.lineTo(xs[i], yNow - live[i] * liftNow);
						off = false;
					}
				}
				ctx.strokeStyle = rgbString(liveRgb, a * 0.85);
				ctx.lineWidth = Math.max(1, scale * 0.0026 * (1 - t * 0.5));
				ctx.stroke();
			}
			ctx.restore();

			const lineRight = midAt(K.Z_NOW) + (K.SIDE * half) / K.Z_NOW;
			const lineLeft = midAt(K.Z_NOW) - (K.SIDE * half) / K.Z_NOW;

			// ---- the waveform itself, on top -------------------------------------------------------------------------
			ctx.beginPath();
			ctx.moveTo(lineLeft, yNow);
			for (let i = 0; i < POINTS; i++) ctx.lineTo(xs[i], yNow - live[i] * liftNow);
			ctx.lineTo(lineRight, yNow);
			ctx.strokeStyle = rgbString(liveRgb, 0.95);
			ctx.lineWidth = Math.max(1.5, scale * 0.0042) * K.LINE;
			ctx.stroke();

			// the halo swells with the sound itself and with a moment
			glow(ctx, ctx.canvas, width, height, scale, (0.3 + c.energy * 0.6 + c.impact * 0.5) * K.GLOW);
		},
		dispose() {
			rows.clear();
			gates.clear();
			glow.dispose();
		}
	};
}

export const ridgePreset: PresetDefinition = { id: "ridge", name: "Ridgeline", create };
