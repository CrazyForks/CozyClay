#!/usr/bin/env node
import { readFileSync } from "node:fs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const room = readFileSync(new URL("../src/room.jsx", import.meta.url), "utf8");

expect("header brand is Cozy Clay", app.includes("Cozy <span>Clay</span>"));
expect("browser title is Cozy Clay", html.includes("<title>Cozy Clay</title>"));
expect("Inter is the only bundled active UI family", css.includes("@font-face{font-family:Inter") && !css.includes("Instrument Serif"));
expect("display and UI roles both use Inter", css.includes('--display: "Inter"') && css.includes('--sans: "Inter"'));
expect("numeric editing data has a monospace role", css.includes("--mono: ui-monospace") && css.includes("font-family: var(--mono)"));
expect("wordmark uses a modern heavy display treatment", css.includes("font-weight: 750") && css.includes("letter-spacing: -.045em"));
expect("main paper token is present", css.includes("--bg: #f3ebdd"));
expect("ink navy token is present", css.includes("--fg: #273849"));
expect("non-photo blue token is present", css.includes("--accent: #4e9fb3"));
expect("timeline uses tracing-paper lanes", css.includes("background-color: #fbf7ef"));
expect("IK uses pencil red", css.includes(".tl-marker.ik") && css.includes("background: #d65f55"));
expect("current frame uses lightbox amber", css.includes(".tl-frame-box") && css.includes("background: #e7b557"));
expect("Canvas uses a bright neutral toon background", app.includes('<color attach="background" args={["#eef4f3"]} />'));
expect("Character uses bright ivory clay", app.includes('const CLAY = "#f2eee6"'));
expect("Room uses a high-key floor and rear wall", room.includes('const FLOOR = "#e7e1d7"') && room.includes('const BACK_WALL = "#eef1ed"'));
expect("Room forms one open L-shaped corner", room.includes('const SIDE_WALL = "#e4ecec"') && room.includes("[-SIZE / 2, HEIGHT / 2, 0]"));
expect("Corner walls are taller than the character stage", room.includes("const HEIGHT = 6.2"));
expect("Room has no ceiling plane", !room.includes("function Ceiling") && !room.includes("SHOT_LAYER"));
expect(
	"Studio uses directional high-key toon lighting",
	room.includes('"#fffdf6", "#d8d0c3", 0.9') &&
		room.includes("<ambientLight intensity={0.18}") &&
		room.includes('intensity={1.12}'),
);

if (failures) process.exit(1);
console.log("all Cozy Clay theme checks PASS");
