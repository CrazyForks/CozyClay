/**
 * Contact-preservation gate for the footage-ingest pipeline (plan §17, Q1).
 *
 * WHY IT EXISTS
 * ------------
 * Two fighters captured in one shared world go through CozyClay's positional
 * retarget independently. The question this gate answers: does a punch that
 * demonstrably lands in the captured joint data still land on the rendered
 * scene? Per-frame, the minimum distance between fighter A's hand joints and
 * fighter B's head/torso joints is measured BEFORE retarget (on the npz
 * posed_joints, ARDY metres) and AFTER retarget (on the rendered bone world
 * positions, converted back to ARDY metres), and the two must agree.
 *
 * THE CONTRACT (plan §17, as amended by the measured rig facts below)
 * -------------------------------------------------------------------
 * A1  contact preserved: for every contact frame f in F (d_before <= 0.25 m),
 *     |d_after(f) - d_before(f)| <= 0.05 m (5 cm)
 * A2  no systematic whiff: min_F d_after <= max_F d_before + 0.05 m
 * A3  negative control - placement: rigB at the origin, A1 must FAIL
 * A4  negative control - shared scale: rigB 10% taller, A1 must FAIL
 * A5  report: measured systematic max_F |d_after - d_before| vs the
 *     rig-predicted bound (|o[A RightForeArm]| + |delta wrist->fist| +
 *     |o[B Head]|)/s from debugPrep plus bind lengths, and the worst frame
 * A6  placeSecondActor output equals the formula inlined in this test to 1e-6
 * A7  A1 and A2 still hold when B's transform comes from placeSecondActor
 * A8  app-faithful config: both rigs = y-bot-tpose.fbx (CHARACTER_MODEL_URL,
 *     src/App.jsx:302, used at :3055 and :3065), s_A === s_B exactly - must pass
 * A9  mixed-pair control: x-bot A + y-bot B fails A1, and the frame-30
 *     residual matches the predicted (1 - s_B/s_A)*h decomposition
 *
 * THRESHOLD RATIONALE (5 cm, from §17): the differential form removes capture
 * noise, which is present on both sides and cancels. The systematic term is
 * the un-driven wrist->fist segment plus the rotating bind residuals,
 * approx 1-3 cm + 1-2 cm, i.e. 2-6 cm worst case; 5 cm separates "still
 * connects" from "whiff" (a 5 cm error at a 2 m camera distance subtends
 * ~1.4 degrees, under the hit/miss perception threshold) and sits far below
 * the 25 cm contact-definition radius, so A1 is a real check rather than a
 * tautology - A3/A4 prove its sensitivity.
 *
 * WHY THE CHECK IS DIFFERENTIAL, NOT ABSOLUTE: an absolute claim ("the scene
 * fist is within X of the captured contact point") would have to absorb
 * capture noise, the un-driven fist segment, and the per-rig bind residuals
 * into one number, so it would fail on noisy captures even when the retarget
 * is perfect and pass on clean ones when it is broken. The differential
 * isolates what the retarget itself does to the two fighters' relative
 * geometry. It deliberately does NOT claim the scene matches the captured
 * world in an absolute sense - a self-consistently wrong world (e.g. a
 * mistyped ring size) passes every differential check by design, and that is
 * the calibration lane's job (plan §9, pre-mortem S3), not this gate's.
 *
 * THE FIST PROBLEM AND THE CONSTRUCTION (leader-approved amendment to §17):
 * the fist joints (RightHand/LeftHand) are deliberately NOT driven -
 * SKINNING_MAP nulls them (playback.js:58-77) - so the rendered fist is the
 * pinned wrist plus the rig's own bind wrist->fist segment. Measuring against
 * posed[hand] while the fist is actually placed by that un-driven segment
 * measures a joint the camera never sees. The synthetic clips therefore
 * overwrite the FOREARM (a driven joint) as well as the hand, so that the
 * RENDERED fist lands exactly on the RENDERED head: posed[ForeArm]@K =
 * target - (o[ForeArm] + bindWristToFist)/s. The pose-side hand is placed at
 * the same target, so the captured joint data shows a demonstrable contact
 * (d_before(30) ~ 4 cm, the hand sitting at the rendered head, 4.3 cm from
 * the pose-side neck) and the rendered scene shows the fist on the head.
 *
 * MEASURED RIG FACTS (override §17's assumptions; carried to the plan ledger):
 *  - s differs on the shipped pair: x-bot 109.2547, y-bot 101.1180 rig
 *    units per ARDY metre - a 7.4% mismatch. B's rendered body is 7.4%
 *    shorter, an irreducible (1 - s_B/s_A)*h vertical miss at ANY placement
 *    (>5 cm for every head/torso target), so the mixed pair CANNOT pass A1
 *    and is asserted as the A9 negative control instead of §17's "broader
 *    proportion test" (the plan assumed "both Mixamo default skeleton, so s
 *    is equal" - false for the shipped rigs).
 *  - bind-vs-neutral offsets are 6-24 cm (not §17's assumed 0.5-3 cm), and
 *    the plan's literal construction (overwrite only posed[hand]) leaves the
 *    rendered fist ~2 m from the head because the forearm stays at neutral.
 *    The absorption construction above is the minimal fix that makes the
 *    rendered geometry land where the captured data says it landed.
 *
 * The measured worst |d_after - d_before| on the gate config lands inside
 * §17's own predicted 2-6 cm band, so the 5 cm threshold stays as written.
 *
 * Q1 RED (TDD): "A3 negative control: placement discarded still passed A1".
 * The first version of this file asserted A3/A4 with the naive polarity
 * (the control config must PASS A1); the first run failed on exactly that
 * line, proving the gate has teeth before the negative controls were wired.
 *
 * A6/A7 oracle: placeSecondActor below is a REFERENCE implementation of the
 * §17 placement formula (charB = charA + s*rot(yaw)*(rootB[anchorB] -
 * rootA[anchorA])). Commit C11 replaces it with the production module; C11's
 * acceptance is that the production export agrees with this oracle to 1e-6
 * (the C11 RED "placeSecondActor vs inlined formula" is measured against it).
 *
 * Run: node test/ingest/verify-contact-preservation.mjs
 */
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { readFileSync } from "node:fs";
import {
	applyMotionFrame,
	debugPrep,
	motionBones,
} from "../../src/ardy/playback.js";
import { CSKEL27_JOINTS } from "../../src/ardy/cskel27.js";
import { CSKEL27_NEUTRAL } from "../../src/ardy/cskel27-neutral.js";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!cond) fail.push(label);
};

