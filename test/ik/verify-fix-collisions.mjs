import * as THREE from "three";
import {
	resolveIkRig,
	createIkState,
	solveIk,
	ikEvaluate,
	ikKeyframes,
	bindWorldPosition,
	restWorldPosition,
	solveMidJoint,
} from "../../src/ardy/ik.js";
import { primeBindPose, applyPose, POSE_BONES, DEFAULT_POSE } from "../../src/poses.js";
import {
	buildCollisionCapsules,
	restPairOverlaps,
	detectPenetrations,
	fixCollisions,
	fixCollisionsRange,
	supportsCollisionCleanup,
	PAIR_TOLERANCE,
	PUSH_FLOOR_CLEARANCE,
	HOME_BIAS,
	MIN_ALIGN,
} from "../../src/ardy/fix-collisions.js";

/** app-stage.jsx's REST_BONES: every joint at zero, i.e. the bind pose. */
const REST_ZERO = Object.fromEntries(POSE_BONES.map((bone) => [bone.id, [0, 0, 0]]));

let failures = 0;
function check(name, cond, detail = "") {
	if (cond) console.log(`PASS ${name}`);
	else {
		failures += 1;
		console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
	}
}

/* Synthetic Mixamo-spelled rig in a T-pose: arms along ±X, legs along -Y,
 * toes forward (+Z). Rig scaled 0.01 (cm → m). Same layout as
 * test/ik/verify-ik.mjs.
 *
 * `withFingers` adds the middle-finger base bones. Real Mixamo exports have
 * them, cheaper game rigs do not, and the hand capsule has to work either
 * way — so the fixture builds both. */
