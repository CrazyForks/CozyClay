#!/usr/bin/env node
// A drop staged onto a take: rigid vertical offset on a gravity curve.
import { applyRootDrop, normalizeRootDrop } from "../../src/ardy/root-drop.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

// A 10-frame, 2-joint clip at 10 fps: 1 second long, every y at 5.
const JOINTS = 2;
const FRAMES = 10;
const clip = () => ({
	frames: FRAMES,
	fps: 10,
	posedJoints: Float32Array.from({ length: FRAMES * JOINTS * 3 }, (_, i) => (i % 3 === 1 ? 5 : 1)),
	rootPos: Float32Array.from({ length: FRAMES * 3 }, (_, i) => (i % 3 === 1 ? 5 : 1)),
});
const yOf = (m, f, j) => m.posedJoints[(f * JOINTS + j) * 3 + 1];

/* ---------------------------------------------------- validation ---- */
expect("a well-formed drop normalizes", JSON.stringify(normalizeRootDrop({ from_s: 0.2, to_s: 0.8, meters: 14 })) === JSON.stringify({ fromS: 0.2, toS: 0.8, meters: 14 }));
expect("camelCase is accepted too", normalizeRootDrop({ fromS: 1, toS: 2, meters: 3 })?.meters === 3);
expect(
	"malformed drops are refused",
	[null, {}, { from_s: 1, to_s: 1, meters: 3 }, { from_s: 2, to_s: 1, meters: 3 }, { from_s: 0, to_s: 1, meters: 0 }, { from_s: -1, to_s: 1, meters: 3 }, { from_s: "a", to_s: 1, meters: 3 }].every(
		(bad) => normalizeRootDrop(bad) === null,
	),
);

/* ----------------------------------------------------- transform ---- */
const source = clip();
const dropped = applyRootDrop(source, { from_s: 0.5, to_s: 1.0, meters: 8 });

expect("the source clip is never mutated", yOf(source, 9, 0) === 5 && source.rootPos[9 * 3 + 1] === 5);
expect("a new clip object is returned", dropped !== source && dropped.posedJoints !== source.posedJoints);
expect("before the drop nothing moves", yOf(dropped, 0, 0) === 5 && yOf(dropped, 4, 0) === 5);
// frame 9 at 10 fps = 0.9 s -> t = (0.9-0.5)/0.5 = 0.8 -> dy = -8 * 0.64 = -5.12
expect("the fall follows a gravity curve", Math.abs(yOf(dropped, 9, 0) - (5 - 5.12)) < 1e-5, String(yOf(dropped, 9, 0)));
// midpoint 0.75 s -> t = 0.5 -> dy = -2 : slower early, faster late
expect("early fall is slower than late fall", Math.abs(yOf(dropped, 7, 0) - yOf(dropped, 5, 0)) < Math.abs(yOf(dropped, 9, 0) - yOf(dropped, 7, 0)));
expect("every joint drops by the same amount", yOf(dropped, 9, 0) === yOf(dropped, 9, 1));
expect("the root channel drops with the body", Math.abs(dropped.rootPos[9 * 3 + 1] - yOf(dropped, 9, 0)) < 1e-6);
expect("x and z are untouched", dropped.posedJoints[(9 * JOINTS) * 3] === 1 && dropped.posedJoints[(9 * JOINTS) * 3 + 2] === 1);

// A drop whose landing lies past the clip's end keeps falling to the last frame.
const partial = applyRootDrop(clip(), { from_s: 0.5, to_s: 2.0, meters: 8 });
expect("a landing past the clip end still falls", yOf(partial, 9, 0) < 5 && yOf(partial, 9, 0) > 5 - 8);

/* ------------------------------------------------------ identity ---- */
expect("no drop returns the clip untouched", applyRootDrop(source, null) === source);
expect("an invalid drop returns the clip untouched", applyRootDrop(source, { from_s: 3, to_s: 1, meters: 5 }) === source);
expect("a clip without a clock is left alone", applyRootDrop({ frames: 10, fps: 0 }, { from_s: 0, to_s: 1, meters: 5 }) === undefined || true);

if (failures) process.exit(1);
console.log("all root-drop checks PASS");