const ARDY_NEUTRAL_TOE = 0.9544128; // neutral toe depth below the hips origin
const JOINTS = CSKEL27_JOINTS.length;
const FRAMES = 60; // synthetic shared-world clip length @ 20 fps
const CONTACT_A = 30; // A's hands land on B's head
const CONTACT_B = 45; // B's hands land on A's Spine3
const GUARD = [0.1, -0.1, 0.05]; // guard-pose hand offset from B's head, 15 cm away
const CONTACT_RADIUS = 0.25; // contact set F: d_before <= 25 cm (plan §17)
const BUDGET = 0.05; // A1 threshold: 5 cm (plan §17, rationale in header)

// cskel27 indices used by the metric (plan §17): A's fists, B's head/torso.
const HANDS = [
	CSKEL27_JOINTS.indexOf("RightHand"),
	CSKEL27_JOINTS.indexOf("LeftHand"),
];
const FOREARMS = [
	CSKEL27_JOINTS.indexOf("RightForeArm"),
	CSKEL27_JOINTS.indexOf("LeftForeArm"),
];
const TARGETS = ["Head", "Spine3", "Spine2", "Neck", "Spine1"].map(
	(name) => CSKEL27_JOINTS.indexOf(name)
);

function loadRig(name) {
	const buf = readFileSync(new URL(`../../public/models/${name}`, import.meta.url));
	const rig = new FBXLoader().parse(
		buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
		"",
	);
	// App-faithful: Character scales the centimetre rig to metres; the
	// skinning math must stay in the space below this root (same convention
	// as test/ardy/verify-playback-skinning.mjs:57-61).
	rig.scale.setScalar(0.01);
	rig.updateMatrixWorld(true);
	return rig;
}

/** The project's bone-matching rule (normalised names equal or suffix). */
function findBone(rig, mixamoName) {
	const target = mixamoName.toLowerCase().replace(/[^a-z0-9]/g, "");
	let found = null;
	rig.traverse((object) => {
		if (found || !object.isBone) return;
		const norm = object.name.toLowerCase().replace(/[^a-z0-9]/g, "");
		if (norm === target || norm.endsWith(target)) found = object;
	});
	return found;
}

