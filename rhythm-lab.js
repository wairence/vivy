// The practical question: is rhythmstring a better source of "a hit just happened" than the
// segment starts we use now? Measured as recall of the beat grid - what share of beats have an
// event within 50ms - for each rhythm band against segment starts on the same track.
const fs=require("fs"),zlib=require("zlib"),path=require("path");
const DIR=path.join(__dirname,"analysis-dumps");
const b64=s=>Buffer.from(s.replace(/-/g,"+").replace(/_/g,"/"),"base64");
function rhythm(t){const v=zlib.inflateSync(b64(t.rhythmstring)).toString("utf8").trim().split(/\s+/).map(Number);
	const sr=v[0],hop=v[1],nb=v[2];let i=3;const bands=[];
	for(let b=0;b<nb;b++){const n=v[i++];const out=[];let c=0;
		for(let k=0;k<n;k++){c+=v[i++];out.push(c*hop/sr)}bands.push(out)}return bands}
const q=(a,p)=>a.slice().sort((x,y)=>x-y)[Math.floor((a.length-1)*p)];
const agg={seg:[],bands:Array.from({length:8},()=>[]),downLo:[],downHi:[]};
console.log("track                       beats  recall: segments  band0  band1  band2  band3  band4  band5  band6  band7");
for(const file of fs.readdirSync(DIR).filter(f=>f.endsWith(".json"))){
	const d=JSON.parse(fs.readFileSync(path.join(DIR,file),"utf8"));
	if(!d.track||!d.track.rhythmstring||!d.beats||d.beats.length<16)continue;
	const bands=rhythm(d.track);
	const beats=d.beats.map(b=>b[0]);
	const bars=new Set(d.bars.map(b=>b[0].toFixed(2)));
	const segs=d.segments.map(g=>g[0]);
	const recall=list=>{let i=0,hit=0;
		for(const b of beats){while(i<list.length&&list[i]<b-0.05)i++;
			if(i<list.length&&Math.abs(list[i]-b)<=0.05)hit++}
		return hit/beats.length};
	const rs=bands.map(recall),seg=recall(segs);
	agg.seg.push(seg);rs.forEach((v,k)=>agg.bands[k].push(v));
	// downbeats specifically: a bar line is where a kick almost always is
	const downs=d.bars.map(b=>b[0]);
	const rec=(list,pts)=>{let hit=0;for(const t of pts)if(list.some(x=>Math.abs(x-t)<=0.05))hit++;return hit/Math.max(1,pts.length)};
	agg.downLo.push(rec(bands[0],downs));agg.downHi.push(rec(bands[7],downs));
	console.log(`${(d.name||file).slice(0,26).padEnd(27)} ${String(beats.length).padStart(5)}       ${(seg*100).toFixed(0).padStart(4)}%  ${rs.map(v=>(v*100).toFixed(0).padStart(4)+"%").join("  ")}`);
}
const p=a=>`${(q(a,.05)*100).toFixed(0)}/${(q(a,.5)*100).toFixed(0)}/${(q(a,.95)*100).toFixed(0)}%`;
console.log(`\nbeat recall p5/50/95   segment starts ${p(agg.seg)}`);
agg.bands.forEach((v,k)=>console.log(`                       band ${k}         ${p(v)}`));
console.log(`\ndownbeat recall        band 0 ${p(agg.downLo)}   band 7 ${p(agg.downHi)}`);
