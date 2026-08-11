import * as THREE from "three";
import {
	resolveIkRig,
	createIkState,
	ikSeedTargets,
	ikSnapshot,
	ikRestore,
	ikTouch,
	ikBakeKeyframe,
	ikRemoveKeyframe,
	ikKeyframes,
	ikEvaluate,
	solveIk,
	solveMidJoint,
	solveSwingAngle,
	solveEffectorSwing,
	solveHipsTranslate,
	ikPlantFeet,
	ikSolvePlantedFeet,
} from "../../src/ardy/ik.js";

let failures = 0;
function check(name, cond, detail = "") {
	if (cond) console.log(`PASS ${name}`);
	else {
		failures += 1;
		console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
	}
}

/* Synthetic Mixamo-spelled rig in a T-pose: arms along ±X, legs along -Y,
 * toes forward (+Z) so the character faces +Z. Rig scaled 0.01 (cm → m). */
function makeRig() {
	const rig = new THREE.Object3D();
	rig.scale.setScalar(0.01);
	const mk = (name, parent, x, y, z) => {
		const b = new THREE.Bone();
		b.name = name;
		b.position.set(x, y, z);
		parent.add(b);
		return b;
	};
	const hips = mk("mixamorigHips", rig, 0, 100, 0);
	const spine = mk("mixamorigSpine", hips, 0, 15, 0);
	const chest = mk("mixamorigSpine1", spine, 0, 15, 0);
	mk("mixamorigSpine2", chest, 0, 15, 0);
	const neck = mk("mixamorigNeck", chest, 0, 30, 0);
	const head = mk("mixamorigHead", neck, 0, 15, 0);
	mk("mixamorigHeadTop_End", head, 0, 20, 0);
	const lShoulder = mk("mixamorigLeftShoulder", chest, 10, 25, 0);
	const rShoulder = mk("mixamorigRightShoulder", chest, -10, 25, 0);
	const lArm = mk("mixamorigLeftArm", lShoulder, 10, -10, 0);
	const lFore = mk("mixamorigLeftForeArm", lArm, 30, 0, 0);
	mk("mixamorigLeftHand", lFore, 30, 0, 0);
	const rArm = mk("mixamorigRightArm", rShoulder, -10, -10, 0);
	const rFore = mk("mixamorigRightForeArm", rArm, -30, 0, 0);
	mk("mixamorigRightHand", rFore, -30, 0, 0);
	const lUp = mk("mixamorigLeftUpLeg", hips, 10, 0, 0);
	const lLeg = mk("mixamorigLeftLeg", lUp, 0, -45, 0);
	const lFoot = mk("mixamorigLeftFoot", lLeg, 0, -45, 0);
	mk("mixamorigLeftToeBase", lFoot, 0, -5, 12);
	const rUp = mk("mixamorigRightUpLeg", hips, -10, 0, 0);
	const rLeg = mk("mixamorigRightLeg", rUp, 0, -45, 0);
	const rFoot = mk("mixamorigRightFoot", rLeg, 0, -45, 0);
	mk("mixamorigRightToeBase", rFoot, 0, -5, 12);
	rig.updateMatrixWorld(true);
	return rig;
}

const rig = makeRig();
const resolved = resolveIkRig(rig);
const chains = resolved ? resolved.chains : null;
const fkJoints = resolved ? resolved.fkJoints : null;
check("resolve finds all four chains", !!chains && chains.size === 4);
check("resolve finds the FK swing joints", !!fkJoints && fkJoints.has("neck") && fkJoints.has("head") && fkJoints.has("hips") && fkJoints.size === 7);

const eff = new THREE.Vector3();
const v = () => new THREE.Vector3();
const arm = chains.get("leftHand");
arm.bones[2].getWorldPosition(eff);
const wristStart = eff.clone();
const shoulder = arm.bones[0].getWorldPosition(v());

/* --- ikSeedTargets: handles appear at the effectors, nothing moves ------- */
const ik = createIkState();
ik.chains = chains;
const quatBefore = arm.bones[0].quaternion.clone();
ikSeedTargets(chains, ik);
check("seedTargets places the handle on the effector", ik.targets.get("leftHand").distanceTo(wristStart) < 1e-9);
check("seeding changes no bone", arm.bones[0].quaternion.angleTo(quatBefore) < 1e-12);