/**
 * Per-rig constants the construction needs, measured from the shipped rigs:
 *  - s      uniform scale from debugPrep (rig units per ARDY metre)
 *  - o(j)   bind-vs-neutral offsets (rig units) from debugPrep
 *  - bindLocal(i)  the rig's OWN bind wrist->fist vector (rig units), read
 *    from bind world positions - the un-driven segment that places the fist.
 */
function rigConstants(rig) {
	const prep = debugPrep(rig);
	const handBones = HANDS.map((h) => findBone(rig, CSKEL27_JOINTS[h]));
	const forearmBones = FOREARMS.map((f) => findBone(rig, CSKEL27_JOINTS[f]));
	const bindLocal = FOREARMS.map((f, i) => {
		const hand = handBones[i].getWorldPosition(new THREE.Vector3()).multiplyScalar(100);
		const forearm = forearmBones[i].getWorldPosition(new THREE.Vector3()).multiplyScalar(100);
		return [hand.x - forearm.x, hand.y - forearm.y, hand.z - forearm.z];
	});
	return {
		s: prep.scale,
		o: (j) => prep.offsets[j],
		bindLocal,
	};
}

/**
 * Synthetic shared-world clips (plan §17): both fighters on the ARDY neutral
 * pose, A's root at (0, 0.9544128, 0), B's at (1.5, 0.9544128, 0) - 1.5 m
 * apart - 60 frames @ 20 fps, all rotations identity, both anchored at frame
 * 0. At frame 30 A's hands are overwritten onto B's rendered head; at frame
 * 45 B's hands onto A's rendered Spine3; frames 31-60 hold a guard pose with
 * A's hands within 25 cm of B's head. The forearm overwrite absorbs the
 * un-driven fist segment (see header) so the RENDERED fist lands exactly on
 * the RENDERED target; `rc` supplies the gate rig pair's constants.
 */
function buildClips(rc) {
	const makeClip = (offset) => {
		const rotMats = new Float32Array(FRAMES * JOINTS * 9);
		for (let i = 0; i < rotMats.length; i += 9) {
			rotMats[i] = 1;
			rotMats[i + 4] = 1;
			rotMats[i + 8] = 1;
		}
		const posedJoints = new Float32Array(FRAMES * JOINTS * 3);
		for (let j = 0; j < JOINTS; j += 1) {
			const n = CSKEL27_NEUTRAL[j];
			for (let f = 0; f < FRAMES; f += 1) {
				posedJoints[(f * JOINTS + j) * 3] = Math.fround(n[0] + offset[0]);
				posedJoints[(f * JOINTS + j) * 3 + 1] = Math.fround(n[1] + ARDY_NEUTRAL_TOE + offset[1]);
				posedJoints[(f * JOINTS + j) * 3 + 2] = Math.fround(n[2] + offset[2]);
			}
		}
		const rootPos = new Float32Array(FRAMES * 3);
		for (let f = 0; f < FRAMES; f += 1) {
			rootPos[f * 3] = offset[0];
			rootPos[f * 3 + 1] = ARDY_NEUTRAL_TOE + offset[1];
			rootPos[f * 3 + 2] = offset[2];
		}
		return { frames: FRAMES, fps: 20, rotMats, rootPos, posedJoints, anchorFrame: 0 };
	};
	const A = makeClip([0, 0, 0]);
	const B = makeClip([1.5, 0, 0]);

	// Where the target JOINT renders, given the rig's offsets: posed + o/s
	// (all three components - a custom rig with a large lateral offset must
	// not silently shift the contact target).
	const renderedAt = (clip, f, j, o) => [
		clip.posedJoints[(f * JOINTS + j) * 3] + o[0] / rc.s,
		clip.posedJoints[(f * JOINTS + j) * 3 + 1] + o[1] / rc.s,
		clip.posedJoints[(f * JOINTS + j) * 3 + 2] + o[2] / rc.s,
	];
	// Place one hand at `target` (ARDY metres) with the forearm absorbed so
	// the rendered fist lands exactly on `target`: posed[FA] = target -
	// (o[FA] + bindWristToFist)/s.
	const placeHand = (clip, f, target, handIndex, forearmIndex) => {
		const o = rc.o(forearmIndex);
		const bl = rc.bindLocal[HANDS.indexOf(handIndex)];
		for (let k = 0; k < 3; k += 1) {
			clip.posedJoints[(f * JOINTS + handIndex) * 3 + k] = Math.fround(target[k]);
			clip.posedJoints[(f * JOINTS + forearmIndex) * 3 + k] = Math.fround(
				target[k] - (o[k] + bl[k]) / rc.s
			);
		}
	};
	const renderedHead = (clip, f) => renderedAt(clip, f, CSKEL27_JOINTS.indexOf("Head"), rc.o(CSKEL27_JOINTS.indexOf("Head")));
	const renderedSpine3 = (clip, f) => renderedAt(clip, f, CSKEL27_JOINTS.indexOf("Spine3"), rc.o(CSKEL27_JOINTS.indexOf("Spine3")));

	// Contact frame 30: A's hands land on B's RENDERED head (pose side and
	// rendered side coincide; d_before(30) ~ 4 cm, see header).
	const head30 = renderedHead(B, CONTACT_A);
	for (let i = 0; i < HANDS.length; i += 1) {
		placeHand(A, CONTACT_A, head30, HANDS[i], FOREARMS[i]);
	}
	// Contact frame 45: B's hands land on A's RENDERED Spine3.
	const spine45 = renderedSpine3(A, CONTACT_B);
	for (let i = 0; i < HANDS.length; i += 1) {
		placeHand(B, CONTACT_B, spine45, HANDS[i], FOREARMS[i]);
	}
	// Guard frames 31-60: A's hands hold 15 cm from B's rendered head,
	// exercising the metric across the rotating bind residuals.
	for (let f = CONTACT_A + 1; f < FRAMES; f += 1) {
		const rh = renderedHead(B, f);
		for (let i = 0; i < HANDS.length; i += 1) {
			placeHand(
				A,
				f,
				[rh[0] + GUARD[0], rh[1] + GUARD[1], rh[2] + GUARD[2]],
				HANDS[i],
				FOREARMS[i],
			);
		}
	}
	return { A, B };
}

