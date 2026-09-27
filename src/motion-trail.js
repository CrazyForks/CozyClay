/**
 * Motion trail math for the IK-mode 3D trajectory line editor.
 *
 * A "trail" is the world-space polyline of one clip-space track (the root, or
 * one effector joint) across every frame of the loaded take. The clip-to-world
 * mapping mirrors sample-at.js rootAt(): frame positions are re-based on the
 * anchor frame's root, rotated by the take's clip-to-scene yaw, and offset by
 * the scene anchor. All functions are pure: deformations return NEW motion
 * objects with cloned arrays and never touch the caller's take.
 */

import { CSKEL27_JOINTS, CSKEL27_PARENTS } from "./ardy/cskel27.js";

const JOINTS = CSKEL27_JOINTS.length;
const jointIndex = (name) => CSKEL27_JOINTS.indexOf(name);

/** Limb trail track -> two-bone chain [root, mid, effector] its drag bends. */
const LIMB_CHAINS = {
	leftHand: ["LeftArm", "LeftForeArm", "LeftHand"],
	rightHand: ["RightArm", "RightForeArm", "RightHand"],
	leftFoot: ["LeftUpLeg", "LeftLeg", "LeftFoot"],
	rightFoot: ["RightUpLeg", "RightLeg", "RightFoot"],
};

/**
 * The always-drawn trail tracks: root plus every IK chain endpoint and the
 * head, coloured exactly like their viewport IK/FK handles (posestudio.jsx
 * coding: arms orange, legs blue, torso yellow, head purple). Pick order is
 * limbs-first so an overlapping grab prefers the finer target; hips last.
 */
export const TRAIL_TRACKS = [
	{ id: "leftHand", joint: "LeftHand", color: "#ff8a3d" },
	{ id: "rightHand", joint: "RightHand", color: "#ff8a3d" },
	{ id: "leftFoot", joint: "LeftFoot", color: "#4dd2ff" },
	{ id: "rightFoot", joint: "RightFoot", color: "#4dd2ff" },
	{ id: "head", joint: "Head", color: "#b98cff" },
	{ id: "hips", joint: "Hips", color: "#ffd23d" },
];

/** ikFocus token -> cskel27 joint whose posed position draws the effector trail. */
export const TRAIL_EFFECTOR_JOINTS = {
	hips: "Hips",
	spine: "Spine1",
	chest: "Spine2",
	neck: "Neck",
	head: "Head",
	leftShoulder: "LeftArm",
	leftElbow: "LeftForeArm",
	leftHand: "LeftHand",
	rightShoulder: "RightArm",
	rightElbow: "RightForeArm",
	rightHand: "RightHand",
	leftKnee: "LeftLeg",
	leftFoot: "LeftFoot",
	rightKnee: "RightLeg",
	rightFoot: "RightFoot",
};

function anchorBasis(motion) {
	const frames = motion?.frames ?? 0;
	const anchorFrame = Math.max(0, Math.min(motion?.anchorFrame || 0, Math.max(0, frames - 1)));
	const radians = (((Number.isFinite(motion?.rotationDeg) ? motion.rotationDeg : 0) * Math.PI) / 180);
	return {
		anchorFrame,
		cos: Math.cos(radians),
		sin: Math.sin(radians),
		anchorX: Number.isFinite(motion?.anchorX) ? motion.anchorX : 0,
		anchorZ: Number.isFinite(motion?.anchorZ) ? motion.anchorZ : 0,
		// The anchor frame's ROOT joint pins the clip to the scene anchor —
		// the same re-basing applyMotionFrame and rootAt use.
		rootX: motion?.posedJoints?.[(anchorFrame * JOINTS) * 3] ?? motion?.rootPos?.[anchorFrame * 3] ?? 0,
		rootZ: motion?.posedJoints?.[(anchorFrame * JOINTS) * 3 + 2] ?? motion?.rootPos?.[anchorFrame * 3 + 2] ?? 0,
	};
}

