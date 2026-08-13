#!/usr/bin/env node
import assert from "node:assert/strict";
import {
	loadShotAuthoring,
	readShotAuthoring,
	serializeShotAuthoring,
	SHOT_AUTHORING_KEY,
	SHOT_AUTHORING_LEGACY_KEY,
	SHOT_AUTHORING_QUARANTINE_KEY,
} from "../src/shot-authoring.js";

const framing = (fovDeg) => ({ pos: { x: 1, y: 1.6, z: 2.4 }, yaw: 0.2, pitch: -0.1, fovDeg });
const shots = [
	{ id: "wide", name: "Wide", startFrame: 0, cameraKeys: [{ frame: 0, framing: framing(40) }] },
	{ id: "close", name: "Close", startFrame: 100, cameraKeys: [{ frame: 100, framing: framing(70) }] },
];

const authored = {
	shots,
	waypoints: [{ frame: 60, x: 1.5, z: -2, heading: null }],
	frameCount: 300,
	followCam: { enabled: true, distance: 3.5, height: 1.8, response: 0.6, lead: 0.2 },
	cameraRail: [{ x: -2, z: -1 }, { x: 1, z: 5 }],
};
const restored = loadShotAuthoring(serializeShotAuthoring(authored));
assert.equal(restored.frameCount, 300);
assert.deepEqual(restored.shots, shots);
assert.deepEqual(restored.waypoints, authored.waypoints);
assert.deepEqual(restored.followCam, authored.followCam);
assert.deepEqual(restored.cameraRail, authored.cameraRail);

const legacy = readShotAuthoring(JSON.stringify({
	version: 1,
	frameCount: 200,
	cameraKeys: [{ frame: 10, framing: framing(35) }, { frame: 180, framing: framing(80) }],
	waypoints: [],
}));
assert.equal(legacy.status, "migrated");
assert.equal(legacy.state.shots.length, 1);
assert.equal(legacy.state.shots[0].startFrame, 0);
assert.deepEqual(legacy.state.shots[0].cameraKeys.map((key) => key.frame), [10, 180]);

assert.equal(readShotAuthoring(null).status, "absent");
assert.equal(readShotAuthoring("{nope").status, "corrupt");
assert.equal(readShotAuthoring('"hello"').status, "corrupt");
assert.equal(readShotAuthoring(JSON.stringify({ version: 2, frameCount: 100 })).status, "corrupt");
assert.equal(readShotAuthoring(JSON.stringify({ version: 99, shots: [] })).status, "future");
assert.equal(loadShotAuthoring("{nope"), null);

const repaired = loadShotAuthoring(JSON.stringify({
	version: 2,
	frameCount: 100,
	shots: [
		{ id: "same", name: " A ", startFrame: 30, cameraKeys: [{ frame: -10, framing: framing(20) }] },
		{ id: "same", name: "", startFrame: 70, cameraKeys: [{ frame: 999, framing: framing(90) }, { frame: 80, framing: null }] },
		{ id: "bad", startFrame: "later", cameraKeys: [] },
	],
	waypoints: [{ frame: 3.6, x: 1, z: 2, heading: "north" }, { frame: 2, x: Infinity, z: 0 }],
	followCam: { enabled: "yes", distance: 999, lead: -5 },
	cameraRail: [{ x: 0, z: 0 }, { x: Infinity, z: 1 }, { x: 2, z: 2 }],
}));
assert.deepEqual(repaired.shots.map((shot) => shot.startFrame), [0, 70]);
assert.equal(new Set(repaired.shots.map((shot) => shot.id)).size, repaired.shots.length);
assert.equal(repaired.shots[0].name, "A");
assert.equal(repaired.shots[0].cameraKeys[0].frame, 0);
assert.equal(repaired.shots[1].cameraKeys[0].frame, 99);
assert.deepEqual(repaired.waypoints, [{ frame: 4, x: 1, z: 2, heading: null }]);
assert.deepEqual(repaired.followCam, { enabled: false, distance: 15, lead: 0 });
assert.deepEqual(repaired.cameraRail, [{ x: 0, z: 0 }, { x: 2, z: 2 }]);

assert.equal(SHOT_AUTHORING_KEY, "cozyclay.shot-authoring.v2");
assert.equal(SHOT_AUTHORING_LEGACY_KEY, "cozyclay.shot-authoring.v1");
assert.equal(SHOT_AUTHORING_QUARANTINE_KEY, "cozyclay.shot-authoring.v2.quarantine");

console.log("all shot-authoring checks PASS");
