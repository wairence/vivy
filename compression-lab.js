// The point of the pop tracks: they are the stress test. Everything structural here reads loudness,
// and a modern pop master has had its dynamics squeezed out on purpose. Does the release mechanic
// still find anything, and does the section ranking still have a range to rank over?
const fs=require("fs"),path=require("path");
const ROOT=__dirname,OUT=path.join(ROOT,"node_modules/.cache/preset-check");
const {findMoments}=require(path.join(OUT,"track-structure.js"));
const q=(a,p)=>a.slice().sort((x,y)=>x-y)[Math.floor((a.length-1)*p)];
const rows=[];
for(const file of fs.readdirSync(path.join(ROOT,"analysis-dumps")).filter(f=>f.endsWith(".json"))){
	const d=JSON.parse(fs.readFileSync(path.join(ROOT,"analysis-dumps",file),"utf8"));
	if(!d.track||!d.track.rhythmstring)continue;
	const segments=d.segments.map(g=>({start:g[0],duration:g[1],loudness_max:g[2],loudness_max_time:g[3],
		loudness_start:g[6],loudness_end:g[7],pitches:g[4],timbre:g[5]}));
	const bars=d.bars.map(b=>({start:b[0],duration:b[1],confidence:b[2]}));
	const curve=d.curve.map(c=>({t:c[0],y:c[1]}));
	const m=findMoments(segments,bars,curve);
	const sl=d.sections.map(s=>s[3]);
	// how compressed: the spread of segment loudness inside the track, in dB
	const lm=segments.map(s=>s.loudness_max);
	rows.push({name:(d.name||file).slice(0,30),loud:d.track.loudness,
		dyn:q(lm,.95)-q(lm,.05), secSpread:sl.length>1?Math.max(...sl)-Math.min(...sl):0,
		moments:m.length,sizes:m.map(x=>x.size)});
}
rows.sort((a,b)=>b.loud-a.loud);
const bucket=(name,f)=>{
	const g=rows.filter(f);if(!g.length)return;
	const none=g.filter(r=>r.moments===0).length;
	console.log(`${name.padEnd(26)} ${String(g.length).padStart(3)} tracks   moments p5/50/95 ${q(g.map(r=>r.moments),.05)}/${q(g.map(r=>r.moments),.5)}/${q(g.map(r=>r.moments),.95)}   silent ${none} (${(none/g.length*100).toFixed(0)}%)   segment dynamic range p50 ${q(g.map(r=>r.dyn),.5).toFixed(1)}dB   section spread p50 ${q(g.map(r=>r.secSpread),.5).toFixed(1)}dB`);
};
console.log("by how hot the master is:\n");
bucket("louder than -4 dB",r=>r.loud>-4);
bucket("-4 to -6 dB",r=>r.loud<=-4&&r.loud>-6);
bucket("-6 to -8 dB",r=>r.loud<=-6&&r.loud>-8);
bucket("quieter than -8 dB",r=>r.loud<=-8);
bucket("ALL",()=>true);
console.log("\ntracks where the release never fires:");
for(const r of rows.filter(x=>x.moments===0))
	console.log(`  ${r.name.padEnd(32)} ${r.loud.toFixed(1)}dB  segment range ${r.dyn.toFixed(1)}dB  section spread ${r.secSpread.toFixed(1)}dB`);
