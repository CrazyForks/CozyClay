#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const props = readFileSync(new URL("../src/props.jsx", import.meta.url), "utf8");
const room = readFileSync(new URL("../src/room.jsx", import.meta.url), "utf8");
const dualview = readFileSync(new URL("../src/dualview.jsx", import.meta.url), "utf8");

expect(
	"legacy per-mesh outline modules are removed",
	!existsSync(new URL("../src/cozy-clay-appearance.jsx", import.meta.url)) &&
		!existsSync(new URL("../src/cozy-clay-style.js", import.meta.url)),
);
expect(
	"renderers contain no hull or geometry edge attachments",
	![app, props, room].some((source) =>
		source.includes("CozyClayOutlines") ||
		source.includes("<Outlines") ||
		source.includes("<Edges"),
	),
);
expect(
	"one screen-space pass owns all shot linework",
	dualview.includes("EDGE_FRAGMENT") &&
		dualview.includes("scene.overrideMaterial = edgePass.normalMaterial") &&
		dualview.includes("edgePass.passScene"),
);
expect(
	"line extraction uses a Sobel depth kernel",
	dualview.includes("depthX = dTL + 2.0 * dL") &&
		dualview.includes("depthY = dTL + 2.0 * dT"),
);
expect(
	"line extraction uses a Sobel normal kernel",
	dualview.includes("normalX = nTL + 2.0 * nL") &&
		dualview.includes("normalY = nTL + 2.0 * nT"),
);
expect(
	"depth silhouettes stay attached to the nearer surface",
	dualview.includes("foregroundOwner") &&
		dualview.includes("depthLine * foregroundOwner"),
);
expect(
	"each pane renders into its own local edge target",
	dualview.includes("edgePass.target.setSize(targetWidth, targetHeight)") &&
		!dualview.includes("gl.setViewport(0, 0, targetWidth, targetHeight)") &&
		!dualview.includes("regionOrigin"),
);
expect(
	"plan view remains free of shot post-processing",
	dualview.includes("draw(planCam, planPane, null, false)"),
);

if (failures) process.exit(1);
console.log("all screen-space NPR appearance checks PASS");