function makeRig(withFingers = false) {
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
	const lHand = mk("mixamorigLeftHand", lFore, 30, 0, 0);
	const rArm = mk("mixamorigRightArm", rShoulder, -10, -10, 0);
	const rFore = mk("mixamorigRightForeArm", rArm, -30, 0, 0);
	const rHand = mk("mixamorigRightHand", rFore, -30, 0, 0);
	if (withFingers) {
		mk("mixamorigLeftHandMiddle1", lHand, 9, 0, 0);
		mk("mixamorigRightHandMiddle1", rHand, -9, 0, 0);
	}
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

// Plausible humanoid radii (metres). The synthetic rig has no skinned mesh
// to measure, so tests inject them explicitly.
const RADII = {
	Spine: 0.13, Head: 0.11, Neck: 0.06,
	LeftArm: 0.05, LeftForeArm: 0.045, LeftHand: 0.05,
	RightArm: 0.05, RightForeArm: 0.045, RightHand: 0.05,
	LeftUpLeg: 0.075, LeftLeg: 0.055, LeftFoot: 0.05,
	RightUpLeg: 0.075, RightLeg: 0.055, RightFoot: 0.05,
};

function penetrations(rig) {
	const capsules = buildCollisionCapsules(rig, RADII);
	return detectPenetrations(capsules, { offset: 0 });
}

/** "a×b" with the ids sorted, so a pair reads the same whichever side of the
 * detection loop it came from. */
function pairIds(pen) {
	return [pen.a.def.id, pen.b.def.id].sort().join("×");
}

/* --- build: every capsule resolves, T-pose is clean ----------------------- */
{
	const rig = makeRig();
	const capsules = buildCollisionCapsules(rig, RADII);
	check("builds all 15 body capsules", capsules && capsules.size === 15);
	check("capsule world positions respect rig scale",
		Math.abs(capsules.get("torso").a.y - 1.0) < 1e-6);
	const pens = penetrations(rig);
	check("T-pose reports no self-collision", pens.length === 0,
		`got ${pens.map((p) => `${p.a.def.id}×${p.b.def.id}@${p.depth.toFixed(3)}`).join(", ")}`);
}

/* --- detect: a wrist dragged into the chest is caught --------------------- */
{
	const rig = makeRig();
	const { chains } = resolveIkRig(rig);
	solveIk(chains.get("leftHand"), new THREE.Vector3(0.05, 1.45, 0));
	const pens = penetrations(rig);
	check("forearm-through-chest is detected", pens.length > 0,
		"no penetration found");
	check("detection names the arm and the torso",
		pens.some((p) => /left(ForeArm|Hand|UpperArm)/.test(p.a.def.id + p.b.def.id)
			&& /torso|chest/.test(p.a.def.id + p.b.def.id)),
		pens.map((p) => `${p.a.def.id}×${p.b.def.id}`).join(", "));
}

/* --- fix: the forearm comes back out of the chest ------------------------- */
{
	const rig = makeRig();
	const { chains, fkJoints } = resolveIkRig(rig);
	const ik = createIkState();
	ik.chains = chains;
	solveIk(chains.get("leftHand"), new THREE.Vector3(0.05, 1.45, 0));
	const before = penetrations(rig).length;
	const result = fixCollisions(rig, chains, { radii: RADII, ikState: ik });
	check("fixer changed the pose", result.changed && before > 0);
	check("no penetration remains after fixing", penetrations(rig).length === 0,
		`residual=${result.residual.toFixed(4)}`);
	check("touched chain is tracked for keying", ik.tracked.has("leftHand"));
	check("segment lengths survive the fix", (() => {
		const c = chains.get("leftHand");
		const p0 = c.bones[0].getWorldPosition(new THREE.Vector3());
		const p1 = c.bones[1].getWorldPosition(new THREE.Vector3());
		const p2 = c.bones[2].getWorldPosition(new THREE.Vector3());
		return Math.abs(p0.distanceTo(p1) - 0.3) < 1e-6 && Math.abs(p1.distanceTo(p2) - 0.3) < 1e-6;
	})());
	void fkJoints;
}

/* --- filter: onlyChains leaves everything else alone ---------------------- */
{
	const rig = makeRig();
	const { chains } = resolveIkRig(rig);
	solveIk(chains.get("leftHand"), new THREE.Vector3(0.05, 1.45, 0));
	const result = fixCollisions(rig, chains, { radii: RADII, onlyChains: new Set(["rightFoot"]) });
	check("onlyChains blocks fixes on unlisted chains", !result.changed);
	check("the penetrating pose is untouched when blocked", penetrations(rig).length > 0);
}

/* --- range: only frames that needed a fix get a key ----------------------- */
{
	const rig = makeRig();
	const { chains, fkJoints } = resolveIkRig(rig);
	const ik = createIkState();
	ik.chains = chains;
	const cleanWrist = new THREE.Vector3(0.8, 1.45, 0);
	const stuckWrist = new THREE.Vector3(0.05, 1.45, 0);
	const applyFrame = (frame) => {
		solveIk(chains.get("leftHand"), frame === 2 ? stuckWrist : cleanWrist);
	};
	const keyed = fixCollisionsRange({
		rig, chains, ikState: ik, fkJoints,
		startFrame: 0, endFrame: 4, applyFrame,
		radii: RADII,
	});
	check("only the penetrating frame is keyed",
		keyed.length === 1 && keyed[0] === 2, `keyed=${keyed.join(",")}`);
	check("the key landed in the IK layer", ikKeyframes(ik).includes(2));
	check("clean frames stay keyless", !ikKeyframes(ik).includes(0) && !ikKeyframes(ik).includes(4));
	check("the range fix left the last frame clean", penetrations(rig).length === 0);
}

/* --- offset: the skin gap is part of the TEST, not just the push ---------- */
/* A pose parked just clear of the thigh at offset 0 must read as penetrating
 * once a gap is demanded, and an already-reported pair's depth must grow by
 * exactly the offset. Before the fix, offset only scaled the push, so the
 * fixer opened a gap detection never asked for and immediately forgot. */
{
	const rig = makeRig();
	const { chains } = resolveIkRig(rig);
	solveIk(chains.get("leftHand"), new THREE.Vector3(0.22, 0.85, 0));
	const capsules = buildCollisionCapsules(rig, RADII);
	check("a grazing pose is clean with no offset",
		detectPenetrations(capsules, { offset: 0 }).length === 0);
	check("the same pose penetrates once a skin gap is demanded",
		detectPenetrations(capsules, { offset: 0.03 }).length > 0);

	const deeper = makeRig();
	const { chains: chains2 } = resolveIkRig(deeper);
	solveIk(chains2.get("leftHand"), new THREE.Vector3(0.2, 0.85, 0));
	const caps2 = buildCollisionCapsules(deeper, RADII);
	const bare = detectPenetrations(caps2, { offset: 0 })[0];
	const gapped = detectPenetrations(caps2, { offset: 0.01 })[0];
	check("offset adds itself to the reported depth",
		bare && gapped && Math.abs((gapped.depth - bare.depth) - 0.01) < 1e-9,
		`delta=${gapped && bare ? (gapped.depth - bare.depth).toFixed(6) : "n/a"}`);
}

/* --- slackFactor: the default is strict, and callers may override --------- */
/* 0.005 m past the allowance at the 0.4 default; invisible at the old 0.6,
 * which is exactly the "hand clearly inside the thigh, tool says clean"
 * complaint. */
{
	const rig = makeRig();
	const { chains } = resolveIkRig(rig);
	solveIk(chains.get("leftHand"), new THREE.Vector3(0.2, 0.85, 0));
	const capsules = buildCollisionCapsules(rig, RADII);
	check("the default slack catches a shallow hand-in-thigh",
		detectPenetrations(capsules, { offset: 0 }).some((p) => /leftHand/.test(p.a.def.id + p.b.def.id)));
	check("a looser slackFactor lets the same pose through",
		detectPenetrations(capsules, { offset: 0, slackFactor: 0.6 }).length === 0);

	const loose = makeRig();
	const { chains: chains2 } = resolveIkRig(loose);
	solveIk(chains2.get("leftHand"), new THREE.Vector3(0.2, 0.85, 0));
	check("fixCollisions forwards slackFactor to detection",
		fixCollisions(loose, chains2, { radii: RADII, offset: 0, slackFactor: 0.6 }).changed === false);

	const strict = makeRig();
	const { chains: chains3 } = resolveIkRig(strict);
	solveIk(chains3.get("leftHand"), new THREE.Vector3(0.2, 0.85, 0));
	check("the default slackFactor fixes what 0.6 ignored",
		fixCollisions(strict, chains3, { radii: RADII, offset: 0 }).changed === true);
}

/* --- hand capsule: fingers when the rig has them, wrist sphere when not --- */
{
	const bare = buildCollisionCapsules(makeRig(false), RADII);
	const fingered = buildCollisionCapsules(makeRig(true), RADII);
	check("a fingerless rig still builds every capsule",
		bare && bare.size === 15, "optional end must not disqualify the rig");
	check("the fingerless hand degrades to a wrist sphere",
		bare.get("leftHand").a.distanceTo(bare.get("leftHand").b) < 1e-9);
	check("the hand capsule reaches the middle finger when present",
		Math.abs(fingered.get("leftHand").a.distanceTo(fingered.get("leftHand").b) - 0.09) < 1e-6,
		`span=${fingered.get("leftHand").a.distanceTo(fingered.get("leftHand").b).toFixed(4)}`);
	check("both spellings of the rig are supported",
		supportsCollisionCleanup(makeRig(false)) && supportsCollisionCleanup(makeRig(true)));
}

/* --- and the fingers CHANGE the verdict: fingertip through the thigh ------ */
/* Wrist parked clear of the thigh, fingers sunk into it. Judged at the wrist
 * this pose is clean — the exact miss the optional end exists to close. */
{
	const target = new THREE.Vector3(0.14, 0.95, -0.1);
	const wristOnly = makeRig(false);
	solveIk(resolveIkRig(wristOnly).chains.get("leftHand"), target);
	const fingered = makeRig(true);
	solveIk(resolveIkRig(fingered).chains.get("leftHand"), target);
	check("the wrist sphere misses a fingertip in the thigh",
		detectPenetrations(buildCollisionCapsules(wristOnly, RADII), { offset: 0 }).length === 0);
	check("the finger-extended hand catches it",
		detectPenetrations(buildCollisionCapsules(fingered, RADII), { offset: 0 })
			.some((p) => /leftHand/.test(p.a.def.id + p.b.def.id) && /leftThigh/.test(p.a.def.id + p.b.def.id)));
}

/* --- per-pass exit: a pass that pushes nothing ends the loop -------------- */
/* Pass 0 pulls the left arm out of the chest; pass 1 still sees a right-hand
 * penetration but has no rightHand chain to push with, so it must stop. A
 * CUMULATIVE `changed` flag stays true from pass 0 and spins the loop out to
 * maxIterations re-solving a pose that cannot move. */
{
	const rig = makeRig();
	const { chains } = resolveIkRig(rig);
	solveIk(chains.get("leftHand"), new THREE.Vector3(0.05, 1.45, 0));
	solveIk(chains.get("rightHand"), new THREE.Vector3(-0.2, 0.85, 0));
	const onlyLeft = new Map([["leftHand", chains.get("leftHand")]]);
	const result = fixCollisions(rig, onlyLeft, { radii: RADII, offset: 0, maxIterations: 8 });
	check("the fixable half still gets fixed", result.changed);
	check("a fruitless pass ends the loop instead of burning iterations",
		result.passes < 8, `passes=${result.passes}`);
	check("only the unpushable penetration is left",
		penetrations(rig).every((p) => /right/.test(p.a.def.id + p.b.def.id)),
		penetrations(rig).map((p) => `${p.a.def.id}×${p.b.def.id}`).join(", "));
}

/* --- unsupported rig: "cannot run" is not "found nothing" ----------------- */
{
	const rig = makeRig();
	rig.getObjectByName("mixamorigLeftToeBase").removeFromParent();
	rig.updateMatrixWorld(true);
	check("a rig missing a required bone is reported unsupported",
		supportsCollisionCleanup(rig) === false);
	check("capsules cannot be built for it", buildCollisionCapsules(rig, RADII) === null);
	const result = fixCollisions(rig, new Map(), { radii: RADII });
	check("fixCollisions says supported:false, not a clean pose",
		result.supported === false && result.changed === false,
		JSON.stringify(result));
	check("a supported rig reports supported:true",
		fixCollisions(makeRig(), resolveIkRig(makeRig()).chains, { radii: RADII }).supported === true);
	check("the range walker bails on an unsupported rig", fixCollisionsRange({
		rig, chains: new Map(), ikState: createIkState(), startFrame: 0, endFrame: 9,
		applyFrame: () => {}, radii: RADII,
	}).length === 0);
}

/* --- REGRESSION (R5): onlyChains binds the WRITE, not just the query ------- */
/* The filter was applied to the detection list only, so a movable×movable pair
 * with one side listed split the push and moved the unlisted limb anyway
 * (3 cm on the probe). The existing filter test above only covers
 * movable×static, where the static side cannot move by construction. */
{
	const rig = makeRig();
	const { chains } = resolveIkRig(rig);
	// Hand sunk into the SAME-SIDE thigh: leftHand (chain leftHand) against
	// leftThigh (chain leftFoot) — two movable capsules.
	solveIk(chains.get("leftHand"), new THREE.Vector3(0.2, 0.85, 0));
	const pair = detectPenetrations(buildCollisionCapsules(rig, RADII), { offset: 0 })
		.find((p) => /leftHand|leftForeArm/.test(p.a.def.id) && /leftThigh|leftShin/.test(p.b.def.id));
	check("the fixture really is a movable×movable pair",
		Boolean(pair && pair.a.def.movable && pair.b.def.movable),
		pair ? `${pair.a.def.id}×${pair.b.def.id}` : "no movable pair found");

	const leg = chains.get("leftFoot");
	const hand = chains.get("leftHand");
	const kneeBefore = leg.bones[1].getWorldPosition(new THREE.Vector3());
	const ankleBefore = leg.bones[2].getWorldPosition(new THREE.Vector3());
	const wristBefore = hand.bones[2].getWorldPosition(new THREE.Vector3());
	const result = fixCollisions(rig, chains, { radii: RADII, offset: 0, onlyChains: new Set(["leftHand"]) });
	const kneeMoved = leg.bones[1].getWorldPosition(new THREE.Vector3()).distanceTo(kneeBefore);
	const ankleMoved = leg.bones[2].getWorldPosition(new THREE.Vector3()).distanceTo(ankleBefore);
	check("the permitted side still gets fixed",
		result.changed && hand.bones[2].getWorldPosition(new THREE.Vector3()).distanceTo(wristBefore) > 1e-4);
	check("onlyChains leaves the unlisted MOVABLE limb exactly where it was",
		kneeMoved < 1e-9 && ankleMoved < 1e-9, `knee=${kneeMoved.toFixed(5)} ankle=${ankleMoved.toFixed(5)}`);
	check("the run reports only the chain it actually drove",
		result.touched.join(",") === "leftHand", `touched=${result.touched.join(",")}`);
	check("the permitted side owed the WHOLE separation (nothing left over)",
		detectPenetrations(buildCollisionCapsules(rig, RADII), { offset: 0 }).length === 0,
		`residual=${result.residual.toFixed(5)}`);
}

/* --- the push respects the floor (R12) ------------------------------------ */
/* A separation normal knows nothing about the ground, so an otherwise correct
 * push can drive an ankle or a knee underground. With the floor raised above
 * the whole pose every push target is below it, which makes the clamp the only
 * thing that can be doing the work. */
{
	const rig = makeRig();
	const { chains } = resolveIkRig(rig);
	solveIk(chains.get("leftHand"), new THREE.Vector3(0.2, 0.85, 0));
	fixCollisions(rig, chains, { radii: RADII, offset: 0, floorY: 0.9, onlyChains: new Set(["leftHand"]) });
	const wristY = chains.get("leftHand").bones[2].getWorldPosition(new THREE.Vector3()).y;
	check("a pushed joint is never driven below the floor clearance",
		wristY >= 0.9 + PUSH_FLOOR_CLEARANCE - 1e-6, `wristY=${wristY.toFixed(4)}`);
}

/* --- detect and solve on the SAME skeleton (bind translations) ------------- */
/* ARDY positional playback writes per-bone translations, so the clip's limbs
 * are not bind length. solveIk can only work at bind — its segment lengths were
 * measured there — so a pass that detected on the clip's skeleton and solved on
 * bind produced a key whose rotation delta was mostly LENGTH COMPENSATION, and
 * a partially-weighted blend of that wandered three times the correction.
 * Normalising up front makes the two agree; a pass that changes nothing puts
 * the translations back. */
{
	const wobble = (rig, factor) => {
		for (const name of ["mixamorigLeftLeg", "mixamorigLeftFoot", "mixamorigLeftForeArm", "mixamorigLeftHand"]) {
			rig.getObjectByName(name).position.multiplyScalar(factor);
		}
		rig.updateMatrixWorld(true);
	};

	// A clean pose keeps its own translations — the tool must not silently
	// rewrite a skeleton it had nothing to fix on.
	const clean = makeRig();
	const cleanChains = resolveIkRig(clean).chains;
	wobble(clean, 1.04);
	const shinBefore = clean.getObjectByName("mixamorigLeftFoot").position.clone();
	const cleanResult = fixCollisions(clean, cleanChains, { radii: RADII });
	check("a no-op fix hands back the clip's own bone translations",
		cleanResult.changed === false
			&& clean.getObjectByName("mixamorigLeftFoot").position.distanceTo(shinBefore) < 1e-12,
		`drift=${clean.getObjectByName("mixamorigLeftFoot").position.distanceTo(shinBefore)}`);

	// THE property: the delta a key stores must be the PUSH, and must not depend
	// on the clip's bone lengths at all. Same penetrating rotations, three
	// different skeleton stretches — one baked delta.
	const bakedDelta = (stretch) => {
		const seed = makeRig();
		solveIk(resolveIkRig(seed).chains.get("leftHand"), new THREE.Vector3(0.05, 1.45, 0));
		const rotations = resolveIkRig(seed).chains.get("leftHand").bones.map((b) => b.quaternion.clone());
		const rig = makeRig();
		const { chains } = resolveIkRig(rig);
		const chain = chains.get("leftHand");
		chain.bones.forEach((bone, index) => {
			bone.quaternion.copy(rotations[index]);
			bone.position.copy(chain.bindPositions[index]).multiplyScalar(stretch);
		});
		rig.updateMatrixWorld(true);
		const result = fixCollisions(rig, chains, { radii: RADII });
		const base = result.baseQuats.get("leftHand");
		return { changed: result.changed, angles: chain.bones.map((b, i) => base[i].angleTo(b.quaternion)) };
	};
	const atBind = bakedDelta(1);
	const stretched = [1.03, 1.06].map(bakedDelta);
	check("the wobbled skeletons still get fixed",
		atBind.changed && stretched.every((d) => d.changed));
	check("the baked delta is the push, independent of the clip's bone lengths",
		stretched.every((d) => d.angles.every((angle, i) => Math.abs(angle - atBind.angles[i]) < 1e-6)),
		`bind=${atBind.angles.map((a) => ((a * 180) / Math.PI).toFixed(3)).join("/")} `
		+ stretched.map((d) => d.angles.map((a) => ((a * 180) / Math.PI).toFixed(3)).join("/")).join(" "));

	// End to end: a clip whose bone translations wobble (positional playback)
	// with ONE penetrating frame. The frames easing out of the key must stay
	// near the clip, which is the whole point of a delta-valued blend.
	const BLEND = 6;
	const angleAt = (frame) => -Math.PI / 2 + (Math.PI / 3) * Math.abs(Math.sin((Math.PI * (frame - 2)) / 16));
	const makeWobblyTake = () => {
		const rig = makeRig();
		const resolved = resolveIkRig(rig);
		const arm = resolved.chains.get("leftHand");
		const poseClip = (frame) => {
			const factor = 1 + 0.02 * Math.sin(frame * 0.9);
			arm.bones.forEach((bone, index) => {
				bone.position.copy(arm.bindPositions[index]).multiplyScalar(factor);
				bone.quaternion.identity();
			});
			arm.bones[0].quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), angleAt(frame));
			rig.updateMatrixWorld(true);
		};
		return { rig, chains: resolved.chains, fkJoints: resolved.fkJoints, arm, poseClip };
	};
	const reference = makeWobblyTake();
	const rawWristAt = (frame) => {
		reference.poseClip(frame);
		return reference.arm.bones[2].getWorldPosition(new THREE.Vector3());
	};

	const take = makeWobblyTake();
	const ik = createIkState();
	ik.chains = take.chains;
	const applyFrame = (frame) => {
		take.poseClip(frame);
		ikEvaluate(take.chains, ik, frame, take.fkJoints, BLEND);
	};
	const wobblyKeys = fixCollisionsRange({
		rig: take.rig, chains: take.chains, ikState: ik, fkJoints: take.fkJoints,
		startFrame: 0, endFrame: 20, applyFrame, radii: RADII,
	});
	check("the wobbly clip still keys only the frames that penetrate",
		wobblyKeys.length > 0 && wobblyKeys.every((f) => f === 2 || f === 18),
		`keyed=${wobblyKeys.join(",")}`);
	let worstNeighbour = 0;
	for (let frame = 0; frame <= 20; frame += 1) {
		if (wobblyKeys.includes(frame)) continue;
		const raw = rawWristAt(frame);
		applyFrame(frame);
		worstNeighbour = Math.max(worstNeighbour, take.arm.bones[2].getWorldPosition(new THREE.Vector3()).distanceTo(raw));
	}
	check("an unkeyed neighbour of a fix on a wobbly clip stays within 1 cm of it",
		worstNeighbour < 0.01, `worst=${(worstNeighbour * 1000).toFixed(1)}mm`);
}

