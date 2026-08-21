#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { serializeUsdCamera } from "../src/usd-camera.js";

const cameraTrack = Array.from({ length: 15 }, (_, frame) => ({
	pos: { x: frame, y: 1.5, z: 4 },
	yaw: 0,
	pitch: 0,
	fovDeg: 45,
	focalMm: 35,
	sensorId: "fullFrame",
}));
cameraTrack[12] = {
	pos: { x: 1, y: 2, z: 3 },
	yaw: Math.PI / 6,
	pitch: Math.PI / 9,
	fovDeg: 39.6,
	focalMm: 50,
	sensorId: "fullFrame",
};
cameraTrack[13] = {
	pos: { x: 1.5, y: 2.25, z: 2.5 },
	yaw: Math.PI / 4,
	pitch: Math.PI / 12,
	fovDeg: 31.2,
	focalMm: 65,
	sensorId: "fullFrame",
};
cameraTrack[14] = {
	pos: { x: 2, y: 2.5, z: 2 },
	yaw: Math.PI / 3,
	pitch: 0,
	fovDeg: 24.1,
	focalMm: 85,
	sensorId: "fullFrame",
};

const scene = {
	frameCount: cameraTrack.length,
	cameraTrack,
	filmback: { sensorId: "fullFrame", aspectRatio: 16 / 9 },
};
const shot = {
	name: "Arrival",
	startFrame: 12,
	endFrame: 14,
	camera: { mode: "follow" },
};

const before = JSON.stringify({ scene, shot });
const serialized = serializeUsdCamera(scene, shot);
const snapshotUrl = new URL("./snapshots/arrival-camera.usda", import.meta.url);
assert.equal(serialized, await readFile(snapshotUrl, "utf8"), "USDA camera matches the reviewed snapshot");
assert.equal(JSON.stringify({ scene, shot }), before, "USD export is pure");

assert.match(serialized, /timeCodesPerSecond = 24/);
assert.match(serialized, /startTimeCode = 12/);
assert.match(serialized, /endTimeCode = 14/);
assert.match(serialized, /custom float cozyclay:verticalApertureMm = 20\.25/);
assert.match(serialized, /custom float cozyclay:horizontalApertureMm = 36/,
	"16:9 crop restores a 36mm horizontal gate instead of reusing the 20.25mm vertical gate");
assert.match(serialized, /13: \(1\.5, 2\.25, 2\.5\)/,
	"the middle frame comes from sampleAt, not shotMetadata's start-frame camera");
assert.match(serialized, /13: 65,/,
	"animated focal length comes from the same addressed camera sample");

// Frame 12 hand check. Three applies YXZ as Ry(30°) * Rx(20°), and both
// Three and USD cameras look down local -Z. The exported (pitch, yaw, roll)
// tuple (20, 30, 0) must therefore point along this world-space unit vector.
const yaw = Math.PI / 6;
const pitch = Math.PI / 9;
const forward = {
	x: -Math.sin(yaw) * Math.cos(pitch),
	y: Math.sin(pitch),
	z: -Math.cos(yaw) * Math.cos(pitch),
};
const expectedForward = {
	x: -0.4698463103929542,
	y: 0.3420201433256687,
	z: -0.8137976813493738,
};
for (const axis of ["x", "y", "z"]) {
	assert.ok(Math.abs(forward[axis] - expectedForward[axis]) < 1e-12,
		`frame 12 ${axis} forward component matches the hand calculation`);
}
assert.match(serialized, /12: \(20, 30, 0\)/,
	"USD rotateYXZ receives Three's pitch/yaw in degrees without an axis flip");

assert.throws(
	() => serializeUsdCamera(scene, { ...shot, endFrame: 15 }),
	/outside the scene range/,
	"a clamped sample cannot silently duplicate the last camera frame",
);

console.log("USD camera verified: 3 addressed frames, 36x20.25mm cropped gate, 24 fps");