/**
 * Reference placement oracle (A6/A7). charB.position = charA.position +
 * s*rot(yaw)*(rootB[anchorB] - rootA[anchorA]) (XZ only; Y shared, yaw 0 in
 * this test), scaled to scene metres by 0.01*s. C11 replaces this function
 * with the production module; its acceptance is agreement to 1e-6.
 */
function placeSecondActor(scale, motionA, motionB, anchorFrame = 0) {
	const o = anchorFrame * JOINTS * 3;
	const dx = motionB.posedJoints[o] - motionA.posedJoints[o];
	const dz = motionB.posedJoints[o + 2] - motionA.posedJoints[o + 2];
	return [0.01 * scale * dx, 0, 0.01 * scale * dz];
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Run one config through the real placement + skinning path and measure
 * d_before / d_after per frame (plan §17 metric, symmetric A<->B direction
 * included). `convertS` restores ARDY metres from rendered world positions
 * given the config's root scale (0.01*s normally; 0.011*s for the A4
 * scale-break config, whose own scale is the honest converter).
 */
function measure(rigA, rigB, clipA, clipB, bPos, bScale, convertS) {
	rigB.position.set(bPos[0], 0, bPos[1]);
	rigA.position.set(0, 0, 0);
	rigB.scale.setScalar(bScale);
	const bonesA = motionBones(rigA);
	const bonesB = motionBones(rigB);
	const handA = HANDS.map((h) => findBone(rigA, CSKEL27_JOINTS[h]));
	const handB = HANDS.map((h) => findBone(rigB, CSKEL27_JOINTS[h]));
	const dBefore = [];
	const dAfter = [];
	for (let f = 0; f < FRAMES; f += 1) {
		applyMotionFrame(rigA, clipA, f);
		applyMotionFrame(rigB, clipB, f);
		rigA.updateMatrixWorld(true);
		rigB.updateMatrixWorld(true);
		let db = Infinity;
		let da = Infinity;
		for (const [R, S] of [[0, 1], [1, 0]]) {
			const posedR = R === 0 ? clipA.posedJoints : clipB.posedJoints;
			const posedS = S === 0 ? clipA.posedJoints : clipB.posedJoints;
			const handsR = R === 0 ? handA : handB;
			const bonesS = S === 0 ? bonesA : bonesB;
			for (let i = 0; i < HANDS.length; i += 1) {
				const h = HANDS[i];
				const pa = [0, 1, 2].map((k) => posedR[(f * JOINTS + h) * 3 + k]);
				const wa = handsR[i].getWorldPosition(new THREE.Vector3());
				for (const t of TARGETS) {
					const pb = [0, 1, 2].map((k) => posedS[(f * JOINTS + t) * 3 + k]);
					const wb = bonesS[t].getWorldPosition(new THREE.Vector3());
					db = Math.min(db, dist(pa, pb));
					da = Math.min(da, dist([wa.x, wa.y, wa.z], [wb.x, wb.y, wb.z]) / convertS);
				}
			}
		}
		dBefore.push(db);
		dAfter.push(da);
	}
	// Contact set F: capture-side distance at or under the 25 cm radius.
	const Fset = [];
	for (let f = 0; f < FRAMES; f += 1) {
		if (dBefore[f] <= CONTACT_RADIUS) Fset.push(f);
	}
	let worst = { f: -1, v: 0 };
	for (const f of Fset) {
		const v = Math.abs(dAfter[f] - dBefore[f]);
		if (v > worst.v) worst = { f, v };
	}
	const a1 =
		Fset.length >= 3 &&
		Fset.includes(CONTACT_A) &&
		Fset.includes(CONTACT_B) &&
		Fset.every((f) => Math.abs(dAfter[f] - dBefore[f]) <= BUDGET);
	const a2 = Math.min(...Fset.map((f) => dAfter[f])) <= Math.max(...Fset.map((f) => dBefore[f])) + BUDGET;
	return { a1, a2, worst, Fset, dBefore, dAfter };
}

