/**
 * C11 gate: S8 placeSecondActor is ONE shared scale, ONE shared world origin
 * (plan 8.5, 13, 17 A6/A7).
 *
 * WHY this test exists: the placement formula is
 *     charB = s * rot(yaw) * (rootB[anchor] - rootA[anchor])
 * with ONE shared scale factor s and no per-person root normalization.
 * Per-character scale or per-character root normalization moves the contact
 * by ~0.1 m for a realistic pair (the C11 RED) -- contact preservation
 * (Q1/A1) is only meaningful if the placement itself is exact.
 *
 * The oracle is the reference implementation inlined in
 * test/ingest/verify-contact-preservation.mjs (A6/A7): it reads the anchor
 * frame's Hips row of posedJoints (XZ only; Y shared, yaw 0) and returns
 * [0.01 * s * dx, 0, 0.01 * s * dz]. THIS module must agree with that
 * oracle to 1e-6 -- the acceptance is the agreement, so the oracle is
 * restated inline below (the general anchor-frame form) and compared
 * directly.
 *
 * The negative controls are the two forbidden simplifications -- per-person
 * scale and per-person root normalization -- and each must FAIL the 1e-6
 * agreement by design, or the test could not tell the shared-world formula
 * from its corruptions.
 */
import { placeSecondActor } from "../../src/ingest/placement.js";
import { CSKEL27_JOINTS } from "../../src/ardy/cskel27.js";
import { CSKEL27_NEUTRAL } from "../../src/ardy/cskel27-neutral.js";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!cond) fail.push(label);
};

const JOINTS = CSKEL27_JOINTS.length;
const HIPS = CSKEL27_JOINTS.indexOf("Hips");
const FRAMES = 60;
const FPS = 20;
const TOE_Y = 0.9544128; // neutral toe depth below the hips origin (plan 17)
const S_SHARED = 101.117974; // measured y-bot scale, Q1 A8 (rig units per ARDY metre)
const S_A = 109.2547; // measured x-bot scale, Q1 A9
const S_B = 101.118; // measured y-bot scale, Q1 A9
const DIST = 1.5; // A at (0, toe, 0), B at (1.5, toe, 0): 1.5 m apart (plan 17)

// The Q1 synthetic shared-world clips (plan 17): both fighters on the ARDY
// neutral pose, anchored at frame 0, poses frozen over all 60 frames.
function makeClip(offsetX) {
	const rotMats = new Float32Array(FRAMES * JOINTS * 9);
	for (let i = 0; i < rotMats.length; i += 9) {
		rotMats[i] = 1;
		rotMats[i + 4] = 1;
		rotMats[i + 8] = 1;
	}
	const posedJoints = new Float32Array(FRAMES * JOINTS * 3);
	for (let f = 0; f < FRAMES; f += 1) {
		for (let j = 0; j < JOINTS; j += 1) {
			posedJoints[(f * JOINTS + j) * 3] = Math.fround(CSKEL27_NEUTRAL[j][0] + offsetX);
			posedJoints[(f * JOINTS + j) * 3 + 1] = Math.fround(CSKEL27_NEUTRAL[j][1] + TOE_Y);
			posedJoints[(f * JOINTS + j) * 3 + 2] = Math.fround(CSKEL27_NEUTRAL[j][2]);
		}
	}
	const rootPos = new Float32Array(FRAMES * 3);
	for (let f = 0; f < FRAMES; f += 1) {
		rootPos[f * 3] = offsetX;
		rootPos[f * 3 + 1] = TOE_Y;
	}
	return { frames: FRAMES, fps: FPS, rotMats, rootPos, posedJoints, anchorFrame: 0 };
}

const clipA = makeClip(0);
const clipB = makeClip(DIST);

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// The A6/A7 oracle, restated inline: charB = s * (rootB[anchor] - rootA[anchor])
// from the anchor frame's Hips row of posedJoints, XZ only, scaled by 0.01*s.
function inlinedPlacement(scale, a, b, anchorFrame) {
	const o = (anchorFrame * JOINTS + HIPS) * 3;
	return [0.01 * scale * (b.posedJoints[o] - a.posedJoints[o]), 0, 0.01 * scale * (b.posedJoints[o + 2] - a.posedJoints[o + 2])];
}

// --- the acceptance: agreement with the Q1 reference to 1e-6 -----------------

