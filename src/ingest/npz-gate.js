/**
 * S7: the npz gate (plan 5, 13 C12, 14.1 phase 2).
 *
 * The pipeline's npz must pass the app's REAL decodeMotionNpz
 * (src/ardy/npz.js): local_rot_mats (F,27,3,3), root_positions (F,3), fps,
 * posed_joints (F,27,3), 20 fps, Y-up right-handed metres. decodeMotionNpz
 * itself rejects a wrong rig -- the C12 RED is its own error
 * ("local_rot_mats must have shape (F, 27, 3, 3), got (124, 24, 3, 3)") --
 * but by then a wrong-rig clip has already been shipped, serialized and
 * paid for. This gate runs at the pipeline's own door, BEFORE emission,
 * and rejects by member NAME with the cskel27 joint count in the message,
 * so a 24-joint SMPL-shaped array never leaves the pipeline.
 *
 * Emission itself uses the plan-mandated writer (tools/ardy/npz.mjs, which
 * is node-side); this module validates only, so it stays browser-safe for
 * the child realm -- the parent writes artifact files (plan 12.3: artifact
 * fields are paths, not URLs).
 */
import { CSKEL27_JOINTS } from "../ardy/cskel27.js";

const JOINTS = CSKEL27_JOINTS.length;
const TARGET_FPS = 20; // S5 resamples to 20 fps and TakePayload asserts it (plan 5)

/**
 * Validate a cskel27 motion against the npz contract. Returns the motion
 * unchanged when it is emittable; throws a member-NAMING error otherwise.
 */
export function gateMotionNpz(motion) {
	if (!motion || typeof motion !== "object") throw new Error("npz gate: motion must be an object");
	const { frames, fps, rotMats, rootPos, posedJoints } = motion;
	if (!Number.isInteger(frames) || frames < 1) {
		throw new Error(`npz gate: frames must be a positive integer, got ${frames}`);
	}
	if (fps !== TARGET_FPS) {
		throw new Error(`npz gate: fps must be ${TARGET_FPS} (the pipeline output rate), got ${fps}`);
	}
	if (!(rotMats instanceof Float32Array) || rotMats.length % (frames * 9) !== 0) {
		throw new Error(
			`npz gate: local_rot_mats must be a Float32Array whose length is frames*27*9 (${frames * JOINTS * 9}), got ${rotMats instanceof Float32Array ? rotMats.length : typeof rotMats}`,
		);
	}
	const joints = rotMats.length / (frames * 9);
	if (joints !== JOINTS) {
		throw new Error(
			`npz gate: local_rot_mats has shape (${frames}, ${joints}, 3, 3), expected (F, ${JOINTS}, 3, 3)`,
		);
	}
	if (!(rootPos instanceof Float32Array) || rootPos.length !== frames * 3) {
		throw new Error(
			`npz gate: root_positions must have shape (F, 3) -- ${frames * 3} elements, got ${rootPos instanceof Float32Array ? rootPos.length : typeof rootPos}`,
		);
	}
	if (!(posedJoints instanceof Float32Array) || posedJoints.length !== frames * JOINTS * 3) {
		throw new Error(
			`npz gate: posed_joints must have shape (F, ${JOINTS}, 3) -- ${frames * JOINTS * 3} elements, got ${posedJoints instanceof Float32Array ? posedJoints.length : typeof posedJoints}`,
		);
	}
	// decodeMotionNpz would reject a non-finite value; the gate must reject
	// it first so the failure is the pipeline's, not the app's.
	for (const [name, array] of [["local_rot_mats", rotMats], ["root_positions", rootPos], ["posed_joints", posedJoints]]) {
		for (let i = 0; i < array.length; i += 1) {
			if (!Number.isFinite(array[i])) {
				throw new Error(`npz gate: ${name}[${i}] is not finite: ${array[i]}`);
			}
		}
	}
	return motion;
}