/* --- REGRESSION (G1): the bind pose is the zero point, not zero ------------ */
/* Capsules are a coarse proxy, and on a real rig the REST pose reports 9.2 mm
 * of torso × upper-arm "penetration". One press of the button on a brand-new
 * project baked a phantom key and claimed a fix. The fixture below reproduces
 * that geometry: the arm hangs 15 cm in front of the torso axis in its BIND
 * pose, which is 9 mm past the slack allowance for that pair. */
{
	const makeBindOverlapRig = () => {
		const rig = makeRig();
		// Fold the left arm down in FRONT of the chest: forearm axis 15 cm from
		// the torso axis (0.13 + 0.045 + 0.002 offset − 0.15 = 27 mm of overlap
		// against an 18 mm slack allowance = 9 mm of reported depth).
		rig.getObjectByName("mixamorigLeftShoulder").position.set(0, 25, 15);
		rig.getObjectByName("mixamorigLeftArm").position.set(0, -10, 0);
		rig.getObjectByName("mixamorigLeftArm").quaternion
			.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
		rig.updateMatrixWorld(true);
		primeBindPose(rig); // this pose IS the character's bind pose
		return rig;
	};

	const rig = makeBindOverlapRig();
	const capsules = buildCollisionCapsules(rig, RADII);
	const uncalibrated = detectPenetrations(capsules, { pairAllowances: null });
	check("the fixture's rest pose DOES trip the uncalibrated rule",
		uncalibrated.some((p) => pairIds(p) === "leftForeArm×torso") ,
		uncalibrated.map(pairIds).join(", ") || "none");
	check("the reported phantom depth is the ~9 mm QA measured",
		Math.abs(uncalibrated.find((p) => pairIds(p) === "leftForeArm×torso").depth - 0.009) < 5e-4,
		`depth=${uncalibrated.find((p) => pairIds(p) === "leftForeArm×torso")?.depth.toFixed(5)}`);
	check("the bind overlap is measured for exactly that pair",
		restPairOverlaps(rig, RADII).get("leftForeArm|torso") > 0.02,
		[...restPairOverlaps(rig, RADII).entries()].map(([k, v]) => `${k}@${v.toFixed(4)}`).join(", "));
	check("the rest pose reads clean once the pair is calibrated against bind",
		detectPenetrations(capsules).length === 0,
		detectPenetrations(capsules).map(pairIds).join(", "));
	check("fixCollisions writes nothing at rest", (() => {
		const restRig = makeBindOverlapRig();
		return fixCollisions(restRig, resolveIkRig(restRig).chains, { radii: RADII }).changed === false;
	})());

	// ... and the same pair still fires when the arm is genuinely driven in.
	const deep = makeBindOverlapRig();
	deep.getObjectByName("mixamorigLeftShoulder").position.set(0, 25, 5); // 5 cm from the axis
	deep.updateMatrixWorld(true);
	const hits = detectPenetrations(buildCollisionCapsules(deep, RADII));
	check("a genuine deep hit on a calibrated pair is still caught",
		hits.some((p) => pairIds(p) === "leftForeArm×torso"),
		hits.map(pairIds).join(", ") || "none");
	check("the calibration shifts the zero point, it does not disable the pair",
		hits.find((p) => pairIds(p) === "leftForeArm×torso").depth > 0.09,
		`depth=${hits.find((p) => pairIds(p) === "leftForeArm×torso")?.depth.toFixed(4)}`);
	check("the tolerance is a few millimetres, not a licence", PAIR_TOLERANCE > 0 && PAIR_TOLERANCE <= 0.01);
	check("a rig with no bind snapshot gets no calibration at all",
		restPairOverlaps(makeRig(), RADII) === null);
}

