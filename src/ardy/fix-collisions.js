import * as THREE from "three";
import {
	findBone,
	solveIk,
	solveMidJoint,
	ikTouch,
	ikBakeKeyframe,
	measureContactRadii,
	hasBindPose,
	bindWorldPosition,
	restWorldPosition,
} from "./ik.js";

/**
 * Self-collision cleanup for generated motion: detect body parts that pass
 * through each other (a hand through the thigh, a forearm through the
 * chest) and push them apart with the existing two-bone IK solver.
 *
 * Standard character-cleanup technique (capsule proxies + iterative
 * projection, as in classic mocap-clean literature and DCC plugins), built
 * entirely on CozyClay's own pieces:
 *
 * - Each body segment gets a CAPSULE proxy (bone → child bone axis, radius
 *   measured from the bind-pose skinned mesh by measureContactRadii).
 * - Torso/head capsules are STATIC blockers; limb capsules are MOVABLE.
 * - A penetration is resolved by moving the limb — mid joint (elbow/knee)
 *   for the upper segment, effector (wrist/ankle) for the lower — along the
 *   separation normal by (depth + offset). solveIk's bend continuity keeps
 *   the elbow/knee on its own side, so the fix never flips a hinge.
 * - Passes repeat until nothing penetrates or maxIterations is hit — the
 *   same projected-gauss-seidel loop physics engines use, but with IK as
 *   the projection step.
 *
 * The result is baked through ikBakeKeyframe, so a fix is an ordinary IK
 * correction key: undoable, scrubbable, and blended back to the clip
 * outside its keyed range by ikEvaluate's blend window.
 */

/* --- capsule table ---------------------------------------------------------- */

/**
 * Body capsules. `movable.chain`/`movable.joint` name the IK chain and the
 * joint of that chain to drive ("mid" = elbow/knee, "effector" = wrist/
 * ankle). Torso, chest and head have no chain: they are blockers the limbs
 * get pushed out of. `radiusJoint` keys into the measured contact radii.
 *
 * `endOptional` marks an end bone the rig is allowed not to have: the hands
 * span wrist → middle-finger base so a fingertip driven into a thigh is
 * judged at the FINGERS, not at the wrist a palm's length behind them (a
 * wrist-only sphere reads that pose as clean). Rigs exported without finger
 * bones simply fall back to the wrist sphere instead of disqualifying the
 * whole tool.
 */
// `maxRadius` caps the measured radius where the mesh extent is not a
// thickness: the head measurement runs crown-to-chin (a length), the foot
// measurement follows the toe (also a length). Uncapped, those fat capsules
// flag permanent false contacts with the torso and with the other foot at
// any normal stance.
const CAPSULE_DEFS = [
	{ id: "torso", start: "mixamorigHips", end: "mixamorigSpine1", radiusJoint: "Spine", maxRadius: 0.17, movable: null },
	{ id: "chest", start: "mixamorigSpine1", end: "mixamorigSpine2", radiusJoint: "Spine", maxRadius: 0.16, movable: null },
	{ id: "head", start: "mixamorigNeck", end: "mixamorigHead", radiusJoint: "Head", maxRadius: 0.11, movable: null },
	{ id: "leftUpperArm", start: "mixamorigLeftArm", end: "mixamorigLeftForeArm", radiusJoint: "LeftArm", movable: { chain: "leftHand", joint: "mid" }, priority: 2 },
	{ id: "leftForeArm", start: "mixamorigLeftForeArm", end: "mixamorigLeftHand", radiusJoint: "LeftForeArm", movable: { chain: "leftHand", joint: "effector" }, priority: 2 },
	{ id: "leftHand", start: "mixamorigLeftHand", end: "mixamorigLeftHandMiddle1", endOptional: true, radiusJoint: "LeftHand", maxRadius: 0.06, movable: { chain: "leftHand", joint: "effector" }, priority: 2 },
	{ id: "rightUpperArm", start: "mixamorigRightArm", end: "mixamorigRightForeArm", radiusJoint: "RightArm", movable: { chain: "rightHand", joint: "mid" }, priority: 2 },
	{ id: "rightForeArm", start: "mixamorigRightForeArm", end: "mixamorigRightHand", radiusJoint: "RightForeArm", movable: { chain: "rightHand", joint: "effector" }, priority: 2 },
	{ id: "rightHand", start: "mixamorigRightHand", end: "mixamorigRightHandMiddle1", endOptional: true, radiusJoint: "RightHand", maxRadius: 0.06, movable: { chain: "rightHand", joint: "effector" }, priority: 2 },
	{ id: "leftThigh", start: "mixamorigLeftUpLeg", end: "mixamorigLeftLeg", radiusJoint: "LeftUpLeg", movable: { chain: "leftFoot", joint: "mid" }, priority: 1 },
	{ id: "leftShin", start: "mixamorigLeftLeg", end: "mixamorigLeftFoot", radiusJoint: "LeftLeg", movable: { chain: "leftFoot", joint: "effector" }, priority: 1 },
	{ id: "leftFoot", start: "mixamorigLeftFoot", end: "mixamorigLeftToeBase", radiusJoint: "LeftFoot", maxRadius: 0.07, movable: { chain: "leftFoot", joint: "effector" }, priority: 1 },
	{ id: "rightThigh", start: "mixamorigRightUpLeg", end: "mixamorigRightLeg", radiusJoint: "RightUpLeg", movable: { chain: "rightFoot", joint: "mid" }, priority: 1 },
	{ id: "rightShin", start: "mixamorigRightLeg", end: "mixamorigRightFoot", radiusJoint: "RightLeg", movable: { chain: "rightFoot", joint: "effector" }, priority: 1 },
	{ id: "rightFoot", start: "mixamorigRightFoot", end: "mixamorigRightToeBase", radiusJoint: "RightFoot", maxRadius: 0.07, movable: { chain: "rightFoot", joint: "effector" }, priority: 1 },
];