/* --- generated positional playback → authored FK chain ------------------- */
// ARDY playback can write each mapped bone's local translation independently.
// Once IK owns the rotations, the edited chain must return to its captured
// Mixamo bind translations or the arm segments no longer describe one FK pose.
arm.bones[0].position.add(new THREE.Vector3(0.04, -0.02, 0.03));
arm.bones[1].position.multiplyScalar(1.35);
arm.bones[2].position.multiplyScalar(0.7);
rig.updateMatrixWorld(true);
solveIk(arm, wristStart.clone().add(new THREE.Vector3(-0.25, 0.3, 0.1)));
check(
	"IK solve restores positional-playback chain translations to bind",
	arm.bones.every((bone, index) => bone.position.distanceTo(arm.bindPositions[index]) < 1e-9)
);

/* --- direct solve: pull the left wrist up/back, reachable ---------------- */
const target = wristStart.clone().add(new THREE.Vector3(-0.25, 0.3, 0.1));
check("test target is reachable", shoulder.distanceTo(target) < 0.58, `reach=${shoulder.distanceTo(target).toFixed(3)}`);
solveIk(arm, target);
arm.bones[2].getWorldPosition(eff);
check("IK reaches a bent target within 2 cm", eff.distanceTo(target) < 0.02, `err=${eff.distanceTo(target).toFixed(4)}`);

const p = [v(), v(), v()];
arm.bones[0].getWorldPosition(p[0]);
arm.bones[1].getWorldPosition(p[1]);
arm.bones[2].getWorldPosition(p[2]);
const lenErr = Math.abs(p[0].distanceTo(p[1]) - 0.3) + Math.abs(p[1].distanceTo(p[2]) - 0.3);
check("IK preserves segment lengths", lenErr < 1e-6, `err=${lenErr.toExponential(2)}`);
check("straight chain falls back to pole (elbow backward)", p[1].z < p[0].z - 0.02, `elbowZ=${p[1].z.toFixed(3)}`);

/* --- unreachable: stretch straight to full length ------------------------ */
const far = wristStart.clone().add(new THREE.Vector3(2, 0, 0));
solveIk(arm, far);
arm.bones[2].getWorldPosition(eff);
const reachDir = far.clone().sub(shoulder).normalize();
const fullReach = shoulder.clone().addScaledVector(reachDir, 0.6 - 1e-6);
check("unreachable target stretches to full length, no NaN", Number.isFinite(eff.x) && eff.distanceTo(fullReach) < 0.02, `err=${eff.distanceTo(fullReach).toFixed(4)}`);

/* --- continuity: drag across the bone line, elbow keeps its side --------- */
// reset to bind, bend once (pole → elbow backward), then sweep the target
// across the bone line; the elbow must NOT mirror-flip (z stays negative)
arm.bones[0].quaternion.identity();
arm.bones[1].quaternion.identity();
rig.updateMatrixWorld(true);
solveIk(arm, target); // bend once, elbow z<0
let maxFlip = 0;
let prevElbowZ = null;
for (let i = 0; i <= 20; i += 1) {
	const sweep = target.clone().lerp(wristStart.clone().add(new THREE.Vector3(-0.2, -0.1, -0.05)), i / 20);
	solveIk(arm, sweep);
	const ez = arm.bones[1].getWorldPosition(v()).z;
	if (prevElbowZ !== null) maxFlip = Math.max(maxFlip, Math.abs(ez - prevElbowZ));
	if (i === 20) check("elbow stays on its own side through the sweep", ez < -0.005, `elbowZ=${ez.toFixed(4)}`);
	prevElbowZ = ez;
}
check("no elbow flip jump through the sweep", maxFlip < 0.15, `maxStep=${maxFlip.toFixed(4)}`);

/* --- quat keys: bake stores b0/b1 local rotations, sparse ---------------- */
const charPos = new THREE.Vector3(1, 0, -2); // kept for API symmetry; unused
solveIk(arm, target);
ikTouch(ik, "leftHand");
ikBakeKeyframe(chains, ik, 10, fkJoints);
const q10b0 = arm.bones[0].quaternion.clone();
solveIk(arm, wristStart);
ikBakeKeyframe(chains, ik, 30, fkJoints);
const q30b0 = arm.bones[0].quaternion.clone();
check("key frames sorted", JSON.stringify(ikKeyframes(ik)) === JSON.stringify([10, 30]));
check("key stores only the tracked chain", ik.keys.get(10).has("leftHand") && !ik.keys.get(10).has("rightHand"));
const sameQ = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) + Math.abs(a.w - b.w) < 1e-12;
check("key stores b0/b1/b2 local quats", ik.keys.get(10).get("leftHand").q.length === 3 && sameQ(ik.keys.get(10).get("leftHand").q[0], q10b0));

