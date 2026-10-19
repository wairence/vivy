// Layers 3D. The same music-to-picture logic as Layers III - three layers on one wind, one mark per
// sound lit before the sound, a mark combing the field it passes through - in a real volume, drawn
// by a real camera. Two attempts at faking depth on the flat picture (a slab that swung, then a
// parallax orbit) could not be seen at all, so this one is not a projection of the old picture: the
// particles LIVE in three dimensions and their trails are ribbons in space, redrawn from the
// camera's place every frame.
//
//   the cloud    a sphere of strokes. The camera sits INSIDE it and orbits its centre, so near
//                strokes sweep one way and far ones the other - parallax, which is what depth is.
//   the ground   wide dim ribbons, ~8 s life. The loudness of the last ten seconds.
//   the sheet    hairlines, ~3 s life. The loudness now.
//   the marks    one per sound, placed where the camera can see it, shaped by that sound.
//
// The rules are Layers III's (DESIGN-RULES): one wind and bounded offsets from it, geometry never
// steps, the only coupling is a mark's wake, time in beats of the track.
//
// Drawn with WebGL into its own canvas and composited onto the frame's 2D context, because a trail
// that is a ribbon in space has to be redrawn whole every frame - ten thousand segments, which the
// 2D canvas cannot stroke at 144 Hz.
import { createNoise3D } from "simplex-noise";
import { createGlow, createKeyHue, shimmerPhase, shimmerTint } from "./effects";
import { createConductor, Hsl, hslToRgb, publishDiagnostics } from "./flowfield-common";
import { colourSettings, palette, paletteAt } from "../colours";
import { createNextSound } from "./next-sound";
import { Preset, PresetDefinition } from "./types";
import { tune } from "./tune";

// ---- the scene, in world units -----------------------------------------------------------------------
// the cloud's radius, and how far inside its surface a stroke starts to fade before it is recycled
const CLOUD = 2.496;
const CLOUD_EDGE = 0.3849;
// the camera: how far from the centre it orbits, how high it sways, and its vertical field of view
const ORBIT_RADIUS = 1.23;
const ORBIT_SWAY = 0.4;
// It does not stare at the centre: the point it looks at wanders this far about the middle of the
// cloud (and the orbit breathes in and out), or the middle of the picture is a fixed, distant pole
// with everything turning round it
const LOOK_WANDER = 0.4;
const FOCAL = 1.458; // 1 / tan(fov / 2), ~66 degrees
// the orbit's speed, rad/s: at rest, and per unit of loudness. A turn every ~40 s at a normal level
const ORBIT_REST = 0.0425;
const ORBIT_LOUD = 0.315;
// a stroke dissolves before it reaches the lens, and into the distance
// (projection is clamped at NEAR; light is already zero by NEAR_DARK, well short of it, so no visible
// point is ever joined to one whose place on screen is the clamp's)
const NEAR = 0.1;
const NEAR_DARK = 0.2076;
const NEAR_CLEAR = 0.731;
const FOG_START = 1.744;
const FOG_END = 3.588;

// ---- populations ---------------------------------------------------------------------------------------
const GROUND_COUNT = 520;
const SHEET_COUNT = 1000;
const MARK_POOL = 220;
// points in every ribbon, and how long each layer's ribbon is in seconds
const TRAIL = 12;
// ...of which the first two are its NOSE: a ribbon's leading end is rounded off, not cut square
const TAIL = TRAIL - 2;
// places remembered per particle: one more than is drawn, so every drawn point can sit at an EXACT
// age between two remembered ones (see `ribbon`)
const RING = TRAIL + 1;
const GROUND_TRAIL = 1.292;
const SHEET_TRAIL = 0.4625;
const MARK_TRAIL = 0.3465;

// ---- the wind, and the flow around it ------------------------------------------------------------------
// THE FLOW is curl noise (Bridson 2007): the curl of a noise potential, which has no sources and no
// sinks. The flat presets' "wind plus two noise offsets" is not that - it herds strokes into ropes
// and leaves holes, which a 2D trail hides and a volume does not. How far off the wind the flow may
// carry a stroke is bounded, so nothing ever flies backwards.
const FLOW_MAX = 0.6496;
// how hard the flow carries a mark off the wind (the ground's and the sheet's are the background's)
const MARK_SPREAD_MAX = 1.5;
// a stroke's place in the flow is re-read every this many frames (staggered across the population),
// and its momentum carries it between - nine noise reads a stroke would otherwise be most of a frame
const FLOW_EVERY = 4;
// INERTIA: how long a stroke takes to come round to what the flow asks of it, seconds. In the flat
// presets a heading was recomputed from nothing every frame and nobody could tell, because a trail
// there is a tenth of a second long. A ribbon here is the last half second or more of the path, laid
// out in space - every change of mind is drawn. Measured before this existed: the sheet reversed its
// turn 0.82 times a second in unison, the marks turned at up to 0.86 rad/s.
const GROUND_INERTIA = 1.62;
const SHEET_INERTIA = 1.067;
const MARK_INERTIA = 0.8696;

// ---- the wake ---------------------------------------------------------------------------------------------
// how far a mark reaches into the field around it, world units; how far the field turns into its
// heading (as a bounded offset from the wind, never a blend of two directions) and how fast that
// offset may change; how much the field hurries
const CUT_RADIUS = 0.7279;
const WAKE_TURN = 0.5925;
const WAKE_RATE = 0.9575;
const WAKE_HURRY = 0.9225;

// ---- the marks ----------------------------------------------------------------------------------------------
const MARK_BASE_SPEED = 0.2625;
const FLING = 0.7949;
const FLING_RANK = 1.403;
// how near the camera a mark may be born, and how far
const MARK_NEAR = 0.6;
const MARK_FAR = 2.7;
// A NEAR MARK FLIES IN FROM OFF SCREEN. Lit where it stands, a big near mark is a thing appearing in
// mid-air; so the nearer ones (this far along the near-far axis, and nearer) start just past the edge
// of the picture, upwind of the place their sound belongs, and are carried in across it as they
// light. The far ones are small enough to come up where they are - and a sky where everything enters
// from one side would be a pattern of its own. The margin is in half-heights of the screen.
const FLY_IN_NEARER = 0.4775;
const FLY_IN_MARGIN = 0.04;

