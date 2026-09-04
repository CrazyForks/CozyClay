import test from "node:test";
import assert from "node:assert/strict";
import { smplToCskel27Motion } from "../tools/ardy/smpl-cskel27.mjs";
import { CSKEL27_JOINTS } from "../src/ardy/cskel27.js";
import { canonicalCskel27Reference } from "../src/ardy/to-cskel27.js";
import { globalRotations, matTranspose, matMul, quatToMat, forwardKinematics } from "../src/ardy/convert.js";
import { existsSync } from "node:fs";
import { readNpz } from "../tools/kimodo/read-npz.mjs";

const rest = (() => {
	const p = Array.from({ length: 24 }, () => [0, 0, 0]);
	p[0] = [0, 0, 0]; p[1] = [0.065, -0.091, -0.013]; p[2] = [-0.065, -0.091, -0.013];
	p[3] = [0, 0.108, -0.005]; p[4] = [0.098, -0.470, -0.022]; p[5] = [-0.098, -0.470, -0.022];
	p[6] = [0, 0.245, 0.008]; p[7] = [0.083, -0.867, -0.063]; p[8] = [-0.083, -0.867, -0.063];
	p[9] = [0, 0.301, 0.026]; p[10] = [0.109, -0.923, 0.053]; p[11] = [-0.109, -0.923, 0.053];
	p[12] = [0, 0.521, -0.004]; p[13] = [0.072, 0.418, -0.009]; p[14] = [-0.072, 0.418, -0.009];
	p[15] = [0, 0.581, 0.026]; p[16] = [0.153, 0.440, -0.016]; p[17] = [-0.153, 0.440, -0.016];
	p[18] = [0.399, 0.394, -0.040]; p[19] = [-0.399, 0.394, -0.040];
	p[20] = [0.635, 0.398, -0.042]; p[21] = [-0.635, 0.398, -0.042];
	p[22] = [0.715, 0.398, -0.042]; p[23] = [-0.715, 0.398, -0.042];
	return p;
})();
const parents = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19, 20, 21];
const axis = (a, n) => [a[0] * n, a[1] * n, a[2] * n];
const aa = (a, n) => axis(a, n);
function sourceFk(globalOrient, bodyPose, transl) {
	const locals = [quatToMat([Math.cos(Math.hypot(...globalOrient) / 2), ...axis(globalOrient, Math.sin(Math.hypot(...globalOrient) / 2) / (Math.hypot(...globalOrient) || 1))])];
	for (let j = 1; j < 24; j += 1) locals[j] = quatToMat([Math.cos(Math.hypot(...bodyPose[j - 1]) / 2), ...axis(bodyPose[j - 1], Math.sin(Math.hypot(...bodyPose[j - 1]) / 2) / (Math.hypot(...bodyPose[j - 1]) || 1))]);
	const worlds = new Array(24), positions = new Array(24);
	for (let j = 0; j < 24; j += 1) {
		worlds[j] = parents[j] < 0 ? locals[j] : matMul(worlds[parents[j]], locals[j]);
		if (parents[j] < 0) positions[j] = [...transl];
		else { const d = [rest[j][0] - rest[parents[j]][0], rest[j][1] - rest[parents[j]][1], rest[j][2] - rest[parents[j]][2]]; const q = worlds[parents[j]]; positions[j] = [positions[parents[j]][0] + q[0][0] * d[0] + q[0][1] * d[1] + q[0][2] * d[2], positions[parents[j]][1] + q[1][0] * d[0] + q[1][1] * d[1] + q[1][2] * d[2], positions[parents[j]][2] + q[2][0] * d[0] + q[2][1] * d[1] + q[2][2] * d[2]]; }
	}
	return positions;
}
function member(data, shape) { return { data: Float32Array.from(data.flat(Infinity)), shape }; }
function fixture(frames = 3) {
	const go = Array.from({ length: frames }, (_, f) => [0, f * 0.08, 0]);
	const pose = Array.from({ length: frames }, () => Array.from({ length: 23 }, () => [0, 0, 0]));
	pose[1][17] = aa([0, 0, 1], Math.PI / 3); pose[1][19] = aa([1, 0, 0], Math.PI * 40 / 180);
	pose[2][3] = aa([0, 0, 1], Math.PI / 4); pose[2][4] = aa([0, 0, 1], Math.PI / 4);
	return { smpl_global_orient: member(go, [frames, 3]), smpl_body_pose: member(pose, [frames, 23, 3]), smpl_transl: member(Array.from({ length: frames }, (_, f) => [f * 0.02, 1, 0]), [frames, 3]), smpl_rest_joints: member(rest, [24, 3]), smpl_joints: member(go.map((_, f) => sourceFk(go[f], pose[f], [f * 0.02, 1, 0])), [frames, 24, 3]), fps: { data: Float32Array.from([30]), shape: [] } };
}
function angle(a, b) { const na = Math.hypot(...a), nb = Math.hypot(...b); return Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / na / nb))); }
const checks = [
	["Hips", "Spine", 0, 3], ["Spine", "Spine1", 3, 6], ["Spine1", "Spine2", 6, 9], ["Spine2", "Spine3", 9, 12], ["Spine3", "Neck", 9, 12],
	["LeftShoulder", "LeftArm", 13, 16], ["LeftArm", "LeftForeArm", 16, 18], ["LeftForeArm", "LeftHand", 18, 20],
	["RightShoulder", "RightArm", 14, 17], ["RightArm", "RightForeArm", 17, 19], ["RightForeArm", "RightHand", 19, 21],
	["LeftUpLeg", "LeftLeg", 1, 4], ["LeftLeg", "LeftFoot", 4, 7], ["LeftFoot", "LeftToeBase", 7, 10], ["RightUpLeg", "RightLeg", 2, 5], ["RightLeg", "RightFoot", 5, 8], ["RightFoot", "RightToeBase", 8, 11],
];
function maxError(motion, sourceFrames) {
	let max = 0;
	for (let f = 0; f < motion.frames; f += 1) for (const [a, b, s, t] of checks) {
		const i = CSKEL27_JOINTS.indexOf(a), j = CSKEL27_JOINTS.indexOf(b), cp = motion.posedJoints;
		const ca = [cp[(f * 27 + i) * 3], cp[(f * 27 + i) * 3 + 1], cp[(f * 27 + i) * 3 + 2]], cb = [cp[(f * 27 + j) * 3], cp[(f * 27 + j) * 3 + 1], cp[(f * 27 + j) * 3 + 2]];
		const sa = sourceFrames[f][s], sb = sourceFrames[f][t]; const e = angle([cb[0] - ca[0], cb[1] - ca[1], cb[2] - ca[2]], [sb[0] - sa[0], sb[1] - sa[1], sb[2] - sa[2]]); max = Math.max(max, e);
	}
	return max;
}