/* --- slerp evaluation: f20 = exact midpoint of the two keys -------------- */
arm.bones[0].quaternion.identity();
arm.bones[1].quaternion.identity();
arm.bones[0].position.add(new THREE.Vector3(0.03, 0.01, -0.02));
arm.bones[1].position.multiplyScalar(1.2);
arm.bones[2].position.multiplyScalar(0.8);
rig.updateMatrixWorld(true);
ikEvaluate(chains, ik, 20, fkJoints);
const expect = q10b0.clone().slerp(q30b0, 0.5);
const deg = (a, b) => (a.angleTo(b) * 180) / Math.PI;
check("f20 bone rotation is the slerp midpoint (<0.5°)", deg(arm.bones[0].quaternion, expect) < 0.5, `err=${deg(arm.bones[0].quaternion, expect).toFixed(4)}°`);
check(
	"IK evaluation restores positional-playback chain translations to bind",
	arm.bones.every((bone, index) => bone.position.distanceTo(arm.bindPositions[index]) < 1e-9)
);

/* untracked chain untouched by evaluate */
const rArm = chains.get("rightHand").bones[0];
const rQ = rArm.quaternion.clone();
ikEvaluate(chains, ik, 20, fkJoints);
check("untracked chain is never written by evaluate", rArm.quaternion.angleTo(rQ) < 1e-12);

/* keys are position-independent: no re-anchor needed (local rotations) */
rig.position.x += 0.5; // character moved
rig.updateMatrixWorld(true);
ikEvaluate(chains, ik, 10, fkJoints);
check("moved character keeps the keyed local rotations", deg(arm.bones[0].quaternion, q10b0) < 0.5, `err=${deg(arm.bones[0].quaternion, q10b0).toFixed(4)}°`);
rig.position.x -= 0.5;
rig.updateMatrixWorld(true);

/* --- snapshot / restore --------------------------------------------------- */
const snap = ikSnapshot(chains, fkJoints);
solveIk(arm, wristStart.clone().add(new THREE.Vector3(0, 0.3, 0)));
ikRestore(chains, snap, fkJoints);
check("restore returns the chain to the snapshot", sameQ(arm.bones[0].quaternion, snap.get("leftHand").quats[0]));

ikRemoveKeyframe(ik, 10);
check("removeKeyframe drops the frame", JSON.stringify(ikKeyframes(ik)) === JSON.stringify([30]));

/* --- mid-joint drag: elbow moves freely even on a STRAIGHT chain --------- */
// THE fix: a straight chain has zero elbow freedom in both-ends-pinned
// models; the sphere-clamp reposition works regardless.
arm.bones[0].quaternion.identity();
arm.bones[1].quaternion.identity();
rig.updateMatrixWorld(true);
const elbowStart = arm.bones[1].getWorldPosition(v());
const foreDirStart = arm.bones[2].getWorldPosition(v()).sub(elbowStart).normalize();
const midTarget = elbowStart.clone().add(new THREE.Vector3(-0.06, 0.12, -0.05));
const clamped = solveMidJoint(arm, midTarget);
const elbowAfter = arm.bones[1].getWorldPosition(v());
check("mid-joint drag moves the elbow on a STRAIGHT chain (> 5 cm)", elbowAfter.distanceTo(elbowStart) > 0.05, `moved=${elbowAfter.distanceTo(elbowStart).toFixed(4)}`);
check("mid-joint drag lands the elbow on the clamped point", elbowAfter.distanceTo(clamped) < 1e-6);
check("clamped point sits on the root sphere (|p0→p1| = l0)", Math.abs(arm.bones[0].getWorldPosition(v()).distanceTo(elbowAfter) - 0.3) < 1e-6);
// forearm keeps its world direction: the wrist follows, parallel to before
const foreDirAfter = arm.bones[2].getWorldPosition(v()).sub(elbowAfter).normalize();
check("mid-joint drag keeps the forearm direction", foreDirAfter.dot(foreDirStart) > 0.999, `dot=${foreDirAfter.dot(foreDirStart).toFixed(4)}`);
check("mid-joint drag preserves segment lengths", Math.abs(elbowAfter.distanceTo(arm.bones[2].getWorldPosition(v())) - 0.3) < 1e-6);

