const http = require("http");
const fs = require("fs");
const path = require("path");

const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
// Dev server: localhost only, files from this folder only, bounded bodies (any page can POST to it).
// Endpoints: POST /dump (track analysis), /mark (B press), /log (probe), /save/<name> (screenshot).
const ROOT = path.resolve(__dirname);
const MAX_BODY = 20 * 1024 * 1024;
const ORIGINS = ["http://localhost:8790", "http://127.0.0.1:8790", "https://xpui.app.spotify.com"];
const inRoot = file => file === ROOT || file.startsWith(ROOT + path.sep);
const collect = (req, res, done) => {
	let body = "";
	req.on("data", c => {
		body += c;
		if (body.length > MAX_BODY) {
			res.writeHead(413);
			res.end();
			req.destroy();
		}
	});
	req.on("end", () => {
		if (body.length <= MAX_BODY) done(body);
	});
};

http
	.createServer((req, res) => {
		// Host check against DNS rebinding; Origin limited to the harness and the Spotify dev client.
		if (!/^(localhost|127\.0\.0\.1):8790$/.test(req.headers.host || "")) {
			res.writeHead(403);
			res.end();
			return;
		}
		const origin = req.headers.origin;
		if (origin && !ORIGINS.includes(origin)) {
			res.writeHead(403);
			res.end();
			return;
		}
		const cors = origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
		if (req.method === "POST" && req.url === "/dump") {
			collect(req, res, body => {
				// one file per track
				let name = "unknown";
				try { name = String(JSON.parse(body).name || "unknown"); } catch { /* keep the default */ }
				const safe = name.replace(/[^\wЀ-ӿ　-鿿 -]/g, "").trim().slice(0, 60) || "unknown";
				const dir = path.join(__dirname, "analysis-dumps");
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(path.join(dir, safe + ".json"), body);
				res.writeHead(200, cors);
				res.end("ok");
			});
			return;
		}
		if (req.method === "POST" && req.url === "/mark") {
			collect(req, res, body => {
				fs.appendFileSync(path.join(__dirname, "marks.jsonl"), `${body}
`);
				res.writeHead(200, cors);
				res.end("ok");
				try {
					const m = JSON.parse(body);
					console.log(`  marked  ${m.track} @ ${Number(m.at).toFixed(1)}s  preset ${m.preset}`);
				} catch {
					console.log("  marked (unparsed)");
				}
			});
			return;
		}
		if (req.method === "POST" && req.url === "/log") {
			collect(req, res, body => {
				fs.appendFileSync(path.join(__dirname, "probe-log.json"), `${new Date().toISOString()} ${body}
`);
				res.writeHead(200, cors);
				res.end("ok");
			});
			return;
		}
		if (req.method === "OPTIONS") {
			res.writeHead(204, {
				...cors,
				"Access-Control-Allow-Methods": "POST",
				"Access-Control-Allow-Headers": "content-type"
			});
			res.end();
			return;
		}
		if (req.method === "POST" && req.url.startsWith("/save/")) {
			// a file name, never a path
			const name = req.url.replace("/save/", "").replace(/[^\w.-]/g, "").replace(/^\.+/, "").slice(0, 80) || "shot";
			collect(req, res, body => {
				const b64 = body.replace(/^data:image\/png;base64,/, "");
				fs.mkdirSync(path.join(__dirname, "shots"), { recursive: true });
				fs.writeFileSync(path.join(__dirname, "shots", name + ".png"), Buffer.from(b64, "base64"));
				res.writeHead(200);
				res.end("ok");
			});
			return;
		}
		let file;
		try {
			file = path.resolve(ROOT, "." + decodeURIComponent(req.url.split("?")[0]));
		} catch {
			file = "";
		}
		if (!file || !inRoot(file)) {
			res.writeHead(403);
			res.end();
			return;
		}
		fs.readFile(file, (err, data) => {
			if (err) {
				res.writeHead(404);
				res.end();
				return;
			}
			res.writeHead(200, { "Content-Type": types[path.extname(file)] || "text/plain" });
			res.end(data);
		});
	})
	.listen(8790, "127.0.0.1", () => console.log("serving on http://localhost:8790"));