// The gate rigs: y-bot is the model both characters actually render
// (CHARACTER_MODEL_URL, src/App.jsx:302) and the only pair with s_A === s_B.
const gateA = loadRig("y-bot-tpose.fbx");
const gateB = loadRig("y-bot-tpose.fbx");
const rcGate = rigConstants(gateA);
const { A: clipA, B: clipB } = buildClips(rcGate);
const sGate = rcGate.s;

// A1: contact preserved (plan §17, amended config: y-bot pair).
const gate = measure(
	gateA,
	gateB,
	clipA,
	clipB,
	[0.01 * sGate * 1.5, 0],
	0.01,
	0.01 * sGate,
);
ok(
	"A1 contact preserved: |d_after - d_before| <= 0.05 m over F (y-bot pair)",
	gate.a1,
	`worst ${gate.worst.v.toFixed(4)} m @ f${gate.worst.f}, F=${gate.Fset.length} frames (30, 45 and guard)`,
);

// A2: no systematic whiff (plan §17).
const minAfter = Math.min(...gate.Fset.map((f) => gate.dAfter[f]));
const maxBefore = Math.max(...gate.Fset.map((f) => gate.dBefore[f]));
ok(
	"A2 no systematic whiff: min_F d_after <= max_F d_before + 0.05 m",
	gate.a2,
	`min_F d_after ${minAfter.toFixed(4)} m, max_F d_before ${maxBefore.toFixed(4)} m`,
);

// A3: negative control - placement discarded (rigB at the origin). A1 must
// FAIL: d_after ~ 1.5 m because B renders at the anchor instead of s*1.5 m.
const a3RigA = loadRig("y-bot-tpose.fbx");
const a3RigB = loadRig("y-bot-tpose.fbx");
const a3 = measure(a3RigA, a3RigB, clipA, clipB, [0, 0], 0.01, 0.01 * sGate);
ok(
	"A3 negative control (placement discarded): A1 correctly FAILS by design",
	!a3.a1,
	`worst |d_after - d_before| ${a3.worst.v.toFixed(4)} m @ f${a3.worst.f} (expected ~1.5 m)`,
);

// A4: negative control - shared scale broken (rigB 10% taller). A1 must FAIL:
// the 10% scale moves every B joint up by 0.1 * height, ~13-17 cm at the
// contact targets, far over the 5 cm budget.
const a4RigA = loadRig("y-bot-tpose.fbx");
const a4RigB = loadRig("y-bot-tpose.fbx");
const a4 = measure(a4RigA, a4RigB, clipA, clipB, [0.01 * sGate * 1.5, 0], 0.011, 0.011 * sGate);
ok(
	"A4 negative control (shared scale broken): A1 correctly FAILS by design",
	!a4.a1,
	`worst |d_after - d_before| ${a4.worst.v.toFixed(4)} m @ f${a4.worst.f} (expected ~0.1 * contact height)`,
);

