#!/usr/bin/env node
import assert from "node:assert/strict";
import {
	createShotAuthoringDocument,
	loadShotAuthoring,
	readShotAuthoring,
	readShotAuthoringDocument,
	serializeShotAuthoring,
	SHOT_AUTHORING_KEY,
	SHOT_AUTHORING_LEGACY_KEY,
	SHOT_AUTHORING_LEGACY_KEYS,
	SHOT_AUTHORING_QUARANTINE_KEY,
} from "../src/shot-authoring.js";

const framing = (fovDeg) => ({ pos: { x: 1, y: 1.6, z: 2.4 }, yaw: 0.2, pitch: -0.1, fovDeg });
const followCam = {
	distance: 3.5,
	height: 1.8,
	response: 0.6,
	lead: 0.2,
	railStartMode: "nearest",
	maxDollySpeed: 2.4,
	pitchOffsetDeg: -10,
};
const cameraRail = [{ x: -2, z: -1 }, { x: 1, z: 5 }];
const shots = [
	{
		id: "wide",
		name: "Wide",
		startFrame: 0,
		endFrame: 99,
		cameraKeys: [{ frame: 0, framing: framing(40) }],
		camera: { mode: "keys", followCam, cameraRail: null, railFollow: null },
	},
	{
		id: "close",
		name: "Close",
		startFrame: 100,
		endFrame: 299,
		cameraKeys: [{ frame: 100, framing: framing(70) }],
		camera: { mode: "rail", followCam, cameraRail, railFollow: { mode: "range", startFrame: 10, endFrame: 80 } },
	},
];

// v3 writes only the canonical body and round-trips per-shot camera blocks.
const authored = {
	shots,
	waypoints: [{ frame: 60, x: 1.5, z: -2, heading: null }],
	frameCount: 300,
	followCam: { enabled: true },
	cameraRail,
};
const document = createShotAuthoringDocument(authored);
assert.deepEqual(Object.keys(document), ["version", "frameCount", "shots", "waypoints"]);
assert.equal(document.version, 3);
const objectRestored = readShotAuthoringDocument(document);
assert.equal(objectRestored.status, "valid");
assert.deepEqual(objectRestored.state, {
	frameCount: 300,
	waypoints: authored.waypoints,
	shots,
});

// The object API is location-independent: nesting under Scene is only a caller concern.
const futureSceneEnvelope = { version: 1, scenes: [{ id: "scene-1", shotDocument: document }] };
assert.deepEqual(readShotAuthoringDocument(futureSceneEnvelope.scenes[0].shotDocument), objectRestored);
assert.equal(readShotAuthoringDocument(undefined).status, "absent");
assert.equal(readShotAuthoringDocument("not-an-object").status, "corrupt");

const raw = serializeShotAuthoring(authored);
assert.deepEqual(JSON.parse(raw), document);
const restored = readShotAuthoring(raw);
assert.equal(restored.status, "valid");
assert.equal(restored.state.frameCount, 300);
assert.deepEqual(restored.state.shots, shots);
assert.deepEqual(restored.state.waypoints, authored.waypoints);
assert.equal("followCam" in restored.state, false);
assert.equal("cameraRail" in restored.state, false);
assert.deepEqual(restored.state.shots[1].camera.railFollow, { mode: "range", startFrame: 10, endFrame: 80 });

const emptyV3 = readShotAuthoring(JSON.stringify({ version: 3, frameCount: 300, shots: [], waypoints: [] }));
assert.equal(emptyV3.status, "valid");
assert.deepEqual(emptyV3.state.shots, [], "zero Shots is a normal persisted state");
const gapV3 = readShotAuthoring(JSON.stringify({
	version: 3,
	frameCount: 300,
	shots: [{ startFrame: 20, endFrame: 59 }, { startFrame: 100, endFrame: 139 }],
	waypoints: [],
}));
assert.deepEqual(gapV3.state.shots.map(({ startFrame, endFrame }) => [startFrame, endFrame]), [[20, 59], [100, 139]]);

// v2 globals become independent camera settings on EVERY repaired shot.
const v2 = readShotAuthoring(JSON.stringify({
	version: 2,
	frameCount: 200,
	shots: shots.map(({ camera, ...shot }) => shot),
	waypoints: [],
	followCam: { enabled: true, ...followCam },
	cameraRail,
	railFollow: { mode: "range", startFrame: 20, endFrame: 90 },
}));
assert.equal(v2.status, "migrated");
assert.equal(v2.state.shots.length, 2);
for (const shot of v2.state.shots) {
	assert.equal(shot.camera.mode, "rail");
	assert.deepEqual(shot.camera.followCam, followCam);
	assert.deepEqual(shot.camera.cameraRail, cameraRail);
	assert.deepEqual(shot.camera.railFollow, { mode: "range", startFrame: 20, endFrame: 90 });
}
assert.notEqual(v2.state.shots[0].camera, v2.state.shots[1].camera);
assert.notEqual(v2.state.shots[0].camera.followCam, v2.state.shots[1].camera.followCam);
assert.notEqual(v2.state.shots[0].camera.cameraRail, v2.state.shots[1].camera.cameraRail);
v2.state.shots[0].camera.followCam.distance = 9;
v2.state.shots[0].camera.cameraRail[0].x = 99;
assert.equal(v2.state.shots[1].camera.followCam.distance, 3.5);
assert.equal(v2.state.shots[1].camera.cameraRail[0].x, -2);