/* far mid drag: clamps radially, no NaN */
const farMid = elbowStart.clone().add(new THREE.Vector3(2, 2, 2));
const clampedFar = solveMidJoint(arm, farMid);
const elbowFar = arm.bones[1].getWorldPosition(v());
check("far mid-joint drag clamps, no NaN", Number.isFinite(elbowFar.x) && elbowFar.distanceTo(clampedFar) < 1e-6);
check("far mid-joint drag keeps lengths", Math.abs(arm.bones[0].getWorldPosition(v()).distanceTo(elbowFar) - 0.3) < 1e-6);

/* --- FK swing as trackball rotation: exact angle, exact axis -------------- */
const neck = fkJoints.get("neck");
const headBone = fkJoints.get("head").bone;
const neckOrigin = neck.bone.getWorldPosition(v());
const startQuat = neck.bone.quaternion.clone();
const startParentQuat = neck.bone.parent.getWorldQuaternion(new THREE.Quaternion());
const axis = new THREE.Vector3(0, 0, 1); // rotate about world Z
const angle = 0.5;
solveSwingAngle(neck, axis, angle, startQuat, startParentQuat);
// the applied rotation must be EXACTLY `angle` about `axis` from the start
const appliedDelta = startParentQuat.clone().multiply(neck.bone.quaternion);
const expectedDelta = new THREE.Quaternion().setFromAxisAngle(axis, angle).multiply(startParentQuat.clone().multiply(startQuat));
check("FK swing applies the exact rotation from drag start", deg(appliedDelta, expectedDelta) < 0.01, `err=${deg(appliedDelta, expectedDelta).toFixed(5)}°`);
// repeated application from the same start state does NOT compound
solveSwingAngle(neck, axis, angle, startQuat, startParentQuat);
check("FK swing is absolute, never compounds", deg(appliedDelta.clone().copy(startParentQuat).multiply(neck.bone.quaternion), expectedDelta) < 0.01);
check("FK swing does not translate the joint", neck.bone.getWorldPosition(v()).distanceTo(neckOrigin) < 1e-9);
// the head sits 0.15 m above the neck; a 0.5 rad rotation swings it ~7 cm
const headStartPos = new THREE.Vector3(0, 1.75, 0);
const headMovedSwing = headBone.getWorldPosition(v()).distanceTo(headStartPos);
check("FK swing visibly moves the head", headMovedSwing > 0.05 && headMovedSwing < 0.2, `d=${headMovedSwing.toFixed(3)}`);

/* --- FK keys: touch fk, bake, slerp evaluate ------------------------------ */
const ik2 = createIkState();
ik2.chains = chains;
solveSwingAngle(neck, axis, angle, neck.bone.quaternion.clone(), startParentQuat);
const neckQ1 = neck.bone.quaternion.clone();
ikTouch(ik2, "neck");
ikBakeKeyframe(chains, ik2, 10, fkJoints);
neck.bone.quaternion.identity();
rig.updateMatrixWorld(true);
ikBakeKeyframe(chains, ik2, 30, fkJoints);
const neckQ2 = neck.bone.quaternion.clone();
neck.bone.quaternion.identity();
rig.updateMatrixWorld(true);
ikEvaluate(chains, ik2, 20, fkJoints);
const expectNeck = neckQ1.clone().slerp(neckQ2, 0.5);
check("FK key slerp midpoint (<0.5°)", deg(neck.bone.quaternion, expectNeck) < 0.5, `err=${deg(neck.bone.quaternion, expectNeck).toFixed(4)}°`);

/* FK snapshot/restore */
const snap2 = ikSnapshot(chains, fkJoints);
solveSwingAngle(neck, new THREE.Vector3(1, 0, 0), 0.3, neck.bone.quaternion.clone(), startParentQuat);
ikRestore(chains, snap2, fkJoints);
check("FK restore returns the joint to the snapshot", sameQ(neck.bone.quaternion, snap2.get("neck").quats[0]));