test("synthetic SMPL rotation retarget preserves bone directions and twist", () => {
	const input = fixture(), source = Array.from({ length: 3 }, (_, f) => sourceFk([0, f * 0.08, 0], input.smpl_body_pose.data.slice(f * 69, (f + 1) * 69).reduce((a, _, i, x) => i % 3 ? a : [...a, x.slice(i, i + 3)], []), [f * 0.02, 1, 0]));
	const motion = smplToCskel27Motion(input); const error = maxError(motion, source); console.log(`max direction error: ${(error * 180 / Math.PI).toFixed(4)}°`); assert.ok(error <= 3 * Math.PI / 180);
	assert.ok([...motion.rotMats, ...motion.posedJoints].every(Number.isFinite));
	const h = CSKEL27_JOINTS.indexOf("LeftHand"), o = (1 * 27 + h) * 9; const local = [[motion.rotMats[o], motion.rotMats[o + 1], motion.rotMats[o + 2]], [motion.rotMats[o + 3], motion.rotMats[o + 4], motion.rotMats[o + 5]], [motion.rotMats[o + 6], motion.rotMats[o + 7], motion.rotMats[o + 8]]]; assert.ok(Math.abs(Math.acos(Math.max(-1, Math.min(1, (local[0][0] + local[1][1] + local[2][2] - 1) / 2))) * 180 / Math.PI - 40) <= 3);
});
test("still input is deterministic and finite", () => { const input = fixture(12); input.smpl_global_orient.data.fill(0); input.smpl_body_pose.data.fill(0); const motion = smplToCskel27Motion(input); for (let f = 1; f < 12; f += 1) assert.deepEqual(Array.from(motion.rotMats.slice(0, 243)), Array.from(motion.rotMats.slice(f * 243, (f + 1) * 243))); assert.ok([...motion.posedJoints].every(Number.isFinite)); });
const realPath = "/tmp/sam3ab/gvhmr-walk-rot.npz";
test("real GVHMR walk direction error", { skip: !existsSync(realPath) ? "skipped: /tmp/sam3ab/gvhmr-walk-rot.npz is absent" : false }, (t) => { let input; try { input = readNpz(realPath); } catch (error) { t.skip(`skipped: readNpz could not consume present file (${error.message})`); return; } const motion = smplToCskel27Motion(input); const source = Array.from({ length: motion.frames }, (_, f) => { const p = input.smpl_joints.data; return Array.from({ length: 24 }, (_, j) => Array.from(p.slice((f * 24 + j) * 3, (f * 24 + j + 1) * 3))); }); const error = maxError(motion, source); console.log(`real max direction error: ${(error * 180 / Math.PI).toFixed(4)}°`); assert.ok(error <= 3 * Math.PI / 180); });

