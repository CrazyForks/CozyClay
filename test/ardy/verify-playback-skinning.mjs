/**
 * Real-rig positional-skinning validation: loads the actual
 * cozyclay-male-neutral.fbx (the same asset the app renders and the viser demo's
 * avatar asset was prepared from) and drives it with a synthetic motion
 * built on the ARDY neutral skeleton (cskel27-neutral.js, exported from
 * CoreSkeleton27.neutral_joints on the box).
 *
 * Assertions:
 *  1. Zero pop: a frame at the floor-shifted ARDY neutral pose reproduces
 *     the rig's bind world positions/quaternions for every mapped bone.
 *  2. Floor plant: with the neutral pose the lowest mapped bone sits within
 *     millimetres of the rig's bind floor (offset residual only).
 *  3. Translation + rotation: a translated, hips-rotated frame moves every
 *     mapped bone to the independently computed skinning target
 *     (s * posed + R @ offset, R @ bindQuat).
 *  4. The prep scale factor is in the plausible cm-per-metre band (guards
 *     the unit logic: X Bot bind hips 104.27 rig units vs ARDY 0.9544 m).
 */
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { readFileSync } from "node:fs";
import {
	applyMotionFrame,
	motionBones,
	snapshotPlaybackBones,
	restorePlaybackBones,
} from "../../src/ardy/playback.js";
import { CSKEL27_JOINTS } from "../../src/ardy/cskel27.js";
import { CSKEL27_NEUTRAL } from "../../src/ardy/cskel27-neutral.js";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!cond) fail.push(label);
};

const quatMaxError = (a, b) => {
	let best = Infinity;
	for (const sign of [1, -1]) {
		const err = Math.max(
			Math.abs(a.x - sign * b.x),
			Math.abs(a.y - sign * b.y),
			Math.abs(a.z - sign * b.z),
			Math.abs(a.w - sign * b.w),
		);
		if (err < best) best = err;
	}
	return best;
};

const ARDY_NEUTRAL_TOE = 0.9544128;
const JOINTS = CSKEL27_JOINTS.length;

const buf = readFileSync(new URL("../../public/models/cozyclay-male-neutral.fbx", import.meta.url));
const rig = new FBXLoader().parse(
	buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
	"",
);
// App-faithful: the CC0 mannequins are authored and rendered in metres.
rig.scale.setScalar(1);
rig.updateMatrixWorld(true);

const bones = motionBones(rig);
const mapped = [];
for (let j = 0; j < JOINTS; j += 1) {
	if (bones[j]) mapped.push({ j, bone: bones[j] });
}
ok("real rig: skinning map resolves the Mixamo core bones", mapped.length >= 20, `mapped=${mapped.length}/27`);

// Bind reference (world, rig at origin) + local transforms for restore.
const bindWorldPos = new Map();
const bindWorldQuat = new Map();
const bindLocal = new Map();
for (const { bone } of mapped) {
	bindWorldPos.set(bone, bone.getWorldPosition(new THREE.Vector3()));
	bindWorldQuat.set(bone, bone.getWorldQuaternion(new THREE.Quaternion()));
	bindLocal.set(bone, { pos: bone.position.clone(), quat: bone.quaternion.clone() });
}

// Independent scale replication: rig leg height over ARDY's neutral leg.
const hips = bones[CSKEL27_JOINTS.indexOf("Hips")];
const hipsY = bindWorldPos.get(hips).y;
let lowestY = hipsY;
for (const { bone } of mapped) lowestY = Math.min(lowestY, bindWorldPos.get(bone).y);
const S = (hipsY - lowestY) / ARDY_NEUTRAL_TOE;
ok(
	"real rig: prep scale matches the rig-to-ARDY leg ratio",
	S > 0.75 && S < 1.25,
	`S=${S.toFixed(4)} scene units/m (bind hips ${hipsY.toFixed(4)} scene units)`,
);

// Motion: frame 0 = floor-shifted neutral (zero-pop + floor-plant checks),
// frame 1 = neutral translated by (+0.5, 0, -0.25) m with hips rotY(90).
const rotMats = new Float32Array(2 * JOINTS * 9);
for (let i = 0; i < rotMats.length; i += 9) {
	rotMats[i] = 1;
	rotMats[i + 4] = 1;
	rotMats[i + 8] = 1;
}
const hipsRotBase = JOINTS * 9; // frame 1, joint 0
rotMats[hipsRotBase + 0] = 0;
rotMats[hipsRotBase + 2] = 1;
rotMats[hipsRotBase + 4] = 1;
rotMats[hipsRotBase + 6] = -1;
rotMats[hipsRotBase + 8] = 0;

