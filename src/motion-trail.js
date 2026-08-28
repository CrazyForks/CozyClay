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

import { CSKEL27_JOINTS } from "./ardy/cskel27.js";

const JOINTS = CSKEL27_JOINTS.length;

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

/**
 * Deform a take by a clip-space delta centred on `grabFrame`: every frame in
 * the falloff window shifts by weight(f) * delta on rootPos AND posedJoints
 * (applyMotionFrame skins from posedJoints; rootPos feeds camera/subject
 * sampling — both must agree or the preview tears). Returns a new motion.
 */
export function applyTrailFalloffDelta(motion, { grabFrame, radiusFrames, clipDelta }) {
	if (!motion?.posedJoints || !motion?.rootPos || !(motion.frames > 0)) return motion;
	const { startFrame, endFrame } = trailEditRange(motion.frames, grabFrame, radiusFrames);
	const rootPos = motion.rootPos.slice();
	const posedJoints = motion.posedJoints.slice();
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
