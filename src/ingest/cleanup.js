/**
 * S6: range-gated, punch-preserving cleanup (plan 8.5, 13 C10).
 *
 * WHY range-gated: a punch is a HIGH-FREQUENCY event. A global smoother
 * attenuates the impact by (1 - centerWeight) of its amplitude -- a 50 mm
 * hand spike loses ~31 mm under the 5-tap pose kernel (the C10 RED) --
 * which is exactly the frame the user cares about. So the filter runs in
 * two bandwidths and every frame whose smoothed deviation from the raw
 * capture exceeds its gate is held EXACT (the range gate): genuine impacts
 * are preserved verbatim while sub-gate capture noise is still reduced.
 *
 * Two bandwidths (the kernels are exported so the design is assertable):
 * the root (rootPos plus the Hips row of posedJoints) drifts at low
 * frequency and gets a 9-tap kernel; the pose joints move at punch
 * frequency and get a 5-tap kernel. Rotations are not positions: a punch's
 * millimetre signature lives in posed_joints, and quaternion filtering is
 * deferred with the Stage-B solvers, so rotMats pass through untouched
 * (which also keeps FK parity trivially intact).
 */
import { CSKEL27_JOINTS } from "../ardy/cskel27.js";

const JOINTS = CSKEL27_JOINTS.length;
const HIPS = CSKEL27_JOINTS.indexOf("Hips");

/** 5-tap binomial pose kernel: light smoothing, punches survive. */
export const POSE_KERNEL = [1, 4, 6, 4, 1].map((w) => w / 16);
/** 9-tap binomial root kernel: heavy smoothing, root drift is low-frequency. */
export const ROOT_KERNEL = [1, 8, 28, 56, 70, 56, 28, 8, 1].map((w) => w / 256);

// Metres: deviations above the gate are held exact, below it are smoothed.
// 8 mm is well above the +-1 mm capture noise the gate must remove and far
// below the multi-centimetre deviation a real punch produces at the spike.
const POSE_GATE_M = 0.008;
const ROOT_GATE_M = 0.006;

function requireMotion(motion) {
	if (!motion || typeof motion !== "object") throw new Error("cleanupMotion: motion must be an object");
	const { frames, fps, rotMats, rootPos, posedJoints } = motion;
	if (!Number.isInteger(frames) || frames < 1) {
		throw new Error(`cleanupMotion: frames must be a positive integer, got ${frames}`);
	}
	if (!Number.isFinite(fps) || fps <= 0) {
		throw new Error(`cleanupMotion: fps must be a positive number, got ${fps}`);
	}
	const expect = (name, len) => {
		const actual = motion[name] instanceof Float32Array ? motion[name].length : typeof motion[name];
		return `cleanupMotion: ${name} must be a Float32Array of ${len} elements, got ${actual}`;
	};
	if (!(rotMats instanceof Float32Array) || rotMats.length !== frames * JOINTS * 9) {
		throw new Error(expect("rotMats", frames * JOINTS * 9));
	}
	if (!(rootPos instanceof Float32Array) || rootPos.length !== frames * 3) {
		throw new Error(expect("rootPos", frames * 3));
	}
	if (!(posedJoints instanceof Float32Array) || posedJoints.length !== frames * JOINTS * 3) {
		throw new Error(expect("posedJoints", frames * JOINTS * 3));
	}
}

/**
 * Filter one component lane (absolute index `lane`, frame stride `stride`)
 * with `kernel`, holding a frame at its raw value when the smoothed value
 * deviates by more than `gate`. At the edges the kernel is truncated and
 * renormalized over the available support.
 */
function filterLane(src, frames, stride, lane, kernel, gate, out) {
	const radius = (kernel.length - 1) / 2;
	for (let f = 0; f < frames; f += 1) {
		const lo = Math.max(0, f - radius);
		const hi = Math.min(frames - 1, f + radius);
		let sum = 0;
		let wsum = 0;
		for (let g = lo; g <= hi; g += 1) {
			const w = kernel[g - (f - radius)];
			sum += w * src[g * stride + lane];
			wsum += w;
		}
		const mean = sum / wsum;
		const raw = src[f * stride + lane];
		out[f * stride + lane] = Math.abs(mean - raw) > gate ? raw : mean;
	}
}

/**
 * Clean `motion` in place of nothing: returns a new motion object with
 * filtered rootPos and posedJoints. rotMats, frames, fps and anchorFrame
 * pass through unchanged.
 */
export function cleanupMotion(motion) {
	requireMotion(motion);
	const { frames, fps, rotMats, rootPos, posedJoints } = motion;
	const outRoot = new Float32Array(frames * 3);
	const outPose = new Float32Array(frames * JOINTS * 3);
	for (let lane = 0; lane < 3; lane += 1) {
		filterLane(rootPos, frames, 3, lane, ROOT_KERNEL, ROOT_GATE_M, outRoot);
	}
	// The Hips row is the root's own track inside posed_joints: same kernel
	// and gate as rootPos, so the two stay coherent under the same drift.
	for (let lane = 0; lane < 3; lane += 1) {
		filterLane(posedJoints, frames, JOINTS * 3, HIPS * 3 + lane, ROOT_KERNEL, ROOT_GATE_M, outPose);
	}
	for (let j = 0; j < JOINTS; j += 1) {
		if (j === HIPS) continue;
		for (let lane = 0; lane < 3; lane += 1) {
			filterLane(posedJoints, frames, JOINTS * 3, j * 3 + lane, POSE_KERNEL, POSE_GATE_M, outPose);
		}
	}
	return { frames, fps, rotMats, rootPos: outRoot, posedJoints: outPose, anchorFrame: motion.anchorFrame };
}