/* --- REGRESSION (R3 + G2): a sparse fix stays sparse ----------------------- */
/* An arm swing that only penetrates at frames 2 and 18. TWO defects met here:
 *   R3 — ikEvaluate gave weight 1 to every frame between a track's first and
 *        last key, so those two keys replaced the whole swing (the wrist landed
 *        60 cm off the generated pose at the midpoint).
 *   G2 — fixCollisionsRange detected against its own evolving output, so the
 *        blend ramps it had just written produced fresh penetrations, which it
 *        then keyed: 4 of 11 keys on the QA clip were on source-CLEAN frames.
 */
{
	const BLEND = 6; // App's IK_CORRECTION_BLEND_FRAMES
	// The upper arm swings from hanging (−90°, wrist beside the thigh) up to
	// −30° and back. |sin| makes frames 2 and 18 the only ones at the bottom.
	const angleAt = (frame) => -Math.PI / 2 + (Math.PI / 3) * Math.abs(Math.sin((Math.PI * (frame - 2)) / 16));
	const makeTake = () => {
		const rig = makeRig();
		const resolved = resolveIkRig(rig);
		const arm = rig.getObjectByName("mixamorigLeftArm");
		const fore = rig.getObjectByName("mixamorigLeftForeArm");
		const hand = rig.getObjectByName("mixamorigLeftHand");
		// The clip writes local rotations AND translations every frame, exactly
		// as ARDY positional playback does.
		const poseClip = (frame) => {
			arm.position.set(10, -10, 0);
			fore.position.set(30, 0, 0);
			hand.position.set(30, 0, 0);
			fore.quaternion.identity();
			hand.quaternion.identity();
			arm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), angleAt(frame));
			rig.updateMatrixWorld(true);
		};
		return { rig, chains: resolved.chains, fkJoints: resolved.fkJoints, poseClip };
	};

	// The raw clip, with no key layer at all — the reference every unkeyed
	// frame must still reproduce.
	const reference = makeTake();
	const rawAt = (frame) => {
		reference.poseClip(frame);
		return reference.chains.get("leftHand").bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
	};
	const sourceDirty = [];
	for (let frame = 0; frame <= 20; frame += 1) {
		reference.poseClip(frame);
		if (detectPenetrations(buildCollisionCapsules(reference.rig, RADII)).length) sourceDirty.push(frame);
	}
	check("the source clip penetrates at exactly frames 2 and 18",
		sourceDirty.join(",") === "2,18", `dirty=${sourceDirty.join(",")}`);

	const take = makeTake();
	const ik = createIkState();
	ik.chains = take.chains;
	// The user already dragged the right arm at some point in this session, so
	// it is TRACKED. A bake that writes "everything tracked" would re-key it on
	// every frame this pass touches (R4).
	ik.tracked.add("rightHand");
	const applyFrame = (frame) => {
		take.poseClip(frame);
		ikEvaluate(take.chains, ik, frame, take.fkJoints, BLEND);
	};
	const keyed = fixCollisionsRange({
		rig: take.rig, chains: take.chains, ikState: ik, fkJoints: take.fkJoints,
		startFrame: 0, endFrame: 20, applyFrame, radii: RADII,
	});
	check("the range pass keys only the frames the SOURCE clip needed",
		keyed.join(",") === "2,18", `keyed=${keyed.join(",")}`);
	check("a key names only the chains that frame actually drove",
		keyed.every((frame) => [...ik.keys.get(frame).keys()].sort().join(",") === "leftFoot,leftHand"),
		keyed.map((f) => `${f}:${[...ik.keys.get(f).keys()].join("+")}`).join(" "));
	check("a tracked-but-untouched limb is never re-keyed by the pass",
		keyed.every((frame) => !ik.keys.get(frame).has("rightHand")),
		keyed.map((f) => `${f}:${[...ik.keys.get(f).keys()].join("+")}`).join(" "));

	// The mid-gap frame is 9 frames from one key and 7 from the other: outside
	// both islands' blend windows, so the clip owns it outright.
	const raw11 = rawAt(11);
	applyFrame(11);
	const drift11 = take.chains.get("leftHand").bones
		.map((bone, index) => bone.getWorldPosition(new THREE.Vector3()).distanceTo(raw11[index]));
	check("an unkeyed mid-gap frame reproduces the raw clip within 1 mm",
		drift11.every((d) => d < 0.001), drift11.map((d) => d.toFixed(4)).join(" "));

	// Frames that ARE inside a window still ease, so the test is not vacuous.
	const raw4 = rawAt(4);
	applyFrame(4);
	const drift4 = take.chains.get("leftHand").bones[2].getWorldPosition(new THREE.Vector3()).distanceTo(raw4[2]);
	check("a frame inside the blend window still carries the correction", drift4 > 1e-6, `drift=${drift4}`);

	const before = ikKeyframes(ik).join(",");
	const again = fixCollisionsRange({
		rig: take.rig, chains: take.chains, ikState: ik, fkJoints: take.fkJoints,
		startFrame: 0, endFrame: 20, applyFrame, radii: RADII,
	});
	check("a second pass over the fixed clip keys nothing new",
		again.length === 0 && ikKeyframes(ik).join(",") === before,
		`again=${again.join(",")} keys=${ikKeyframes(ik).join(",")}`);
}