/** Fallback radius when no measurement exists (matches ik.js's floor). */
const RADIUS_FALLBACK = 0.01;

/** Soft-tissue compression allowance, as a fraction of the thinner capsule.
 * See detectPenetrations for why this is 0.4 and not something roomier. */
const DEFAULT_SLACK_FACTOR = 0.4;

/** How much closer than its BIND pose a pair must come before the extra
 * closeness counts as a collision. See restPairOverlaps. 5 mm is under the
 * amplitude of the proxy error itself and far under any visible interpenetration. */
export const PAIR_TOLERANCE = 0.005;

/** Clearance the pushed joint keeps above the floor. A separation normal has
 * no idea the ground exists, so an otherwise correct push can drive an ankle
 * or a knee underground; the fix trades a little residual for never solving one
 * artefact by creating a worse one. */
export const PUSH_FLOOR_CLEARANCE = 0.005;

/**
 * True when the rig carries every bone the capsule table REQUIRES — the
 * cheap pre-flight the UI runs to decide whether to offer the tool at all.
 * Bone lookups only: no mesh measurement, so it is safe to call per render.
 * Optional ends (the finger bones) never count against a rig.
 */
export function supportsCollisionCleanup(rig) {
	if (!rig) return false;
	for (const def of CAPSULE_DEFS) {
		if (!findBone(rig, def.start)) return false;
		if (def.end && !def.endOptional && !findBone(rig, def.end)) return false;
	}
	return true;
}

/** The capsule table against an arbitrary source of bone positions — the
 * current pose for detection, the bind pose for calibration. Returns null when
 * a REQUIRED bone is missing. */
function buildCapsules(rig, radiiMap, positionOf) {
	const capsules = new Map();
	for (const def of CAPSULE_DEFS) {
		const start = findBone(rig, def.start);
		if (!start) return null;
		const end = def.end ? findBone(rig, def.end) : null;
		// A missing OPTIONAL end degrades to the wrist sphere; a missing
		// required end means this is not a rig we can build proxies for.
		if (def.end && !end && !def.endOptional) return null;
		const a = positionOf(start);
		const b = end ? positionOf(end) : a.clone();
		const measured = Math.max(RADIUS_FALLBACK, radiiMap[def.radiusJoint] ?? RADIUS_FALLBACK);
		capsules.set(def.id, {
			def,
			bones: end ? [start, end] : [start],
			a,
			b,
			radius: def.maxRadius ? Math.min(measured, def.maxRadius) : measured,
		});
	}
	return capsules;
}

/**
 * Build world-space capsules for the rig's CURRENT pose. Cheap (a bone
 * lookup + two world positions per entry), so callers rebuild per frame.
 * `radii` overrides the measured map (tests, or rigs without skin weights).
 * Returns null when a REQUIRED bone is missing — a non-Mixamo rig the tool
 * cannot describe, same policy as resolveIkRig. Callers must tell that apart
 * from "found nothing to fix": see fixCollisions's `supported` flag.
 */
