// ray-plane.js - C4b: pixel -> world-floor intersection (plan §8.2).
//
// Why this shape: a planted-foot pixel becomes a fighter world position
// through exactly this function, so a silently wrong intersection becomes a
// silently wrong fighter placement. The pipeline is three steps with a named
// rejection at each failure point: d_cam = normalize(K⁻¹·[u,v,1]ᵀ), then
// d_ring = R_ring_from_cam·d_cam with o_ring = t_ring_from_cam, then
// λ = (floorY − o_ring.y)/d_ring.y. A ray parallel to the floor (|d_ring.y|
// below 1e-6) never meets it and must be REJECTED, never approximated; a
// negative λ means the meeting point sits behind the ray origin (the ray
// points away from the plane / toward a plane behind the camera); a
// degenerate plane normal makes the plane itself undefined. Each rejection
// throws a named error so the caller can distinguish the failure mode, and
// the general plane form (arbitrary planeNormal) reduces exactly to the
// plan's Y-axis equations when the normal is [0,1,0].

// Plan §8.2 parallelism guard: |d_ring.y| < 1e-6 means the ray never meets
// the plane within the project's metre scale.
const PARALLEL_EPS = 1e-6;

const mat3Vec = (a, v) => [
	a[0][0] * v[0] + a[0][1] * v[1] + a[0][2] * v[2],
	a[1][0] * v[0] + a[1][1] * v[1] + a[1][2] * v[2],
	a[2][0] * v[0] + a[2][1] * v[1] + a[2][2] * v[2],
];

// General 3x3 inverse; the caller validates finiteness/invertibility first,
// so this cannot fail on a validated K.
function mat3Inverse(a) {
	const det =
		a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
		a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
		a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
	return [
		[(a[1][1] * a[2][2] - a[1][2] * a[2][1]) / det, (a[0][2] * a[2][1] - a[0][1] * a[2][2]) / det, (a[0][1] * a[1][2] - a[0][2] * a[1][1]) / det],
		[(a[1][2] * a[2][0] - a[1][0] * a[2][2]) / det, (a[0][0] * a[2][2] - a[0][2] * a[2][0]) / det, (a[0][2] * a[1][0] - a[0][0] * a[1][2]) / det],
		[(a[1][0] * a[2][1] - a[1][1] * a[2][0]) / det, (a[0][1] * a[2][0] - a[0][0] * a[2][1]) / det, (a[0][0] * a[1][1] - a[0][1] * a[1][0]) / det],
	];
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Intersect the camera ray through `pixel` with the floor plane (plan §8.2).
 *
 * Inputs: pixel [u, v] (px), K (full-image intrinsics), R = R_ring_from_cam,
 * t = t_ring_from_cam (p_ring = R·p_cam + t), floorY (metres, the plane's Y
 * offset), planeNormal (default [0,1,0]). Returns { point: [x, y, z] } in
 * ring metres. Rejections by name:
 *   - `plane-normal-degenerate` — planeNormal/floorY not finite or the
 *     normal has zero length (the plane is undefined);
 *   - `camera-intrinsics-degenerate` — K singular/non-finite, or R/t/pixel
 *     non-finite (a silently NaN intersection is a silently wrong one);
 *   - `ray-parallel-to-plane` — |d_ring·n̂| < 1e-6 (the ray never meets it);
 *   - `ray-away-from-plane` — λ ≤ 0 (the meeting point is behind the ray
 *     origin: the ray points away from the plane, or the plane is behind
 *     the camera).
 */
export function rayPlaneIntersect({ pixel, K, R, t, floorY = 0, planeNormal = [0, 1, 0] }) {
	if (!Array.isArray(pixel) || pixel.length !== 2 || !Number.isFinite(pixel[0]) || !Number.isFinite(pixel[1])) {
		throw new Error("ray-plane-input: pixel must be two finite numbers");
	}
	if (!Array.isArray(planeNormal) || planeNormal.length !== 3) {
		throw new Error("plane-normal-degenerate: planeNormal must be a 3-vector");
	}
	if (!planeNormal.every(Number.isFinite) || !Number.isFinite(floorY)) {
		throw new Error("plane-normal-degenerate: non-finite planeNormal or floorY");
	}
	const nLen = Math.hypot(planeNormal[0], planeNormal[1], planeNormal[2]);
	if (nLen < 1e-12) {
		throw new Error("plane-normal-degenerate: zero-length planeNormal");
	}
	if (
		!Array.isArray(K) || K.length !== 3 ||
		!Array.isArray(R) || R.length !== 3 ||
		!Array.isArray(t) || t.length !== 3
	) {
		throw new Error("camera-intrinsics-degenerate: K/R/t must be 3x3/3x3/3");
	}
	for (const row of K) {
		if (!row || row.length !== 3 || !row.every(Number.isFinite)) {
			throw new Error("camera-intrinsics-degenerate: K must be finite 3x3");
		}
	}
	for (const row of R) {
		if (!row || row.length !== 3 || !row.every(Number.isFinite)) {
			throw new Error("camera-intrinsics-degenerate: R must be finite 3x3");
		}
	}
	if (!t.every(Number.isFinite)) {
		throw new Error("camera-intrinsics-degenerate: t must be finite");
	}
	const det =
		K[0][0] * (K[1][1] * K[2][2] - K[1][2] * K[2][1]) -
		K[0][1] * (K[1][0] * K[2][2] - K[1][2] * K[2][0]) +
		K[0][2] * (K[1][0] * K[2][1] - K[1][1] * K[2][0]);
	if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
		throw new Error("camera-intrinsics-degenerate: singular K");
	}

	// d_cam = normalize(K⁻¹·[u,v,1]ᵀ): the ray direction in the y-down
	// camera frame (its z component is always 1 before normalization, so the
	// ray always points forward out of the camera).
	const Kinv = mat3Inverse(K);
	const ray = mat3Vec(Kinv, [pixel[0], pixel[1], 1]);
	const rayLen = Math.hypot(ray[0], ray[1], ray[2]);
	const dCam = [ray[0] / rayLen, ray[1] / rayLen, ray[2] / rayLen];

	// To ring coordinates: d_ring = R·d_cam, o_ring = t.
	const dRing = mat3Vec(R, dCam);
	const oRing = t;

	// General plane form: the floor plane is { p : n̂·p = n̂·(0, floorY, 0) }.
	// With planeNormal = [0,1,0] this is exactly the plan's
	// λ = (floorY − o_ring.y)/d_ring.y.
	const n = [planeNormal[0] / nLen, planeNormal[1] / nLen, planeNormal[2] / nLen];
	const denom = dot3(n, dRing);
	if (Math.abs(denom) < PARALLEL_EPS) {
		throw new Error("ray-parallel-to-plane: ray is parallel to the plane (|d_ring·n| < 1e-6)");
	}
	const planeD = dot3(n, [0, floorY, 0]);
	const lambda = (planeD - dot3(n, oRing)) / denom;
	if (lambda <= 0) {
		throw new Error(`ray-away-from-plane: intersection at lambda=${lambda} is behind the ray origin`);
	}
	return {
		point: [oRing[0] + lambda * dRing[0], oRing[1] + lambda * dRing[1], oRing[2] + lambda * dRing[2]],
	};
}
