/**
 * lowest-foot feasibility runner (F2b), the degraded fallback.
 *
 * WHY: contact probabilities may be unusable on real footage (F1-e quality unknown), so
 * this mode deliberately ignores contact values and picks, per frame, whichever foot
 * observation sits lower. "Lower" is defined geometrically, in the only space a 2D
 * observation exists: a foot ON the floor subtends a steeper downward ray from a raised
 * camera than a lifted foot, so in the ring frame the planted foot has the more negative
 * d_ring.y. On synthetic GT the planted foot always wins (the swing foot hangs 0.15 m up),
 * so the runner reproduces the GT roots to float noise while never reading a contact.
 *
 * Degraded mode: F3 must display "spacing may read soft" and keep separate telemetry
 * (plan 10.3) when it selects this mode.
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

// plan 8.2 ray -> plane; null on rejection (parallel or behind-camera ray), which the
// synthetic control never produces.
function rayPlane(pixel, K, R, t, floorY) {
	const dCam = normalize(matVec(mat3Inv(K), [pixel[0], pixel[1], 1]));
	const dRing = matVec(R, dCam);
	if (Math.abs(dRing[1]) < 1e-6) return null;
	const lam = (floorY - t[1]) / dRing[1];
	if (lam <= 0) return null;
	return [t[0] + lam * dRing[0], t[1] + lam * dRing[1], t[2] + lam * dRing[2]];
}

export function solveLowestFoot(rawTrack, floorFrame) {
	const K = rawTrack.K;
	const R = floorFrame.R_ring_from_cam;
	const t = floorFrame.t_ring_from_cam;
	const floorY = floorFrame.floorY;
	const subjects = rawTrack.subjects.map((s) => {
		const rootWorld = [];
		for (let f = 0; f < rawTrack.frames; f += 1) {
			// never read s.leftContact / s.rightContact: the whole point of this mode
			const leftPx = s.footObservations2d.left.keypoints[f];
			const rightPx = s.footObservations2d.right.keypoints[f];
			const dL = matVec(R, normalize(matVec(mat3Inv(K), [leftPx[0], leftPx[1], 1])));
			const dR = matVec(R, normalize(matVec(mat3Inv(K), [rightPx[0], rightPx[1], 1])));
			// more downward ring ray = the lower foot; equal rays -> left (deterministic)
			const side = dL[1] <= dR[1] ? "left" : "right";
			rootWorld.push(rayPlane(side === "left" ? leftPx : rightPx, K, R, t, floorY));
		}
		return { trackId: s.trackId, rootWorld };
	});
	return { mode: "lowest-foot", subjects };
}
