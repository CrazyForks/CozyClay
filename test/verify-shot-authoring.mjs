#!/usr/bin/env node
// Contracts for shot-authoring persistence: what survives a reload, and how
// hostile or half-corrupt storage payloads are tamed on the way back in.
import { loadShotAuthoring, serializeShotAuthoring, SHOT_AUTHORING_KEY } from "../src/shot-authoring.js";

let failures = 0;
const expect = (name, cond, detail = "") => {
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` — ${detail}`}`);
	if (!cond) failures += 1;
};

const framing = (fovDeg) => ({ pos: { x: 1, y: 1.6, z: 2.4 }, yaw: 0.2, pitch: -0.1, fovDeg });

/* ---------------------------------------------------- round trip ---- */

const authored = {
	cameraKeys: [
		{ frame: 0, framing: framing(40) },
		{ frame: 180, framing: framing(70) },
	],
	waypoints: [
		{ frame: 60, x: 1.5, z: -2, heading: null },
		{ frame: 140, x: 3, z: 1, heading: 0.5 },
	],
	frameCount: 300,
};
const restored = loadShotAuthoring(serializeShotAuthoring(authored));
expect("round trip keeps the clip length", restored.frameCount === 300);
expect(
	"round trip keeps every camera key",
	restored.cameraKeys.length === 2 && restored.cameraKeys[1].frame === 180 && restored.cameraKeys[1].framing.fovDeg === 70,
	JSON.stringify(restored.cameraKeys),
);
expect(
	"round trip keeps every waypoint",
	restored.waypoints.length === 2 && restored.waypoints[0].heading === null && restored.waypoints[1].heading === 0.5,
	JSON.stringify(restored.waypoints),
);

/* ------------------------------------------------- hostile input ---- */

expect("nothing stored starts fresh", loadShotAuthoring(null) === null && loadShotAuthoring("") === null);
expect("broken JSON starts fresh", loadShotAuthoring("{nope") === null);
expect("a non-object payload starts fresh", loadShotAuthoring('"hello"') === null && loadShotAuthoring("42") === null);

const mixed = loadShotAuthoring(
	JSON.stringify({
		version: 1,
		frameCount: "soon",
		cameraKeys: [
			{ frame: 20, framing: framing(50) },
			{ frame: -5, framing: framing(50) }, // negative frame
			{ frame: 40, framing: { pos: { x: 0, y: Number.NaN, z: 0 }, yaw: 0, pitch: 0, fovDeg: 40 } }, // NaN inside
			{ frame: 60 }, // no framing
			"garbage",
		],
		waypoints: [
			{ frame: 30, x: 1, z: 1, heading: "north" }, // non-numeric heading -> null
			{ frame: 50, x: Number.POSITIVE_INFINITY, z: 0 }, // non-finite position
			null,
		],
	}),
);
expect("a bad key is dropped without taking the shot down", mixed.cameraKeys.length === 1 && mixed.cameraKeys[0].frame === 20, JSON.stringify(mixed.cameraKeys));
expect("a bad waypoint is dropped, bad heading folds to null", mixed.waypoints.length === 1 && mixed.waypoints[0].heading === null, JSON.stringify(mixed.waypoints));
expect("an unusable clip length falls back to the default", mixed.frameCount === null);

/* ------------------------------------------------ normalisation ---- */

const messy = loadShotAuthoring(
	JSON.stringify({
		frameCount: 1e9,
		cameraKeys: [
			{ frame: 100.4, framing: framing(30) },
			{ frame: 10, framing: framing(20) },
			{ frame: 100, framing: framing(90) }, // duplicate frame: later entry wins
		],
		waypoints: [
			{ frame: 80, x: 2, z: 2 },
			{ frame: 20, x: 1, z: 1 },
		],
	}),
);
expect("keys come back sorted by frame", messy.cameraKeys.map((k) => k.frame).join(",") === "10,100");
expect("duplicate key frames keep the later entry (re-key semantics)", messy.cameraKeys[1].framing.fovDeg === 90);
expect("waypoints come back sorted by frame", messy.waypoints.map((w) => w.frame).join(",") === "20,80");
expect("clip length is clamped to sane bounds", messy.frameCount === 24000, String(messy.frameCount));

expect("storage key is versioned", /\.v\d+$/.test(SHOT_AUTHORING_KEY), SHOT_AUTHORING_KEY);

console.log(failures === 0 ? "all shot-authoring checks PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
