/**
 * Pose data + pure logic for the pose studio. No React, no three.js imports:
 * object3D trees are consumed structurally (`isBone`, `traverse`, `rotation`),
 * so this module runs anywhere.
 */

/**
 * Ordered list of editable joints. `bone` is the canonical Mixamo name; the
 * matcher also accepts the `mixamorig:`-prefixed FBX spelling and rigs that
 * drop the prefix entirely.
 */
export const POSE_BONES = [
	{ id: "hips", bone: "mixamorigHips", label: "Hips" },
	{ id: "spine", bone: "mixamorigSpine", label: "Spine" },
	{ id: "chest", bone: "mixamorigSpine1", label: "Chest" },
	{ id: "neck", bone: "mixamorigNeck", label: "Neck" },
	{ id: "head", bone: "mixamorigHead", label: "Head" },
	{ id: "lShoulder", bone: "mixamorigLeftShoulder", label: "L Shoulder" },
	{ id: "rShoulder", bone: "mixamorigRightShoulder", label: "R Shoulder" },
	{ id: "lArm", bone: "mixamorigLeftArm", label: "L Upper Arm" },
	{ id: "rArm", bone: "mixamorigRightArm", label: "R Upper Arm" },
	{ id: "lForeArm", bone: "mixamorigLeftForeArm", label: "L Forearm" },
	{ id: "rForeArm", bone: "mixamorigRightForeArm", label: "R Forearm" },
	{ id: "lHand", bone: "mixamorigLeftHand", label: "L Hand" },
	{ id: "rHand", bone: "mixamorigRightHand", label: "R Hand" },
	{ id: "lUpLeg", bone: "mixamorigLeftUpLeg", label: "L Thigh" },
	{ id: "rUpLeg", bone: "mixamorigRightUpLeg", label: "R Thigh" },
	{ id: "lLeg", bone: "mixamorigLeftLeg", label: "L Shin" },
	{ id: "rLeg", bone: "mixamorigRightLeg", label: "R Shin" },
	{ id: "lFoot", bone: "mixamorigLeftFoot", label: "L Foot" },
	{ id: "rFoot", bone: "mixamorigRightFoot", label: "R Foot" },
];

/** Strip every non-alphanumeric character and lowercase, so `mixamorig:LeftArm`,
 * `mixamorigLeftArm` and `LeftArm` all compare equal. */