/** Clip-space (x, z) of one frame of one track -> world (x, z). */
function toWorldXZ(basis, x, z) {
	const dx = x - basis.rootX;
	const dz = z - basis.rootZ;
	return [
		basis.anchorX + dx * basis.cos + dz * basis.sin,
		basis.anchorZ + -dx * basis.sin + dz * basis.cos,
	];
}

/**
 * World-space polyline of one cskel27 joint's posed position across the take.
 * Returns a flat [x0,y0,z0, x1,y1,z1, ...] array of length frames*3.
 * `baseY` is the character entry's stage height (roof scenes ride above 0).
 */
export function jointTrailPoints(motion, jointName = "Hips", { baseY = 0, scale = 1 } = {}) {
	if (!motion?.posedJoints || !(motion.frames > 0)) return null;
	const joint = CSKEL27_JOINTS.indexOf(jointName);
	if (joint < 0) return null;
	const basis = anchorBasis(motion);
	const out = new Float32Array(motion.frames * 3);
	for (let f = 0; f < motion.frames; f += 1) {
		const po = (f * JOINTS + joint) * 3;
		const [wx, wz] = toWorldXZ(basis, motion.posedJoints[po], motion.posedJoints[po + 2]);
		out[f * 3] = basis.anchorX + (wx - basis.anchorX) * scale;
		out[f * 3 + 1] = baseY + motion.posedJoints[po + 1] * scale;
		out[f * 3 + 2] = basis.anchorZ + (wz - basis.anchorZ) * scale;
	}
	return out;
}

/**
 * A world-space POINT -> the take's own clip space — the exact inverse of what
 * jointTrailPoints does on the way out.
 *
 * WHY THIS EXISTS, and why it is not worldDeltaToClip. That one inverts the yaw
 * only, which is all a DELTA needs: rebasing and the anchor offset cancel in a
 * difference, and scale is applied by the caller. An absolute point has to undo
 * the whole chain — scale about the anchor, the yaw, the anchor offset, the
 * anchor frame's root rebase and baseY — because it is going to be compared
 * against `posed_joints` in an npz, which knows nothing about where the
 * character was placed on the stage.
 *
 * That is the pins3d contract in one sentence: a pin is authored where the
 * artist can see it (the viewport) and shipped in the space the take is stored
 * in, and THIS is the only conversion between the two. Read
 * `jointTrailPoints` beside it — every line here undoes one line there, in
 * reverse order.
 *
 * @param {object} motion  the loaded take (frames, posedJoints, rotationDeg,
 *   anchorX/Z, anchorFrame) — the same object jointTrailPoints takes.
 * @param {{x:number,y:number,z:number}} point  world metres.
 * @param {{baseY?:number, scale?:number}} [placement]  the character entry's
 *   stage height and scale, exactly as passed to jointTrailPoints.
 * @returns {{x:number,y:number,z:number}} clip space, comparable to posedJoints.
 */
export function worldPointToClip(motion, point, { baseY = 0, scale = 1 } = {}) {
	const basis = anchorBasis(motion);
	// A zero or negative scale would make the mapping non-invertible; the
	// character UI cannot produce one, and refusing to divide by it beats
	// returning an infinity that lands in a wire payload.
	const s = Number.isFinite(scale) && Math.abs(scale) > 1e-9 ? scale : 1;
	// 1. undo the scale-about-the-anchor and the anchor offset -> rotated clip
	const rx = (point.x - basis.anchorX) / s;
	const rz = (point.z - basis.anchorZ) / s;
	// 2. undo the yaw (toWorldXZ applies [cos, sin; -sin, cos])
	const dx = rx * basis.cos - rz * basis.sin;
	const dz = rx * basis.sin + rz * basis.cos;
	// 3. undo the anchor-frame root rebase
	return {
		x: basis.rootX + dx,
		y: (point.y - baseY) / s,
		z: basis.rootZ + dz,
	};
}