// ---- light ----------------------------------------------------------------------------------------------------
const GROUND_ALPHA_CAP = 0.75;
const SHEET_ALPHA_CAP = 0.9;
const MARK_ALPHA_CAP = 0.95;
// a mark's star is never bigger than this, as a fraction of the screen's height
const MAX_STAR = 0.065;
// ribbon half-widths, world units
const GROUND_WIDTH = 0.005862;
const SHEET_WIDTH = 0.003571;
const MARK_WIDTH = 0.004;
// no ribbon is drawn wider than this, as a fraction of the screen's height: perspective alone makes a
// stroke near the lens a flat band across the picture, which reads as paper, not as light
const MAX_HALF_WIDTH = 0.004117;
// live knobs (T in the client): every one starts at the constant above and is read each frame
const K = tune("layers3d", {
	ORBIT_RADIUS: [ORBIT_RADIUS, 0.3, 2.5, "orbit distance", "camera"],
	ORBIT_SWAY: [ORBIT_SWAY, 0, 1.2, "how high it sways"],
	LOOK_WANDER: [LOOK_WANDER, 0, 1.2, "gaze wanders off centre"],
	FOCAL: [FOCAL, 0.6, 3, "lens: higher is narrower"],
	ORBIT_REST: [ORBIT_REST, 0, 0.2, "turn speed when quiet"],
	ORBIT_LOUD: [ORBIT_LOUD, 0, 1, "turn speed added by loudness"],
	NEAR_DARK: [NEAR_DARK, 0.12, 0.6, "dark this near the lens", "depth"],
	NEAR_CLEAR: [NEAR_CLEAR, 0.65, 2, "clear from this far"],
	FOG_START: [FOG_START, 0.5, 3, "fog starts"],
	FOG_END: [FOG_END, 3.05, 6, "fog is total"],
	CLOUD: [CLOUD, 0.8, 4, "size of the cloud"],
	CLOUD_EDGE: [CLOUD_EDGE, 0.05, 1, "fade at its edge"],
	GROUND_TRAIL: [GROUND_TRAIL, 0.2, 4, "ground ribbon length, s", "motion"],
	SHEET_TRAIL: [SHEET_TRAIL, 0.1, 3, "sheet ribbon length, s"],
	MARK_TRAIL: [MARK_TRAIL, 0.1, 3, "mark ribbon length, s"],
	FLOW_MAX: [FLOW_MAX, 0.05, 2, "how far the flow carries off the wind"],
	MARK_SPREAD_MAX: [MARK_SPREAD_MAX, 0, 3, "marks off the wind"],
	GROUND_INERTIA: [GROUND_INERTIA, 0.05, 4, "ground heaviness, s"],
	SHEET_INERTIA: [SHEET_INERTIA, 0.05, 4, "sheet heaviness, s"],
	MARK_INERTIA: [MARK_INERTIA, 0.05, 4, "mark heaviness, s"],
	CUT_RADIUS: [CUT_RADIUS, 0.05, 1.5, "how far a mark stirs the field", "wake"],
	WAKE_TURN: [WAKE_TURN, 0, 1.5, "how hard it turns the field"],
	WAKE_RATE: [WAKE_RATE, 0.1, 5, "how fast that turn may change"],
	WAKE_HURRY: [WAKE_HURRY, 0, 3, "how much the field hurries"],
	MARK_BASE_SPEED: [MARK_BASE_SPEED, 0, 1.5, "mark speed", "marks"],
	FLING: [FLING, 0.05, 3, "how hard a hit throws a mark"],
	FLING_RANK: [FLING_RANK, 0, 3, "throw of a mark in a run"],
	MARK_NEAR: [MARK_NEAR, 0.2, 2, "nearest a mark is born"],
	MARK_FAR: [MARK_FAR, 0.6, 5, "furthest a mark is born"],
	FLY_IN_NEARER: [FLY_IN_NEARER, 0, 1, "nearer than this flies in from off screen"],
	FLY_IN_MARGIN: [FLY_IN_MARGIN, 0, 0.5, "how far off screen it starts"],
	GROUND_ALPHA_CAP: [GROUND_ALPHA_CAP, 0, 1, "ground brightest", "light"],
	SHEET_ALPHA_CAP: [SHEET_ALPHA_CAP, 0, 1, "sheet brightest"],
	MARK_ALPHA_CAP: [MARK_ALPHA_CAP, 0, 1, "mark brightest"],
	MAX_STAR: [MAX_STAR, 0, 0.2, "biggest star of a mark"],
	GROUND_WIDTH: [GROUND_WIDTH, 0.0005, 0.02, "ground ribbon width"],
	SHEET_WIDTH: [SHEET_WIDTH, 0.0005, 0.02, "sheet ribbon width"],
	MARK_WIDTH: [MARK_WIDTH, 0.0005, 0.02, "mark ribbon width"],
	MAX_HALF_WIDTH: [MAX_HALF_WIDTH, 0.001, 0.03, "no ribbon wider than"],
	GLOW: [1, 0, 2.5, "halo strength", "look"]
	},
	// what each one does, shown beside the panel on hover
	{
		ORBIT_RADIUS: "How far the viewpoint is from the middle of the cloud as it circles. Higher pulls out and shows more of the cloud; lower goes deep inside.",
		ORBIT_SWAY: "How far the viewpoint drifts up and down while it circles. Higher gives a bigger, slower rise and fall.",
		LOOK_WANDER: "How much the view drifts away from the centre of the cloud. Zero stares dead at the middle; higher wanders around it.",
		FOCAL: "Lens zoom. Higher zooms in and narrows the view, making everything bigger; lower gives a wide-angle view.",
		ORBIT_REST: "How fast the view turns around the cloud when the music is quiet. Zero stops it; higher keeps it moving in silence.",
		ORBIT_LOUD: "How much louder music speeds up the turning. Higher makes loud parts spin the view noticeably faster.",
		NEAR_DARK: "Distance from the viewpoint inside which strokes are invisible. Higher hides more of what is close up.",
		NEAR_CLEAR: "Distance at which strokes reach full brightness. Higher makes near strokes fade in more gradually, lower makes them show up sooner.",
		FOG_START: "Distance where strokes start to dim into the distance. Higher keeps far strokes bright for longer.",
		FOG_END: "Distance where strokes have faded out completely. Higher lets you see further into the cloud; lower hides the far side.",
		CLOUD: "Size of the cloud of strokes. Higher fills a bigger space with the same strokes, so it looks sparser; lower packs it tighter.",
		CLOUD_EDGE: "How softly strokes fade out as they reach the edge of the cloud. Higher gives a gentler edge; lower a sharper one.",
		GROUND_TRAIL: "Length of the wide, dim ribbons that follow the loudness of the last ten seconds. Higher makes them longer.",
		SHEET_TRAIL: "Length of the thin hairlines that follow the loudness right now. Higher makes them longer streaks.",
		MARK_TRAIL: "Length of the tail behind each bright mark. Higher makes longer comet tails.",
		FLOW_MAX: "How far the swirling flow can push strokes off their main direction. Higher gives more curling and tangled motion; lower is straighter.",
		MARK_SPREAD_MAX: "How far the bright marks are swirled off the main direction. Zero sends them straight; higher makes them curve more.",
		GROUND_INERTIA: "How slowly the wide ribbons change direction. Higher makes them turn in long, lazy curves; lower makes them twitchy.",
		SHEET_INERTIA: "How slowly the thin hairlines change direction. Higher makes them turn in long, lazy curves; lower makes them twitchy.",
		MARK_INERTIA: "How slowly the bright marks change direction. Higher makes them turn in long, lazy curves; lower makes them twitchy.",
		CUT_RADIUS: "How far around a bright mark the surrounding strokes are disturbed. Higher stirs a bigger patch of the cloud.",
		WAKE_TURN: "How strongly a passing mark bends the strokes near it into its direction. Zero leaves them alone.",
		WAKE_RATE: "How quickly the nearby strokes swing round after a mark. Higher makes them snap over; lower makes them follow slowly.",
		WAKE_HURRY: "How much a passing mark speeds up the strokes near it. Zero keeps them at the same pace.",
		MARK_BASE_SPEED: "How fast the bright marks travel. Higher makes them dash across; zero makes them hang in place.",
		FLING: "How hard a hit throws its mark. Higher sends marks of loud, sharp sounds flying much faster.",
		FLING_RANK: "How hard each mark in a rapid run of sounds is thrown. Higher makes runs of notes shoot out faster.",
		MARK_NEAR: "How close to the viewer a mark may appear. Lower lets marks come up big and close; higher keeps them away.",
		MARK_FAR: "How far from the viewer a mark may appear. Higher lets marks appear small and far off; lower keeps them all close.",
		FLY_IN_NEARER: "Marks closer than this fly in from off screen instead of appearing in place. Zero makes all fly in, one makes all appear in place.",
		FLY_IN_MARGIN: "How far past the screen edge a flying-in mark begins. Higher makes it travel further before coming into view.",
		GROUND_ALPHA_CAP: "Brightest the wide, dim ribbons can get. Higher makes the background haze stronger; zero hides it.",
		SHEET_ALPHA_CAP: "Brightest the thin hairlines can get. Higher makes them stand out; zero hides them.",
		MARK_ALPHA_CAP: "Brightest the marks can get. Lower dims even the loudest hits; zero hides the marks.",
		MAX_STAR: "Largest size of the glowing spot at the head of a mark. Higher lets loud hits flare big; zero removes the spots.",
		GROUND_WIDTH: "Thickness of the wide, dim ribbons. Higher makes them fatter.",
		SHEET_WIDTH: "Thickness of the thin hairlines. Higher makes them heavier lines.",
		MARK_WIDTH: "Thickness of the tail behind each mark. Higher makes it thicker.",
		MAX_HALF_WIDTH: "Widest any ribbon may look on screen, however close. Lower stops close strokes turning into broad bands.",
		GLOW: "The soft halo around the light. Zero is clean and sharp; higher blooms every mark into a cloud."
	},
	// shown without "More"; the rest is for whoever wants to dig
	["FOCAL", "ORBIT_REST", "ORBIT_LOUD", "CLOUD", "MARK_TRAIL", "FLOW_MAX", "MAX_STAR", "GLOW"]
);


