/**
 * contact-head feasibility runner (F2a).
 *
 * WHY: the Phase-0 decision function (F3) needs measurable candidate roots per mode, and
 * nobody here can run GVHMR -- so this runner's only job is to invert the RawTrack-shaped
 * synthetic observations: pick the planted foot by contact probability, ray-cast its
 * full-image 2D observation to the ring floor (plan 8.2), and report the floor point as
 * the candidate root. On synthetic GT the planted foot IS the ground-truth root, so the
 * runner must reproduce it to float noise; anything else fails the F2a gate.
 *
 * The root is deliberately floor-level, not the pelvis: M3 measures "solved planted-foot
 * world XZ", M5 compares the solved root against hand-annotated FOOT world positions, and
 * M6 measures inter-fighter separation -- all foot-level quantities. The pelvis root is a
 * Stage-B production-solver concern, and this file is deleted in Stage B.
 *
 * @feasibility-only -- disposable Phase-0 feasibility code (plan 10.2). NOT production:
 * no envelope integration, no HTTP route, no UI, no contract obligations, no provenance emission,
 * no error taxonomy. Mechanically fenced (6.2): nothing outside
 * tools/ingest/feasibility/** and test/ingest/** may import it. Removed in Stage B.
 */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const normalize = (v) => {
	const n = Math.hypot(v[0], v[1], v[2]);
	return [v[0] / n, v[1] / n, v[2] / n];
};
// row-major matvec: result[i] = row i of m dotted with v
const matVec = (m, v) => [
	m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
	m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
	m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];
const transpose = (m) => [
	[m[0][0], m[1][0], m[2][0]],
	[m[0][1], m[1][1], m[2][1]],
	[m[0][2], m[1][2], m[2][2]],
];
function mat3Inv(m) {
	const [a, b, c] = m[0];
	const [d, e, f] = m[1];
	const [g, h, i] = m[2];
	const A = e * i - f * h;
	const B = -(d * i - f * g);
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	if (det === 0) return null; // singular K: cannot happen for the pinned K
	return [
		[A / det, (c * h - b * i) / det, (b * f - c * e) / det],
		[B / det, (a * i - c * g) / det, (c * d - a * f) / det],
		[C / det, (b * g - a * h) / det, (a * e - b * d) / det],
	];
}

// plan 8.2: d_cam = normalize(K^-1 [u,v,1]); d_ring = R_ring_from_cam d_cam;
// lambda = (floorY - o.y)/d_ring.y, reject parallel or behind-camera rays. Returns
// null on rejection -- the synthetic control never produces one, and a real degenerate
// ray is a feasibility finding, not something this disposable runner must classify.
function rayPlane(pixel, K, R, t, floorY) {
	const dCam = normalize(matVec(mat3Inv(K), [pixel[0], pixel[1], 1]));
	const dRing = matVec(R, dCam);
	if (Math.abs(dRing[1]) < 1e-6) return null; // ray parallel to the floor plane
	const lam = (floorY - t[1]) / dRing[1];
	if (lam <= 0) return null; // intersection behind the camera
	return [t[0] + lam * dRing[0], t[1] + lam * dRing[1], t[2] + lam * dRing[2]];
}

// ring-frame ray direction for a pixel; dRing[1] < 0 means "pointing down at the floor",
// and the more negative it is, the lower the observed point sits (see lowest-foot.mjs).
function ringDir(pixel, K, R) {
	const dCam = normalize(matVec(mat3Inv(K), [pixel[0], pixel[1], 1]));
	return matVec(R, dCam);
}

function lowerFootSide(s, f, K, R) {
	const dl = ringDir(s.footObservations2d.left.keypoints[f], K, R);
	const dr = ringDir(s.footObservations2d.right.keypoints[f], K, R);
	return dl[1] <= dr[1] ? "left" : "right";
}

export function solveContactHead(rawTrack, floorFrame) {
	const K = rawTrack.K;
	const R = floorFrame.R_ring_from_cam;
	const t = floorFrame.t_ring_from_cam;
	const floorY = floorFrame.floorY;
	const subjects = rawTrack.subjects.map((s) => {
		const rootWorld = [];
		for (let f = 0; f < rawTrack.frames; f += 1) {
			const l = s.leftContact[f];
			const r = s.rightContact[f];
			// planted foot = higher contact probability; if BOTH are airborne the
			// contact signal is useless, so degrade to the lower-foot rule rather
			// than guessing (cannot occur in the synthetic control).
			const side = Math.max(l, r) <= 0.5 ? lowerFootSide(s, f, K, R) : l >= r ? "left" : "right";
			const pixel = s.footObservations2d[side].keypoints[f];
			rootWorld.push(rayPlane(pixel, K, R, t, floorY));
		}
		return { trackId: s.trackId, rootWorld };
	});
	return { mode: "contact-head", subjects };
}