const p0 = placeSecondActor(S_SHARED, clipA, clipB, 0);
const err0 = dist(p0, inlinedPlacement(S_SHARED, clipA, clipB, 0));
ok(
	"placeSecondActor equals the inlined formula to 1e-6 (anchor frame 0)",
	err0 <= 1e-6,
	`placeSecondActor vs inlined formula: ${err0.toExponential(2)}m`,
);

// A non-zero anchor frame exercises the general form (the oracle indexes
// posedJoints by anchorFrame * JOINTS * 3; any frame must agree, not just 0).
const p37 = placeSecondActor(S_SHARED, clipA, clipB, 37);
const err37 = dist(p37, inlinedPlacement(S_SHARED, clipA, clipB, 37));
ok(
	"placeSecondActor equals the inlined formula to 1e-6 (anchor frame 37)",
	err37 <= 1e-6,
	`placeSecondActor vs inlined formula: ${err37.toExponential(2)}m`,
);

// ONE shared world origin: Y stays 0 (both fighters share the floor) and the
// X offset is exactly s * 1.5 m scaled to rig units -- the value Q1's A7
// feeds measure() (0.01 * sGate * 1.5).
ok(
	"one shared world origin: Y = 0, X = 0.01*s*1.5 exactly",
	p0[1] === 0 && Math.abs(p0[0] - 0.01 * S_SHARED * DIST) < 1e-12,
	`p = [${p0[0].toFixed(6)}, ${p0[1]}, ${p0[2].toFixed(6)}]`,
);

// The general formula carries rot(yaw); at yaw 0 it must reduce to the
// oracle bit-for-bit, and at 90 deg it must swap the XZ offset (within float
// dust of cos(pi/2)).
const pYaw = placeSecondActor(S_SHARED, clipA, clipB, 0, 90);
const yawExpected = [0.01 * S_SHARED * (clipB.posedJoints[(0 * JOINTS + HIPS) * 3 + 2] - clipA.posedJoints[(0 * JOINTS + HIPS) * 3 + 2]), 0, -0.01 * S_SHARED * (clipB.posedJoints[(0 * JOINTS + HIPS) * 3] - clipA.posedJoints[(0 * JOINTS + HIPS) * 3])];
ok(
	"rot(yaw) rotates the offset in the XZ plane (90 deg)",
	dist(pYaw, yawExpected) < 1e-9,
	`|p(90deg) - expected| = ${dist(pYaw, yawExpected).toExponential(1)}m`,
);

// --- negative control 1: per-person scale must FAIL the agreement ------------

// Forbidden: scale A's root by A's rig scale and B's root by B's rig scale
// (x-bot vs y-bot differ by 7.4%). The shared-scale placement uses S_A for
// both; the per-person variant shrinks B's offset by the 0.9255 ratio, so
// B lands ~0.12 m short.
const perPersonScale = [
	0.01 * (S_B * clipB.posedJoints[(0 * JOINTS + HIPS) * 3] - S_A * clipA.posedJoints[(0 * JOINTS + HIPS) * 3]),
	0,
	0.01 * (S_B * clipB.posedJoints[(0 * JOINTS + HIPS) * 3 + 2] - S_A * clipA.posedJoints[(0 * JOINTS + HIPS) * 3 + 2]),
];
const scaleErr = dist(perPersonScale, inlinedPlacement(S_A, clipA, clipB, 0));
ok(
	"negative control: per-person scale misses by ~0.12m (must exceed 1e-6)",
	scaleErr > 1e-6,
	`per-person scale: ${scaleErr.toFixed(3)}m from the shared-scale formula, expected <=1e-6`,
);

// --- negative control 2: per-person root normalization must FAIL -------------

// Forbidden: each character's root is first translated to its own origin, so
// the differenced offset is (rootB - rootB) - (rootA - rootA) = 0 and B is
// placed on A -- the shared world frame is discarded.
const perPersonRoot = [0, 0, 0];
const rootErr = dist(perPersonRoot, inlinedPlacement(S_SHARED, clipA, clipB, 0));
ok(
	"negative control: per-person root normalization drops B onto A (must exceed 1e-6)",
	rootErr > 1e-6,
	`per-person root normalization: ${rootErr.toFixed(3)}m from the shared-origin formula, expected <=1e-6`,
);

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