type Rgb = { r: number; g: number; b: number };

type Particle = {
	x: number;
	y: number;
	z: number;
	life: number;
	brightness: number;
	// its own speed, fixed for life: variety lives in the population. Without it every hairline is
	// the same length going the same way, which is a hatching and not a flow
	pace: number;
	// how much a passing mark is lighting it, eased
	lit: number;
	// the wake it sits in, eased, and how far its heading is pulled into it - a stored offset under a rate cap
	wx: number;
	wy: number;
	wz: number;
	// the way it is flying, in units of its layer's speed: it comes round to what the flow asks, and is
	// never set to it. All zero = it has just been put somewhere and takes the flow as it finds it
	hx: number;
	hy: number;
	hz: number;
	// what the flow last asked of it here, off the wind (re-read every FLOW_EVERY frames)
	gx: number;
	gy: number;
	gz: number;
	tx: number;
	ty: number;
	tz: number;
	// what it is drawn with this frame
	alpha: number;
};

type Mark = Particle & {
	chase: number;
	breadth: number;
	soft: number;
	boost: number;
	age: number;
	rise: number;
	decay: number;
	fling: number;
	charge: number;
	power: number;
	streak: number;
	// where it sits on the palette when the colours follow the sounds: how ringing its sound was
	tone: number;
	// where it is in the picture: across and up in half-heights of the screen
	vx: number;
	vy: number;
};

// one layer's ribbons: the last TRAIL places of every particle, in world space, as a ring
type Trail = { points: Float32Array; head: number; clock: number; step: number };

// what the gradient can follow here (see colours.ts and the colour block in draw)
const COLOURS = colourSettings("layers3d", [
	["layers", "Layers", "The haze, the hairlines and the marks take one colour each, first to last"],
	["depth", "Depth", "Far away takes the first colour, up close the last"],
	["sounds", "Sounds", "Each mark by its sound: dull sounds the first colour, ringing ones the last"],
	["music", "Music", "Everything slides along the colours with how loud the music is"]
]);

const smoothstep = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const shortest = (d: number) => ((d + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

const RIBBON_VS = `
attribute vec2 a_pos;
attribute float a_alpha;
attribute float a_side;
attribute float a_tone;
uniform vec2 u_res;
varying float v_alpha;
varying float v_side;
varying float v_tone;
void main() {
	v_alpha = a_alpha;
	v_side = a_side;
	v_tone = a_tone;
	gl_Position = vec4(a_pos.x / u_res.x * 2.0 - 1.0, 1.0 - a_pos.y / u_res.y * 2.0, 0.0, 1.0);
}`;
// soft across its width, so a ribbon has no hard edge at any size
const RIBBON_FS = `
precision mediump float;
uniform vec3 u_color;
uniform vec3 u_near;
varying float v_alpha;
varying float v_side;
varying float v_tone;
void main() {
	float e = 1.0 - v_side * v_side;
	gl_FragColor = vec4(mix(u_color, u_near, v_tone) * v_alpha * e, 1.0);
}`;
const HEAD_VS = `
attribute vec2 a_pos;
attribute vec2 a_uv;
attribute float a_alpha;
attribute float a_hot;
attribute float a_tone;
uniform vec2 u_res;
uniform vec3 u_color;
uniform vec3 u_near;
varying vec2 v_uv;
varying float v_alpha;
varying float v_hot;
varying vec3 v_color;
void main() {
	v_uv = a_uv;
	v_alpha = a_alpha;
	v_hot = a_hot;
	v_color = mix(u_color, u_near, a_tone);
	gl_Position = vec4(a_pos.x / u_res.x * 2.0 - 1.0, 1.0 - a_pos.y / u_res.y * 2.0, 0.0, 1.0);
}`;
// a crack burns white-hot and tight, a voice glows soft and wide
const HEAD_FS = `
precision mediump float;
varying vec2 v_uv;
varying float v_alpha;
varying float v_hot;
varying vec3 v_color;
void main() {
	vec3 u_color = v_color;
	float r = length(v_uv);
	float glow = pow(max(0.0, 1.0 - r), 2.2);
	float core = exp(-r * r * 60.0);
	vec3 c = u_color * glow * (0.75 - v_hot * 0.3) + mix(u_color, vec3(1.0), 0.75) * core * v_hot * 1.4;
	gl_FragColor = vec4(c * v_alpha, 1.0);
}`;

type Renderer = {
	canvas: HTMLCanvasElement;
	// a GPU reset, a driver update, sleep: the context goes, and everything made in it with it
	lost: () => boolean;
	draw: (width: number, height: number, layers: { verts: Float32Array; count: number; rgb: Rgb; near: Rgb }[], heads: Float32Array, headCount: number, headRgb: Rgb, headNear: Rgb) => void;
};

// null wherever there is no WebGL - the headless check harness, or a client with it switched off. The
// simulation and the geometry still run there, so their numbers are still checked.
function createRenderer(maxParticles: number): Renderer | null {
	if (typeof document === "undefined") return null;
	const canvas = document.createElement("canvas");
	const gl = canvas.getContext("webgl", { alpha: false, antialias: true, premultipliedAlpha: false }) as WebGLRenderingContext | null;
	if (!gl || typeof gl.createShader !== "function") return null;

	const program = (vs: string, fs: string) => {
		const p = gl.createProgram()!;
		for (const [type, src] of [
			[gl.VERTEX_SHADER, vs],
			[gl.FRAGMENT_SHADER, fs]
		] as const) {
			const s = gl.createShader(type)!;
			gl.shaderSource(s, src);
			gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("layers3d shader: " + gl.getShaderInfoLog(s));
			gl.attachShader(p, s);
		}
		gl.linkProgram(p);
		return p;
	};
	const ribbon = program(RIBBON_VS, RIBBON_FS);
	const head = program(HEAD_VS, HEAD_FS);
	const vbo = gl.createBuffer()!;

	// every ribbon is the same strip of TRAIL points; every head the same quad
	const ribbonIndex = new Uint16Array(maxParticles * (TRAIL - 1) * 6);
	for (let p = 0, o = 0; p < maxParticles; p++) {
		for (let j = 0; j < TRAIL - 1; j++) {
			const v = (p * TRAIL + j) * 2;
			ribbonIndex[o++] = v;
			ribbonIndex[o++] = v + 1;
			ribbonIndex[o++] = v + 2;
			ribbonIndex[o++] = v + 1;
			ribbonIndex[o++] = v + 3;
			ribbonIndex[o++] = v + 2;
		}
	}
	const ribbonIbo = gl.createBuffer()!;
	gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ribbonIbo);
	gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ribbonIndex, gl.STATIC_DRAW);
	const headIndex = new Uint16Array(MARK_POOL * 6);
	for (let q = 0, o = 0; q < MARK_POOL; q++) {
		const v = q * 4;
		headIndex[o++] = v;
		headIndex[o++] = v + 1;
		headIndex[o++] = v + 2;
		headIndex[o++] = v + 1;
		headIndex[o++] = v + 3;
		headIndex[o++] = v + 2;
	}
	const headIbo = gl.createBuffer()!;
	gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, headIbo);
	gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, headIndex, gl.STATIC_DRAW);

	const attr = (p: WebGLProgram, name: string, size: number, stride: number, offset: number) => {
		const loc = gl.getAttribLocation(p, name);
		gl.enableVertexAttribArray(loc);
		gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, offset * 4);
	};

	return {
		canvas,
		lost: () => gl.isContextLost(),
		draw(width, height, layers, heads, headCount, headRgb, headNear) {
			if (canvas.width !== width || canvas.height !== height) {
				canvas.width = width;
				canvas.height = height;
			}
			gl.viewport(0, 0, width, height);
			gl.clearColor(0, 0, 0, 1);
			gl.clear(gl.COLOR_BUFFER_BIT);
			// light adds: a ribbon over a ribbon is brighter, never an occlusion
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.ONE, gl.ONE);
			gl.bindBuffer(gl.ARRAY_BUFFER, vbo);

			gl.useProgram(ribbon);
			gl.uniform2f(gl.getUniformLocation(ribbon, "u_res"), width, height);
			gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ribbonIbo);
			for (const layer of layers) {
				gl.bufferData(gl.ARRAY_BUFFER, layer.verts, gl.DYNAMIC_DRAW);
				attr(ribbon, "a_pos", 2, 5, 0);
				attr(ribbon, "a_alpha", 1, 5, 2);
				attr(ribbon, "a_side", 1, 5, 3);
				attr(ribbon, "a_tone", 1, 5, 4);
				gl.uniform3f(gl.getUniformLocation(ribbon, "u_color"), layer.rgb.r / 255, layer.rgb.g / 255, layer.rgb.b / 255);
				gl.uniform3f(gl.getUniformLocation(ribbon, "u_near"), layer.near.r / 255, layer.near.g / 255, layer.near.b / 255);
				gl.drawElements(gl.TRIANGLES, layer.count * (TRAIL - 1) * 6, gl.UNSIGNED_SHORT, 0);
			}

			if (headCount > 0) {
				gl.useProgram(head);
				gl.uniform2f(gl.getUniformLocation(head, "u_res"), width, height);
				gl.uniform3f(gl.getUniformLocation(head, "u_color"), headRgb.r / 255, headRgb.g / 255, headRgb.b / 255);
				gl.uniform3f(gl.getUniformLocation(head, "u_near"), headNear.r / 255, headNear.g / 255, headNear.b / 255);
				gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, headIbo);
				gl.bufferData(gl.ARRAY_BUFFER, heads, gl.DYNAMIC_DRAW);
				attr(head, "a_pos", 2, 7, 0);
				attr(head, "a_uv", 2, 7, 2);
				attr(head, "a_alpha", 1, 7, 4);
				attr(head, "a_hot", 1, 7, 5);
				attr(head, "a_tone", 1, 7, 6);
				gl.drawElements(gl.TRIANGLES, headCount * 6, gl.UNSIGNED_SHORT, 0);
			}
		}
	};
}

