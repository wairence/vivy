// Runs the structure detector against a REAL track's analysis and prints what it is thinking.
//
// It exists because the detector was previously validated on synthetic songs whose verse and chorus
// chords were made artificially distinct. It scored 3/3 on those and found the whole song to be one
// chorus on actual music - the test data had been built to match the algorithm's assumptions, which
// makes it a mirror rather than a test.
//
//   1. play a track with `npm run live`'s server running; the app posts its analysis to /dump
//   2. node structure-lab.js "66,145"     <- the seconds where you hear the choruses
//
// Prints boundaries, how the blocks grouped, which group was chosen and why, so a wrong answer can
// be traced to the step that produced it.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const OUT = path.join(__dirname, "node_modules", ".cache", "preset-check");
if (!fs.existsSync(path.join(OUT, "track-structure.js"))) {
	execFileSync(
		process.execPath,
		[
			path.join(__dirname, "node_modules", "typescript", "bin", "tsc"),
			"src/presets/index.ts", "src/types/audio-analysis.d.ts", "src/types/spicetify.d.ts",
			"--outDir", OUT, "--module", "commonjs", "--target", "es2017",
			"--esModuleInterop", "--skipLibCheck", "--strict", "--ignoreConfig"
		],
		{ cwd: __dirname, stdio: "inherit" }
	);
}
const { findMoments } = require(path.join(OUT, "track-structure.js"));
const mmssTop = t => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}`;

// node structure-lab.js <track name fragment> "<chorus seconds, comma separated>"
const DIR = path.join(__dirname, "analysis-dumps");
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => f.endsWith(".json")) : [];
if (files.length === 0) {
	console.log("No analysis dumps yet. Run `npm run live`'s server and play a track in Spotify.");
	process.exit(0);
}
// with no arguments, run every labelled track and print a scoreboard
const LABELS = fs.existsSync(path.join(__dirname, "structure-labels.json"))
	? JSON.parse(fs.readFileSync(path.join(__dirname, "structure-labels.json"), "utf8"))
	: {};
if (process.argv.length <= 2) {
	const TOL = 3;
	let totalTruth = 0, totalHits = 0, totalSpurious = 0;
	console.log("track                     found   spurious   detail");
	for (const [key, truth] of Object.entries(LABELS)) {
		if (key.startsWith("_")) continue;
		const f = files.find(x => x.toLowerCase().includes(key.toLowerCase()));
		if (!f) { console.log(`${key.padEnd(24)}  no dump`); continue; }
		const d = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
		const segs = d.segments.map(([start, duration, lm, lmt, pitches, timbre]) => ({
			start, duration, loudness_max: lm, loudness_max_time: lmt,
			loudness_start: lm - 4, loudness_end: lm - 3,
			pitches, timbre: timbre.concat([0,0,0,0,0,0]).slice(0, 12)
		}));
		const bs = d.bars.map(([start, duration, confidence]) => ({ start, duration, confidence }));
		const cv = d.curve.map(([t, y]) => ({ t, y }));
		const found = findMoments(segs, bs, cv).map(m => m.t);
		const hits = truth.filter(t => found.some(m => Math.abs(m - t) <= TOL));
		const spur = found.filter(m => !truth.some(t => Math.abs(m - t) <= TOL));
		totalTruth += truth.length; totalHits += hits.length; totalSpurious += spur.length;
		const detail = truth.map(t => {
			const near = found.reduce((b, m) => (Math.abs(m - t) < Math.abs(b - t) ? m : b), Infinity);
			return Number.isFinite(near) && Math.abs(near - t) <= TOL
				? `${mmssTop(t)}+${(near - t).toFixed(1)}`
				: `${mmssTop(t)}MISS`;
		}).join(" ");
		console.log(`${key.padEnd(24)}  ${hits.length}/${truth.length}      ${String(spur.length).padStart(2)}       ${detail}`);
	}
	console.log(`
TOTAL  ${totalHits}/${totalTruth} moments found, ${totalSpurious} spurious`);
	process.exit(0);
}
const wanted = (process.argv[2] || "").toLowerCase();
const file = files.find(f => f.toLowerCase().includes(wanted)) || files[0];
if (!wanted || !files.some(f => f.toLowerCase().includes(wanted)))
	console.log(`(dumps available: ${files.map(f => f.replace(".json", "")).join(" | ")})
`);
const dump = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8"));
const segments = dump.segments.map(([start, duration, loudness_max, loudness_max_time, pitches, timbre]) => ({
	start, duration, loudness_max, loudness_max_time,
	loudness_start: loudness_max - 4, loudness_end: loudness_max - 3,
	pitches, timbre: timbre.concat([0, 0, 0, 0, 0, 0]).slice(0, 12)
}));
const bars = dump.bars.map(([start, duration, confidence]) => ({ start, duration, confidence }));
const curve = dump.curve.map(([t, y]) => ({ t, y }));

const truth = (process.argv[3] || "")
	.split(",")
	.map(s => Number(s.trim()))
	.filter(n => Number.isFinite(n));

const mmss = t => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}`;

console.log(`${dump.name}  -  ${segments.length} segments, ${bars.length} bars, ${Math.round(curve[curve.length - 1].t)}s\n`);

const moments = findMoments(segments, bars, curve);
console.log("detected:");
for (const m of moments)
	console.log(
		`  ${mmss(m.t).padStart(5)} (${m.t.toFixed(1).padStart(6)}s)  size ${m.size.toFixed(2)}  lead ${m.leadSeconds.toFixed(1)}s  dip ${m.dip.toFixed(2)}  build ${m.build.toFixed(2)}`
	);
if (moments.length === 0) console.log("  (nothing)");

if (truth.length) {
	console.log("\nagainst what you hear:");
	const TOL = 3;
	let hits = 0;
	for (const t of truth) {
		const near = moments.reduce((best, m) => (Math.abs(m.t - t) < Math.abs(best - t) ? m.t : best), Infinity);
		const off = Number.isFinite(near) ? near - t : null;
		if (off !== null && Math.abs(off) <= TOL) hits++;
		console.log(
			`  chorus ${mmss(t)}  ->  ${off === null ? "MISSED" : `${off > 0 ? "+" : ""}${off.toFixed(1)}s ${Math.abs(off) <= TOL ? "hit" : "MISSED"}`}`
		);
	}
	const spurious = moments.filter(m => !truth.some(t => Math.abs(m.t - t) <= TOL));
	console.log(`\n  ${hits}/${truth.length} found, ${spurious.length} spurious: ${spurious.map(m => mmss(m.t)).join(" ") || "none"}`);
}