/** World-space drag delta -> clip-space delta (inverse of the trail yaw). */
export function worldDeltaToClip(motion, delta) {
	const basis = anchorBasis(motion);
	const { cos, sin } = basis;
	// Inverse of [x' = dx*cos + dz*sin; z' = -dx*sin + dz*cos].
	return {
		x: delta.x * cos - delta.z * sin,
		y: delta.y,
		z: delta.x * sin + delta.z * cos,
	};
}

/** Smoothstep falloff: 1 at the grab frame, 0 at/beyond the radius. */
export function falloffWeight(distanceFrames, radiusFrames) {
	if (!(radiusFrames > 0)) return distanceFrames === 0 ? 1 : 0;
	const t = Math.min(1, Math.abs(distanceFrames) / radiusFrames);
	const s = 1 - t;
	return s * s * (3 - 2 * s);
}

/** The frames a grab at `grabFrame` with `radiusFrames` falloff can move. */
export function trailEditRange(frameCount, grabFrame, radiusFrames) {
	const last = Math.max(0, frameCount - 1);
	const grab = Math.max(0, Math.min(last, Math.round(grabFrame) || 0));
	const radius = Math.max(0, Math.round(radiusFrames) || 0);
	return {
		startFrame: Math.max(0, grab - radius),
		// endFrame is EXCLUSIVE, matching motionEdit's start..end contract.
		endFrame: Math.min(frameCount, grab + radius + 1),
	};
}