// Migration mode is derived from the old enabled flag and usable rail.
const migrateMode = (enabled, rail) => readShotAuthoring(JSON.stringify({
	version: 2,
	frameCount: 100,
	shots: [{ startFrame: 0, cameraKeys: [] }],
	followCam: { enabled },
	cameraRail: rail,
})).state.shots[0].camera.mode;
assert.equal(migrateMode(false, cameraRail), "keys");
assert.equal(migrateMode(true, null), "follow");
assert.equal(migrateMode(true, [{ x: 0, z: 0 }]), "follow");
assert.equal(migrateMode(true, cameraRail), "rail");

// A v1 roll follows the same migration rules and arrives as one v3 shot.
const v1 = readShotAuthoring(JSON.stringify({
	version: 1,
	frameCount: 200,
	cameraKeys: [{ frame: 10, framing: framing(35) }, { frame: 180, framing: framing(80) }],
	waypoints: [],
	followCam: { enabled: true, distance: 4 },
}));
assert.equal(v1.status, "migrated");
assert.equal(v1.state.shots.length, 1);
assert.deepEqual(v1.state.shots[0].cameraKeys.map((key) => key.frame), [10, 180]);
assert.equal(v1.state.shots[0].camera.mode, "follow");
assert.deepEqual(v1.state.shots[0].camera.followCam, {
	distance: 4,
	height: 1.6,
	response: 0.7,
	lead: 0.25,
	railStartMode: "head",
	maxDollySpeed: 4,
	pitchOffsetDeg: 0,
});

// Invalid v3 block fields are repaired independently without leaking globals.
const repaired = loadShotAuthoring(JSON.stringify({
	version: 3,
	frameCount: 100,
	shots: [
		{
			id: "same",
			name: " A ",
			startFrame: 30,
			cameraKeys: [{ frame: -10, framing: framing(20) }],
			camera: {
				mode: "rail",
				followCam: {
					distance: 999,
					lead: -5,
					railStartMode: "middle",
					maxDollySpeed: 999,
					pitchOffsetDeg: -999,
				},
				cameraRail: [{ x: 0, z: 0 }, { x: Infinity, z: 1 }],
			},
		},
		{ id: "same", name: "", startFrame: 70, cameraKeys: [{ frame: 999, framing: framing(90) }], camera: { mode: "orbit" } },
	],
	waypoints: [{ frame: 3.6, x: 1, z: 2, heading: "north" }, { frame: 2, x: Infinity, z: 0 }],
}));
assert.deepEqual(repaired.shots.map((shot) => shot.startFrame), [30, 70]);
assert.equal(new Set(repaired.shots.map((shot) => shot.id)).size, 2);
assert.equal(repaired.shots[0].name, "A");
assert.equal(repaired.shots[0].cameraKeys[0].frame, 30);
assert.equal(repaired.shots[1].cameraKeys[0].frame, 99);
assert.deepEqual(repaired.waypoints, [{ frame: 4, x: 1, z: 2, heading: null }]);
assert.deepEqual(repaired.shots[0].camera, {
	mode: "follow",
	followCam: {
		distance: 15,
		height: 1.6,
		response: 0.7,
		lead: 0,
		railStartMode: "head",
		maxDollySpeed: 8,
		pitchOffsetDeg: -30,
	},
	cameraRail: null,
	railFollow: null,
});
assert.equal(repaired.shots[1].camera.mode, "keys");

// Rail Follow is part of each self-contained Camera Block, not a v3 global.
assert.equal("railFollow" in document, false);
const offRail = loadShotAuthoring(serializeShotAuthoring({
	frameCount: 100,
	shots: [{ startFrame: 0, camera: { mode: "rail", cameraRail, railFollow: { mode: "off" } } }],
}));
assert.deepEqual(offRail.shots[0].camera.railFollow, { mode: "off" });
const badRail = loadShotAuthoring(JSON.stringify({
	version: 3,
	frameCount: 100,
	shots: [{ startFrame: 0, camera: { mode: "rail", cameraRail, railFollow: { mode: "range", startFrame: 50, endFrame: 10 } } }],
}));
assert.equal(badRail.shots[0].camera.railFollow, null);

// Corrupt/future bytes remain tagged so App can quarantine or preserve them.
assert.equal(readShotAuthoring(null).status, "absent");
assert.equal(readShotAuthoring("{nope").status, "corrupt");
assert.equal(readShotAuthoring('"hello"').status, "corrupt");
assert.equal(readShotAuthoring(JSON.stringify({ version: 3, frameCount: 100 })).status, "corrupt");
assert.equal(readShotAuthoring(JSON.stringify({ version: 99, shots: [] })).status, "future");
assert.equal(loadShotAuthoring("{nope"), null);

assert.equal(SHOT_AUTHORING_KEY, "cozyclay.shot-authoring.v3");
assert.equal(SHOT_AUTHORING_LEGACY_KEY, "cozyclay.shot-authoring.v2");
assert.deepEqual(SHOT_AUTHORING_LEGACY_KEYS, ["cozyclay.shot-authoring.v2", "cozyclay.shot-authoring.v1"]);
assert.equal(SHOT_AUTHORING_QUARANTINE_KEY, "cozyclay.shot-authoring.v3.quarantine");

console.log("all shot-authoring checks PASS");