const posedJoints = new Float32Array(2 * JOINTS * 3);
for (let j = 0; j < JOINTS; j += 1) {
	const n = CSKEL27_NEUTRAL[j];
	posedJoints[(0 * JOINTS + j) * 3] = Math.fround(n[0]);
	posedJoints[(0 * JOINTS + j) * 3 + 1] = Math.fround(n[1] + ARDY_NEUTRAL_TOE);
	posedJoints[(0 * JOINTS + j) * 3 + 2] = Math.fround(n[2]);
	posedJoints[(1 * JOINTS + j) * 3] = Math.fround(n[0] + 0.5);
	posedJoints[(1 * JOINTS + j) * 3 + 1] = Math.fround(n[1] + ARDY_NEUTRAL_TOE);
	posedJoints[(1 * JOINTS + j) * 3 + 2] = Math.fround(n[2] - 0.25);
}
const rootY = Math.fround(ARDY_NEUTRAL_TOE);
const rootPos = new Float32Array([0, rootY, 0, 0.5, rootY, -0.25]);
const motion = { frames: 2, fps: 20, rotMats, rootPos, posedJoints, anchorFrame: 0 };

const snapshot = snapshotPlaybackBones(rig);

// 1. zero pop at the neutral frame.
applyMotionFrame(rig, motion, 0);
rig.updateMatrixWorld(true);
let popErr = 0;
let popQuatErr = 0;
let popWorst = "";
for (const { bone } of mapped) {
	const err = bone.getWorldPosition(new THREE.Vector3()).distanceTo(bindWorldPos.get(bone));
	if (err > popErr) { popErr = err; popWorst = bone.name; }
	popQuatErr = Math.max(popQuatErr, quatMaxError(bone.getWorldQuaternion(new THREE.Quaternion()), bindWorldQuat.get(bone)));
}
ok(
	"real rig: neutral frame reproduces the bind pose (zero pop)",
	popErr < 0.002 && popQuatErr < 1e-3,
	`max pos err ${popErr.toFixed(5)} scene units at ${popWorst}, max quat err ${popQuatErr.toExponential(1)}`,
);

// 2. floor plant: the lowest mapped bone returns to its bind floor height.
let lowestBoneY = Infinity;
for (const { bone } of mapped) lowestBoneY = Math.min(lowestBoneY, bone.getWorldPosition(new THREE.Vector3()).y);
ok(
	"real rig: lowest mapped bone plants at the bind floor",
	Math.abs(lowestBoneY - lowestY) < 0.002,
	`lowest=${lowestBoneY.toFixed(5)} bind floor=${lowestY.toFixed(5)}`,
);

// 3. translated + rotated frame: independent target for every mapped bone.
applyMotionFrame(rig, motion, 1);
rig.updateMatrixWorld(true);
const qGlobal = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
const anchorX = Math.fround(CSKEL27_NEUTRAL[0][0]); // anchor hips xz (frame 0)
const anchorZ = Math.fround(CSKEL27_NEUTRAL[0][2]);
let posErr = 0;
let quatErr = 0;
let posWorst = "";
for (const { j, bone } of mapped) {
	const n = CSKEL27_NEUTRAL[j];
	const offset = bindWorldPos.get(bone).clone().sub(new THREE.Vector3(
		S * n[0],
		S * (n[1] + ARDY_NEUTRAL_TOE),
		S * n[2],
	));
	const expected = new THREE.Vector3(
		S * (Math.fround(n[0] + 0.5) - anchorX),
		S * Math.fround(n[1] + ARDY_NEUTRAL_TOE),
		S * (Math.fround(n[2] - 0.25) - anchorZ),
	).add(offset.applyQuaternion(qGlobal));
	const err = bone.getWorldPosition(new THREE.Vector3()).distanceTo(expected);
	if (err > posErr) { posErr = err; posWorst = bone.name; }
	const expectedQuat = qGlobal.clone().multiply(bindWorldQuat.get(bone));
	quatErr = Math.max(quatErr, quatMaxError(bone.getWorldQuaternion(new THREE.Quaternion()), expectedQuat));
}
ok(
	"real rig: translated/rotated frame hits s*posed + R@offset everywhere",
	posErr < 0.005 && quatErr < 1e-3,
	`max pos err ${posErr.toFixed(5)} scene units at ${posWorst}, max quat err ${quatErr.toExponential(1)}`,
);

// 4. restore reproduces the bind transforms bitwise.
restorePlaybackBones(rig, snapshot);
ok(
	"real rig: restore reproduces bind transforms exactly",
	mapped.every(({ bone }) => {
		const b = bindLocal.get(bone);
		return bone.position.equals(b.pos) && bone.quaternion.equals(b.quat);
	}),
	`bones=${mapped.length} bitwise`,
);

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
