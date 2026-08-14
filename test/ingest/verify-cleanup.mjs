/**
 * C10 gate: S6 cleanup is range-gated and punch-preserving (plan 8.5, 13).
 *
 * WHY this test exists: a punch is a HIGH-FREQUENCY event, so global
 * smoothing destroys exactly the frame the user wants. The C10 RED is the
 * naive smoother's own number: a 50 mm hand spike loses 31 mm under the
 * 5-tap pose kernel ((1 - 6/16) * 50 mm = 31.25 mm). The gate must hold
 * impact frames exact (<= 2 mm) while still reducing sub-gate capture
 * noise -- assert BOTH, or the filter proves nothing. The root is filtered
 * at a lower bandwidth than the pose (9-tap vs 5-tap), because root drift
 * is low-frequency while punches live in the limbs.
 *
 * The synthetic motion is a 60-frame neutral clip @ 20 fps with +-1 mm
 * uniform capture noise on every channel, a 50 mm spike on RightHand.x at
 * frame 30, and noise-free frames 28..32 so the spike's kernel support is
 * exactly the spike (the naive control's 31 mm is then deterministic).
 *
 * The negative control is the C10 RED itself: the same kernels WITHOUT the
 * range gate must move the impact frame by ~31 mm, or the test could not
 * tell a gated filter from an ungated one.
 */
import { cleanupMotion, POSE_KERNEL, ROOT_KERNEL } from "../../src/ingest/cleanup.js";
import { CSKEL27_JOINTS } from "../../src/ardy/cskel27.js";
import { CSKEL27_NEUTRAL } from "../../src/ardy/cskel27-neutral.js";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!cond) fail.push(label);
};

const JOINTS = CSKEL27_JOINTS.length;
const FRAMES = 60;
const FPS = 20;
const IMPACT = 30; // the punch frame
const SPIKE_JOINT = CSKEL27_JOINTS.indexOf("RightHand");
const SPIKE_M = 0.05; // 50 mm hand spike
const NOISE_M = 0.001; // +-1 mm capture noise
const IMPACT_BUDGET_M = 0.002; // an impact frame may move at most 2 mm
const WINDOW = [...Array(FRAMES).keys()].filter((f) => f < IMPACT - 2 || f > IMPACT + 2); // outside the spike's kernel support

// Deterministic PRNG (mulberry32): the noise profile is part of the test,
// so it must reproduce byte-for-byte on every run.
function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function makeRawMotion() {
	const rand = mulberry32(0xc9c10);
	const rotMats = new Float32Array(FRAMES * JOINTS * 9);
	for (let i = 0; i < rotMats.length; i += 9) {
		rotMats[i] = 1;
		rotMats[i + 4] = 1;
		rotMats[i + 8] = 1;
	}
	const rootPos = new Float32Array(FRAMES * 3);
	const posedJoints = new Float32Array(FRAMES * JOINTS * 3);
	for (let f = 0; f < FRAMES; f += 1) {
		// Ground truth: the ARDY neutral pose with the root at toe depth, the
		// same construction the Q1 contact gate's synthetic clips use.
		for (let j = 0; j < JOINTS; j += 1) {
			for (let k = 0; k < 3; k += 1) {
				posedJoints[(f * JOINTS + j) * 3 + k] = Math.fround(CSKEL27_NEUTRAL[j][k] + (k === 1 ? 0.9544128 : 0));
			}
		}
		rootPos[f * 3 + 1] = 0.9544128;
		if (f >= IMPACT - 2 && f <= IMPACT + 2) continue; // clean kernel support around the spike
		for (let i = 0; i < posedJoints.length / FRAMES; i += 1) {
			posedJoints[f * (JOINTS * 3) + i] += (rand() * 2 - 1) * NOISE_M;
		}
		for (let k = 0; k < 3; k += 1) rootPos[f * 3 + k] += (rand() * 2 - 1) * NOISE_M;
	}
	posedJoints[(IMPACT * JOINTS + SPIKE_JOINT) * 3] += SPIKE_M;
	return { frames: FRAMES, fps: FPS, rotMats, rootPos, posedJoints };
}

const raw = makeRawMotion();
const clean = cleanupMotion(raw);

// --- the two acceptances: impact held exact, noise still reduced ------------

// Impact frame: EVERY channel at frame 30 (pose joints and root) must stay
// within 2 mm of the raw capture. The spike frame is held exact; its
// neighbors carry only sub-gate noise, so the whole-frame bound is the
// honest assertion.
let worstImpactMm = 0;
for (let j = 0; j < JOINTS; j += 1) {
	for (let k = 0; k < 3; k += 1) {
		worstImpactMm = Math.max(
			worstImpactMm,
			Math.abs(clean.posedJoints[(IMPACT * JOINTS + j) * 3 + k] - raw.posedJoints[(IMPACT * JOINTS + j) * 3 + k]) * 1000,
		);
	}
}
for (let k = 0; k < 3; k += 1) {
	worstImpactMm = Math.max(worstImpactMm, Math.abs(clean.rootPos[IMPACT * 3 + k] - raw.rootPos[IMPACT * 3 + k]) * 1000);
}
ok(
	"impact frame held exact: every channel within 2mm of the raw capture",
	worstImpactMm <= IMPACT_BUDGET_M * 1000,
	`impact frame moved ${worstImpactMm.toFixed(1)}mm, expected <=2mm`,
);