// A5: report - measured systematic vs the rig-predicted worst-case bound
// (|o[A RightForeArm]| + |delta wrist->fist| + |o[B Head]|)/s from debugPrep
// plus bind lengths (plan §17). The bound is a triangle-inequality worst
// case; a custom rig with larger residuals fails loudly here with the cause.
const oFA = rcGate.o(FOREARMS[0]);
const oHead = rcGate.o(TARGETS[0]);
const oMag = (v) => Math.hypot(v[0], v[1], v[2]);
const neutralHand = CSKEL27_NEUTRAL[HANDS[0]];
const neutralFA = CSKEL27_NEUTRAL[FOREARMS[0]];
const neutralSeg = Math.hypot(
	neutralHand[0] - neutralFA[0],
	neutralHand[1] - neutralFA[1],
	neutralHand[2] - neutralFA[2],
);
const deltaFist = Math.abs(oMag(rcGate.bindLocal[0]) - sGate * neutralSeg);
const predictedBound = (oMag(oFA) + deltaFist + oMag(oHead)) / sGate;
ok(
	"A5 report: measured systematic within the rig-predicted bound",
	gate.worst.v <= predictedBound + 0.005,
	`measured ${gate.worst.v.toFixed(4)} m, predicted (|o[RFA]| ${oMag(oFA).toFixed(2)} + |Δwrist->fist| ${deltaFist.toFixed(2)} + |o[Head]| ${oMag(oHead).toFixed(2)})/s ${predictedBound.toFixed(4)} m, worst frame f${gate.worst.f}`,
);

// A6: the placement oracle equals the formula inlined in this test to 1e-6
// (plan §17). The inlined form uses the hips anchor index and the motion
// anchor frames directly; placeSecondActor is the general formula - two
// independent formulations of the same §17 expression.
const hipsIndex = CSKEL27_JOINTS.indexOf("Hips");
const inlinedPlacement = [
	0.01 * sGate * (clipB.posedJoints[hipsIndex * 3] - clipA.posedJoints[hipsIndex * 3]),
	0,
	0.01 * sGate * (clipB.posedJoints[hipsIndex * 3 + 2] - clipA.posedJoints[hipsIndex * 3 + 2]),
];
const oraclePlacement = placeSecondActor(sGate, clipA, clipB, 0);
const placementError = dist(oraclePlacement, inlinedPlacement);
ok(
	"A6 placeSecondActor equals the inlined formula to 1e-6",
	placementError <= 1e-6,
	`|oracle - inlined| = ${placementError.toExponential(2)} m`,
);

// A7: A1/A2 still hold when B's transform comes from placeSecondActor.
const a7RigA = loadRig("y-bot-tpose.fbx");
const a7RigB = loadRig("y-bot-tpose.fbx");
const a7 = measure(a7RigA, a7RigB, clipA, clipB, oraclePlacement, 0.01, 0.01 * sGate);
ok(
	"A7 A1 and A2 hold with placeSecondActor placement",
	a7.a1 && a7.a2,
	`A1=${a7.a1 ? "PASS" : "FAIL"} A2=${a7.a2 ? "PASS" : "FAIL"} worst ${a7.worst.v.toFixed(4)} m @ f${a7.worst.f}`,
);

// A8: app-faithful configuration - both rigs y-bot-tpose.fbx (the model both
// characters actually render), where s_A === s_B exactly; A1/A2 must pass.
const a8RigA = loadRig("y-bot-tpose.fbx");
const a8RigB = loadRig("y-bot-tpose.fbx");
const sA8 = debugPrep(a8RigA).scale;
const sB8 = debugPrep(a8RigB).scale;
const a8 = measure(a8RigA, a8RigB, clipA, clipB, [0.01 * sA8 * 1.5, 0], 0.01, 0.01 * sA8);
ok(
	"A8 app-faithful config (both rigs y-bot): s_A === s_B exactly and A1/A2 pass",
	Math.abs(sA8 - sB8) === 0 && a8.a1 && a8.a2,
	`s_A ${sA8.toFixed(6)} vs s_B ${sB8.toFixed(6)}, A1=${a8.a1 ? "PASS" : "FAIL"} A2=${a8.a2 ? "PASS" : "FAIL"}, worst ${a8.worst.v.toFixed(4)} m @ f${a8.worst.f}`,
);

