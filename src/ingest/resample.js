/**
 * S5: resample a cskel27 motion to the pipeline's 20 fps output rate
 * (plan 8.5, 13 C9).
 *
 * WHY slerp: rotations live on SO(3). Linearly interpolating the 3x3
 * matrices cuts the chord, so at a 170 deg separation the naive lerp
 * midpoint is 4.6 deg off the true slerp midpoint (the C9 RED) -- and the
 * npz gate's decodeMotionNpz would reject the result as a non-proper
 * rotation. Rotations are therefore slerped as quaternions (short way,
 * sign-flipped when the dot product is negative); positions live in
 * Euclidean space and are lerped.
 *
 * The quaternion math reuses src/ardy/convert.js (matToQuat/quatToMat),
 * the JS twin of the ARDY reference implementation, so this module and the
 * Python repo cannot drift apart.
 *
 * The output frame count is floor((frames-1) * targetFps / fps) + 1: the
 * last output sample never lands past the last input sample (no
 * extrapolation). Output frames that coincide with an input frame (alpha
 * exactly 0 or 1) are copied verbatim, so a resample is a no-op wherever
 * no interpolation is needed.
 */
import { CSKEL27_JOINTS } from "../ardy/cskel27.js";
import { matToQuat, quatToMat } from "../ardy/convert.js";

const JOINTS = CSKEL27_JOINTS.length;

