/**
 * C12 gate: S7's npz gate rejects wrong-rig arrays BY NAME and lets only a
 * valid (F,27,3,3) clip through the app's REAL decodeMotionNpz (plan 5, 13,
 * 14.1 phase 2).
 *
 * WHY this test exists: the emitted npz must pass the app's own gate
 * (src/ardy/npz.js): local_rot_mats (F,27,3,3), root_positions (F,3), fps,
 * posed_joints (F,27,3), 20 fps, Y-up right-handed metres. decodeMotionNpz
 * itself already rejects a wrong rig -- the C12 RED is its own error
 * ("local_rot_mats must have shape (F, 27, 3, 3), got (124, 24, 3, 3)") --
 * but by then a wrong-rig clip has already been shipped, serialized and
 * paid for. The pipeline gate must reject the shape at its own door, before
 * emission, NAMING the member and the cskel27 joint count.
 *
 * The frame count 124 is the fixture's: 186 frames @ 29.97 fps resample to
 * exactly 124 @ 20 fps (verify-resample.mjs), so a 24-joint clip reaching
 * the app gate reads as (124, 24, 3, 3). Emission uses the plan-mandated
 * writer (tools/ardy/npz.mjs); the negative control is the ungated path
 * that reproduces the C12 RED against the real decodeMotionNpz.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateMotionNpz } from "../../src/ingest/npz-gate.js";
import { decodeMotionNpz } from "../../src/ardy/npz.js";
import { CSKEL27_JOINTS } from "../../src/ardy/cskel27.js";
import { CSKEL27_NEUTRAL } from "../../src/ardy/cskel27-neutral.js";
import { motionArraysToNpzMembers, writeNpz } from "../../tools/ardy/npz.mjs";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!cond) fail.push(label);
};

const JOINTS = CSKEL27_JOINTS.length;
const FRAMES = 124; // 186 frames @ 29.97 fps resampled to 20 fps (the C12 RED's count)
const FPS = 20;
const TOE_Y = 0.9544128;

// The synthetic cskel27 clip: neutral pose, identity rotations, frozen over
// all frames -- the same construction the Q1 contact gate uses, at the
// fixture's resampled frame count.
function makeClip(frames, joints, fps) {
	const rotMats = new Float32Array(frames * joints * 9);
	for (let i = 0; i < rotMats.length; i += 9) {
		rotMats[i] = 1;
		rotMats[i + 4] = 1;
		rotMats[i + 8] = 1;
	}
	const rootPos = new Float32Array(frames * 3);
	const posedJoints = new Float32Array(frames * joints * 3);
	for (let f = 0; f < frames; f += 1) {
		rootPos[f * 3 + 1] = TOE_Y;
		for (let j = 0; j < joints; j += 1) {
			posedJoints[(f * joints + j) * 3] = Math.fround(CSKEL27_NEUTRAL[j % JOINTS][0]);
			posedJoints[(f * joints + j) * 3 + 1] = Math.fround(CSKEL27_NEUTRAL[j % JOINTS][1] + TOE_Y);
			posedJoints[(f * joints + j) * 3 + 2] = Math.fround(CSKEL27_NEUTRAL[j % JOINTS][2]);
		}
	}
	return { frames, fps, rotMats, rootPos, posedJoints };
}

const valid = makeClip(FRAMES, JOINTS, FPS);
const dir = mkdtempSync(join(tmpdir(), "cozyclay-npz-gate-"));
const outPath = join(dir, "motion.npz");
try {
	// --- the gate accepts the valid clip --------------------------------------

	let gated = null;
	let gateError = null;
	try {
		gated = gateMotionNpz(valid);
	} catch (e) {
		gateError = e;
	}
	ok(
		"gate accepts the valid (F,27,3,3) motion",
		gateError === null && gated === valid,
		gateError ? `gate rejected: ${gateError.message}` : "gate passed the motion through unchanged",
	);

	// --- the accepted clip survives the real app gate (decodeMotionNpz) -------

	writeNpz(outPath, motionArraysToNpzMembers(valid));
	const bytes = readFileSync(outPath);
	const decoded = await decodeMotionNpz(bytes);
	let bitExact = decoded.frames === FRAMES && decoded.fps === FPS;
	for (let i = 0; i < decoded.rotMats.length; i += 1) {
		if (decoded.rotMats[i] !== valid.rotMats[i]) bitExact = false;
	}
	for (let i = 0; i < decoded.rootPos.length; i += 1) {
		if (decoded.rootPos[i] !== valid.rootPos[i]) bitExact = false;
	}
	for (let i = 0; i < decoded.posedJoints.length; i += 1) {
		if (decoded.posedJoints[i] !== valid.posedJoints[i]) bitExact = false;
	}
	ok(
		"the emitted npz passes the real decodeMotionNpz bit-exact",
		bitExact,
		`decoded ${decoded.frames} frames @ ${decoded.fps} fps, shapes (${decoded.rotMats.length / 9 / FRAMES}, 27, 3, 3)`,
	);

	// --- the gate rejects a wrong-rig clip BY NAME ----------------------------

	const smpl24 = makeClip(FRAMES, 24, FPS); // SMPL-shaped 24-joint rig
	let rejectMsg = null;
	try {
		gateMotionNpz(smpl24);
	} catch (e) {
		rejectMsg = e.message;
	}
	ok(
		"gate rejects a (F,24,3,3) clip by name (local_rot_mats, 27 joints)",
		rejectMsg !== null && rejectMsg.includes("local_rot_mats") && rejectMsg.includes(`${JOINTS}`),
		rejectMsg ? `gate: ${rejectMsg}` : "gate ACCEPTED a 24-joint clip",
	);

	const badFps = { ...valid, fps: 30 };
	let fpsMsg = null;
	try {
		gateMotionNpz(badFps);
	} catch (e) {
		fpsMsg = e.message;
	}
	ok(
		"gate rejects a non-20 fps clip by name (fps)",
		fpsMsg !== null && fpsMsg.includes("fps") && fpsMsg.includes("20"),
		fpsMsg ? `gate: ${fpsMsg}` : "gate ACCEPTED a 30 fps clip",
	);

	const badPose = makeClip(FRAMES, 24, FPS);
	const posed24 = { ...valid, posedJoints: badPose.posedJoints };
	let poseMsg = null;
	try {
		gateMotionNpz(posed24);
	} catch (e) {
		poseMsg = e.message;
	}
	ok(
		"gate rejects a 24-joint posed_joints clip by name (posed_joints)",
		poseMsg !== null && poseMsg.includes("posed_joints") && poseMsg.includes(`${JOINTS}`),
		poseMsg ? `gate: ${poseMsg}` : "gate ACCEPTED a 24-joint posed_joints clip",
	);

	const badRoot = { ...valid, rootPos: new Float32Array(FRAMES * 2) };
	let rootMsg = null;
	try {
		gateMotionNpz(badRoot);
	} catch (e) {
		rootMsg = e.message;
	}
	ok(
		"gate rejects a wrong-length root_positions clip by name (root_positions)",
		rootMsg !== null && rootMsg.includes("root_positions"),
		rootMsg ? `gate: ${rootMsg}` : "gate ACCEPTED a truncated root_positions clip",
	);

	// --- negative control: the ungated path reproduces the C12 RED ------------

	// Without the gate, a wrong-rig emitter (SMPL-shaped 24-joint data) writes
	// its OWN members -- it does not use motionArraysToNpzMembers, which
	// hardcodes 27 joints and would reject the shape on its own -- and the
	// file reaches the app gate, which rejects it with the canonical RED
	// message. The pipeline gate must therefore have rejected the same data
	// earlier, BY NAME (asserted above): the app gate's error is not the
	// pipeline's contract.
	const ungated = join(dir, "smpl24.npz");
	writeNpz(ungated, {
		local_rot_mats: { data: smpl24.rotMats, shape: [FRAMES, 24, 3, 3] },
		root_positions: { data: smpl24.rootPos, shape: [FRAMES, 3] },
		posed_joints: { data: smpl24.posedJoints, shape: [FRAMES, 24, 3] },
		fps: { data: Int32Array.of(FPS), shape: [] },
	});
	let decodeError = null;
	try {
		await decodeMotionNpz(readFileSync(ungated));
	} catch (e) {
		decodeError = e.message;
	}
	ok(
		"negative control: ungated (F,24,3,3) clip fails the app gate (the C12 RED)",
		decodeError !== null && decodeError.includes("local_rot_mats") && decodeError.includes("24"),
		`decodeMotionNpz: ${decodeError}`,
	);
} finally {
	rmSync(dir, { recursive: true, force: true });
}

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