// Proportions: a mocap take wears the performer's limb lengths, not the
// canonical body's. Measured on the synthetic rest above, so the expected
// lengths are known exactly.
test("posed limb lengths equal the SMPL rest limb lengths and boneScale says so", () => {
	const input = fixture(3); input.smpl_global_orient.data.fill(0); input.smpl_body_pose.data.fill(0);
	const motion = smplToCskel27Motion(input);
	const J = (n) => CSKEL27_JOINTS.indexOf(n);
	const at = (f, j) => Array.from(motion.posedJoints.slice((f * 27 + j) * 3, (f * 27 + j + 1) * 3));
	const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
	const smpl = (a, b) => len(rest[a], rest[b]);
	for (const f of [0, 1]) {
		assert.ok(Math.abs(len(at(f, J("LeftUpLeg")), at(f, J("LeftLeg"))) - smpl(1, 4)) < 1e-3, "thigh");
		assert.ok(Math.abs(len(at(f, J("LeftLeg")), at(f, J("LeftFoot"))) - smpl(4, 7)) < 1e-3, "shin");
		assert.ok(Math.abs(len(at(f, J("LeftArm")), at(f, J("LeftForeArm"))) - smpl(16, 18)) < 1e-3, "upper arm");
		assert.ok(Math.abs(len(at(f, J("LeftForeArm")), at(f, J("LeftHand"))) - smpl(18, 20)) < 1e-3, "forearm");
		// The four spine links are scaled by one ratio taken on the straight
		// pelvis->spine3 distance; the chain itself is slightly curved, so the
		// invariant is that the CURVE scales by that ratio, i.e. the polyline
		// length grows by exactly boneScale[Spine].
		const chain = ["Hips", "Spine", "Spine1", "Spine2", "Spine3"];
		const polyline = chain.slice(1).reduce((sum, n, i) => sum + len(at(f, J(chain[i])), at(f, J(n))), 0);
		const canonPoly = chain.slice(1).reduce((sum, n, i) => sum + len(canonicalCskel27Reference().posed_joints[J(chain[i])], canonicalCskel27Reference().posed_joints[J(n)]), 0);
		assert.ok(Math.abs(polyline / canonPoly - motion.boneScale[J("Spine")]) < 1e-6, "torso");
	}
	const canon = canonicalCskel27Reference().posed_joints;
	const canonLen = (a, b) => len(canon[J(a)], canon[J(b)]);
	assert.ok(Math.abs(motion.boneScale[J("LeftLeg")] - smpl(1, 4) / canonLen("LeftUpLeg", "LeftLeg")) < 1e-6);
	assert.ok(Math.abs(motion.boneScale[J("LeftForeArm")] - smpl(16, 18) / canonLen("LeftArm", "LeftForeArm")) < 1e-6);
	assert.equal(motion.boneScale[J("Hips")], 1);
	assert.equal(motion.boneScale[J("Head")], 1, "head is character geometry, not measured");
	assert.equal(motion.personScale, 1);
	// Standing on real legs: the lowest foot sits on the floor after the shift.
	let low = Infinity; for (const j of ["LeftFoot", "RightFoot", "LeftToeBase", "RightToeBase"]) low = Math.min(low, at(0, J(j))[1]);
	assert.ok(Math.abs(low) < 1e-3);
});

// A SMPL zero pose is an upright body; retargeted, cskel27's neck/head must
// come out upright too. SMPL's head joint sits INSIDE the skull ahead of the
// neck (neck->head is ~45 deg forward in the zero pose), so aligning the neck
// by that stub pitched the whole neck 47 deg forward on every take.
test("zero pose keeps the neck and head upright", () => {
	const input = fixture(3); input.smpl_global_orient.data.fill(0); input.smpl_body_pose.data.fill(0);
	// Real SMPL neutral neck/head stubs (measured on the GVHMR rest skeleton):
	// neck leans back 13 deg, the head joint sits 45 deg FORWARD of the neck.
	const r = input.smpl_rest_joints.data;
	const set = (j, v) => { r[j * 3] = v[0]; r[j * 3 + 1] = v[1]; r[j * 3 + 2] = v[2]; };
	set(12, [rest[9][0] - 0.003, rest[9][1] + 0.217, rest[9][2] - 0.052]);
	set(15, [r[12 * 3] + 0.005, r[12 * 3 + 1] + 0.059, r[12 * 3 + 2] + 0.055]);
	rest[12] = [r[36], r[37], r[38]]; rest[15] = [r[45], r[46], r[47]];
	const motion = smplToCskel27Motion(input);
	const J = (n) => CSKEL27_JOINTS.indexOf(n);
	const at = (f, j) => Array.from(motion.posedJoints.slice((f * 27 + j) * 3, (f * 27 + j + 1) * 3));
	const pitch = (a, b) => Math.atan2(b[2] - a[2], b[1] - a[1]) * 180 / Math.PI; // forward lean of a bone, deg
	const neckPitch = pitch(at(0, J("Spine3")), at(0, J("Neck")));
	const headPitch = pitch(at(0, J("Neck")), at(0, J("Head")));
	const smplNeckPitch = Math.atan2(rest[12][2] - rest[9][2], rest[12][1] - rest[9][1]) * 180 / Math.PI;
	assert.ok(Math.abs(neckPitch - smplNeckPitch) < 5, `neck pitch ${neckPitch.toFixed(1)} vs SMPL neck ${smplNeckPitch.toFixed(1)} (head pitch ${headPitch.toFixed(1)})`);
	assert.ok(Math.abs(headPitch) < 25, `head pitch ${headPitch.toFixed(1)} should be near upright`);
});
