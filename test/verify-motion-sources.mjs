#!/usr/bin/env node
/**
 * The neutral motion registry (plan 7.4, S6): App.jsx must never name the
 * feature, so both clip slots live behind keyed accessors. Subject 2's clip
 * must actually drive Subject 2's rig — the registry routes the slot and the
 * rig plays it on the shared playhead. The registry stays subject-keyed so
 * the Phase-6 widening from two fixed slots to an N-entry `motions: Map` is
 * additive: callers never reach into slot-shaped state, and the accessor
 * already accepts a Map.
 */
import { readFileSync } from "node:fs";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { applyMotionFrame, motionBones } from "../src/ardy/playback.js";
import { CSKEL27_JOINTS } from "../src/ardy/cskel27.js";
import { CSKEL27_NEUTRAL } from "../src/ardy/cskel27-neutral.js";
import { SUBJECTS, motionFor } from "../src/motion-sources.js";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!cond) fail.push(label);
};

// A throwing export must surface as the named behavioural assertion below,
// never as a resolution error.
const safe = (fn) => {
	try {
		return fn();
	} catch {
		return null;
	}
};

// The real model both characters render (CHARACTER_MODEL_URL), app-faithful
// centimetre→metre step.
const buf = readFileSync(new URL("../public/models/y-bot-tpose.fbx", import.meta.url));
const rigB = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");
rigB.scale.setScalar(0.01);
rigB.updateMatrixWorld(true);

// Synthetic Subject-2 clip: 60 frames @ 20 fps, neutral everywhere except a
// hips rotation at frame 30 — the frame the RED checks.
const JOINTS = CSKEL27_JOINTS.length;
const ARDY_NEUTRAL_TOE = 0.9544128;
const rotMats = new Float32Array(60 * JOINTS * 9);
for (let i = 0; i < rotMats.length; i += 9) {
	rotMats[i] = 1;
	rotMats[i + 4] = 1;
	rotMats[i + 8] = 1;
}
const hipsBase = 30 * JOINTS * 9;
rotMats[hipsBase + 0] = 0;
rotMats[hipsBase + 2] = 1;
rotMats[hipsBase + 4] = 1;
rotMats[hipsBase + 6] = -1;
rotMats[hipsBase + 8] = 0;
const posedJoints = new Float32Array(60 * JOINTS * 3);
for (let f = 0; f < 60; f += 1) {
	for (let j = 0; j < JOINTS; j += 1) {
		posedJoints[(f * JOINTS + j) * 3] = CSKEL27_NEUTRAL[j][0];
		posedJoints[(f * JOINTS + j) * 3 + 1] = CSKEL27_NEUTRAL[j][1] + ARDY_NEUTRAL_TOE;
		posedJoints[(f * JOINTS + j) * 3 + 2] = CSKEL27_NEUTRAL[j][2];
	}
}
const motionB = { frames: 60, fps: 20, rotMats, rootPos: new Float32Array(60 * 3), posedJoints, anchorFrame: 0 };

// --- S6: the second slot routes and plays -----------------------------------
// The registry must hand Subject 2's slot to the playback path; at RED the
// slot resolves to nothing and the rig stays in its bind pose at frame 30.
const hips = motionBones(rigB)[CSKEL27_JOINTS.indexOf("Hips")];
const clipB = safe(() => motionFor("B", { A: null, B: motionB }));
const before = hips.quaternion.clone();
applyMotionFrame(rigB, clipB, 30);
ok(
	"Character B plays motionB",
	clipB !== null && (hips.quaternion.x !== before.x || hips.quaternion.y !== before.y || hips.quaternion.z !== before.z || hips.quaternion.w !== before.w),
	"rigB bone unchanged at frame 30",
);
ok(
	"slots are keyed A/B for the future motions: Map",
	SUBJECTS.length === 2 && SUBJECTS[0] === "A" && SUBJECTS[1] === "B",
	JSON.stringify(SUBJECTS),
);
ok(
	"the A slot routes independently of B",
	safe(() => motionFor("A", { A: motionB, B: null })) === motionB,
	"A's slot holds a clip while B's is empty",
);
ok(
	"an unknown subject reads an empty slot",
	safe(() => motionFor("C", { A: null, B: motionB })) === null,
	"unknown subject resolves null",
);
ok(
	"a Map-shaped registry widens additively",
	safe(() => motionFor("B", new Map([["A", null], ["B", motionB]]))) === motionB,
	"the Phase-6 motions: Map shape routes through the same accessor",
);

if (fail.length) {
	console.log(`\nfailures: ${fail.length}`);
	process.exit(1);
}
console.log("all motion-source registry checks PASS");