/* --- body root: hips translate = crouch/lean, keys carry the position ----- */
const hips = fkJoints.get("hips");
const hipsWorldBefore = hips.bone.getWorldPosition(v()).clone();
const hipsLocalBefore = hips.bone.position.clone();
check("hips joint carries its bind local position", !!hips.bindPos && hips.bindPos.distanceTo(hipsLocalBefore) < 1e-9);
solveHipsTranslate(hips, new THREE.Vector3(0, -0.4, 0), hips.bindPos.clone()); // crouch 40 cm
const hipsWorldAfter = hips.bone.getWorldPosition(v());
check("hips translate lowers the body 0.4 m in world", Math.abs(hipsWorldBefore.y - hipsWorldAfter.y - 0.4) < 1e-3, `dy=${(hipsWorldBefore.y - hipsWorldAfter.y).toFixed(4)}`);
check("hips translate converted through the cm scale (local Δ = 40 cm)", Math.abs(hipsLocalBefore.y - hips.bone.position.y - 40) < 1e-3, `dy_local=${(hipsLocalBefore.y - hips.bone.position.y).toFixed(3)}`);
// the whole skeleton follows: the head sinks by the same 0.4 m as the hips
const headDropBefore = fkJoints.get("head").bone.getWorldPosition(v()).y;
solveHipsTranslate(hips, new THREE.Vector3(0, -0.4, 0), hips.bone.position.clone());
const headDropAfter = fkJoints.get("head").bone.getWorldPosition(v()).y;
check("hips translate moves the whole skeleton with it", Math.abs(headDropBefore - headDropAfter - 0.4) < 1e-3, `headDy=${(headDropBefore - headDropAfter).toFixed(4)}`);
solveHipsTranslate(hips, new THREE.Vector3(0, 0.4, 0), hips.bone.position.clone());

// yaw conversion: rotate the rig 90° about Y, world +X delta maps to local Z
rig.rotation.y = Math.PI / 2;
rig.updateMatrixWorld(true);
const before2 = hips.bone.position.clone();
solveHipsTranslate(hips, new THREE.Vector3(0.2, 0, 0), before2.clone());
check("hips translate converts world delta through parent yaw", Math.abs(Math.abs(hips.bone.position.z - before2.z) - 20) < 1e-2 && Math.abs(hips.bone.position.x - before2.x) < 1e-2, `localΔ=(${(hips.bone.position.x - before2.x).toFixed(2)},${(hips.bone.position.z - before2.z).toFixed(2)})`);
rig.rotation.y = 0;
rig.updateMatrixWorld(true);

// keys carry the hips local position; evaluation lerps it
const ik3 = createIkState();
ik3.chains = chains;
hips.bone.position.copy(hips.bindPos);
rig.updateMatrixWorld(true);
ikTouch(ik3, "hips");
ikBakeKeyframe(chains, ik3, 10, fkJoints);
const hipsKeyLow = hips.bone.position.clone();
solveHipsTranslate(hips, new THREE.Vector3(0, -0.4, 0), hips.bone.position.clone());
ikBakeKeyframe(chains, ik3, 30, fkJoints);
const hipsKeyHigh = hips.bone.position.clone();
check("hips key stores the local position", ik3.keys.get(30).get("hips").p && sameQ(ik3.keys.get(30).get("hips").p, hipsKeyHigh) === false && ik3.keys.get(30).get("hips").p.distanceTo(hipsKeyHigh) < 1e-9);
hips.bone.position.copy(hips.bindPos);
rig.updateMatrixWorld(true);
ikEvaluate(chains, ik3, 20, fkJoints);
const expectedHips = hipsKeyLow.clone().lerp(hipsKeyHigh, 0.5);
check("hips position lerps between keys", hips.bone.position.distanceTo(expectedHips) < 1e-6, `err=${hips.bone.position.distanceTo(expectedHips).toExponential(2)}`);

// restore puts the bind position back
const snap3 = ikSnapshot(chains, fkJoints);
solveHipsTranslate(hips, new THREE.Vector3(0, -0.5, 0), hips.bone.position.clone());
ikRestore(chains, snap3, fkJoints);
check("restore returns the hips bind position", hips.bone.position.distanceTo(snap3.get("hips").pos) < 1e-9);

