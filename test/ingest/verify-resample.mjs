/**
 * C9 gate: S5 resamples the cskel27 chain to 20 fps with SLERP, never lerp
 * (plan 8.5, 13).
 *
 * WHY this test exists: rotations live on SO(3), so linearly interpolating
 * the 3x3 matrices cuts the chord -- at a 170 deg separation the naive lerp
 * midpoint lands 4.6 deg off the true slerp midpoint (the C9 RED, plan 13).
 * Positions live in Euclidean space and are lerped. The acceptance is the
 * midpoint check, plus the frame accounting the rest of the chain depends
 * on: the 186-frame 29.97 fps fixture resamples to exactly 124 frames at
 * 20 fps (the frame count the C12 RED names), output frames that coincide
 * with an input frame are copied verbatim, and every output rotation stays
 * a proper rotation so the npz gate's decodeMotionNpz can never reject the
 * chain's output.
 *
 * The negative control is the C9 RED itself: the naive matrix-lerp
 * midpoint of the same two frames must FAIL the 0.1 deg assertion by the
 * canonical 4.6 deg, or the test could not tell slerp from lerp.
 */
import { resampleMotion } from "../../src/ingest/resample.js";
import { CSKEL27_JOINTS } from "../../src/ardy/cskel27.js";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!cond) fail.push(label);
};

const JOINTS = CSKEL27_JOINTS.length;

/** Rotation about Y by `deg` degrees, row-major 3x3 flattened npz layout. */
function rotY(deg) {
	const t = (deg * Math.PI) / 180;
	const c = Math.cos(t);
	const s = Math.sin(t);
	return [c, 0, s, 0, 1, 0, -s, 0, c];
}

/** Trace-based rotation angle of a 3x3. Exact for proper rotations; the
 * naive lerp midpoint is NOT proper, and its trace-angle is the quantity
 * the C9 RED quotes (89.56 deg vs the true 85 deg midpoint). */
function traceAngleDeg(m) {
	const trace = m[0] + m[4] + m[8];
	return (Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * 180) / Math.PI;
}

function makeMotion(frames, fps, makeRot, makePos) {
	const rotMats = new Float32Array(frames * JOINTS * 9);
	const rootPos = new Float32Array(frames * 3);
	const posedJoints = new Float32Array(frames * JOINTS * 3);
	for (let f = 0; f < frames; f += 1) {
		for (let j = 0; j < JOINTS; j += 1) {
			rotMats.set(makeRot(f), (f * JOINTS + j) * 9);
		}
		for (let k = 0; k < 3; k += 1) rootPos[f * 3 + k] = makePos(f * 3 + k);
	}
	return { frames, fps, rotMats, rootPos, posedJoints };
}

const frameAt = (motion, f, j) => motion.rotMats.slice((f * JOINTS + j) * 9, (f * JOINTS + j) * 9 + 9);

// --- the C9 acceptance: 170 deg separation, slerp midpoint ------------------

// Two frames 170 deg apart (0 deg and 170 deg about Y, the axis pair whose
// naive matrix-lerp midpoint measures 89.56 deg -- 4.6 deg off the true
// 85 deg midpoint). Resample 2 frames @ 1 fps to @ 2 fps: output frames sit
// at input times 0, 0.5, 1, so frame 1 IS the midpoint.
const wide = makeMotion(
	2,
	1,
	(f) => rotY(f * 170),
	(i) => i,
);
const resampled = resampleMotion(wide, 2);

ok(
	"resample 2 frames @ 1 fps -> 3 frames @ 2 fps (no extrapolation)",
	resampled.frames === 3 && resampled.fps === 2,
	`got ${resampled.frames} frames @ ${resampled.fps} fps`,
);

const midpointError = Math.abs(traceAngleDeg(frameAt(resampled, 1, 0)) - 85);
ok(
	"170deg midpoint: within 0.1deg of the slerp midpoint (85deg)",
	midpointError <= 0.1,
	`170deg midpoint: ${midpointError.toFixed(1)}deg from slerp, expected <=0.1deg`,
);

// Frames that coincide with an input frame must be copied verbatim: output
// frames 0 and 2 sit exactly on input frames 0 and 1.
const f0 = frameAt(resampled, 0, 0);
const f2 = frameAt(resampled, 2, 0);
const exact0 = f0.every((v, k) => v === rotY(0)[k]);
const exact2 = f2.every((v, k) => v === Math.fround(rotY(170)[k])); // input rows are stored float32
ok(
	"coincident output frames are copied verbatim (alpha 0)",
	exact0 && exact2,
	`frame0 ${exact0 ? "exact" : "DRIFTED"}, frame2 ${exact2 ? "exact" : "DRIFTED"}`,
);