export function buildCollisionCapsules(rig, radii = null) {
	if (!rig) return null;
	rig.updateMatrixWorld(true);
	const radiiMap = radii ?? measureContactRadii(rig);
	const capsules = buildCapsules(rig, radiiMap, (bone) => bone.getWorldPosition(new THREE.Vector3()));
	// Ride the pair calibration along on the map so detectPenetrations gets it
	// for free — it is a property of the RIG, which detection alone cannot see.
	if (capsules) capsules.pairAllowances = restPairOverlaps(rig, radiiMap);
	return capsules;
}

/* --- rest-relative calibration ---------------------------------------------- */

/** Stable key for an unordered capsule pair. */
function pairKey(idA, idB) {
	return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

// rig → (radii object identity → pair overlap map). The reference poses never
// change, so this is measured once per character.
const restOverlapCache = new WeakMap();

/** Every non-adjacent pair's overlap in one reference pose, positive entries
 * only, merged into `into` by taking the larger of the two. */
function collectPairOverlaps(rig, radiiMap, positionOf, into) {
	const capsules = buildCapsules(rig, radiiMap, positionOf);
	if (!capsules) return into;
	const list = [...capsules.values()];
	const pa = new THREE.Vector3();
	const pb = new THREE.Vector3();
	for (let i = 0; i < list.length; i += 1) {
		for (let j = i + 1; j < list.length; j += 1) {
			if (capsulesAdjacent(list[i], list[j])) continue;
			closestPointsSegmentSegment(list[i].a, list[i].b, list[j].a, list[j].b, pa, pb);
			const overlap = list[i].radius + list[j].radius - pa.distanceTo(pb);
			if (overlap <= 0) continue;
			const key = pairKey(list[i].def.id, list[j].def.id);
			if (overlap > (into.get(key) ?? 0)) into.set(key, overlap);
		}
	}
	return into;
}

/**
 * How much each non-adjacent capsule pair ALREADY overlaps in a pose the
 * character legitimately holds, in metres (positive entries only; a pair that is
 * clear in every reference pose has no entry). Returns null on a rig with no
 * bind snapshot to compose from.
 *
 * Capsules are a coarse proxy for a specific mesh, and on real characters the
 * proxy error is not small: on the shipped default rig the REST pose reports
 * torso × upper arm at 9.2 mm of "penetration" (torso 0.17 + upper arm 0.05447
 * + offset 0.002 against a 0.19547 axis distance, minus a 21.8 mm slack
 * allowance). One press of Fix collisions on a brand-new project baked a phantom
 * key and moved the rig 13.7 mm. Slack cannot fix this: the rig would need
 * slackFactor ≥ 0.569 to read clean, and a global allowance that loose re-masks
 * every real contact on every other pair.
 *
 * So the pair's own reference overlap becomes its zero point — the same
 * clip-relative-ground move auto-physics made for the floor.
 *
 * TWO REFERENCE POSES, and the second is the one that matters. `poseBind` is a
 * T-POSE: arms straight out, nowhere near the torso (LeftForeArm at x = 0.4616).
 * The pose the app actually shows is DEFAULT_POSE — arms hanging at the sides,
 * the same forearm at x = 0.1876 — and that is where the arm capsules graze the
 * torso. Calibrating against bind alone therefore recorded only leftThigh ×
 * rightThigh and left torso × upper arm at zero allowance, which is exactly the
 * pair that false-positives. Both poses are measured and the LARGER allowance
 * wins, so a T-posed character and a standing one both read clean, while a pair
 * that overlaps in neither (a hand driven into a thigh) still fires at full
 * sensitivity. Both are composed virtually through ik.js, so measuring never
 * disturbs — or depends on — the pose currently on screen.
 *
 * The cost, stated plainly: contact that the rest pose already has is invisible
 * here. An arm pressed flat against the ribs cannot be distinguished from an arm
 * hanging beside them, because the capsule proxies genuinely cannot tell those
 * apart. Excluding those pairs outright (the alternative) would lose the deep
 * hits too; this keeps them.
 */
export function restPairOverlaps(rig, radii = null) {
	if (!rig || !hasBindPose(rig)) return null;
	const radiiMap = radii ?? measureContactRadii(rig);
	let perRadii = restOverlapCache.get(rig);
	if (!perRadii) restOverlapCache.set(rig, (perRadii = new Map()));
	const cached = perRadii.get(radiiMap);
	if (cached) return cached;
	rig.updateMatrixWorld(true);
	const overlaps = new Map();
	collectPairOverlaps(rig, radiiMap, (bone) => bindWorldPosition(rig, bone, new THREE.Vector3()), overlaps);
	collectPairOverlaps(rig, radiiMap, (bone) => restWorldPosition(rig, bone, new THREE.Vector3()), overlaps);
	perRadii.set(radiiMap, overlaps);
	return overlaps;
}

/* --- detection -------------------------------------------------------------- */

/** Closest points between two segments (Ericson, Real-Time Collision
 * Detection — the textbook segment/segment distance). Writes into outA/outB
 * and returns the squared distance. */
function closestPointsSegmentSegment(p1, q1, p2, q2, outA, outB) {
	const d1 = q1.clone().sub(p1);
	const d2 = q2.clone().sub(p2);
	const r = p1.clone().sub(p2);
	const a = d1.dot(d1);
	const e = d2.dot(d2);
	const f = d2.dot(r);
	let s;
	let t;
	if (a <= 1e-12 && e <= 1e-12) {
		outA.copy(p1); outB.copy(p2);
		return r.dot(r);
	}
	if (a <= 1e-12) {
		s = 0;
		t = Math.max(0, Math.min(1, f / e));
	} else {
		const c = d1.dot(r);
		if (e <= 1e-12) {
			t = 0;
			s = Math.max(0, Math.min(1, -c / a));
		} else {
			const b = d1.dot(d2);
			const denom = a * e - b * b;
			s = denom > 1e-12 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
			t = (b * s + f) / e;
			if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
			else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
		}
	}
	outA.copy(p1).addScaledVector(d1, s);
	outB.copy(p2).addScaledVector(d2, t);
	return outA.distanceToSquared(outB);
}

/** Ancestor hop count between two bones, or Infinity when unrelated.
 * Capsules whose endpoints sit within HOP_LIMIT hops on the skeleton are
 * neighbours (upper arm against chest at the shoulder, thigh against the
 * pelvis) and ALWAYS overlap at the joint — checking them would pin the
 * fixer forever. */
const HOP_LIMIT = 2;
function bonesRelated(b0, b1) {
	for (let node = b0, hops = 0; node && hops <= HOP_LIMIT; node = node.parent, hops += 1) {
		if (node === b1) return true;
	}
	for (let node = b1, hops = 0; node && hops <= HOP_LIMIT; node = node.parent, hops += 1) {
		if (node === b0) return true;
	}
	return false;
}

function capsulesAdjacent(ca, cb) {
	return ca.bones.some((ba) => cb.bones.some((bb) => bonesRelated(ba, bb)));
}

/**
 * Find every penetrating capsule pair in the current pose. Returns records
 * { a, b, depth, normal, pointA, pointB } sorted deepest-first. `normal`
 * points from b toward a. `offset` inflates the contact distance HERE, in
 * the test itself — a pair counts as penetrating once it is closer than
 * rA + rB + offset — so the same gap the fixer pushes out to is the gap it
 * checks for. Honouring offset only in the push distance would make the
 * fixer chase a target detection never asked for, and the very gap it just
 * opened would read as clean at exactly the surface-grazing pose it exists
 * to avoid.
 *
 * SLACK: capsules are rigid proxies for soft tissue — an upper arm resting
 * against the torso, or thighs touching, legitimately overlaps the proxies.
 * A pair only counts once it penetrates past `slackFactor × min(radius)`,
 * the soft-tissue compression allowance; `depth` is the amount PAST that
 * allowance, which is also the distance the fixer pushes. The default 0.4 is
 * deliberately tighter than a "never complain" value: at 0.6 a hand sunk
 * most of the way into a thigh — plainly wrong on screen — still fit inside
 * the allowance and the tool answered "no collisions".
 *
 * BIND CALIBRATION: on top of the global slack, a pair that already overlaps in
 * the rig's bind pose gets that overlap plus PAIR_TOLERANCE as its own
 * allowance (see restPairOverlaps), so a rest or bind pose can never report a
 * collision. `pairAllowances` overrides the map buildCollisionCapsules attached;
 * pass null to measure a pose against nothing but the slack rule.
 */
export function detectPenetrations(capsules, { offset = 0.002, slackFactor = DEFAULT_SLACK_FACTOR, pairAllowances } = {}) {
	if (!capsules) return [];
	const calibration = pairAllowances === undefined ? (capsules.pairAllowances ?? null) : pairAllowances;
	const list = [...capsules.values()];
	const out = [];
	const pa = new THREE.Vector3();
	const pb = new THREE.Vector3();
	for (let i = 0; i < list.length; i += 1) {
		for (let j = i + 1; j < list.length; j += 1) {
			const ca = list[i];
			const cb = list[j];
			if (capsulesAdjacent(ca, cb)) continue;
			closestPointsSegmentSegment(ca.a, ca.b, cb.a, cb.b, pa, pb);
			const overlap = ca.radius + cb.radius + offset - pa.distanceTo(pb);
			const slack = slackFactor * Math.min(ca.radius, cb.radius);
			const bindOverlap = calibration?.get(pairKey(ca.def.id, cb.def.id)) ?? 0;
			const allowance = Math.max(slack, bindOverlap > 0 ? bindOverlap + PAIR_TOLERANCE : 0);
			const depth = overlap - allowance;
			if (depth <= 1e-7) continue;
			const normal = pa.clone().sub(pb);
			if (normal.lengthSq() < 1e-12) {
				// Coincident axes: any perpendicular direction separates them.
				normal.set(0, 0, 1).cross(ca.b.clone().sub(ca.a));
				if (normal.lengthSq() < 1e-12) normal.set(0, 1, 0);
			}
			normal.normalize();
			out.push({ a: ca, b: cb, depth, normal, pointA: pa.clone(), pointB: pb.clone() });
		}
	}
	out.sort((x, y) => y.depth - x.depth);
	return out;
}

/* --- resolution ------------------------------------------------------------- */

const NO_PUSH = Object.freeze({ ran: false, moved: false });

/**
 * Push one movable capsule by `push` (world vector). Mid joint drives the
 * elbow/knee (upper segment), effector drives the wrist/ankle (lower segment
 * and end spheres). Returns { ran, moved }: `ran` means a solver was invoked on
 * this chain (so the chain's pose may have changed and must be keyed), `moved`
 * means the driven joint actually went somewhere.
 *
 * `onlyChains` is enforced HERE, not only at the detection filter. A pair is
 * kept when EITHER side names a permitted chain, so a movable×movable pair with
 * one side listed used to push the unlisted side too (3 cm of unrequested
 * motion in "filter only selected" mode) — a filter honoured by the query but
 * not by the write.
 *
 * KNOWN LIMITATION (contact-normal choice): the push direction is the segment-
 * to-segment separation normal, which is the shortest way out and not always
 * the way a body would go. A forearm resting slightly inside the chest can be
 * closest to the far side of the torso axis, and the fix then slides the arm
 * ACROSS the chest instead of back out the way it came. Resolving this needs a
 * notion of which side of the body the limb belongs to (or the previous frame's
 * clean pose as a hint); it is not addressed here.
 */
function pushCapsule(capsule, chains, push, ikState, { onlyChains = null, floorY = 0 } = {}) {
	const target = capsule.def.movable;
	if (!target) return NO_PUSH;
	if (onlyChains && !onlyChains.has(target.chain)) return NO_PUSH;
	const chain = chains?.get(target.chain);
	if (!chain) return NO_PUSH;
	if (ikState) ikTouch(ikState, target.chain);
	const driven = target.joint === "mid" ? chain.bones[1] : chain.bones[2];
	const before = driven.getWorldPosition(new THREE.Vector3());
	const goal = before.clone().add(push);
	goal.y = Math.max(goal.y, floorY + PUSH_FLOOR_CLEARANCE);
	if (target.joint === "mid") solveMidJoint(chain, goal);
	else solveIk(chain, goal);
	// A push the solver clamped away (unreachable target, floor guard, a limb
	// already at full stretch) is NOT progress. Counting it as progress kept the
	// pass loop alive to maxIterations re-solving a pose that cannot move.
	return { ran: true, moved: driven.getWorldPosition(new THREE.Vector3()).distanceTo(before) > 1e-6 };
}

/**
 * Clean self-collisions out of the CURRENT pose. Iterates detect → push
 * until the deepest remaining penetration fits in `epsilon` or
 * maxIterations passes ran. A movable-vs-static pair pushes the limb by the
 * full depth + offset; two movable capsules split it, weighted toward the
 * higher-priority limb (arms yield before legs — leg moves read heavier).
 *
 * `onlyChains` (Set of chain ids) restricts which limbs may move — the
 * "filter only selected" mode. `ikState`, when given, marks every touched
 * chain as tracked so a following ikBakeKeyframe persists the fix.
 * `slackFactor` rides through to detectPenetrations for callers that want a
 * stricter or looser reading than the default.
 *
 * Returns { supported, changed, passes, residual, touched } — residual is the
 * deepest remaining penetration in metres, 0 when fully clean, and `touched` is
 * the chain ids THIS run actually drove. `supported` is false when the rig has
 * no capsule proxies to build at all (a non-Mixamo skeleton): the tool did not
 * run, which is a DIFFERENT answer from "ran and found nothing", and the UI
 * must say so rather than claim a clean pose.
 *
 * `touched` exists so the bake can name what moved. ikBakeKeyframe defaults to
 * the whole tracked set, which after any earlier drag or pass is far more than
 * this fix touched — keying a leg fix at frame 40 also re-keyed the hand
 * dragged at frame 2, at whatever blended value the layer happened to be
 * showing there.
 *
 * `baseQuats` is the other half of that: the rotations the key is a DELTA from.
 * The returned map (chain id → the three bone quaternions BEFORE the first
 * solver pass) is what a caller hands to ikBakeKeyframe so the blend window
 * carries the correction rather than the whole pose difference. Pass the option
 * in when you know the RAW CLIP rotations for this frame — the range walker
 * does, because it samples the clip with the layer switched off — otherwise the
 * pose on the rig at entry is used, which is exact whenever no earlier key is
 * already blending into this frame.
 *
 * BIND TRANSLATIONS FIRST. Every chain is normalised to its bind translations
 * before the first capsule is built, and left that way if anything was fixed.
 * solveIk already does this the moment it runs — its segment lengths were
 * measured at bind and its law of cosines is exact only there — so without the
 * up-front reset the pass detected on one skeleton (the clip's, whose
 * positional playback puts the bones ~19 mm off bind) and solved on another,
 * and the resulting key's rotation delta was mostly the LENGTH COMPENSATION
 * rather than the push: a 15 mm lift came back as an 11.8° knee swing whose
 * components only cancel at full weight, which made a partially-weighted blend
 * of it wander 31 mm. Normalising first makes the delta the push and nothing
 * else. A pass that changes nothing puts the translations back, so a clean pose
 * is still left exactly as it was found.
 */
export function fixCollisions(rig, chains, {
	radii = null,
	offset = 0.002,
	epsilon = 1e-4,
	maxIterations = 8,
	onlyChains = null,
	ikState = null,
	slackFactor = DEFAULT_SLACK_FACTOR,
	floorY = 0,
	baseQuats = null,
} = {}) {
	if (!rig || !chains) {
		return { supported: false, changed: false, passes: 0, residual: 0, touched: [], baseQuats: new Map() };
	}
	const bases = baseQuats ?? new Map(
		[...chains].map(([id, chain]) => [id, chain.bones.map((bone) => bone.quaternion.clone())]),
	);
	// Rotations are unaffected by the translation reset below, so the bases are
	// equally valid either side of it.
	const clipTranslations = [];
	for (const [id, chain] of chains) {
		if (!chain?.bindPositions) continue;
		chain.bones.forEach((bone, index) => {
			clipTranslations.push([id, bone, bone.position.clone()]);
			bone.position.copy(chain.bindPositions[index]);
		});
	}
	if (clipTranslations.length) rig.updateMatrixWorld(true);
	/** Give the clip its translations back on every chain this pass did not
	 * actually key. Only a keyed chain owes the bind pose its rotations were
	 * solved in; the rest are the clip's business and are handed back untouched. */
	const restoreTranslations = (keptIds = null) => {
		let restored = false;
		for (const [id, bone, position] of clipTranslations) {
			if (keptIds?.has(id)) continue;
			bone.position.copy(position);
			restored = true;
		}
		if (restored) rig.updateMatrixWorld(true);
	};
	const touched = new Set();
	const drive = (capsule, vector) => {
		const outcome = pushCapsule(capsule, chains, vector, ikState, { onlyChains, floorY });
		if (outcome.ran) touched.add(capsule.def.movable.chain);
		return outcome.moved;
	};
	let changed = false;
	let residual = 0;
	let pass = 0;
	for (; pass < maxIterations; pass += 1) {
		const capsules = buildCollisionCapsules(rig, radii);
		if (!capsules) {
			if (!changed) restoreTranslations();
			return { supported: false, changed, passes: pass, residual, touched: [...touched], baseQuats: bases };
		}
		// `changed` is cumulative across passes, so it can never report what
		// THIS pass did. A pass that pushes nothing — every penetration
		// belongs to a chain the rig lacks, or to a filtered-out chain — would
		// otherwise keep looping to maxIterations re-solving an unmoving pose.
		let passChanged = false;
		const pens = detectPenetrations(capsules, { offset, slackFactor }).filter((pen) => {
			// Two static blockers (e.g. head near torso in a crouch) can touch
			// but no limb chain can fix them — reporting them just burns passes.
			if (!pen.a.def.movable && !pen.b.def.movable) return false;
			if (!onlyChains) return true;
			const chainsOf = [pen.a, pen.b].map((c) => c.def.movable?.chain).filter(Boolean);
			return chainsOf.some((id) => onlyChains.has(id));
		});
		if (pens.length === 0) { residual = 0; break; }
		residual = pens[0].depth;
		for (const pen of pens) {
			const ma = pen.a.def.movable;
			const mb = pen.b.def.movable;
			const push = pen.normal.clone().multiplyScalar(pen.depth + offset);
			// `normal` points b → a: +push moves a away from b, -push the reverse.
			if (ma && !mb) passChanged = drive(pen.a, push) || passChanged;
			else if (mb && !ma) passChanged = drive(pen.b, push.clone().negate()) || passChanged;
			else if (ma && mb) {
				// Splitting the push is only right when BOTH sides are allowed to
				// move. With a filter naming one of them, the permitted side owes
				// the whole separation — half a push leaves half a penetration.
				const allowA = !onlyChains || onlyChains.has(ma.chain);
				const allowB = !onlyChains || onlyChains.has(mb.chain);
				if (allowA && allowB) {
					const pa = pen.a.def.priority ?? 1;
					const pb = pen.b.def.priority ?? 1;
					const shareA = pa / (pa + pb); // arms (2) yield before legs (1)
					const movedA = drive(pen.a, push.clone().multiplyScalar(shareA));
					const movedB = drive(pen.b, push.clone().negate().multiplyScalar(1 - shareA));
					passChanged = movedA || movedB || passChanged;
				} else if (allowA) passChanged = drive(pen.a, push) || passChanged;
				else if (allowB) passChanged = drive(pen.b, push.clone().negate()) || passChanged;
			}
		}
		changed = changed || passChanged;
		if (!passChanged) break;
	}
	// Hand the pose back as it arrived everywhere this pass did not key.
	restoreTranslations(changed ? touched : null);
	// Final measurement for an honest residual report.
	if (changed) {
		const capsules = buildCollisionCapsules(rig, radii);
		const pens = capsules ? detectPenetrations(capsules, { offset, slackFactor }) : [];
		residual = pens.length ? pens[0].depth : 0;
	}
	return { supported: true, changed, passes: pass, residual, touched: [...touched], baseQuats: bases };
}

/** Every bone the IK layer can write, once each: the chain bones plus the FK
 * joints. These are exactly the bones a bake at one frame can change, so
 * snapshotting them captures everything this pass could contaminate. */
function layerBones(chains, fkJoints) {
	const bones = [];
	const seen = new Set();
	const add = (bone) => {
		if (!bone || seen.has(bone)) return;
		seen.add(bone);
		bones.push(bone);
	};
	for (const chain of chains.values()) for (const bone of chain.bones) add(bone);
	if (fkJoints) for (const joint of fkJoints.values()) add(joint.bone);
	return bones;
}

function snapshotBones(bones) {
	return bones.map((bone) => ({ position: bone.position.clone(), quaternion: bone.quaternion.clone() }));
}

function restoreBones(rig, bones, snapshot) {
	for (let index = 0; index < bones.length; index += 1) {
		bones[index].position.copy(snapshot[index].position);
		bones[index].quaternion.copy(snapshot[index].quaternion);
	}
	rig.updateMatrixWorld(true);
}

/**
 * Clean a frame RANGE, baking every touched frame into the IK key layer.
 * `applyFrame(frame)` must pose the rig (motion apply + ikEvaluate) before
 * the fix runs — App owns that plumbing, this owns the loop. Only frames
 * that actually changed get a key, so a clean clip stays keyless.
 * Returns the list of keyed frames — empty on a rig the tool cannot
 * describe, which the caller should have screened with
 * supportsCollisionCleanup before offering the button at all.
 *
 * TWO SWEEPS, for the same reason auto-physics needs them. `applyFrame`
 * evaluates the IK layer, so once this loop starts writing keys it is no longer
 * looking at the clip: frame 40 gets posed as clip + the blend ramp of the key
 * written at frame 37, that blend introduces penetrations of its own, and those
 * get keyed too. On the QA clip 4 of 11 keys landed on frames that were CLEAN
 * in the source, and 58 frames finished flagged that started clean — the pass
 * chasing its own tail. Sweep 1 therefore records each frame's pose with
 * nothing of this run's written yet; sweep 2 restores that pose before
 * detecting, so every frame is judged and fixed against the clip.
 *
 * Sweep 1 records TWO poses per frame, and the difference matters:
 *
 *  - the LAYER pose (clip + whatever keys already existed) is what the fix is
 *    applied to, because the user's earlier corrections are part of the pose
 *    they are asking to clean;
 *  - the RAW CLIP pose — sampled with `ikState.tracked` emptied, which makes
 *    the caller's own ikEvaluate a no-op — is what each key's rotations are
 *    stored as a DELTA FROM. It has to be the raw one: ikEvaluate finds the raw
 *    clip on the bone when it comes to apply the key, so only a delta measured
 *    from there collapses back to the authored pose at the keyed frame.
 *
 * With no keys yet the two are identical and the second sample is skipped.
 */
export function fixCollisionsRange({
	rig,
	chains,
	ikState,
	fkJoints = null,
	startFrame,
	endFrame,
	applyFrame,
	...options
} = {}) {
	if (!rig || !chains || !ikState || typeof applyFrame !== "function") return [];
	const start = Math.max(0, Math.round(startFrame));
	const end = Math.max(start, Math.round(endFrame));

	/* --- sweep 1: record the clip as it stands, writing nothing ------------ */
	const bones = layerBones(chains, fkJoints);
	const chainIds = [...chains.keys()];
	const readChainQuats = () => new Map(chainIds.map((id) => [id, chains.get(id).bones.map((b) => b.quaternion.clone())]));
	const layerActive = ikState.tracked.size > 0;
	const basePose = [];
	const clipQuats = [];
	for (let frame = start; frame <= end; frame += 1) {
		if (layerActive) {
			// Silence the layer for one sample: ikEvaluate walks `tracked`, so an
			// empty set makes the caller's applyFrame pure clip. Restored on the
			// same iteration, and never observed by anyone else — this loop owns
			// the rig for its duration.
			const tracked = ikState.tracked;
			ikState.tracked = new Set();
			try {
				applyFrame(frame);
				clipQuats.push(readChainQuats());
			} finally {
				ikState.tracked = tracked;
			}
		}
		applyFrame(frame);
		basePose.push(snapshotBones(bones));
		if (!layerActive) clipQuats.push(readChainQuats());
	}

	/* --- sweep 2: fix each frame against that recorded pose ---------------- */
	const keyed = [];
	for (let frame = start; frame <= end; frame += 1) {
		// applyFrame still runs: it poses the bones outside the IK layer (fingers,
		// toes, spine tips) that the capsules also measure. The restore then
		// overwrites exactly the bones this pass could have moved.
		applyFrame(frame);
		restoreBones(rig, bones, basePose[frame - start]);
		const result = fixCollisions(rig, chains, {
			...options,
			ikState,
			baseQuats: clipQuats[frame - start],
		});
		// An unsupported rig is unsupported at every frame: bail on the first
		// one instead of re-posing the whole clip to learn the same thing.
		if (!result.supported) return keyed;
		if (!result.changed || !result.touched.length) continue;
		// Only the chains THIS frame moved — the pass must not re-key an
		// unrelated limb at the blended value it happens to be showing here —
		// and each one as a delta from the clip's own rotations at this frame.
		ikBakeKeyframe(chains, ikState, frame, fkJoints, result.touched, null, result.baseQuats);
		keyed.push(frame);
	}
	return keyed;
}