// A9: mixed-pair control - x-bot A + y-bot B on the SAME clip. The two rigs'
// scales differ by 7.4% (measured: 109.2547 vs 101.1180), so the shared-frame
// contract is void: B renders (1 - s_B/s_A) ~ 12.5 cm short at the head, an
// irreducible miss at any placement. A1 must FAIL, and the frame-30 residual
// must match the predicted decomposition to within the stated tolerance:
//   residual = |(1 - s_B/s_A)*(posedB[Head] - anchorB) + o_B[Head]*(1/s_B - 1/s_A)
//               + (o_A[FA] + bindLocal_A)/s_A - (o_B[FA] + bindLocal_B)/s_B|
// (the clip's absorption constants are the gate rig's - y-bot - so the
// o/bindLocal bundle is part of the prediction, not noise). Tolerance 0.03 m:
// generous over float32 clip quantization (measured deviation ~1e-4).
const a9RigA = loadRig("x-bot-tpose.fbx");
const a9RigB = loadRig("y-bot-tpose.fbx");
const rcX = rigConstants(a9RigA);
const rcY = rigConstants(a9RigB);
const sX = rcX.s;
const sY = rcY.s;
const a9 = measure(a9RigA, a9RigB, clipA, clipB, [0.01 * sX * 1.5, 0], 0.01, 0.01 * sX);
const head30 = [0, 1, 2].map((k) => clipB.posedJoints[(CONTACT_A * JOINTS + TARGETS[0]) * 3 + k]);
const anchorB = [clipB.posedJoints[hipsIndex * 3], 0, clipB.posedJoints[hipsIndex * 3 + 2]];
const scaleMiss = [
	(1 - sY / sX) * (head30[0] - anchorB[0]),
	(1 - sY / sX) * head30[1],
	(1 - sY / sX) * (head30[2] - anchorB[2]),
];
const oYHead = rcY.o(TARGETS[0]);
const oXFA = rcX.o(FOREARMS[0]);
const oYFA = rcY.o(FOREARMS[0]);
const predicted = [
	scaleMiss[0] + oYHead[0] * (1 / sY - 1 / sX) + (oXFA[0] + rcX.bindLocal[0][0]) / sX - (oYFA[0] + rcY.bindLocal[0][0]) / sY,
	scaleMiss[1] + oYHead[1] * (1 / sY - 1 / sX) + (oXFA[1] + rcX.bindLocal[0][1]) / sX - (oYFA[1] + rcY.bindLocal[0][1]) / sY,
	scaleMiss[2] + oYHead[2] * (1 / sY - 1 / sX) + (oXFA[2] + rcX.bindLocal[0][2]) / sX - (oYFA[2] + rcY.bindLocal[0][2]) / sY,
];
const predictedMag = dist(predicted, [0, 0, 0]);
ok(
	"A9 mixed-pair control (x-bot A, y-bot B): A1 must FAIL by design",
	!a9.a1,
	`worst |d_after - d_before| ${a9.worst.v.toFixed(4)} m @ f${a9.worst.f}, s_A ${sX.toFixed(4)} vs s_B ${sY.toFixed(4)} (ratio ${(sY / sX).toFixed(4)})`,
);
// The frame-30 pair-specific residual: rendered A-RightHand vs rendered
// B-Head, the pair the scale miss dominates.
applyMotionFrame(a9RigA, clipA, CONTACT_A);
applyMotionFrame(a9RigB, clipB, CONTACT_A);
a9RigA.updateMatrixWorld(true);
a9RigB.updateMatrixWorld(true);
const a9Hand = findBone(a9RigA, CSKEL27_JOINTS[HANDS[0]]).getWorldPosition(new THREE.Vector3());
const a9Head = motionBones(a9RigB)[TARGETS[0]].getWorldPosition(new THREE.Vector3());
const measuredResidual = dist([a9Hand.x, a9Hand.y, a9Hand.z], [a9Head.x, a9Head.y, a9Head.z]) / (0.01 * sX);
ok(
	"A9 predicted residual matches the (1 - s_B/s_A)*h decomposition",
	Math.abs(measuredResidual - predictedMag) <= 0.03,
	`measured ${measuredResidual.toFixed(4)} m vs predicted ${predictedMag.toFixed(4)} m (lead term (1 - s_B/s_A)*h ${Math.hypot(scaleMiss[0], scaleMiss[1], scaleMiss[2]).toFixed(4)} m), deviation ${Math.abs(measuredResidual - predictedMag).toFixed(4)} m`,
);

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
