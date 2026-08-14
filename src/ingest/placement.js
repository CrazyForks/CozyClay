/**
 * S8: place the second actor (plan 8.5, 13 C11, 17 A6/A7).
 *
 * charB = s * rot(yaw) * (rootB[anchor] - rootA[anchor])
 *
 * ONE shared scale factor s (rig units per ARDY metre) and ONE shared world
 * origin: the offset between the two root tracks is measured in the shared
 * world frame and Y stays 0 (both fighters stand on the same floor). There
 * is NO per-person scale and NO per-person root normalization -- a
 * per-character scale or per-character root offset moves the contact by
 * ~0.1 m for a 1.90 m vs 1.72 m pair (the C11 RED), which breaks the
 * contact gate (Q1/A1) that placement exists to serve.
 *
 * The reference oracle for this formula is inlined in
 * test/ingest/verify-contact-preservation.mjs (A6/A7); the acceptance is
 * agreement with it to 1e-6. The oracle reads the anchor frame's Hips row
 * of posedJoints (XZ only; yaw 0 in the gate), so this module reads the
 * same row -- Hips IS the root joint, and the npz's root_positions hold
 * the same numbers. In Stage A the pipeline passes yawDeg = 0 (TakePayload
 * asserts a.rotationDeg === b.rotationDeg === 0, plan 5).
 *
 * The returned vector is in rig units (0.01 * s * metres), the convention
 * the app's rig.position expects (plan 17: rigB.position.set(s * 1.5, 0, 0)
 * with the 0.01 rig scale applied by loadRig).
 */
import { CSKEL27_JOINTS } from "../ardy/cskel27.js";

const JOINTS = CSKEL27_JOINTS.length;
const HIPS = CSKEL27_JOINTS.indexOf("Hips");

/**
 * World offset that places motionB's anchor root onto motionA's anchor
 * root, scaled by the shared `scale`: [0.01*s*rotXZ(yaw)*(rootB-rootA), 0].
 */
export function placeSecondActor(scale, motionA, motionB, anchorFrame = 0, yawDeg = 0) {
	if (!Number.isFinite(scale)) throw new Error(`placeSecondActor: scale must be finite, got ${scale}`);
	if (!Number.isInteger(anchorFrame) || anchorFrame < 0) {
		throw new Error(`placeSecondActor: anchorFrame must be a non-negative integer, got ${anchorFrame}`);
	}
	if (!Number.isFinite(yawDeg)) throw new Error(`placeSecondActor: yawDeg must be finite, got ${yawDeg}`);
	const o = (anchorFrame * JOINTS + HIPS) * 3;
	const end = o + 3;
	for (const [label, motion] of [["motionA", motionA], ["motionB", motionB]]) {
		if (!motion || !(motion.posedJoints instanceof Float32Array) || motion.posedJoints.length < end) {
			throw new Error(
				`placeSecondActor: ${label}.posedJoints must cover the anchor frame's Hips row (need ${end} elements, got ${motion?.posedJoints?.length ?? typeof motion?.posedJoints})`,
			);
		}
	}
	const dx = motionB.posedJoints[o] - motionA.posedJoints[o];
	const dz = motionB.posedJoints[o + 2] - motionA.posedJoints[o + 2];
	const yaw = (yawDeg * Math.PI) / 180;
	const c = Math.cos(yaw);
	const s = Math.sin(yaw);
	// yaw 0 must reduce to the oracle bit-for-bit: cos(0) = 1 and sin(0) = 0
	// exactly, so the rotXZ terms collapse to dx / dz without float dust.
	return [
		0.01 * scale * (c * dx + s * dz),
		0,
		0.01 * scale * (-s * dx + c * dz),
	];
}