/* --- foot planting: hips drop, ankles stay at their plants ----------------- */
// reset the hips and the left leg to bind
hips.bone.position.copy(hips.bindPos);
const lLeg = chains.get("leftFoot");
lLeg.bones[0].quaternion.identity();
lLeg.bones[1].quaternion.identity();
rig.updateMatrixWorld(true);
const ik4 = createIkState();
ik4.chains = chains;
const anklePlant = lLeg.bones[2].getWorldPosition(v()).clone();
ikPlantFeet(chains, ik4);
check("plantFeet captures both ankle positions", ik4.plants.has("leftFoot") && ik4.plants.has("rightFoot") && ik4.plants.get("leftFoot").distanceTo(anklePlant) < 1e-9);
// drop the hips 0.3 m — the feet would normally follow through the floor
solveHipsTranslate(hips, new THREE.Vector3(0, -0.3, 0), hips.bone.position.clone());
const ankleDropped = lLeg.bones[2].getWorldPosition(v()).clone();
check("without the planted solve the ankle follows the hips down", ankleDropped.y < anklePlant.y - 0.2, `dy=${(ankleDropped.y - anklePlant.y).toFixed(3)}`);
ikSolvePlantedFeet(chains, ik4);
const ankleSolved = lLeg.bones[2].getWorldPosition(v());
check("planted solve returns the ankle to its plant", ankleSolved.distanceTo(anklePlant) < 1e-6, `err=${ankleSolved.distanceTo(anklePlant).toExponential(2)}`);
// the knee must have bent to compensate (it moved off the straight line)
const kneeAfter = lLeg.bones[1].getWorldPosition(v());
const hipAfter = hips.bone.getWorldPosition(v());
const lineT = kneeAfter.clone().sub(hipAfter);
const lineLen = lineT.length();
const toAnkle = ankleSolved.clone().sub(hipAfter).normalize();
const toKnee = lineT.divideScalar(lineLen);
check("the knee bent to keep the foot planted", toKnee.dot(toAnkle) < 0.999, `dot=${toKnee.dot(toAnkle).toFixed(4)}`);
// with no plants captured, the planted solve is a no-op
const ik5 = createIkState();
ik5.chains = chains;
const ankleBeforeNoop = lLeg.bones[2].getWorldPosition(v()).clone();
solveHipsTranslate(hips, new THREE.Vector3(0, -0.1, 0), hips.bone.position.clone());
ikSolvePlantedFeet(chains, ik5);
check("no plants → planted solve does nothing", lLeg.bones[2].getWorldPosition(v()).distanceTo(ankleBeforeNoop) > 0.05);

/* --- effector swing: hand/foot rotation editing -------------------------- */
{
	const chains2 = resolved.chains;
	const lHand = chains2.get("leftHand");
	const handBone = lHand.bones[2];
	const b1Before = lHand.bones[1].quaternion.clone();
	const startQuat = handBone.quaternion.clone();
	const startParentQuat = handBone.parent.getWorldQuaternion(new THREE.Quaternion());
	// 90° twist around world Z, absolute from the start orientation
	solveEffectorSwing(lHand, new THREE.Vector3(0, 0, 1), Math.PI / 2, startQuat, startParentQuat);
	const twisted = handBone.getWorldQuaternion(new THREE.Quaternion());
	const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
		.multiply(startParentQuat.clone().multiply(startQuat));
	check("effector swing twists the hand by the drag angle", twisted.angleTo(expected) < 1e-6, `err=${twisted.angleTo(expected).toExponential(2)}`);
	check("effector swing leaves the forearm alone", lHand.bones[1].quaternion.angleTo(b1Before) < 1e-6);
	check("zero-angle swing is a no-op", (() => {
		const q = handBone.quaternion.clone();
		solveEffectorSwing(lHand, new THREE.Vector3(1, 0, 0), 0, handBone.quaternion.clone(), startParentQuat);
		return handBone.quaternion.angleTo(q) < 1e-6;
	})());

	// the bake now stores the effector quaternion with the chain's, and the
	// evaluation puts it back: twist, bake at frame 7, untwist, evaluate.
	const ik6 = createIkState();
	ik6.chains = chains2;
	ikTouch(ik6, "leftHand");
	ikBakeKeyframe(chains2, ik6, 7, null);
	check("baked chain key stores three quats (b0, b1, b2)", ik6.keys.get(7).get("leftHand").q.length === 3);
	handBone.quaternion.identity();
	handBone.updateMatrixWorld(true);
	ikEvaluate(chains2, ik6, 7, null);
	check("evaluate restores the authored effector rotation", handBone.quaternion.angleTo(ik6.keys.get(7).get("leftHand").q[2]) < 1e-6,
		`err=${handBone.quaternion.angleTo(ik6.keys.get(7).get("leftHand").q[2]).toExponential(2)}`);
	// pre-rotation keys (b0/b1 only) still evaluate without touching b2
	ik6.keys.get(7).get("leftHand").q = ik6.keys.get(7).get("leftHand").q.slice(0, 2);
	const q2 = handBone.quaternion.clone();
	ikEvaluate(chains2, ik6, 7, null);
	check("two-quat legacy keys leave the effector as-is", handBone.quaternion.angleTo(q2) < 1e-6);
}

if (failures) {
	console.log(`${failures} FAIL`);
	process.exit(1);
}
console.log("all PASS");