function requireMotion(motion, caller) {
	if (!motion || typeof motion !== "object") throw new Error(`${caller}: motion must be an object`);
	const { frames, fps, rotMats, rootPos, posedJoints } = motion;
	if (!Number.isInteger(frames) || frames < 1) {
		throw new Error(`${caller}: frames must be a positive integer, got ${frames}`);
	}
	if (!Number.isFinite(fps) || fps <= 0) {
		throw new Error(`${caller}: fps must be a positive number, got ${fps}`);
	}
	const expect = (name, len) => {
		const actual = motion[name] instanceof Float32Array ? motion[name].length : typeof motion[name];
		return `${caller}: ${name} must be a Float32Array of ${len} elements, got ${actual}`;
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

/** Unit [w, x, y, z] quaternion slerp at fraction t (short way around). */
function slerpQuat(a, b, t) {
	let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
	// q and -q are the same rotation: flip b so the arc is the short way.
	// Without this, a 170 deg separation (dot < 0 after a representation
	// sign flip) would take the long way around the sphere.
	let bx = b[1];
	let by = b[2];
	let bz = b[3];
	let bw = b[0];
	if (dot < 0) {
		dot = -dot;
		bx = -bx;
		by = -by;
		bz = -bz;
		bw = -bw;
	}
	if (dot > 0.9995) {
		// Nearly parallel: slerp's sin(theta) degenerates, so fall back to
		// nlerp; the chord-vs-arc error is far below the 0.1 deg budget.
		const w = 1 - t;
		const n = Math.hypot(w * a[0] + t * bw, w * a[1] + t * bx, w * a[2] + t * by, w * a[3] + t * bz);
		return [(w * a[0] + t * bw) / n, (w * a[1] + t * bx) / n, (w * a[2] + t * by) / n, (w * a[3] + t * bz) / n];
	}
	const theta = Math.acos(dot);
	const sinTheta = Math.sin(theta);
	const wa = Math.sin((1 - t) * theta) / sinTheta;
	const wb = Math.sin(t * theta) / sinTheta;
	return [wa * a[0] + wb * bw, wa * a[1] + wb * bx, wa * a[2] + wb * by, wa * a[3] + wb * bz];
}

/**
 * Resample `motion` from its own fps to `targetFps` (default: the pipeline
 * output rate, 20 fps). Returns a new motion object of the same shape;
 * `anchorFrame`, when present, is remapped to the new timebase.
 */
export function resampleMotion(motion, targetFps = 20) {
	requireMotion(motion, "resampleMotion");
	if (!Number.isFinite(targetFps) || targetFps <= 0) {
		throw new Error(`resampleMotion: targetFps must be a positive number, got ${targetFps}`);
	}
	const { frames, fps, rotMats, rootPos, posedJoints } = motion;
	const outFrames = Math.floor(((frames - 1) * targetFps) / fps) + 1;
	const outRot = new Float32Array(outFrames * JOINTS * 9);
	const outRoot = new Float32Array(outFrames * 3);
	const outPose = new Float32Array(outFrames * JOINTS * 3);

	// Precompute the input rotations as quaternions once: every output frame
	// needs at most two of them, and the matrix->quaternion conversion is the
	// same work whichever frame asks for it.
	const quats = new Float64Array(frames * JOINTS * 4);
	for (let f = 0; f < frames; f += 1) {
		const base = f * JOINTS * 9;
		for (let j = 0; j < JOINTS; j += 1) {
			const o = base + j * 9;
			const q = matToQuat([
				[rotMats[o], rotMats[o + 1], rotMats[o + 2]],
				[rotMats[o + 3], rotMats[o + 4], rotMats[o + 5]],
				[rotMats[o + 6], rotMats[o + 7], rotMats[o + 8]],
			]);
			quats[(f * JOINTS + j) * 4] = q[0];
			quats[(f * JOINTS + j) * 4 + 1] = q[1];
			quats[(f * JOINTS + j) * 4 + 2] = q[2];
			quats[(f * JOINTS + j) * 4 + 3] = q[3];
		}
	}

	// Output frame k sits at input-frame time k * fps / targetFps.
	const step = fps / targetFps;
	const copyFrame = (k, i) => {
		outRot.set(rotMats.subarray(i * JOINTS * 9, (i + 1) * JOINTS * 9), k * JOINTS * 9);
		outRoot.set(rootPos.subarray(i * 3, (i + 1) * 3), k * 3);
		outPose.set(posedJoints.subarray(i * JOINTS * 3, (i + 1) * JOINTS * 3), k * JOINTS * 3);
	};
	const lerpFrame = (k, i, a) => {
		const ib = i + 1;
		for (let j = 0; j < JOINTS; j += 1) {
			const qa = (i * JOINTS + j) * 4;
			const qb = (ib * JOINTS + j) * 4;
			const q = slerpQuat(
				[quats[qa], quats[qa + 1], quats[qa + 2], quats[qa + 3]],
				[quats[qb], quats[qb + 1], quats[qb + 2], quats[qb + 3]],
				a,
			);
			const m = quatToMat(q);
			const o = (k * JOINTS + j) * 9;
			for (let r = 0; r < 3; r += 1) {
				for (let c = 0; c < 3; c += 1) outRot[o + r * 3 + c] = m[r][c];
			}
		}
		for (let c = 0; c < 3; c += 1) {
			outRoot[k * 3 + c] = rootPos[i * 3 + c] * (1 - a) + rootPos[ib * 3 + c] * a;
			for (let j = 0; j < JOINTS; j += 1) {
				outPose[(k * JOINTS + j) * 3 + c] =
					posedJoints[(i * JOINTS + j) * 3 + c] * (1 - a) + posedJoints[(ib * JOINTS + j) * 3 + c] * a;
			}
		}
	};
	for (let k = 0; k < outFrames; k += 1) {
		const t = k * step;
		const i = Math.floor(t);
		if (i >= frames - 1) {
			copyFrame(k, frames - 1); // past the last input sample: no extrapolation
			continue;
		}
		const a = t - i;
		if (a === 0) copyFrame(k, i);
		else lerpFrame(k, i, a);
	}

	const out = { frames: outFrames, fps: targetFps, rotMats: outRot, rootPos: outRoot, posedJoints: outPose };
	if (motion.anchorFrame !== undefined) {
		out.anchorFrame = Math.round(motion.anchorFrame * (targetFps / fps));
	}
	return out;
}