let sharedRenderer: Renderer | null | undefined;
let rendererLost = false;
const makeRenderer = () => {
	try {
		return createRenderer(Math.max(GROUND_COUNT, SHEET_COUNT, MARK_POOL));
	} catch (err) {
		// a shader that will not compile on this GPU: the same as no WebGL, said the same way
		console.error("[visualizer] Drift renderer", err);
		return null;
	}
};

function create(): Preset {
	const noise = createNoise3D();
	const conduct = createConductor();
	const nextSound = createNextSound();
	// ONE renderer for the life of the page. create() reruns on every preset switch, and a browser
	// keeps only about sixteen WebGL contexts alive: a context per switch would end with the oldest
	// being dropped and this preset going black after enough switching back and forth.
	if (sharedRenderer === undefined) sharedRenderer = makeRenderer();
	let renderer = sharedRenderer;
	// after a lost context: when to try for a new one
	let retryAt = 0;
	let nearDark = K.NEAR_DARK;
	let nearK = 1;
	let fogStart = K.FOG_START;
	let fogK = 1;
	// a black screen with no reason given is the worst thing this could do
	if (!renderer && typeof Spicetify !== "undefined") Spicetify.showNotification("Drift needs WebGL, and this client has it switched off");

	// a point somewhere in the cloud
	const scatter = (p: Particle) => {
		for (;;) {
			p.x = (Math.random() * 2 - 1) * K.CLOUD;
			p.y = (Math.random() * 2 - 1) * K.CLOUD;
			p.z = (Math.random() * 2 - 1) * K.CLOUD;
			if (p.x * p.x + p.y * p.y + p.z * p.z < K.CLOUD * K.CLOUD) return;
		}
	};
	const spawn = (): Particle => {
		const p: Particle = { x: 0, y: 0, z: 0, life: Math.random(), brightness: 0.35 + Math.random() * 0.65, pace: 0.6 + Math.pow(Math.random(), 1.6) * 1.1, lit: 0, wx: 0, wy: 0, wz: 0, hx: 0, hy: 0, hz: 0, gx: 0, gy: 0, gz: 0, tx: 0, ty: 0, tz: 0, alpha: 0 };
		scatter(p);
		return p;
	};
	const spawnMark = (): Mark => ({
		...spawn(),
		chase: 8,
		breadth: 0.5,
		soft: 0,
		boost: 0,
		age: 99,
		rise: 0.06,
		decay: 0.22,
		fling: 0,
		charge: 0,
		power: 0.5,
		streak: 0,
		tone: 0.5,
		vx: 0,
		vy: 0
	});
	const ground = Array.from({ length: GROUND_COUNT }, spawn);
	const sheet = Array.from({ length: SHEET_COUNT }, spawn);
	const marks = Array.from({ length: MARK_POOL }, spawnMark);

	const trailOf = (list: Particle[], seconds: number): Trail => {
		const t = { points: new Float32Array(list.length * RING * 3), head: 0, clock: 0, step: seconds / (TAIL - 1) };
		list.forEach((p, i) => resetTrail(t, i, p));
		return t;
	};
	// a stroke that has just been put somewhere new has no tail yet
	const resetTrail = (t: Trail, i: number, p: Particle) => {
		for (let j = 0; j < RING; j++) {
			const o = (i * RING + j) * 3;
			t.points[o] = p.x;
			t.points[o + 1] = p.y;
			t.points[o + 2] = p.z;
		}
	};
	const groundTrail = trailOf(ground, K.GROUND_TRAIL);
	const sheetTrail = trailOf(sheet, K.SHEET_TRAIL);
	const markTrail = trailOf(marks, K.MARK_TRAIL);

	const groundVerts = new Float32Array(GROUND_COUNT * TRAIL * 2 * 5);
	const sheetVerts = new Float32Array(SHEET_COUNT * TRAIL * 2 * 5);
	const markVerts = new Float32Array(MARK_POOL * TRAIL * 2 * 5);
	const headVerts = new Float32Array(MARK_POOL * 4 * 7);

	const glow = createGlow();

	let fieldTime = 0;
	// the wind, as two angles: a heading and a rise off the horizontal. Rate-capped, never recomputed
	let windAz = 0;
	let windEl = 0;
	let duck = 0;
	let flare = 0;
	let slowBand = 0.35;
	let skySize = 0;
	let harm = 0;
	let cursor = 0;
	let flash = 0;
	const keyHue = createKeyHue();
	// where on the palette the music has the picture, when the colour follows the sound
	let soundAt = 0.5;
	// where the camera is on its orbit
	let orbit = 0;
	let swayClock = 0;
	let tick = 0;

	return {
		draw(frame) {
			const { ctx, width, height, isPlaying, colorRgb, audio, progressSec } = frame;
			if (!isPlaying) return;
			// the lens and the fog, read once a frame: per point they were a sixth of the whole frame's work
			nearDark = K.NEAR_DARK;
			nearK = 1 / (K.NEAR_CLEAR - K.NEAR_DARK);
			fogStart = K.FOG_START;
			fogK = 1 / (K.FOG_END - K.FOG_START);
			// a ribbon's length is a knob: the same points, spaced further apart in time
			groundTrail.step = K.GROUND_TRAIL / (TAIL - 1);
			sheetTrail.step = K.SHEET_TRAIL / (TAIL - 1);
			markTrail.step = K.MARK_TRAIL / (TAIL - 1);

			const c = conduct(frame);
			const beat = audio?.tempo && audio.tempo > 40 ? 60 / audio.tempo : 0.5;
			slowBand += (c.loudness - slowBand) * Math.min(1, 0.1 * c.dt);

			// ---- the sky ------------------------------------------------------------------------------
			// how many marks can be seen is the background's statement; one number, read by every loop
			const skyTarget = Math.max(8, Math.min(marks.length, marks.length * (0.35 + slowBand * 0.75)));
			if (skySize === 0) skySize = Math.round(skyTarget);
			else if (skyTarget >= skySize + 1) skySize++;
			// the sky shrinks past a mark only once it has gone out - cut while lit, it vanished on the spot
			else if (skyTarget <= skySize - 1 && marks[skySize - 1].age > marks[skySize - 1].rise + marks[skySize - 1].decay * 4.5) skySize--;
			const inSky = Math.max(8, Math.min(marks.length, skySize));
			const cutters: Mark[] = [];
			for (let i = 0; i < inSky; i++) if (marks[i].charge > 0.15) cutters.push(marks[i]);
			for (let i = inSky; i < marks.length; i++) {
				marks[i].age += c.dt;
				marks[i].charge = 0;
			}

			// ---- the brace and the release (as Layers III) ------------------------------------------------
			const braceEarly = Math.max(c.anticipation, Math.min(1, c.windup * 0.8));
			const releaseRaw = c.timeToImpact !== null && c.timeToImpact > 0 ? 0 : c.impact;
			flash += (releaseRaw - flash) * Math.min(1, (releaseRaw > flash ? 11 : 3) * c.dt);
			const release = flash;
			const runDip = Math.max(0.12, c.runInDip);
			const windUp = 1 + c.windup * (0.12 + c.runInBuild * 0.9);
			const cutGate = 1 - braceEarly * 0.5;
			const dim = (1 - braceEarly * 0.42 * runDip) * (1 + release * 0.15);
			const contraction = 1 - braceEarly * 0.55;

			harm += (c.harmonicShift - harm) * Math.min(1, 6 * c.dt);
			fieldTime += (0.05 + c.brightness * 0.1) * c.dt;

			const duckTarget = Math.min(1, flare * (0.55 + c.attackSharpness * 0.5));
			duck += (duckTarget - duck) * Math.min(1, (duckTarget > duck ? 10 : 2.6) * c.dt);
			const tintPulse = Math.min(1, flare * 1.1);

			// ---- the camera: on its orbit, looking at a point that wanders about the middle of the cloud -----
			const orbitRate = K.ORBIT_REST + c.loudness * K.ORBIT_LOUD;
			orbit += orbitRate * c.dt;
			swayClock += c.dt;
			tick++;
			const radius = K.ORBIT_RADIUS * (1 + Math.sin(swayClock * 0.07) * 0.18);
			const Px = Math.sin(orbit) * radius;
			const Py = Math.sin(swayClock * 0.11) * K.ORBIT_SWAY;
			const Pz = -Math.cos(orbit) * radius;
			// forward, right, up
			let Fx = Math.sin(swayClock * 0.05 + 1) * K.LOOK_WANDER - Px;
			let Fy = Math.sin(swayClock * 0.083) * K.LOOK_WANDER * 0.5 - Py;
			let Fz = Math.cos(swayClock * 0.067 + 2) * K.LOOK_WANDER - Pz;
			const fl = Math.hypot(Fx, Fy, Fz);
			Fx /= fl;
			Fy /= fl;
			Fz /= fl;
			const rl = Math.hypot(Fz, Fx);
			const Rx = Fz / rl;
			const Rz = -Fx / rl;
			const Yx = Fy * Rz;
			const Yy = Fz * Rx - Fx * Rz;
			const Yz = -Fy * Rx;
			const focal = K.FOCAL * (height / 2);
			const aspect = width / height;

			// ---- the wind: one direction in the world, wandering slowly on its own -----------------------------
			// (Tied to the camera's travel it was tried, so that the flow always crossed the picture, and
			// cut on sight: the wind is the scene's, not the camera's.)
			const windStep = (0.22 + harm * 1.5) * c.dt;
			windAz += Math.max(-windStep, Math.min(windStep, shortest(noise(fieldTime * 0.14, 11.3, 0) * Math.PI - windAz)));
			windEl += Math.max(-windStep * 0.5, Math.min(windStep * 0.5, noise(fieldTime * 0.11, 3.1, 7.7) * 0.5 - windEl));
			const ce = Math.cos(windEl);
			const Wx = ce * Math.cos(windAz);
			const Wy = Math.sin(windEl);
			const Wz = ce * Math.sin(windAz);

			// ---- the flow: what a stroke at (x, y, z) is asked to do, off the wind --------------------------
			let flowX = 0;
			let flowY = 0;
			let flowZ = 0;
			const E = 0.12;
			const flow = (x: number, y: number, z: number, freq: number, time: number, amount: number) => {
				const X = x * freq;
				const Y = y * freq;
				const Z = z * freq + time;
				// the potential is three reads of one noise, far apart; its curl is six differences
				const a = noise(X, Y, Z);
				const b = noise(X + 31.7, Y - 12.3, Z);
				const d = noise(X - 17.9, Y + 41.1, Z);
				const k = (amount * 0.3) / E;
				flowX = (noise(X - 17.9, Y + 41.1 + E, Z) - d - (noise(X + 31.7, Y - 12.3, Z + E) - b)) * k;
				flowY = (noise(X, Y, Z + E) - a - (noise(X - 17.9 + E, Y + 41.1, Z) - d)) * k;
				flowZ = (noise(X + 31.7 + E, Y - 12.3, Z) - b - (noise(X, Y + E, Z) - a)) * k;
				const l = Math.hypot(flowX, flowY, flowZ);
				if (l > K.FLOW_MAX) {
					flowX *= K.FLOW_MAX / l;
					flowY *= K.FLOW_MAX / l;
					flowZ *= K.FLOW_MAX / l;
				}
			};
			// comes round to the velocity (x, y, z) over `inertia` seconds
			const steer = (p: Particle, x: number, y: number, z: number, inertia: number) => {
				if (p.hx === 0 && p.hy === 0 && p.hz === 0) {
					p.hx = x;
					p.hy = y;
					p.hz = z;
					return;
				}
				const k = 1 - Math.exp(-c.dt / inertia);
				p.hx += (x - p.hx) * k;
				p.hy += (y - p.hy) * k;
				p.hz += (z - p.hz) * k;
			};

			// ---- colour: one family of hues, leaned by this section's key against the track's home key ----
			// The three layers take three points along the palette (the cover's, or the picked colours):
			// the haze its first colour, the hairlines the middle, the marks the last. With the colour
			// following the sound, the whole family slides along it with the music.
			const pal = palette(COLOURS, frame.palette ?? [colorRgb]);
			// What the gradient follows (see COLOURS above). Each layer keeps its own lightness and the colour
			// only says where on the palette it is:
			//   layers   the haze the first colour, the hairlines the middle, the marks the last
			//   depth    every stroke from the first colour where the fog begins to the last at the lens
			//   sounds   the marks by their sound, dull the first colour and ringing the last, over the haze
			//            and hairlines in the first and middle
			//   music    the whole family slides along the palette with how loud the music is
			// The music is read against the band levels live in (5th to 95th percentile over eight tracks,
			// the same as Ridgeline's camera), not against 0..1, where it barely moved.
			soundAt += (smoothstep((c.energy - 0.154) / (0.49 - 0.154)) - soundAt) * Math.min(1, c.dt / 0.8);
			const byDepth = COLOURS.follows === "depth";
			const bySound = COLOURS.follows === "sounds";
			const along = (t: number) => paletteAt(pal, COLOURS.follows === "music" ? t * 0.3 + soundAt * 0.7 : t);
			// the cover's palette is spread a little round the wheel between the layers; picked colours stay as picked
			const turn = COLOURS.mode === "cover" ? 1 : 0;
			const key = keyHue(audio, progressSec, c.dt) * COLOURS.harmony;
			const shimmer = shimmerPhase(fieldTime);
			const groundOf = (g: Hsl) => shimmerTint(hslToRgb(g.h + key, g.s * 0.7, g.l * 0.62), shimmer, tintPulse * 0.4);
			const sheetOf = (sh: Hsl) => shimmerTint(hslToRgb(sh.h + key + 0.06 * turn, sh.s, sh.l), shimmer, tintPulse);
			const markOf = (m: Hsl) => shimmerTint(hslToRgb(m.h + key + 0.14 * turn, Math.min(1, m.s + 0.08), Math.min(0.78, m.l + 0.14)), shimmer, tintPulse);
			const groundRgb = groundOf(along(0));
			const sheetRgb = sheetOf(along(byDepth ? 0 : 0.5));
			const markRgb = markOf(along(byDepth || bySound ? 0 : 1));
			const groundNear = byDepth ? groundOf(along(1)) : groundRgb;
			const sheetNear = byDepth ? sheetOf(along(1)) : sheetRgb;
			const markNear = byDepth || bySound ? markOf(along(1)) : markRgb;


			// ---- the wake: what the marks cutting through the field do to a stroke at (x, y, z) -----------------
			const cutFall = 1 / beat;
			const wakeRise = 1 / (0.3 * beat);
			const wakeFall = 1 / (2.2 * beat);
			let cutX = 0;
			let cutY = 0;
			let cutZ = 0;
			let cutW = 0;
			const cutAt = (x: number, y: number, z: number) => {
				cutW = 0;
				cutX = 0;
				cutY = 0;
				cutZ = 0;
				for (const m of cutters) {
					const ax = x - m.x;
					const ay = y - m.y;
					const az = z - m.z;
					const d2 = ax * ax + ay * ay + az * az;
					if (d2 > K.CUT_RADIUS * K.CUT_RADIUS) continue;
					const force = m.charge * (0.45 + m.power * 0.85) * (1 - Math.sqrt(d2) / K.CUT_RADIUS);
					cutW += force;
					cutX += m.hx * force;
					cutY += m.hy * force;
					cutZ += m.hz * force;
				}
				cutW = Math.min(1, cutW);
			};

			// ---- a ribbon: one particle's trail, from the camera's place, into a strip of vertices -----------
			let checksum = 0;
			// A ribbon is the particle's path RESAMPLED AT FIXED AGES: point j is where it was exactly j steps
			// ago, found between the two remembered places either side of that moment. Drawing the
			// remembered places themselves was the jerk in the first build - a new one is taken ~17 times a
			// second, and on that frame the strip's first segment collapsed to nothing and its soft tip
			// changed length, so every ribbon twitched at 17 Hz. Resampled, every point slides continuously.
			// The strip's first two points are a NOSE in front of the particle - a half and a whole width
			// ahead, narrowing as a circle does - so the thick end is round. (It was cut square: hidden
			// under a mark's star when the star was big, and plain to see when it was not.)
			const maxHalf = height * K.MAX_HALF_WIDTH;
			const ribbon = (verts: Float32Array, t: Trail, i: number, alpha: number, halfWidth: number, tone = -1) => {
				const back = 1 - t.clock / t.step;
				let o = i * TRAIL * 10;
				for (let j = 0; j < TAIL; j++) {
					const qa = (i * RING + ((t.head - j + RING) % RING)) * 3;
					let wx = t.points[qa];
					let wy = t.points[qa + 1];
					let wz = t.points[qa + 2];
					if (j > 0) {
						const qb = (i * RING + ((t.head - j - 1 + RING * 2) % RING)) * 3;
						wx += (t.points[qb] - wx) * back;
						wy += (t.points[qb + 1] - wy) * back;
						wz += (t.points[qb + 2] - wz) * back;
					}
					const ax = wx - Px;
					const ay = wy - Py;
					const az = wz - Pz;
					const depth = ax * Fx + ay * Fy + az * Fz;
					const d = Math.max(NEAR, depth);
					const k = j + 2;
					sxs[k] = width / 2 + ((ax * Rx + az * Rz) / d) * focal;
					sys[k] = height / 2 - ((ax * Yx + ay * Yy + az * Yz) / d) * focal;
					const age = j / (TAIL - 1);
					// gone before the lens and into the distance
					const seen = smoothstep((depth - nearDark) * nearK) * (1 - smoothstep((depth - fogStart) * fogK));
					// it narrows towards its tail, like anything drawn by something moving
					const w = Math.min(maxHalf, (halfWidth * focal) / d) * (1 - age * 0.7);
					// a ribbon finer than a pixel is drawn a pixel wide and dimmer, not thinner
					hws[k] = Math.max(0.6, w);
					als[k] = alpha * seen * (1 - age) * Math.min(1, w / 0.6);
					// how near it is, for a gradient that follows depth: 1 at the lens, 0 where the fog begins
					tns[k] = tone >= 0 ? tone : 1 - smoothstep((depth - nearDark) / Math.max(0.001, fogStart - nearDark));
				}
				// the nose, along the way it is going on screen (a ribbon standing still has none)
				let nx0 = sxs[2] - sxs[3];
				let ny0 = sys[2] - sys[3];
				const nl = Math.hypot(nx0, ny0);
				if (nl > 0.3) {
					nx0 /= nl;
					ny0 /= nl;
				} else {
					nx0 = 0;
					ny0 = 0;
				}
				sxs[1] = sxs[2] + nx0 * hws[2] * 0.5;
				sys[1] = sys[2] + ny0 * hws[2] * 0.5;
				hws[1] = hws[2] * 0.87;
				als[1] = als[2];
				sxs[0] = sxs[2] + nx0 * hws[2];
				sys[0] = sys[2] + ny0 * hws[2];
				hws[0] = hws[2] * 0.2;
				als[0] = als[2];
				tns[0] = tns[1] = tns[2];
				// A stroke coming straight at the lens is a short fat slab on screen - "flat". It is a point
				// of light seen end-on, so it dims as its length on screen falls under a few of its widths.
				const endOn = Math.min(1, Math.hypot(sxs[2] - sxs[TRAIL - 1], sys[2] - sys[TRAIL - 1]) / (hws[2] * 6));
				// across the strip at every point: from its neighbours, and where two of them coincide, from
				// the nearest point that has a direction - never a zero, which pinches the strip shut
				let known = -1;
				for (let j = 0; j < TRAIL; j++) {
					const a = Math.max(0, j - 1);
					const b = Math.min(TRAIL - 1, j + 1);
					const nx = -(sys[a] - sys[b]);
					const ny = sxs[a] - sxs[b];
					const len = Math.hypot(nx, ny);
					if (len > 0.3) {
						nxs[j] = nx / len;
						nys[j] = ny / len;
						if (known < 0) for (let k = 0; k < j; k++) {
							nxs[k] = nxs[j];
							nys[k] = nys[j];
						}
						known = j;
					} else if (known >= 0) {
						nxs[j] = nxs[known];
						nys[j] = nys[known];
					} else {
						nxs[j] = 0;
						nys[j] = 0;
					}
				}
				for (let j = 0; j < TRAIL; j++) {
					const a = als[j] * endOn;
					verts[o++] = sxs[j] + nxs[j] * hws[j];
					verts[o++] = sys[j] + nys[j] * hws[j];
					verts[o++] = a;
					verts[o++] = 1;
					verts[o++] = tns[j];
					verts[o++] = sxs[j] - nxs[j] * hws[j];
					verts[o++] = sys[j] - nys[j] * hws[j];
					verts[o++] = a;
					verts[o++] = -1;
					verts[o++] = tns[j];
					checksum += sxs[j] + sys[j] + a;
				}
			};
			// every layer remembers a new place on its own clock, so a ribbon is as long in SECONDS on any
			// screen; between them the newest follows the particle
			const advance = (t: Trail, list: Particle[]) => {
				t.clock += c.dt;
				for (let n = 0; t.clock >= t.step && n < RING; n++) {
					t.clock -= t.step;
					const from = t.head;
					t.head = (t.head + 1) % RING;
					for (let i = 0; i < list.length; i++) {
						const a = (i * RING + from) * 3;
						const b = (i * RING + t.head) * 3;
						t.points[b] = t.points[a];
						t.points[b + 1] = t.points[a + 1];
						t.points[b + 2] = t.points[a + 2];
					}
				}
				t.clock = Math.min(t.clock, t.step);
			};
			const setHead = (t: Trail, i: number, p: Particle) => {
				const o = (i * RING + t.head) * 3;
				t.points[o] = p.x;
				t.points[o + 1] = p.y;
				t.points[o + 2] = p.z;
			};

			// ---- the ground and the sheet: one machine, two settings ------------------------------------------
			const drawField = (
				list: Particle[],
				t: Trail,
				verts: Float32Array,
				inertia: number,
				freq: number,
				drift: number,
				spread: number,
				cutStir: number,
				speed: number,
				wakeHurry: number,
				lightBase: number,
				lightBrightness: number,
				lightCut: number,
				duckDepth: number,
				layerLight: number,
				alphaCap: number,
				halfWidth: number,
				lifeRate: number
			) => {
				advance(t, list);
				for (let i = 0; i < list.length; i++) {
					const p = list[i];
					cutAt(p.x, p.y, p.z);
					p.lit += (cutW - p.lit) * Math.min(1, (cutW > p.lit ? 12 : cutFall) * c.dt);
					const cut = p.lit * cutGate;
					// where a mark is passing the flow is stirred harder - an amplitude, never a direction
					if ((tick + i) % FLOW_EVERY === 0 || (p.gx === 0 && p.gy === 0 && p.gz === 0)) {
						flow(p.x, p.y, p.z, freq, fieldTime * drift, spread + cut * cutStir);
						p.gx = flowX;
						p.gy = flowY;
						p.gz = flowZ;
					}
					// the wake, eased; and the heading's pull into it - a stored offset chased under a rate cap
					const wakeStep = Math.min(1, (cutW > 0 ? wakeRise : wakeFall) * c.dt);
					p.wx += (cutX - p.wx) * wakeStep;
					p.wy += (cutY - p.wy) * wakeStep;
					p.wz += (cutZ - p.wz) * wakeStep;
					const wl = Math.hypot(p.wx, p.wy, p.wz);
					const wake = Math.min(1, wl);
					const pull = wl > 0.02 ? (wake * K.WAKE_TURN) / wl : 0;
					const ex = p.wx * pull - p.tx;
					const ey = p.wy * pull - p.ty;
					const ez = p.wz * pull - p.tz;
					const el = Math.hypot(ex, ey, ez);
					const step = el > 1e-6 ? Math.min(1, (K.WAKE_RATE * c.dt) / el) : 0;
					p.tx += ex * step;
					p.ty += ey * step;
					p.tz += ez * step;

					// one wind; everything else is a bounded offset from it, so nothing can flip
					steer(p, Wx + p.gx + p.tx, Wy + p.gy + p.ty, Wz + p.gz + p.tz, inertia);
					const v = speed * p.pace * (1 + wake * K.WAKE_HURRY * wakeHurry) * c.dt;
					p.x += p.hx * v;
					p.y += p.hy * v;
					p.z += p.hz * v;

					const fromCentre = Math.hypot(p.x, p.y, p.z);
					const edge = Math.max(0, Math.min(1, (K.CLOUD - fromCentre) / K.CLOUD_EDGE));
					p.alpha = Math.min(
						alphaCap,
						Math.max(0, (lightBase + p.brightness * lightBrightness + cut * lightCut) * Math.sin(p.life * Math.PI) * edge * (1 - duck * duckDepth * (1 - cut)) * layerLight * 1.05)
					);
					p.life -= c.dt * lifeRate;
					if (p.life <= 0 || fromCentre > K.CLOUD) {
						// invisible by now: the bell and the edge have both taken it to zero
						scatter(p);
						p.life = 1;
						p.lit = p.wx = p.wy = p.wz = p.tx = p.ty = p.tz = p.hx = p.hy = p.hz = p.gx = p.gy = p.gz = 0;
						resetTrail(t, i, p);
					} else setHead(t, i, p);
					ribbon(verts, t, i, p.alpha, halfWidth);
				}
			};

			drawField(
				ground,
				groundTrail,
				groundVerts,
				K.GROUND_INERTIA,
				0.35,
				0.35,
				Math.max(0.08, (0.4 + slowBand * 0.7) * contraction),
				0.45,
				(0.025 + c.loudness * 0.26) * windUp,
				1,
				0.3 + slowBand * 0.28 + c.loudness * 0.5 + release * 0.03,
				0.14,
				0.85,
				0.55,
				dim * (1 - release * 0.1),
				K.GROUND_ALPHA_CAP,
				K.GROUND_WIDTH * (0.75 + slowBand * 0.45 + c.loudness * 0.2) * (1 + release * 0.15),
				0.12
			);
			drawField(
				sheet,
				sheetTrail,
				sheetVerts,
				K.SHEET_INERTIA,
				0.55,
				1,
				// how widely it wanders is the background's statement, like the ground's: `harmonicShift`
				// is not a rare event (its eased form sits near 0.7 all song), and as an amplitude on every
				// heading at once it was the rest of the sheet's wiggle
				Math.max(0.04, (0.6 + slowBand * 0.8) * (1 - braceEarly * 0.35)),
				0.27,
				(0.035 + c.loudness * 0.55) * windUp,
				1.3,
				0.22 + c.loudness * 0.45 + slowBand * 0.26 + harm * 0.21 + release * 0.06,
				0.17,
				0.9,
				0.3,
				dim,
				K.SHEET_ALPHA_CAP,
				K.SHEET_WIDTH * (0.8 + c.loudness * 0.35 + c.brightness * 0.4) * (1 + release * 0.15),
				0.33
			);

			// ---- the next sound, and the marks it lights ---------------------------------------------------------
			const sound = nextSound(audio, progressSec, beat, c.energy);
			const hitFling = K.FLING * (0.35 + sound.sharp * sound.sharp * 0.65) * (0.5 + sound.breadth * 0.8);
			// "Across the wind", as the wind looks from the camera - the axis a sound's register is read along
			let ax = Wx * Rx + Wz * Rz;
			let ay = Wx * Yx + Wy * Yy + Wz * Yz;
			const al = Math.hypot(ax, ay);
			if (al > 0.15) {
				ax /= al;
				ay /= al;
			} else {
				ax = 1;
				ay = 0;
			}
			// puts a dark mark at a place in the picture (half-heights across and up, and a depth)
			const place = (m: Mark, i: number, px: number, py: number, depth: number) => {
				const ox = (px * depth) / K.FOCAL;
				const oy = (py * depth) / K.FOCAL;
				m.x = Px + Fx * depth + Rx * ox + Yx * oy;
				m.y = Py + Fy * depth + Yy * oy;
				m.z = Pz + Fz * depth + Rz * ox + Yz * oy;
				m.hx = m.hy = m.hz = m.gx = m.gy = m.gz = 0;
				resetTrail(markTrail, i, m);
			};
			// Written only while it is dark: its light starts at zero and rises through a smoothstep.
			// (Keeping the dark marks flying in the picture and lighting the nearest was tried, to stop a
			// mark appearing in mid-air: it did, and it made the sky orderly - every mark already settled
			// into the stream, evenly spread. Cut on the listener's eye.)
			const ignite = (m: Mark, i: number, lit: number, wanted: number) => {
				m.streak = lit === 0 && sound.standout ? 1 : 0;
				m.age = -lit * 0.014;
				m.rise = sound.rise * (0.85 + Math.random() * 0.35);
				m.decay = sound.decay * (0.8 + Math.random() * 0.5) * (m.streak > 0 ? 1.6 : 1);
				m.fling = hitFling * (m.streak > 0 ? K.FLING_RANK / K.FLING : 1);
				m.chase = 0.9 / Math.max(0.08, m.rise);
				m.power = Math.min(1, sound.amp) * (0.7 + Math.random() * 0.45);
				m.breadth = sound.breadth * (0.8 + Math.random() * 0.4);
				m.soft = 1 - sound.sharp;
				m.tone = sound.ringing;
				// a crack travels, a swell drifts; a few run, and the faster of a sound's marks are the nearer
				const runner = Math.random() < 0.1;
				const r = Math.random();
				m.pace = (0.95 + sound.sharp * sound.sharp * 1.55) * (0.8 + r * 0.45) * (runner ? 1.5 : 0.88);
				if (runner) {
					m.fling *= 1.8;
					m.chase = 3.6;
				}
				m.boost = 0;
				// its place: across the wind by how ringing the sound was, anywhere along it
				const at = runner ? 0.5 : sound.ringing;
				const spread = runner ? 0.3 : 0.2 + Math.min(0.45, wanted * 0.008);
				const across = (Math.max(0, Math.min(1, at + (Math.random() - 0.5) * spread)) - 0.5) * 2 * 0.8;
				const along = (Math.random() - 0.5) * 2;
				let px = Math.max(-0.95 * aspect, Math.min(0.95 * aspect, -ay * across + ax * along * aspect));
				let py = Math.max(-0.9, Math.min(0.9, ax * across + ay * along * aspect));
				const near = runner ? 1 : 0.15 + r * 0.7;
				if (near > K.FLY_IN_NEARER && al > 0.15) {
					// back along the wind to just past the edge it would have come in over
					const tx = ax > 1e-3 ? (px + aspect) / ax : ax < -1e-3 ? (px - aspect) / ax : 1e9;
					const ty = ay > 1e-3 ? (py + 1) / ay : ay < -1e-3 ? (py - 1) / ay : 1e9;
					const t = Math.min(tx, ty) + K.FLY_IN_MARGIN;
					px -= ax * t;
					py -= ay * t;
				}
				place(m, i, px, py, K.MARK_FAR - near * (K.MARK_FAR - K.MARK_NEAR));
			};
			advance(markTrail, marks);
			if (sound.fired) {
				const grandeur = 1.2 + Math.min(1.4, sound.amp) * 3.2 + sound.breadth * 2.8 + release * 3;
				const wanted = Math.max(2, Math.round(grandeur * (0.5 + slowBand * 1.5)));
				let lit = 0;
				for (let tries = 0; tries < inSky && lit < wanted; tries++) {
					const i = cursor++ % inSky;
					// only a mark that has gone out: one taken at 0.6 of its decay still had half its charge,
					// up to full light at the cap, and vanished in one frame - 55 a minute, measured. When none
					// is dark enough the sound lights fewer, never one that is still lit
					if (marks[i].age <= marks[i].rise + marks[i].decay * 4.5) continue;
					ignite(marks[i], i, lit, wanted);
					lit++;
				}
			}

			const sectionPower = 0.78 + slowBand * 0.45;
			const markSpread = K.MARK_SPREAD_MAX * contraction;
			const markSpeed = K.MARK_BASE_SPEED * (0.3 + c.loudness * 1.2) * windUp;
			const markWidthBand = 0.7 + slowBand * 0.6;
			let flareNow = 0;
			let headCount = 0;
			for (let i = 0; i < marks.length; i++) {
				const m = marks[i];
				if (i >= inSky || m.age > m.rise + m.decay * 6) {
					// dark: it draws nothing and goes nowhere until a sound places it again
					m.charge = 0;
					if (i < inSky) m.age += c.dt;
					ribbon(markVerts, markTrail, i, 0, 0);
					continue;
				}
				m.age += c.dt;
				m.charge = m.age <= 0 ? 0 : m.age < m.rise ? smoothstep(m.age / m.rise) : Math.exp(-(m.age - m.rise) / m.decay);
				// the throw is chased, never assigned
				const boostTarget = Math.min(1, m.charge) * m.fling;
				m.boost += (boostTarget - m.boost) * Math.min(1, (boostTarget > m.boost ? m.chase : m.chase * 0.4) * c.dt);

				// a slow broad flow: a mark is on screen for about a second, and in that second it should fly
				// one arc, not two
				if ((tick + i) % FLOW_EVERY === 0 || (m.gx === 0 && m.gy === 0 && m.gz === 0)) {
					flow(m.x, m.y, m.z, 0.38, fieldTime * 0.6, markSpread);
					m.gx = flowX;
					m.gy = flowY;
					m.gz = flowZ;
				}
				steer(m, Wx + m.gx, Wy + m.gy, Wz + m.gz, K.MARK_INERTIA);
				const v = markSpeed * m.pace * (1 + m.boost) * c.dt;
				m.x += m.hx * v;
				m.y += m.hy * v;
				m.z += m.hz * v;
				setHead(markTrail, i, m);

				// where it is in the picture now
				const bx = m.x - Px;
				const by = m.y - Py;
				const bz = m.z - Pz;
				const depth = bx * Fx + by * Fy + bz * Fz;
				const dd = Math.max(NEAR, depth);
				m.vx = ((bx * Rx + bz * Rz) / dd) * K.FOCAL;
				m.vy = ((bx * Yx + by * Yy + bz * Yz) / dd) * K.FOCAL;

				m.alpha = Math.min(K.MARK_ALPHA_CAP, Math.max(0, m.charge * (0.8 + m.power * 1.3) * sectionPower * (0.62 + m.brightness * 0.55)));
				// one channel each: length is the pace, brightness the loudness, width the breadth
				ribbon(markVerts, markTrail, i, m.alpha, K.MARK_WIDTH * (0.5 + m.breadth + m.soft * 0.75 + m.charge * 0.6) * markWidthBand, bySound ? m.tone : -1);
				if (m.charge > flareNow) flareNow = m.charge;

				// its head: a star, as bright as its sound and as big as its hit
				if (m.charge > 0.04 && depth > NEAR) {
					const seen = smoothstep((depth - nearDark) * nearK) * (1 - smoothstep((depth - fogStart) * fogK));
					const sx = width / 2 + m.vx * (height / 2);
					const sy = height / 2 - m.vy * (height / 2);
					const hot = Math.max(0, Math.min(1, 0.35 + m.breadth * 0.9 - m.soft * 0.6));
					const size = Math.min(height * K.MAX_STAR, (((0.026 + m.power * 0.05) * (0.55 + m.charge * 0.45) * (1.5 - hot * 0.5)) / depth) * focal);
					const light = Math.min(1, m.charge * (0.35 + m.power * 0.65) * sectionPower) * seen;
					let o = headCount++ * 28;
					const tone = bySound ? m.tone : byDepth ? 1 - smoothstep((depth - nearDark) / Math.max(0.001, fogStart - nearDark)) : 0;
					for (let k = 0; k < 4; k++) {
						const u = k % 2 === 0 ? -1 : 1;
						const w = k < 2 ? -1 : 1;
						headVerts[o++] = sx + u * size;
						headVerts[o++] = sy + w * size;
						headVerts[o++] = u;
						headVerts[o++] = w;
						headVerts[o++] = light;
						headVerts[o++] = hot;
						headVerts[o++] = tone;
					}
					checksum += sx + sy + size;
				}
			}
			flare = flareNow;

			// what the geometry adds up to: a NaN anywhere in the scene shows here, with or without a GPU
			publishDiagnostics("layers3d", { checksum, cameraX: Px, cameraZ: Pz, heads: headCount });

			// a lost context is not the end: a new one is asked for every couple of seconds until it comes
			if (renderer?.lost()) {
				renderer = sharedRenderer = null;
				rendererLost = true;
			}
			if (!renderer && rendererLost) {
				const now = performance.now();
				if (sharedRenderer) renderer = sharedRenderer;
				else if (now > retryAt) {
					retryAt = now + 2000;
					renderer = sharedRenderer = makeRenderer();
					if (renderer) rendererLost = false;
				}
			}
			if (!renderer) return;
			renderer.draw(
				width,
				height,
				[
					{ verts: groundVerts, count: ground.length, rgb: groundRgb, near: groundNear },
					{ verts: sheetVerts, count: sheet.length, rgb: sheetRgb, near: sheetNear },
					{ verts: markVerts, count: marks.length, rgb: markRgb, near: markNear }
				],
				headVerts,
				headCount,
				markRgb,
				markNear
			);

			// ---- onto the frame, and the bloom over it -------------------------------------------------------
			ctx.drawImage(renderer.canvas, 0, 0);
			// the halo is the events' channel: it swells with the marks' own light and the release
			glow(ctx, renderer.canvas, width, height, c.scale, (0.4 + tintPulse * 0.35 + release * 0.9) * K.GLOW);
		}
	};
}

// scratch for one ribbon's projected points - module scope, so a frame allocates nothing
const sxs = new Float32Array(TRAIL);
const sys = new Float32Array(TRAIL);
const hws = new Float32Array(TRAIL);
const nxs = new Float32Array(TRAIL);
const nys = new Float32Array(TRAIL);
const als = new Float32Array(TRAIL);
const tns = new Float32Array(TRAIL);

export const layers3dPreset: PresetDefinition = { id: "layers3d", name: "Drift", experimental: true, create };