/* --- small vector / row-major 3x3 helpers for the limb and head solves --- */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
function unit(a) {
	const l = len(a);
	return l > 1e-9 ? scale3(a, 1 / l) : null;
}
function matMul(a, b) {
	const out = new Array(9);
	for (let r = 0; r < 3; r += 1) {
		for (let c = 0; c < 3; c += 1) {
			out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
		}
	}
	return out;
}
const matT = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const matVec = (m, v) => [
	m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
	m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
	m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
/** Rotation taking orthonormal frame (u, n, u x n) onto (u2, n2, u2 x n2). */
function frameRotation(u, n, u2, n2) {
	const w = cross(u, n);
	const w2 = cross(u2, n2);
	const from = [u[0], n[0], w[0], u[1], n[1], w[1], u[2], n[2], w[2]];
	const to = [u2[0], n2[0], w2[0], u2[1], n2[1], w2[1], u2[2], n2[2], w2[2]];
	return matMul(to, matT(from));
}
/** Shortest-arc rotation taking unit `a` onto unit `b` (Rodrigues). */
function arcRotation(a, b) {
	const c = dot(a, b);
	if (c < -1 + 1e-9) {
		const axis = unit(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
		const [x, y, z] = axis;
		return [2 * x * x - 1, 2 * x * y, 2 * x * z, 2 * x * y, 2 * y * y - 1, 2 * y * z, 2 * x * z, 2 * y * z, 2 * z * z - 1];
	}
	const [x, y, z] = cross(a, b);
	const k = 1 / (1 + c);
	return [
		1 - k * (y * y + z * z), -z + k * x * y, y + k * x * z,
		z + k * x * y, 1 - k * (x * x + z * z), -x + k * y * z,
		-y + k * x * z, x + k * y * z, 1 - k * (x * x + y * y),
	];
}

/** Joint `root` and everything below it in the cskel27 tree. */
function subtreeOf(root) {
	return CSKEL27_JOINTS.map((_, j) => j).filter((j) => {
		for (let k = j; k !== null; k = CSKEL27_PARENTS[k]) if (k === root) return true;
		return false;
	});
}

/** Per-frame accessors over a take's flat posedJoints / rotMats (locals). */
function frameAccess(posedJoints, rotMats, f) {
	const globals = new Map();
	const local = (j) => Array.from(rotMats.subarray((f * JOINTS + j) * 9, (f * JOINTS + j) * 9 + 9));
	const global = (j) => {
		if (!globals.has(j)) {
			const parent = CSKEL27_PARENTS[j];
			globals.set(j, parent === null ? local(j) : matMul(global(parent), local(j)));
		}
		return globals.get(j);
	};
	return {
		pos: (j) => {
			const po = (f * JOINTS + j) * 3;
			return [posedJoints[po], posedJoints[po + 1], posedJoints[po + 2]];
		},
		setPos: (j, p) => posedJoints.set(p, (f * JOINTS + j) * 3),
		global,
		/** Write joint j's LOCAL rotation so its global becomes `g` (parent untouched). */
		setGlobal: (j, g, parentGlobal = CSKEL27_PARENTS[j] === null ? null : global(CSKEL27_PARENTS[j])) => {
			rotMats.set(parentGlobal ? matMul(matT(parentGlobal), g) : g, (f * JOINTS + j) * 9);
		},
	};
}

/**
 * Two-bone limb solve for one frame: the effector moves by `offset` (clamped to
 * the chain's reach), the root joint stays put, the mid joint is re-placed on
 * the old elbow/knee side with both segment lengths kept, and the effector's
 * descendants translate with it. rotMats (when present) are rewritten so the
 * root and mid globals swing onto the new segments and the effector keeps its
 * global orientation: FK over the new locals reproduces the new positions,
 * which matters because playback drives the arm chain from rotations only.
 */
function bendLimbFrame(access, [a, b, c], descendants, offset) {
	const A = access.pos(a);
	const B = access.pos(b);
	const C = access.pos(c);
	const l1 = len(sub(B, A));
	const l2 = len(sub(C, B));
	const toTarget = sub(add(C, offset), A);
	const dir = unit(toTarget) ?? unit(sub(C, A));
	if (!dir) return;
	const d = Math.min(l1 + l2, Math.max(Math.abs(l1 - l2), len(toTarget)));
	if (!(d > 1e-9)) return;
	const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
	const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
	// Pole = the old mid joint off the new reach line, so the bend keeps its side.
	const AB = sub(B, A);
	const oldNormal = unit(cross(AB, sub(C, A)));
	const pole = unit(sub(AB, scale3(dir, dot(AB, dir))))
		?? (oldNormal && unit(cross(oldNormal, dir)))
		?? unit(cross(dir, Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
	const B2 = add(A, add(scale3(dir, along), scale3(pole, h)));
	const C2 = add(A, scale3(dir, d));
	const move = sub(C2, C);
	for (const j of descendants) access.setPos(j, add(access.pos(j), move));
	access.setPos(b, B2);
	if (!access.rotMats) return;
	// Both segments swing with the bend plane (normal -> pole x dir), so the
	// mid joint's local change is a pure hinge about the plane normal.
	const newNormal = unit(cross(pole, dir));
	const swing = (from, to) => {
		const u = unit(from);
		const u2 = unit(to);
		return oldNormal ? frameRotation(u, oldNormal, u2, newNormal) : arcRotation(u, u2);
	};
	const ga = matMul(swing(AB, sub(B2, A)), access.global(a));
	const gb = matMul(swing(sub(C, B), sub(C2, B2)), access.global(b));
	const gc = access.global(c);
	access.setGlobal(a, ga);
	access.setGlobal(b, gb, ga);
	access.setGlobal(c, gc, gb);
}

/** Head drag for one frame: swing Neck->Head about the neck toward the target. */
function swingHeadFrame(access, neck, head, subtree, offset) {
	const N = access.pos(neck);
	const H = access.pos(head);
	const from = unit(sub(H, N));
	const to = unit(sub(add(H, offset), N));
	if (!from || !to) return;
	const q = arcRotation(from, to);
	for (const j of subtree) access.setPos(j, add(N, matVec(q, sub(access.pos(j), N))));
	if (access.rotMats) access.setGlobal(neck, matMul(q, access.global(neck)));
}

/**
 * Deform a take by a clip-space delta centred on `grabFrame`, weighted per
 * frame by the smoothstep falloff. `track` is the dragged TRAIL_TRACKS id:
 *   - "hips" (default): the whole body shifts by weight(f) * delta on rootPos
 *     AND posedJoints (applyMotionFrame skins from posedJoints; rootPos feeds
 *     camera/subject sampling — both must agree or the preview tears).
 *   - a hand/foot: only that limb bends (bendLimbFrame).
 *   - "head": only the head swings about the neck (swingHeadFrame).
 * Limb and head edits rewrite rotMats too, since playback reads rotations.
 * Returns a new motion; the caller's arrays are never written.
 */
export function applyTrailFalloffDelta(motion, { track = "hips", grabFrame, radiusFrames, clipDelta }) {
	if (!motion?.posedJoints || !motion?.rootPos || !(motion.frames > 0)) return motion;
	const { startFrame, endFrame } = trailEditRange(motion.frames, grabFrame, radiusFrames);
	const rootPos = motion.rootPos.slice();
	const posedJoints = motion.posedJoints.slice();
	const chain = LIMB_CHAINS[track]?.map(jointIndex);
	if (chain || track === "head") {
		const rotMats = motion.rotMats ? motion.rotMats.slice() : null;
		const neck = jointIndex("Neck");
		const head = jointIndex("Head");
		const moved = subtreeOf(chain ? chain[2] : head).filter((j) => !chain || j !== chain[2]);
		for (let f = startFrame; f < endFrame; f += 1) {
			const w = falloffWeight(f - grabFrame, radiusFrames);
			if (w <= 0) continue;
			const access = { ...frameAccess(posedJoints, rotMats, f), rotMats };
			const offset = [clipDelta.x * w, clipDelta.y * w, clipDelta.z * w];
			if (chain) bendLimbFrame(access, chain, [chain[2], ...moved], offset);
			else swingHeadFrame(access, neck, head, moved, offset);
		}
		return rotMats ? { ...motion, rootPos, posedJoints, rotMats } : { ...motion, rootPos, posedJoints };
	}
	for (let f = startFrame; f < endFrame; f += 1) {
		const w = falloffWeight(f - grabFrame, radiusFrames);
		if (w <= 0) continue;
		const dx = clipDelta.x * w;
		const dy = clipDelta.y * w;
		const dz = clipDelta.z * w;
		rootPos[f * 3] += dx;
		rootPos[f * 3 + 1] += dy;
		rootPos[f * 3 + 2] += dz;
		for (let j = 0; j < JOINTS; j += 1) {
			const po = (f * JOINTS + j) * 3;
			posedJoints[po] += dx;
			posedJoints[po + 1] += dy;
			posedJoints[po + 2] += dz;
		}
	}
	return { ...motion, rootPos, posedJoints };
}

/**
 * Nearest trail frame to a pointer RAY (for grab picking without any
 * per-pointermove scene raycasting). Returns { frame, distance } of the
 * closest point, or null when nothing lies within `maxDistance` metres.
 */
export function nearestFrameToRay(points, origin, direction, maxDistance = 0.25) {
	if (!points || points.length < 3) return null;
	const len = Math.hypot(direction.x, direction.y, direction.z) || 1;
	const dx = direction.x / len;
	const dy = direction.y / len;
	const dz = direction.z / len;
	let best = null;
	for (let f = 0; f * 3 < points.length; f += 1) {
		const px = points[f * 3] - origin.x;
		const py = points[f * 3 + 1] - origin.y;
		const pz = points[f * 3 + 2] - origin.z;
		const t = px * dx + py * dy + pz * dz;
		if (t < 0) continue; // behind the camera
		const ox = px - t * dx;
		const oy = py - t * dy;
		const oz = pz - t * dz;
		const distance = Math.hypot(ox, oy, oz);
		if (distance <= maxDistance && (!best || distance < best.distance)) {
			best = { frame: f, distance };
		}
	}
	return best;
}

/** Nearest trail frame to a world-space point (for grab picking). */
export function nearestTrailFrame(points, world) {
	if (!points || points.length < 3) return 0;
	let best = 0;
	let bestD = Infinity;
	for (let f = 0; f * 3 < points.length; f += 1) {
		const dx = points[f * 3] - world.x;
		const dy = points[f * 3 + 1] - world.y;
		const dz = points[f * 3 + 2] - world.z;
		const d = dx * dx + dy * dy + dz * dz;
		if (d < bestD) {
			bestD = d;
			best = f;
		}
	}
	return best;
}
