// Run by `npm run release` after the minified build: the minifier strips licence comments, and the
// bundle carries simplex-noise inside it, whose licence asks for its notice to travel with it.
const fs = require("fs");
const file = "dist/index.js";
const notice =
	"/*! vivy - MIT License, (c) 2026 wairence - https://github.com/wairence/vivy\n" +
	" *  Includes simplex-noise (MIT, (c) 2018 Jonas Wagner) and code adapted from\n" +
	" *  Konsl/spicetify-visualizer (MIT, (c) 2026 Konsl). See THIRD_PARTY_NOTICES.md. */\n";
const body = fs.readFileSync(file, "utf8");
if (!body.startsWith("/*! vivy")) fs.writeFileSync(file, notice + body);
console.log("notice added to", file);