/* --- REGRESSION (G2): every frame is judged against the CLIP --------------- */
/* With fixes close enough together to share a blend window, the difference is
 * unmissable: `applyFrame` evaluates the keys this pass already wrote, so
 * frame 6 used to be detected and solved on top of frame 2's blend ramp rather
 * than on the clip. What the pass keys, and the pose it bakes, then depend on
 * the order it walked the range in — the "chasing its own tail" QA measured as
 * 4 of 11 keys landing on source-clean frames. The fix is the auto-physics
 * two-sweep pattern: record the clip first, restore it before every fix.
 *
 * The invariant that pins it down: a range pass must produce EXACTLY what
 * fixing each frame of the raw clip on its own produces. */
{
	const BLEND = 6;
	// Bottoms of the swing every 4 frames — inside each other's blend windows.
	const angleAt = (frame) => -Math.PI / 2 + (Math.PI / 3) * Math.abs(Math.sin((Math.PI * (frame - 2)) / 4));
	const makeTake = () => {
		const rig = makeRig();
		const resolved = resolveIkRig(rig);
		const arm = rig.getObjectByName("mixamorigLeftArm");
		const fore = rig.getObjectByName("mixamorigLeftForeArm");
		const hand = rig.getObjectByName("mixamorigLeftHand");
		const poseClip = (frame) => {
			arm.position.set(10, -10, 0);
			fore.position.set(30, 0, 0);
			hand.position.set(30, 0, 0);
			fore.quaternion.identity();
			hand.quaternion.identity();
			arm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), angleAt(frame));
			rig.updateMatrixWorld(true);
		};
		return { rig, chains: resolved.chains, fkJoints: resolved.fkJoints, poseClip };
	};

	// Ground truth: fix each frame of the RAW clip, alone, on a virgin state.
	const independent = new Map();
	for (let frame = 0; frame <= 20; frame += 1) {
		const solo = makeTake();
		solo.poseClip(frame);
		const outcome = fixCollisions(solo.rig, solo.chains, { radii: RADII, ikState: createIkState() });
		if (outcome.changed) {
			independent.set(frame, solo.chains.get("leftHand").bones.map((b) => b.quaternion.clone()));
		}
	}
	check("the fixture puts several fixes inside one blend window",
		independent.size >= 4 && [...independent.keys()].every((f, i, all) => i === 0 || f - all[i - 1] <= BLEND),
		`dirty=${[...independent.keys()].join(",")}`);

	const take = makeTake();
	const ik = createIkState();
	ik.chains = take.chains;
	const keyed = fixCollisionsRange({
		rig: take.rig, chains: take.chains, ikState: ik, fkJoints: take.fkJoints,
		startFrame: 0, endFrame: 20, radii: RADII,
		applyFrame: (frame) => {
			take.poseClip(frame);
			ikEvaluate(take.chains, ik, frame, take.fkJoints, BLEND);
		},
	});
	check("the range pass keys exactly the frames the raw clip needs",
		keyed.join(",") === [...independent.keys()].join(","),
		`range=${keyed.join(",")} raw=${[...independent.keys()].join(",")}`);
	const poseErrors = keyed.map((frame) => {
		const baked = ik.keys.get(frame).get("leftHand").q;
		return Math.max(...baked.map((q, i) => q.angleTo(independent.get(frame)[i])));
	});
	// Tolerance is solver round-off (the range walks one rig through many more
	// matrix updates than the per-frame reference does); the contaminated pose
	// misses by ~0.3°, three hundred times this.
	check("and bakes the pose a raw-clip fix would have produced",
		poseErrors.every((error) => error < 1e-5),
		poseErrors.map((e) => ((e * 180) / Math.PI).toFixed(4) + "°").join(" "));
}