// Noise still reduced: RMS deviation from the ground truth over the frames
// outside the spike's kernel support must drop by at least 40%.
const gtPose = (f, j, k) => Math.fround(CSKEL27_NEUTRAL[j][k] + (k === 1 ? 0.9544128 : 0));
function rmsM(stream, of) {
	let sum = 0;
	let n = 0;
	for (const f of WINDOW) {
		for (let j = 0; j < JOINTS; j += 1) {
			for (let k = 0; k < 3; k += 1) {
				sum += (stream.posedJoints[(f * JOINTS + j) * 3 + k] - of(f, j, k)) ** 2;
				n += 1;
			}
		}
		for (let k = 0; k < 3; k += 1) {
			sum += (stream.rootPos[f * 3 + k] - (k === 1 ? 0.9544128 : 0)) ** 2;
			n += 1;
		}
	}
	return Math.sqrt(sum / n) * 1000;
}
const rmsBefore = rmsM(raw, gtPose);
const rmsAfter = rmsM(clean, gtPose);
ok(
	"non-impact noise still reduced (RMS vs ground truth, <= 0.6x)",
	rmsAfter <= 0.6 * rmsBefore,
	`noise RMS ${rmsAfter.toFixed(3)}mm after vs ${rmsBefore.toFixed(3)}mm raw (factor ${(rmsAfter / rmsBefore).toFixed(3)})`,
);

// --- the two bandwidths: root filtered more heavily than the pose -----------

// The kernels are the design (9-tap root vs 5-tap pose); assert they are
// normalized, odd, and that the root's is strictly wider, then measure the
// consequence: on noise-only channels the root output is closer to the
// ground truth than the pose output is.
const sum = (a) => a.reduce((x, y) => x + y, 0);
ok(
	"root and pose are filtered at different bandwidths (9-tap root, 5-tap pose)",
	ROOT_KERNEL.length > POSE_KERNEL.length &&
		ROOT_KERNEL.length % 2 === 1 &&
		POSE_KERNEL.length % 2 === 1 &&
		Math.abs(sum(ROOT_KERNEL) - 1) < 1e-12 &&
		Math.abs(sum(POSE_KERNEL) - 1) < 1e-12,
	`root ${ROOT_KERNEL.length}-tap, pose ${POSE_KERNEL.length}-tap`,
);

// per-stream factors over the same window: root (rootPos) vs pose (non-Hips
// joints of posedJoints). The root kernel is wider, so its factor must be
// strictly smaller.
function rmsFactorPose() {
	let before = 0;
	let after = 0;
	let n = 0;
	for (const f of WINDOW) {
		for (let j = 1; j < JOINTS; j += 1) {
			for (let k = 0; k < 3; k += 1) {
				const gt = Math.fround(CSKEL27_NEUTRAL[j][k] + (k === 1 ? 0.9544128 : 0));
				before += (raw.posedJoints[(f * JOINTS + j) * 3 + k] - gt) ** 2;
				after += (clean.posedJoints[(f * JOINTS + j) * 3 + k] - gt) ** 2;
				n += 1;
			}
		}
	}
	return Math.sqrt(after / n) / Math.sqrt(before / n);
}
let rootBefore = 0;
let rootAfter = 0;
let rootN = 0;
for (const f of WINDOW) {
	for (let k = 0; k < 3; k += 1) {
		const gt = k === 1 ? 0.9544128 : 0;
		rootBefore += (raw.rootPos[f * 3 + k] - gt) ** 2;
		rootAfter += (clean.rootPos[f * 3 + k] - gt) ** 2;
		rootN += 1;
	}
}
const factorRoot = Math.sqrt(rootAfter / rootN) / Math.sqrt(rootBefore / rootN);
const factorPose = rmsFactorPose();
ok(
	"root bandwidth is lower than pose bandwidth (measured attenuation)",
	factorRoot < factorPose,
	`root RMS factor ${factorRoot.toFixed(3)} < pose RMS factor ${factorPose.toFixed(3)}`,
);

// --- cleanup does not disturb the things it does not own ---------------------

ok(
	"cleanup preserves frames, fps and rotations",
	clean.frames === FRAMES && clean.fps === FPS && clean.rotMats === raw.rotMats,
	`frames ${clean.frames}, fps ${clean.fps}, rotMats ${clean.rotMats === raw.rotMats ? "passed through" : "REPLACED"}`,
);

// --- negative control: the same kernels WITHOUT the gate (the C10 RED) -------

// Inline the ungated filter: identical kernels, no range gate. The spike
// frame's deviation from the smoothed value is (1 - 6/16) * 50 mm = 31.25 mm
// with clean neighbors, so the control must fail the 2 mm budget by the
// canonical 31 mm -- proving the gate, not the kernel, preserves the punch.
function naiveSmooth(src, frames, stride, lane, kernel) {
	const radius = (kernel.length - 1) / 2;
	const out = new Float32Array(frames);
	for (let f = 0; f < frames; f += 1) {
		const lo = Math.max(0, f - radius);
		const hi = Math.min(frames - 1, f + radius);
		let sumW = 0;
		let sumV = 0;
		for (let g = lo; g <= hi; g += 1) {
			const w = kernel[g - (f - radius)];
			sumV += w * src[g * stride + lane];
			sumW += w;
		}
		out[f] = sumV / sumW;
	}
	return out;
}
const naivePose = naiveSmooth(raw.posedJoints, FRAMES, JOINTS * 3, SPIKE_JOINT * 3, POSE_KERNEL);
const naiveImpactMm = Math.abs(naivePose[IMPACT] - raw.posedJoints[(IMPACT * JOINTS + SPIKE_JOINT) * 3]) * 1000;
ok(
	"negative control: ungated smoothing moves the impact frame ~31mm (the C10 RED)",
	naiveImpactMm > IMPACT_BUDGET_M * 1000 && Math.abs(naiveImpactMm - 31.25) < 0.5,
	`impact frame moved ${Math.round(naiveImpactMm)}mm, expected <=2mm`,
);

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