export function normalizeBoneName(name) {
	return String(name ?? "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

/** A bone matches a joint when the normalised names are equal or one is a
 * suffix of the other (`mixamorigleftarm` vs bare `leftarm`). */
function boneMatches(boneName, entry) {
	const norm = normalizeBoneName(boneName);
	const target = normalizeBoneName(entry.bone);
	return norm === target || norm.endsWith(target) || target.endsWith(norm);
}

/**
 * Built-in pose presets. `bones` maps a POSE_BONES id to an [x, y, z] Euler
 * triple in radians — a rotation delta composed onto the character's rest
 * (bind) pose, so T-pose/rest is all zeros on any rig. Values were tuned
 * against the shipped CozyClay CC0 mannequin skeleton and verified by joint
 * world positions on both shipped rigs.
 */
export const BUILT_IN_POSES = [
	{
		id: "tpose",
		label: "A-pose",
		prompt: "standing in a neutral A-pose",
		bones: {
			hips: [0, 0, 0],
			spine: [0, 0, 0],
			chest: [0, 0, 0],
			neck: [0, 0, 0],
			head: [0, 0, 0],
			lShoulder: [0, 0, 0],
			rShoulder: [0, 0, 0],
			lArm: [0, 0, 0],
			rArm: [0, 0, 0],
			lForeArm: [0, 0, 0],
			rForeArm: [0, 0, 0],
			lHand: [0, 0, 0],
			rHand: [0, 0, 0],
			lUpLeg: [0, 0, 0],
			rUpLeg: [0, 0, 0],
			lLeg: [0, 0, 0],
			rLeg: [0, 0, 0],
			lFoot: [0, 0, 0],
			rFoot: [0, 0, 0],
		},
	},
	{
		id: "relaxed",
		label: "Relaxed",
		prompt: "standing relaxed with arms hanging naturally at their sides",
		bones: {
			lArm: [1.5632, 0.1164, -0.2889],
			rArm: [1.5632, -0.1164, 0.2889],
			lForeArm: [-0.0076, 0.0003, -0.0874],
			rForeArm: [-0.0076, -0.0003, 0.0874],
		},
	},
	{
		id: "contrapposto",
		label: "Contrapposto",
		prompt: "standing in a contrapposto stance with the weight on one leg, hips and shoulders gently counter-rotated",
		bones: {
			hips: [0.04, 0.1542, 0.142],
			spine: [-0.0264, -0.2662, -0.0167],
			chest: [0, -0.12, 0],
			head: [0, -0.08, 0],
			lUpLeg: [0.2, 0, 0],
			lLeg: [-0.3, 0, 0],
			lArm: [1.7229, 0.1824, -0.2563],
			rArm: [1.4178, -0.188, 0.194],
			lForeArm: [0.0181, -0.0008, -0.0858],
			rForeArm: [-0.0214, -0.0009, 0.0851],
		},
	},
	{
		id: "walk",
		label: "Walking",
		prompt: "walking with a mid-stride gait, the right leg forward and the left arm swinging forward",
		bones: {
			spine: [0.0005, -0.079, 0.0128],
			rUpLeg: [0.6191, 0, 0],
			rLeg: [0.3386, 0, 0],
			lUpLeg: [-0.6035, 0, 0],
			lLeg: [-0.1861, 0, 0],
			lArm: [1.3487, -0.2962, -0.727],
			lForeArm: [-0.2903, 0.0931, -0.6172],
			rArm: [1.3728, -0.6284, -0.2942],
			rForeArm: [-0.2523, 0.0965, -0.7273],
		},
	},
	{
		id: "seated",
		label: "Seated",
		prompt: "sitting upright with knees bent at right angles and hands resting near the knees",
		bones: {
			hips: [0.14, 0, 0],
			spine: [-0.08, 0, 0],
			rUpLeg: [1.3515, 0, 0],
			lUpLeg: [1.3515, 0, 0],
			rLeg: [1.5599, 0, 0],
			lLeg: [1.5599, 0, 0],
			rFoot: [-1.3043, 0, 0],
			lFoot: [-1.3044, 0, 0],
			lArm: [1.4894, -0.0842, -0.4769],
			rArm: [1.4894, 0.0843, 0.4768],
			lForeArm: [-0.1208, 0.0256, -0.4174],
			rForeArm: [-0.1208, -0.0256, 0.4174],
		},
	},
	{
		id: "arms-crossed",
		label: "Arms crossed",
		prompt: "standing with arms crossed over the chest",
		bones: {
			rArm: [0.3878, 0.8097, 2.4919],
			rForeArm: [0.713, -0.1597, -0.4234],
			lArm: [0.3878, -0.8097, -2.4919],
			lForeArm: [0.713, 0.1597, 0.4234],
		},
	},
	{
		id: "pointing",
		label: "Pointing",
		prompt: "pointing forward with the right arm extended and the left arm relaxed at the side",
		bones: {
			rArm: [-0.0382, 0.0586, 1.5707],
			lArm: [1.5632, 0.1164, -0.2889],
			lForeArm: [-0.0076, 0.0003, -0.0874],
		},
	},
	{
		id: "hands-on-hips",
		label: "Hands on hips",
		prompt: "standing with both hands resting on the hips",
		bones: {
			rArm: [1.0891, -0.2178, 0.0633],
			rForeArm: [1.249, -0.0715, -0.0992],
			lArm: [1.0891, 0.2178, -0.0633],
			lForeArm: [1.249, 0.0715, 0.0992],
		},
	},
	{
		id: "looking-back",
		label: "Looking back",
		prompt: "standing with the torso twisted and the head turned to look back over the shoulder",
		bones: {
			spine: [0.0084, 0.3157, -0.0529],
			chest: [0, 0.28, 0],
			neck: [0, 0.52, 0],
			head: [0, 0.74, 0],
			lArm: [1.4354, 0.1623, -0.2244],
			rArm: [1.7014, -0.15, 0.2785],
			lForeArm: [-0.0519, 0.0018, -0.0706],
			rForeArm: [0.045, 0.0017, 0.0752],
		},
	},
	{
		id: "hands-up",
		label: "Hands up",
		prompt: "standing with both arms raised straight above the head",
		bones: {
			lArm: [-1.6214, -0.2072, -0.0104],
			rArm: [-1.6214, 0.2072, 0.0104],
		},
	},
	{
		id: "wave",
		label: "Wave",
		category: "gesture",
		prompt: "standing in a friendly wave with the right hand raised beside the head",
		bones: {
			chest: [0, -0.08, 0],
			head: [0, -0.12, 0],
			lArm: [1.5632, 0.1164, -0.2889],
			lForeArm: [-0.0076, 0.0003, -0.0874],
			rArm: [-0.762, 0.118, 0.865],
			rForeArm: [-0.94, -0.12, 0.42],
			rHand: [0.12, 0.2, 0.3],
		},
	},
	{
		id: "thinking",
		label: "Thinking",
		category: "gesture",
		prompt: "standing thoughtfully with one hand near the chin and the other arm relaxed",
		bones: {
			spine: [-0.04, -0.05, 0],
			neck: [0.08, -0.08, 0],
			head: [0.12, -0.12, 0],
			lArm: [1.5632, 0.1164, -0.2889],
			lForeArm: [-0.0076, 0.0003, -0.0874],
			rArm: [0.55, -0.18, 0.48],
			rForeArm: [1.42, -0.18, -0.32],
			rHand: [0.18, -0.1, -0.08],
		},
	},
	{
		id: "crouch",
		label: "Crouch",
		category: "action",
		prompt: "crouching low with knees bent and arms balancing forward",
		bones: {
			hips: [0.34, 0, 0],
			spine: [-0.24, 0, 0],
			chest: [-0.12, 0, 0],
			lUpLeg: [1.02, 0.08, 0.08],
			rUpLeg: [1.02, -0.08, -0.08],
			lLeg: [1.26, 0, 0],
			rLeg: [1.26, 0, 0],
			lFoot: [-0.74, 0, 0],
			rFoot: [-0.74, 0, 0],
			lArm: [0.72, 0.14, -0.54],
			rArm: [0.72, -0.14, 0.54],
			lForeArm: [0.24, 0.02, -0.2],
			rForeArm: [0.24, -0.02, 0.2],
		},
	},
	{
		id: "kneel",
		label: "Kneel",
		category: "floor",
		prompt: "kneeling on one knee with the torso upright and hands relaxed",
		bones: {
			hips: [0.16, 0, -0.04],
			spine: [-0.12, 0, 0.02],
			lUpLeg: [1.12, 0.04, 0.08],
			lLeg: [1.48, 0, 0],
			lFoot: [-1.1, 0, 0],
			rUpLeg: [0.28, -0.04, -0.08],
			rLeg: [1.28, 0, 0],
			rFoot: [-0.62, 0, 0],
			lArm: [1.45, 0.12, -0.28],
			rArm: [1.45, -0.12, 0.28],
			lForeArm: [0.18, 0.02, -0.18],
			rForeArm: [0.18, -0.02, 0.18],
		},
	},
	{
		id: "run",
		label: "Run",
		category: "action",
		prompt: "running in an energetic stride with opposite arm and leg driving forward",
		bones: {
			hips: [0.18, 0, -0.05],
			spine: [-0.22, 0.03, 0.04],
			chest: [-0.12, -0.04, 0],
			rUpLeg: [0.96, 0, 0],
			rLeg: [0.8, 0, 0],
			rFoot: [-0.38, 0, 0],
			lUpLeg: [-0.82, 0, 0],
			lLeg: [-0.52, 0, 0],
			lFoot: [0.24, 0, 0],
			lArm: [0.88, -0.5, -0.76],
			lForeArm: [-0.78, 0.16, -0.44],
			rArm: [1.92, -0.54, 0.36],
			rForeArm: [-0.68, 0.12, 0.62],
		},
	},
	{
		id: "jump",
		label: "Jump",
		category: "action",
		prompt: "jumping upward with both arms lifted and knees slightly tucked",
		bones: {
			hips: [0.08, 0, 0],
			spine: [-0.12, 0, 0],
			chest: [-0.08, 0, 0],
			lArm: [-1.18, -0.18, -0.18],
			rArm: [-1.18, 0.18, 0.18],
			lForeArm: [-0.2, 0.04, -0.08],
			rForeArm: [-0.2, -0.04, 0.08],
			lUpLeg: [0.46, 0.1, 0.12],
			rUpLeg: [0.46, -0.1, -0.12],
			lLeg: [0.78, 0, 0],
			rLeg: [0.78, 0, 0],
			lFoot: [-0.34, 0, 0],
			rFoot: [-0.34, 0, 0],
		},
	},
];
const STORAGE_KEY = "cozyclay_poses";

/* --- quaternion helpers (plain math, no three.js import) ------------------
 * Pose values are Euler triples in radians, in the bone's local frame, applied
 * as a rotation delta on top of the character's rest (bind) pose. That keeps
 * presets rig-independent: "T-pose/rest" is all zeros on any rig, and a pose
 * captured on one character poses the other identically.
 * The Euler <-> quaternion conversions replicate three.js exactly (order XYZ),
 * so values written by three (e.g. a drag handler) round-trip bit-exactly.
 */

/** Fallback per-root cache of every bone's rest-pose quaternion, used when the
 * caller never mounted PoseHandles (which snapshots into `userData.poseBind`
 * at pose-mode entry, before any drag can move a bone). */
const bindByRoot = new WeakMap();

function qFromEuler(x, y, z) {
	const c1 = Math.cos(x / 2);
	const c2 = Math.cos(y / 2);
	const c3 = Math.cos(z / 2);
	const s1 = Math.sin(x / 2);
	const s2 = Math.sin(y / 2);
	const s3 = Math.sin(z / 2);
	return {
		x: s1 * c2 * c3 + c1 * s2 * s3,
		y: c1 * s2 * c3 - s1 * c2 * s3,
		z: c1 * c2 * s3 + s1 * s2 * c3,
		w: c1 * c2 * c3 - s1 * s2 * s3,
	};
}

function qMultiply(a, b) {
	return {
		x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
		y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
		z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
		w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
	};
}

function qInverse(q) {
	return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

function qToEuler(q) {
	const m11 = 1 - 2 * (q.y * q.y + q.z * q.z);
	const m12 = 2 * (q.x * q.y - q.w * q.z);
	const m13 = 2 * (q.x * q.z + q.w * q.y);
	const m22 = 1 - 2 * (q.x * q.x + q.z * q.z);
	const m23 = 2 * (q.y * q.z - q.w * q.x);
	const m32 = 2 * (q.y * q.z + q.w * q.x);
	const m33 = 1 - 2 * (q.x * q.x + q.y * q.y);
	const y = Math.asin(Math.max(-1, Math.min(1, m13)));
	if (Math.abs(m13) < 0.9999999) {
		return [Math.atan2(-m23, m33), y, Math.atan2(-m12, m11)];
	}
	return [Math.atan2(m32, m22), y, 0];
}

/**
 * Snapshot the true bind pose, before anything has been applied to the rig.
 *
 * This MUST run while the rig is still untouched. PoseHandles used to be the
 * only writer, and it mounts long after Character's own effect has already
 * applied the default pose -- so the snapshot baked the default's deltas
 * (~90 degrees on the arms) and called them "rest". Everything downstream that
 * expresses a pose as a delta -- capturePose, savePose, and the ARDY export --
 * then measured against a pose instead of against the bind, and a default
 * character exported arms as identity.
 */
export function primeBindPose(root) {
	if (!root || root.userData?.poseBind) return;
	const map = new Map();
	root.traverse((object) => {
		if (object.isBone) {
			const q = object.quaternion;
			const p = object.position;
			map.set(object, {
				x: q.x,
				y: q.y,
				z: q.z,
				w: q.w,
				position: { x: p.x, y: p.y, z: p.z },
			});
		}
	});
	root.userData.poseBind = map;
}

function bindOf(root) {
	// primeBindPose stamps the untouched rig at clone time; prefer that over any
	// later capture, which would already carry whatever pose is on the rig.
	const primed = root.userData && root.userData.poseBind;
	if (primed) return primed;
	let map = bindByRoot.get(root);
	if (!map) {
		map = new Map();
		root.traverse((object) => {
			if (object.isBone) {
				const q = object.quaternion;
				const p = object.position;
				map.set(object, {
					x: q.x,
					y: q.y,
					z: q.z,
					w: q.w,
					position: { x: p.x, y: p.y, z: p.z },
				});
			}
		});
		bindByRoot.set(root, map);
	}
	return map;
}

/** True when `bone` hangs underneath one of the already-rotated instances.
 * Mixamo FBX exports nest an identity "skinned" copy of every bone under the
 * control bone; writing the control bone moves the whole subtree, so the copy
 * must not be rotated again. */
function isDescendantOf(bone, rotated) {
	for (let p = bone.parent; p; p = p.parent) {
		if (rotated.includes(p)) return true;
	}
	return false;
}

/** Apply a pose to a character root: every bone whose normalised name matches a
 * POSE_BONES entry gets the pose's Euler triple composed onto its rest rotation;
 * unmatched bones stay untouched. Returns how many of the POSE_BONES joints
 * were actually found and written. */
export function applyPose(root, pose) {
	const total = POSE_BONES.length;
	let applied = 0;
	if (root && pose) {
		const binds = bindOf(root);
		const matchesByJoint = new Map();
		root.traverse((object) => {
			if (!object.isBone) return;
			for (const entry of POSE_BONES) {
				if (boneMatches(object.name, entry)) {
					let list = matchesByJoint.get(entry.id);
					if (!list) matchesByJoint.set(entry.id, (list = []));
					list.push(object);
				}
			}
		});
		for (const entry of POSE_BONES) {
			const value = pose[entry.id];
			const list = matchesByJoint.get(entry.id);
			if (!list || !Array.isArray(value) || value.length < 3) continue;
			const delta = qFromEuler(value[0], value[1], value[2]);
			const rotated = [];
			for (const bone of list) {
				if (rotated.length && isDescendantOf(bone, rotated)) continue;
				rotated.push(bone);
				const q = qMultiply(delta, binds.get(bone) ?? binds.get(list[0]) ?? { x: 0, y: 0, z: 0, w: 1 });
				bone.quaternion.set(q.x, q.y, q.z, q.w);
			}
			applied++;
		}
		root.updateMatrixWorld(true);
	}
	return { applied, total };
}

/** Read the current rotation of every POSE_BONES joint back into the same
 * `{ id: [x, y, z] }` delta shape `applyPose` consumes. */
export function capturePose(root) {
	const pose = {};
	if (root) {
		const binds = bindOf(root);
		const captured = new Map();
		root.traverse((object) => {
			if (!object.isBone) return;
			for (const entry of POSE_BONES) {
				if (!captured.has(entry.id) && boneMatches(object.name, entry)) {
					captured.set(entry.id, object);
					break;
				}
			}
		});
		for (const entry of POSE_BONES) {
			const bone = captured.get(entry.id);
			if (bone) {
				const q = bone.quaternion;
				const bind = binds.get(bone);
				const delta = bind ? qMultiply({ x: q.x, y: q.y, z: q.z, w: q.w }, qInverse(bind)) : { x: q.x, y: q.y, z: q.z, w: q.w };
				pose[entry.id] = qToEuler(delta);
			}
		}
	}
	return pose;
}

export function loadCustomPoses() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(p) => p && typeof p === "object" && typeof p.id === "string" && p.bones && typeof p.bones === "object"
		);
	} catch {
		// Private mode / quota errors degrade to an empty list.
		return [];
	}
}

export function saveCustomPoses(list) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
		return true;
	} catch {
		return false;
	}
}

export function deleteCustomPose(id, list) {
	const next = list.filter((p) => p.id !== id);
	saveCustomPoses(next);
	return next;
}