/* --- REGRESSION (Defect A): calibrate against the REST pose ---------------- */
/* The T-pose fixture above proved the calibration works when the pair overlaps
 * in BIND. On a real character it does not: poseBind is a T-pose with the arms
 * straight out, while the pose on screen is DEFAULT_POSE with the arms hanging
 * at the sides — and that is where the arm capsules graze the torso. Bind-only
 * calibration therefore recorded nothing for torso × forearm, the rest pose
 * still read ~1 cm penetrating, and one press of Fix collisions on a brand-new
 * project baked a phantom key and moved the rig 13.7 mm.
 *
 * The fixture below is the first synthetic rig here with MIXAMO-LIKE bone
 * frames: the shoulders carry a bind rotation, so DEFAULT_POSE's X-axis delta
 * swings the arms down instead of spinning them about their own axis. */
{
	const shoulderQ = (sign) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), sign * Math.PI / 2);
	const makeStandingRig = () => {
		const rig = new THREE.Object3D();
		rig.scale.setScalar(0.01);
		const mk = (name, parent, x, y, z, quat) => {
			const b = new THREE.Bone();
			b.name = name;
			b.position.set(x, y, z);
			if (quat) b.quaternion.copy(quat);
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
		// Shoulder-local +Z is world +X (left) and +Y is world +Y, so the arm
		// chain runs out sideways at bind and DEFAULT_POSE rotates it down.
		const lSh = mk("mixamorigLeftShoulder", chest, 10, 25, 0, shoulderQ(1));
		const lArm = mk("mixamorigLeftArm", lSh, 0, -10, 4);
		const lFore = mk("mixamorigLeftForeArm", lArm, 0, 0, 30);
		mk("mixamorigLeftHand", lFore, 0, 0, 30);
		const rSh = mk("mixamorigRightShoulder", chest, -10, 25, 0, shoulderQ(-1));
		const rArm = mk("mixamorigRightArm", rSh, 0, -10, 4);
		const rFore = mk("mixamorigRightForeArm", rArm, 0, 0, 30);
		mk("mixamorigRightHand", rFore, 0, 0, 30);
		const lUp = mk("mixamorigLeftUpLeg", hips, 10, 0, 0);
		const lLeg = mk("mixamorigLeftLeg", lUp, 0, -45, 0);
		const lFoot = mk("mixamorigLeftFoot", lLeg, 0, -45, 0);
		mk("mixamorigLeftToeBase", lFoot, 0, -5, 12);
		const rUp = mk("mixamorigRightUpLeg", hips, -10, 0, 0);
		const rLeg = mk("mixamorigRightLeg", rUp, 0, -45, 0);
		const rFoot = mk("mixamorigRightFoot", rLeg, 0, -45, 0);
		mk("mixamorigRightToeBase", rFoot, 0, -5, 12);
		rig.updateMatrixWorld(true);
		primeBindPose(rig); // the T-pose IS the bind, exactly as at clone time
		return rig;
	};
	/** The rig as the app shows it: bind + DEFAULT_POSE, via applyPose itself. */
	const standing = () => {
		const rig = makeStandingRig();
		applyPose(rig, { ...REST_ZERO, ...DEFAULT_POSE.bones });
		rig.updateMatrixWorld(true);
		return rig;
	};

	const rig = standing();
	const foreArm = rig.getObjectByName("mixamorigLeftForeArm");
	check("the fixture's bind is a T-pose while its rest hangs the arm down",
		bindWorldPosition(rig, foreArm, new THREE.Vector3()).x > 0.4
			&& foreArm.getWorldPosition(new THREE.Vector3()).x < 0.2,
		`bindX=${bindWorldPosition(rig, foreArm, new THREE.Vector3()).x.toFixed(4)} restX=${foreArm.getWorldPosition(new THREE.Vector3()).x.toFixed(4)}`);

	const capsules = buildCollisionCapsules(rig, RADII);
	const uncalibrated = detectPenetrations(capsules, { pairAllowances: null });
	const phantom = uncalibrated.find((p) => pairIds(p) === "leftForeArm×torso");
	check("the standing rest pose DOES trip the uncalibrated rule at torso × forearm",
		Boolean(phantom), uncalibrated.map(pairIds).join(", ") || "none");
	check("the phantom is the centimetre-scale one QA measured",
		phantom.depth > 0.005 && phantom.depth < 0.02, `depth=${(phantom.depth * 1000).toFixed(1)}mm`);
	check("bind alone cannot see it — the arms are nowhere near the torso there",
		detectPenetrations(buildCollisionCapsules(makeStandingRig(), RADII), { pairAllowances: null })
			.every((p) => pairIds(p) !== "leftForeArm×torso"));

	check("the standing rest pose reads completely clean once calibrated",
		detectPenetrations(capsules).length === 0,
		detectPenetrations(capsules).map((p) => `${pairIds(p)}@${(p.depth * 1000).toFixed(1)}mm`).join(", "));
	check("the bind T-pose reads clean too",
		detectPenetrations(buildCollisionCapsules(makeStandingRig(), RADII)).length === 0);
	check("Fix collisions on a fresh standing project writes nothing", (() => {
		const fresh = standing();
		const result = fixCollisions(fresh, resolveIkRig(fresh).chains, { radii: RADII });
		return result.supported === true && result.changed === false && result.touched.length === 0;
	})());
	check("and it hands the pose back untouched", (() => {
		const fresh = standing();
		const before = fresh.getObjectByName("mixamorigLeftForeArm").getWorldPosition(new THREE.Vector3());
		fixCollisions(fresh, resolveIkRig(fresh).chains, { radii: RADII });
		return fresh.getObjectByName("mixamorigLeftForeArm").getWorldPosition(new THREE.Vector3()).distanceTo(before) < 1e-9;
	})());
	check("the allowance came from the REST composition, not from bind",
		restPairOverlaps(rig, RADII).get("leftForeArm|torso") > 0.02,
		[...restPairOverlaps(rig, RADII).entries()].map(([k, o]) => `${k}@${(o * 1000).toFixed(1)}mm`).join(", "));

	// ...and a genuine deep hit on that very pair is still caught at full depth.
	const driven = standing();
	driven.getObjectByName("mixamorigLeftShoulder").position.set(2, 25, 0);
	driven.updateMatrixWorld(true);
	const hits = detectPenetrations(buildCollisionCapsules(driven, RADII));
	const deep = hits.find((p) => pairIds(p) === "leftForeArm×torso");
	check("a forearm genuinely driven into the torso is still detected",
		Boolean(deep), hits.map(pairIds).join(", ") || "none");
	check("the calibration moved the zero point, it did not disable the pair",
		deep.depth > 0.05, `depth=${(deep.depth * 1000).toFixed(1)}mm`);
}