// Positions lerp: input rootPos is linear in the flat index (lane 0 of frame
// f holds 3f), so the midpoint output must sit halfway (0.5 * (0 + 3) = 1.5).
ok(
	"positions are lerped (Euclidean space): midpoint rootPos = mean of endpoints",
	Math.abs(resampled.rootPos[1 * 3] - 1.5) < 1e-6,
	`midpoint rootPos.x ${resampled.rootPos[1 * 3]}, expected 1.5`,
);

// --- the fixture's frame accounting (the C12 RED names 124) ------------------

const fixture = makeMotion(
	186,
	29.97,
	(f) => rotY(f * 3),
	() => 0,
);
const down = resampleMotion(fixture, 20);
ok(
	"186 frames @ 29.97 fps resample to 124 frames @ 20 fps",
	down.frames === 124 && down.fps === 20,
	`got ${down.frames} frames @ ${down.fps} fps`,
);

// Every output rotation must stay a proper rotation (det +1, R^T R = I), the
// precondition decodeMotionNpz enforces with its 1e-3 tolerance.
let worstOrtho = 0;
let worstDet = 0;
for (let f = 0; f < down.frames; f += 1) {
	for (let j = 0; j < JOINTS; j += 1) {
		const m = frameAt(down, f, j);
		let ortho = 0;
		for (let r = 0; r < 3; r += 1) {
			for (let c = 0; c < 3; c += 1) {
				let dot = 0;
				for (let k = 0; k < 3; k += 1) dot += m[r * 3 + k] * m[c * 3 + k];
				ortho = Math.max(ortho, Math.abs(dot - (r === c ? 1 : 0)));
			}
		}
		const det =
			m[0] * (m[4] * m[8] - m[5] * m[7]) -
			m[1] * (m[3] * m[8] - m[5] * m[6]) +
			m[2] * (m[3] * m[7] - m[4] * m[6]);
		worstOrtho = Math.max(worstOrtho, ortho);
		worstDet = Math.max(worstDet, Math.abs(det - 1));
	}
}
ok(
	"every resampled rotation stays a proper rotation",
	worstOrtho < 1e-6 && worstDet < 1e-6,
	`worst |R^T R - I| ${worstOrtho.toExponential(1)}, worst |det-1| ${worstDet.toExponential(1)}`,
);

// --- negative control: naive matrix lerp must FAIL the midpoint check --------

// The same 2-frame motion through an elementwise matrix-lerp resampler: the
// midpoint matrix is (I + R170)/2, whose trace-angle is 89.56 deg.
function naiveLerpResample(motion, targetFps) {
	const outFrames = Math.floor(((motion.frames - 1) * targetFps) / motion.fps) + 1;
	const rotMats = new Float32Array(outFrames * JOINTS * 9);
	const rootPos = new Float32Array(outFrames * 3);
	const posedJoints = new Float32Array(outFrames * JOINTS * 3);
	const tPer = motion.fps / targetFps;
	for (let k = 0; k < outFrames; k += 1) {
		const t = k * tPer;
		const i = Math.min(Math.floor(t), motion.frames - 2);
		const a = Math.min(Math.max(t - i, 0), 1);
		for (let j = 0; j < JOINTS; j += 1) {
			const o = (i * JOINTS + j) * 9;
			const n = (k * JOINTS + j) * 9;
			for (let c = 0; c < 9; c += 1) {
				rotMats[n + c] = motion.rotMats[o + c] * (1 - a) + motion.rotMats[((i + 1) * JOINTS + j) * 9 + c] * a;
			}
		}
		for (let c = 0; c < 3; c += 1) {
			rootPos[k * 3 + c] = motion.rootPos[i * 3 + c] * (1 - a) + motion.rootPos[(i + 1) * 3 + c] * a;
			for (let j = 0; j < JOINTS; j += 1) {
				posedJoints[(k * JOINTS + j) * 3 + c] =
					motion.posedJoints[(i * JOINTS + j) * 3 + c] * (1 - a) +
					motion.posedJoints[((i + 1) * JOINTS + j) * 3 + c] * a;
			}
		}
	}
	return { frames: outFrames, fps: targetFps, rotMats, rootPos, posedJoints };
}

const naiveMidpointError = Math.abs(traceAngleDeg(frameAt(naiveLerpResample(wide, 2), 1, 0)) - 85);
ok(
	"negative control: naive matrix-lerp midpoint misses by ~4.6deg (the C9 RED)",
	naiveMidpointError > 0.1 && Math.abs(naiveMidpointError - 4.6) <= 0.05,
	`170deg midpoint: ${naiveMidpointError.toFixed(1)}deg from slerp, expected <=0.1deg`,
);

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