/* --- REGRESSION (escape direction): a limb escapes toward where it BELONGS -- */
/* The push used to follow the segment-to-segment separation normal, i.e. the
 * SHORTEST way out, which on a deep hit is regularly the wrong side of the
 * blocker: QA's forearm-in-the-chest exited ACROSS the chest and parked the
 * hand at the opposite shoulder, and a hand 10.8 cm inside the head exited
 * forward, turning "hand to face" into "hand held out in front of the face".
 * The escape is now the normal blended with a HOME direction — contact point →
 * the driven joint's REST-pose position — with the push length divided by the
 * alignment so the separation ALONG THE NORMAL is unchanged.
 *
 * Every fixture here primes a bind pose: with no bind snapshot there is no rest
 * pose to bias toward (restWorldPosition would compose the penetrating pose
 * itself), and the fixer deliberately keeps the old unbiased normal — which is
 * why every fixture above still measures exactly what it always did. */
{
	check("the bias constants are the documented ones",
		HOME_BIAS === 0.6 && MIN_ALIGN === 0.35, `HOME_BIAS=${HOME_BIAS} MIN_ALIGN=${MIN_ALIGN}`);

	/** The synthetic rig with a bind pose primed, so a rest pose exists. */
	const primed = () => {
		const rig = makeRig(true);
		primeBindPose(rig);
		return rig;
	};

	/**
	 * The same rig with the shoulders turned so the arms are authored pointing
	 * FORWARD (+Z). DEFAULT_POSE's delta then rotates each arm about its own
	 * axis, so the REST pose keeps the hands out in front of the chest — a rig
	 * where "where the limb belongs" is unambiguous, and where an escape out of
	 * the BACK of the chest is unmistakably the wrong answer.
	 */
	const reachRig = () => {
		const rig = makeRig(true);
		rig.getObjectByName("mixamorigLeftShoulder").quaternion
			.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
		rig.getObjectByName("mixamorigRightShoulder").quaternion
			.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
		rig.updateMatrixWorld(true);
		primeBindPose(rig);
		return rig;
	};

	const wristOf = (chains) => chains.get("leftHand").bones[2].getWorldPosition(new THREE.Vector3());
	/** Signed side of the sagittal plane; the synthetic hips sit at x = 0 with
	 * no rotation, so this is simply the wrist's x. Positive = the rig's LEFT. */
	const side = (point) => point.x;
	const CHEST_SURFACE = 0.13; // the Spine radius the capsule table uses here

	{
		const rig = reachRig();
		check("the reach rig's rest pose holds the wrist out in FRONT of the chest",
			restWorldPosition(rig, rig.getObjectByName("mixamorigLeftHand"), new THREE.Vector3()).z > 0.6,
			`restZ=${restWorldPosition(rig, rig.getObjectByName("mixamorigLeftHand"), new THREE.Vector3()).z.toFixed(3)}`);
	}

	/* (a) forearm driven into the chest FROM THE FRONT. The old rule slid the
	 * hand sideways along the shortest normal and left it buried at the side of
	 * the chest (z = 0.053, well inside the 0.13 chest surface); the rest-biased
	 * escape brings it back out the way it came in. */
	{
		const rig = reachRig();
		const { chains } = resolveIkRig(rig);
		solveIk(chains.get("leftHand"), new THREE.Vector3(0.06, 1.46, 0));
		rig.updateMatrixWorld(true);
		const before = wristOf(chains);
		const hits = detectPenetrations(buildCollisionCapsules(rig, RADII));
		check("the fixture buries the forearm in the chest from the front",
			hits.some((p) => /chest/.test(pairIds(p)) && /left(ForeArm|Hand)/.test(pairIds(p)))
				&& side(before) > 0 && Math.abs(before.z) < CHEST_SURFACE,
			`${hits.map(pairIds).join(", ")} wrist=${before.toArray().map((n) => n.toFixed(3)).join(",")}`);

		const result = fixCollisions(rig, chains, { radii: RADII });
		const after = wristOf(chains);
		check("the chest fix leaves nothing penetrating",
			result.changed && result.residual === 0 && penetrations(rig).length === 0,
			`residual=${(result.residual * 1000).toFixed(2)}mm passes=${result.passes}`);
		check("the wrist keeps its OWN side of the sagittal plane",
			side(after) > 0, `x=${after.x.toFixed(3)} (was ${before.x.toFixed(3)})`);
		check("and comes out IN FRONT of the chest, not sideways through it",
			after.z >= CHEST_SURFACE, `z=${after.z.toFixed(3)} (chest surface ${CHEST_SURFACE})`);
		check("the chest fix preserves the arm's bone lengths", (() => {
			const c = chains.get("leftHand").bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
			return Math.abs(c[0].distanceTo(c[1]) - 0.3) < 1e-6 && Math.abs(c[1].distanceTo(c[2]) - 0.3) < 1e-6;
		})());
		const again = fixCollisions(rig, chains, { radii: RADII });
		check("a second run over the fixed pose changes nothing",
			again.changed === false && wristOf(chains).distanceTo(after) < 1e-9,
			`drift=${wristOf(chains).distanceTo(after).toFixed(6)}`);
	}

	/* (a, side clause) the same defect measured as QA saw it: a deep forearm hit
	 * walking the hand across the body a couple of centimetres per pass until it
	 * ends at the opposite shoulder. Every one of these targets crossed the
	 * midline under the unbiased normal (one ended at x = -0.224). */
	{
		const crossers = [
			[0.12, 1.42, 0.14], [0.15, 1.44, 0.10], [0.16, 1.44, 0.10],
			[0.04, 1.50, 0.12], [0.05, 1.52, 0.14],
		];
		const ended = crossers.map((target) => {
			const rig = primed();
			const { chains } = resolveIkRig(rig);
			solveIk(chains.get("leftHand"), new THREE.Vector3(...target));
			rig.updateMatrixWorld(true);
			const result = fixCollisions(rig, chains, { radii: RADII });
			return { x: side(wristOf(chains)), residual: result.residual };
		});
		check("no deep chest hit walks the left hand over to the right side",
			ended.every((e) => e.x > 0), ended.map((e) => e.x.toFixed(3)).join(" "));
		check("and those deep hits still come out clean",
			ended.every((e) => e.residual === 0),
			ended.map((e) => (e.residual * 1000).toFixed(2) + "mm").join(" "));
	}

	/* (b) THE CROUCH CLIP: a hand 12.9 cm inside the head. The separation normal
	 * there points away from the hand's rest position, so the unbiased escape
	 * shoved the hand further from where it belongs (−27 mm along home) and the
	 * "hand to face" gesture became "hand held out in front of the face". */
	{
		const rig = primed();
		const { chains } = resolveIkRig(rig);
		solveIk(chains.get("leftHand"), new THREE.Vector3(0, 1.75, -0.02));
		rig.updateMatrixWorld(true);
		const before = wristOf(chains);
		const home = restWorldPosition(rig, chains.get("leftHand").bones[2], new THREE.Vector3())
			.sub(before).normalize();
		const hit = detectPenetrations(buildCollisionCapsules(rig, RADII))
			.find((p) => pairIds(p) === "head×leftHand");
		check("the fixture sinks the hand deep into the head",
			Boolean(hit) && hit.depth > 0.1, hit ? `${(hit.depth * 1000).toFixed(1)}mm` : "no head×hand hit");
		// `normal` points b → a = hand → head, so the hand escapes along −normal.
		check("and the head's own escape normal points AWAY from the rest pose",
			hit.normal.clone().negate().dot(home) < 0,
			`dot=${hit.normal.clone().negate().dot(home).toFixed(3)}`);

		const result = fixCollisions(rig, chains, { radii: RADII });
		const move = wristOf(chains).sub(before);
		check("the head fix still separates completely",
			result.changed && result.residual === 0 && penetrations(rig).length === 0,
			`residual=${(result.residual * 1000).toFixed(2)}mm`);
		check("the hand leaves the head TOWARD its rest position, not along the head normal",
			move.dot(home) > 0.05, `alongHome=${(move.dot(home) * 1000).toFixed(1)}mm`);
		check("the hand also stays on its own side coming out of the head",
			side(wristOf(chains)) > 0, `x=${wristOf(chains).x.toFixed(3)}`);
	}

	/* (c) a case the bias has no opinion about — a thigh driven up into the
	 * chest, movable × static, escaping straight out the front. It converged in
	 * 4 passes with the unbiased normal and must still do so: the bias chooses a
	 * side, it must never cost convergence. */
	{
		const rig = primed();
		const { chains } = resolveIkRig(rig);
		solveMidJoint(chains.get("leftFoot"), new THREE.Vector3(0.10, 1.35, 0.10));
		rig.updateMatrixWorld(true);
		const hits = detectPenetrations(buildCollisionCapsules(rig, RADII));
		const thigh = hits.find((p) => pairIds(p) === "chest×leftThigh");
		check("the thigh fixture is a movable × static hit",
			Boolean(thigh) && thigh.depth > 0.04
				&& Boolean(thigh.b.def.movable) && !thigh.a.def.movable,
			hits.map(pairIds).join(", ") || "none");
		const result = fixCollisions(rig, chains, { radii: RADII });
		check("the thigh case still converges to zero residual",
			result.changed && result.residual === 0 && penetrations(rig).length === 0,
			`residual=${(result.residual * 1000).toFixed(3)}mm`);
		check("in the same 4 passes the unbiased rule needed",
			result.passes <= 4, `passes=${result.passes}`);
		check("with the leg's bone lengths intact", (() => {
			const c = chains.get("leftFoot").bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
			return Math.abs(c[0].distanceTo(c[1]) - 0.45) < 1e-6 && Math.abs(c[1].distanceTo(c[2]) - 0.45) < 1e-6;
		})());
	}
}

console.log(failures ? `\n${failures} FAIL` : "\nall pass");
process.exit(failures ? 1 : 0);
