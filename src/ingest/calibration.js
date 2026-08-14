// calibration.js - C4a: the stage-2 calibration estimator (plan §9).
//
// Why this design: the estimator is normalized DLT (Hartley) over the
// coplanar fit marks, wrapped in an EXHAUSTIVE C(N,4) minimal-sample search
// (70 candidates for N = 8) with fully deterministic scoring. A four-point
// model fits its own four points exactly by construction, so its self-
// residual is zero and can never detect its own error — the only way to find
// the consensus model is to build every minimal model and rank them. The
// ranking must be deterministic (inlier count descending, then SSE over the
// inliers ascending, then the sorted id tuple lexicographically) or the same
// footage would calibrate differently on every run. Three independent
// signals gate the verdict, none of which is the fit residual on the fit
// points: a held-out check point never used in the fit (reported in metres),
// the inlier ratio, and a fixed-grid Monte-Carlo click-noise propagation to
// a 1σ world uncertainty at fighter depth.
//
// Convention: the recovered K, R, t live in the y-down camera frame that
// K⁻¹·[u,v,1] implies (image x right, y down, z forward — the OpenCV
// convention), so the ray→plane math in ray-plane.js (§8.2) composes with
// this module without any axis flip: p_ring = R·p_cam + t.

// Plan §9: inlier threshold and the minimal-subset collinearity tolerance.
const INLIER_THRESHOLD_PX = 2;

// Plan §9 thresholds, in metres and fractions (against research 12's 5 cm
// contact budget). Strict comparisons: warn trips ABOVE the warn threshold,
// block ABOVE the block threshold, ratio warn BELOW 0.9 / block BELOW 0.75.
const WARN_HELDOUT_M = 0.02;
const BLOCK_HELDOUT_M = 0.05;
const WARN_RATIO = 0.9;
const BLOCK_RATIO = 0.75;
const WARN_SIGMA_M = 0.03;
const BLOCK_SIGMA_M = 0.08;

// Plan §9 "Collinearity (unchanged)": the mark set is globally degenerate —
// rejected outright — when the 2×2 mark-covariance condition number exceeds
// 100 or every mark lies inside a band narrower than 2% of the image
// diagonal about one line.
const MAX_MARK_COV_COND = 100;
const MIN_BAND_FRACTION = 0.02;

// Fixed Monte-Carlo budget (plan §9): 200 samples on a fixed seed so the 1σ
// readout is reproducible across runs and machines.
const MC_SAMPLES = 200;
const MC_SEED = 0xc4a;
const MC_CLICK_SIGMA_PX = 3;

// ---------------------------------------------------------------------------
// Small vector / matrix helpers (3x3 only; row-major arrays of arrays).
// ---------------------------------------------------------------------------

const cross3 = (a, b) => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];

const mat3Mul = (a, b) => {
	const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 3; j++) {
			out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
		}
	}
	return out;
};

const mat3Vec = (a, v) => [
	a[0][0] * v[0] + a[0][1] * v[1] + a[0][2] * v[2],
	a[1][0] * v[0] + a[1][1] * v[1] + a[1][2] * v[2],
	a[2][0] * v[0] + a[2][1] * v[1] + a[2][2] * v[2],
];

const transpose3 = (a) => [
	[a[0][0], a[1][0], a[2][0]],
	[a[0][1], a[1][1], a[2][1]],
	[a[0][2], a[1][2], a[2][2]],
];

// Inverse of the 3x3 homography (used to map the held-out PIXEL back to the
// world plane). Throws on a singular matrix rather than returning NaN.
function mat3Inverse(a) {
	const det =
		a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
		a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
		a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
	if (!Number.isFinite(det) || Math.abs(det) < 1e-18) {
		throw new Error("calibration-decompose-failed: singular homography inverse");
	}
	return [
		[(a[1][1] * a[2][2] - a[1][2] * a[2][1]) / det, (a[0][2] * a[2][1] - a[0][1] * a[2][2]) / det, (a[0][1] * a[1][2] - a[0][2] * a[1][1]) / det],
		[(a[1][2] * a[2][0] - a[1][0] * a[2][2]) / det, (a[0][0] * a[2][2] - a[0][2] * a[2][0]) / det, (a[0][2] * a[1][0] - a[0][0] * a[1][2]) / det],
		[(a[1][0] * a[2][1] - a[1][1] * a[2][0]) / det, (a[0][1] * a[2][0] - a[0][0] * a[2][1]) / det, (a[0][0] * a[1][1] - a[0][1] * a[1][0]) / det],
	];
}

// Deterministic symmetric eigensolver (Jacobi rotations over a fixed sweep
// budget in a fixed rotation order). The DLT needs the smallest eigenvector
// of the 9x9 normal matrix AᵀA; Jacobi returns the full decomposition with
// no iteration-count or convergence non-determinism (plan §9: "No iteration
// ⇒ no convergence non-determinism").
function jacobiEigen(n, a) {
	const v = new Float64Array(n * n);
	for (let i = 0; i < n; i++) v[i * n + i] = 1;
	for (let sweep = 0; sweep < 64; sweep++) {
		let off = 0;
		for (let p = 0; p < n; p++) {
			for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q];
		}
		if (off < 1e-28) break;
		for (let p = 0; p < n; p++) {
			for (let q = p + 1; q < n; q++) {
				const apq = a[p * n + q];
				if (apq === 0) continue;
				const app = a[p * n + p];
				const aqq = a[q * n + q];
				const theta = (aqq - app) / (2 * apq);
				// Equal diagonals make theta exactly 0, where the standard
				// sign(theta)/(|theta| + sqrt(theta^2+1)) formula degenerates
				// to t = 0 — a silent no-op that never zeroes the off-
				// diagonal and leaves the matrix undiagonalized (the ring's
				// x/z symmetry makes this happen EXACTLY in floating point).
				// The correct rotation for equal diagonals is 45 degrees.
				const t = theta === 0 ? 1 : Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
				const c = 1 / Math.sqrt(t * t + 1);
				const s = t * c;
				for (let k = 0; k < n; k++) {
					if (k === p || k === q) continue;
					const akp = a[k * n + p];
					const akq = a[k * n + q];
					const apk = a[p * n + k];
					const aqk = a[q * n + k];
					a[k * n + p] = c * akp - s * akq;
					a[k * n + q] = s * akp + c * akq;
					a[p * n + k] = c * apk - s * aqk;
					a[q * n + k] = s * apk + c * aqk;
				}
				a[p * n + p] = c * c * app - 2 * s * c * apq + s * s * aqq;
				a[q * n + q] = s * s * app + 2 * s * c * apq + c * c * aqq;
				a[p * n + q] = 0;
				a[q * n + p] = 0;
				for (let k = 0; k < n; k++) {
					const vkp = v[k * n + p];
					const vkq = v[k * n + q];
					v[k * n + p] = c * vkp - s * vkq;
					v[k * n + q] = s * vkp + c * vkq;
				}
			}
		}
	}
	const values = new Float64Array(n);
	for (let i = 0; i < n; i++) values[i] = a[i * n + i];
	return { values, vectors: v };
}

// ---------------------------------------------------------------------------
// Normalized DLT (Hartley): 2D plane coords -> image coords homography.
// ---------------------------------------------------------------------------

// Similarity taking a point set to centroid 0 with mean distance √2 — the
// Hartley normalization that makes the DLT well-conditioned.
function hartleySimilarity(pts) {
	let cx = 0;
	let cy = 0;
	for (const p of pts) {
		cx += p[0];
		cy += p[1];
	}
	cx /= pts.length;
	cy /= pts.length;
	let mean = 0;
	for (const p of pts) mean += Math.hypot(p[0] - cx, p[1] - cy);
	mean /= pts.length;
	const scale = mean > 0 ? Math.sqrt(2) / mean : 1;
	return [
		[scale, 0, -scale * cx],
		[0, scale, -scale * cy],
		[0, 0, 1],
	];
}

// Normalized DLT fit of the plane->image homography. Returns the 3x3 H
// (canonical scale H[2][2] = 1) and the nonzero-spectrum condition number of
// the normalized design matrix (largest over smallest NONZERO singular value
// — the always-present scale null space is excluded, so this measures
// geometric conditioning, not the trivial scale ambiguity).
function fitHomography(plane, image) {
	const ts = hartleySimilarity(plane);
	const ti = hartleySimilarity(image);
	const n = plane.length;
	const A = new Float64Array(2 * n * 9);
	for (let i = 0; i < n; i++) {
		const X = mat3Vec(ts, [plane[i][0], plane[i][1], 1]);
		const x = mat3Vec(ti, [image[i][0], image[i][1], 1]);
		const r1 = i * 18;
		const r2 = r1 + 9;
		// The two standard DLT rows per correspondence: the cross product
		// x × (H·X) = 0 expanded over the entries of H.
		A[r1 + 3] = -x[2] * X[0];
		A[r1 + 4] = -x[2] * X[1];
		A[r1 + 5] = -x[2] * X[2];
		A[r1 + 6] = x[1] * X[0];
		A[r1 + 7] = x[1] * X[1];
		A[r1 + 8] = x[1] * X[2];
		A[r2 + 0] = x[2] * X[0];
		A[r2 + 1] = x[2] * X[1];
		A[r2 + 2] = x[2] * X[2];
		A[r2 + 6] = -x[0] * X[0];
		A[r2 + 7] = -x[0] * X[1];
		A[r2 + 8] = -x[0] * X[2];
	}
	// Normal matrix AᵀA; its smallest eigenvector is the DLT null vector.
	const ata = new Float64Array(81);
	for (let r = 0; r < 2 * n; r++) {
		const row = r * 9;
		for (let i = 0; i < 9; i++) {
			const ai = A[row + i];
			for (let j = i; j < 9; j++) ata[i * 9 + j] += ai * A[row + j];
		}
	}
	for (let i = 0; i < 9; i++) {
		for (let j = 0; j < i; j++) ata[i * 9 + j] = ata[j * 9 + i];
	}
	const { values, vectors } = jacobiEigen(9, ata);
	let minK = 0;
	for (let i = 1; i < 9; i++) {
		if (values[i] < values[minK]) minK = i;
	}
	const hn = new Array(9);
	for (let i = 0; i < 9; i++) hn[i] = vectors[i * 9 + minK];
	const Hn = [hn.slice(0, 3), hn.slice(3, 6), hn.slice(6, 9)];
	const H = mat3Mul(mat3Inverse(ti), mat3Mul(Hn, ts));
	// Canonical scale: a front-facing camera homography never has H[2][2] ~ 0.
	const s = H[2][2];
	const Hc = H.map((row) => row.map((x) => x / s));
	const sorted = [...values].sort((a, b) => b - a);
	const condNonZero = sorted[8] > 0 ? Math.sqrt(sorted[0] / sorted[8]) : Infinity;
	return { H: Hc, condNonZero };
}

// ---------------------------------------------------------------------------
// Homography decomposition -> K, R, t (y-down camera frame).
// ---------------------------------------------------------------------------

// Recover f (square-pixel, zero-skew, principal point fixed at the image
// centre — the plan's stated assumption) and the camera pose from a
// plane->image homography. With G = T⁻¹·H (T the principal-point shift),
// G = s·[(f·r1x, f·r1y, r1z) | (f·r2x, f·r2y, r2z) | (f·t̃x, f·t̃y, t̃z)] for
// unit rotation columns r1, r2 and unknown DLT scale s; eliminating s across
// the two columns gives f² = (|g1xy|² − |g2xy|²)/(g1z² − g2z²), then s, then
// the unit columns, then r3 = r1 × r2. R = R_ring_from_cam, t = t_ring_from_cam
// with p_ring = R·p_cam + t. With an operator-supplied K the same algebra
// runs on B = K⁻¹·H with f pinned.
function decomposeHomography(H, principal, suppliedK) {
	// With an operator-supplied K, B = K⁻¹·H = s̃·[r1 r2 t̃] already has the
	// intrinsics divided out, so its columns are the unit rotation columns
	// times ONE unknown scale s̃. Without K, the columns carry the unknown
	// focal length too: G = s·K_f·[r1 r2 t̃], and f comes from eliminating s
	// across the two columns, then s from the unit-norm constraint.
	let g;
	let f;
	if (suppliedK) {
		const B = mat3Mul(mat3Inverse(suppliedK), H);
		g = [B.map((row) => row[0]), B.map((row) => row[1]), B.map((row) => row[2])];
		f = suppliedK[0][0];
	} else {
		const cx = principal[0];
		const cy = principal[1];
		g = [
			[H[0][0] - cx * H[2][0], H[1][0] - cy * H[2][0], H[2][0]],
			[H[0][1] - cx * H[2][1], H[1][1] - cy * H[2][1], H[2][1]],
			[H[0][2] - cx * H[2][2], H[1][2] - cy * H[2][2], H[2][2]],
		];
		const g1xy2 = g[0][0] ** 2 + g[0][1] ** 2;
		const g2xy2 = g[1][0] ** 2 + g[1][1] ** 2;
		const g1z2 = g[0][2] ** 2;
		const g2z2 = g[1][2] ** 2;
		const denom = g2z2 - g1z2;
		if (Math.abs(denom) < 1e-12) {
			throw new Error("calibration-decompose-failed: plane axes project to near-equal z-components");
		}
		const f2 = (g1xy2 - g2xy2) / denom;
		if (!Number.isFinite(f2) || f2 <= 0) {
			throw new Error("calibration-decompose-failed: non-positive focal length recovered");
		}
		f = Math.sqrt(f2);
	}
	let r1;
	let r2;
	let tcam;
	if (suppliedK) {
		// B = s̃·[r1 r2 t̃] with unit r1, r2: s̃ is the mean column norm.
		const s = (Math.hypot(g[0][0], g[0][1], g[0][2]) + Math.hypot(g[1][0], g[1][1], g[1][2])) / 2;
		if (!Number.isFinite(s) || s <= 0) {
			throw new Error("calibration-decompose-failed: non-positive DLT scale recovered");
		}
		r1 = [g[0][0] / s, g[0][1] / s, g[0][2] / s];
		r2 = [g[1][0] / s, g[1][1] / s, g[1][2] / s];
		tcam = [g[2][0] / s, g[2][1] / s, g[2][2] / s];
	} else {
		const g1xy2 = g[0][0] ** 2 + g[0][1] ** 2;
		const g2xy2 = g[1][0] ** 2 + g[1][1] ** 2;
		const s2 = (g1xy2 / (f * f) + g[0][2] ** 2 + g2xy2 / (f * f) + g[1][2] ** 2) / 2;
		const s = Math.sqrt(s2);
		if (!Number.isFinite(s) || s <= 0) {
			throw new Error("calibration-decompose-failed: non-positive DLT scale recovered");
		}
		r1 = [g[0][0] / (s * f), g[0][1] / (s * f), g[0][2] / s];
		r2 = [g[1][0] / (s * f), g[1][1] / (s * f), g[1][2] / s];
		tcam = [g[2][0] / (s * f), g[2][1] / (s * f), g[2][2] / s];
	}
	const r3 = cross3(r1, r2);
	// r1, r2, r3 are the images of the plane axes e_x, e_z and of
	// r1 × r2 = −e_y — the DLT's plane-coordinate frame. The standard y-down
	// camera frame orders its columns (x, y_down, z), so the world->cam
	// rotation is [r1, r3, r2]; its transpose is R_ring_from_cam and
	// t_ring = −Rᵀ·tcam = the camera centre.
	const R = transpose3([r1, r3, r2]);
	const negRt = mat3Vec(R, tcam);
	const t = [-negRt[0], -negRt[1], -negRt[2]];
	const K = [[f, 0, principal[0]], [0, f, principal[1]], [0, 0, 1]];
	return { f, K, R, t };
}

// ---------------------------------------------------------------------------
// Degeneracy guards and geometric helpers.
// ---------------------------------------------------------------------------

// 2x2 covariance condition number of the plane marks (worldX, worldZ): a
// near-collinear mark layout makes the homography underdetermined regardless
// of what the image looks like.
function markCovarianceCondition(planePts) {
	let mx = 0;
	let mz = 0;
	for (const p of planePts) {
		mx += p[0];
		mz += p[1];
	}
	mx /= planePts.length;
	mz /= planePts.length;
	let a = 0;
	let b = 0;
	let c = 0;
	for (const p of planePts) {
		a += (p[0] - mx) ** 2;
		b += (p[0] - mx) * (p[1] - mz);
		c += (p[1] - mz) ** 2;
	}
	const disc = Math.sqrt((a - c) ** 2 + 4 * b * b);
	const lamMax = (a + c + disc) / 2;
	const lamMin = (a + c - disc) / 2;
	if (lamMin <= 0) return Infinity;
	return lamMax / lamMin;
}

// The band (max perpendicular deviation from the least-squares line) of a
// point set, in px — used for the global-degeneracy check.
function bandOfSet(pts) {
	let mu = [0, 0];
	for (const p of pts) {
		mu[0] += p[0];
		mu[1] += p[1];
	}
	mu = [mu[0] / pts.length, mu[1] / pts.length];
	let a = 0;
	let b = 0;
	let c = 0;
	for (const p of pts) {
		a += (p[0] - mu[0]) ** 2;
		b += (p[0] - mu[0]) * (p[1] - mu[1]);
		c += (p[1] - mu[1]) ** 2;
	}
	// Minor-axis direction of the 2x2 covariance: the perpendicular to the
	// best-fit line.
	const disc = Math.sqrt((a - c) ** 2 + 4 * b * b);
	const lamMin = (a + c - disc) / 2;
	let vx = b;
	let vy = lamMin - a;
	if (Math.hypot(vx, vy) < 1e-12) {
		vx = lamMin - c;
		vy = b;
	}
	const len = Math.hypot(vx, vy) || 1;
	let band = 0;
	for (const p of pts) {
		const d = Math.abs(vx * (p[0] - mu[0]) + vy * (p[1] - mu[1])) / len;
		if (d > band) band = d;
	}
	return band;
}

// Max deviation of any of the three points from the line through the other
// two — the minimal-subset collinearity measure. Two coincident points make
// the triple degenerate for the DLT regardless of the third, so that case
// reports Infinity (always skipped).
function maxLineDeviation(pts) {
	let worst = 0;
	for (let i = 0; i < 3; i++) {
		const a = pts[i];
		const b = pts[(i + 1) % 3];
		const c = pts[(i + 2) % 3];
		const dx = b[0] - a[0];
		const dy = b[1] - a[1];
		const len = Math.hypot(dx, dy);
		if (len < 1e-12) return Infinity;
		const d = Math.abs(dy * (c[0] - a[0]) - dx * (c[1] - a[1])) / len;
		if (d > worst) worst = d;
	}
	return worst;
}

// All k-subsets of {0..n-1} in lexicographic index order — the deterministic
// enumeration order the persisted candidate table is keyed on.
function* combinations(n, k) {
	const idx = Array.from({ length: k }, (_, i) => i);
	while (true) {
		yield idx.slice();
		let i = k - 1;
		while (i >= 0 && idx[i] === n - k + i) i--;
		if (i < 0) return;
		idx[i]++;
		for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
	}
}

const reprojectError = (H, planePt, imagePt) => {
	const h = mat3Vec(H, [planePt[0], planePt[1], 1]);
	return [imagePt[0] - h[0] / h[2], imagePt[1] - h[1] / h[2]];
};

const inlierIndices = (H, planePts, imagePts, threshold) => {
	const out = [];
	for (let i = 0; i < planePts.length; i++) {
		const [ex, ey] = reprojectError(H, planePts[i], imagePts[i]);
		if (Math.hypot(ex, ey) <= threshold) out.push(i);
	}
	return out;
};

// ---------------------------------------------------------------------------
// Monte-Carlo click-noise propagation (plan §9, signal 3).
// ---------------------------------------------------------------------------

// Deterministic 32-bit LCG (mulberry32): the sample grid must be fixed or
// the 1σ readout would differ between the fixture build and the verifier.
function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Box-Muller pair from two uniforms — deterministic given the LCG state.
function gaussianPair(rng) {
	const u1 = rng() || 1e-12;
	const u2 = rng();
	const r = Math.sqrt(-2 * Math.log(u1));
	return [r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u2)];
}

// ---------------------------------------------------------------------------
// The estimator core (no Monte-Carlo, no verdict — shared by the main call
// and every Monte-Carlo sample).
// ---------------------------------------------------------------------------

function coreCalibrate({ marks, heldOut, imageSize, suppliedK, inlierThresholdPx }) {
	const n = marks.length;
	const principal = [imageSize.width / 2, imageSize.height / 2];
	const planePts = marks.map((m) => [m.worldX, m.worldZ]);
	const imagePts = marks.map((m) => [m.x, m.y]);

	// Global degeneracy (plan §9, "Collinearity (unchanged)"): a mark set
	// that cannot determine a homography must be rejected by name before any
	// candidate is scored.
	if (markCovarianceCondition(planePts) > MAX_MARK_COV_COND) {
		throw new Error("degenerate-calibration: mark covariance condition number exceeds 100");
	}
	const diag = Math.hypot(imageSize.width, imageSize.height);
	if (bandOfSet(imagePts) < MIN_BAND_FRACTION * diag) {
		throw new Error("degenerate-calibration: all marks inside a band narrower than 2% of the image diagonal");
	}

	// Exhaustive C(N,4) enumeration with the deterministic scoring record.
	const candidates = [];
	for (const idx of combinations(n, 4)) {
		const ids = idx.map((i) => marks[i].id);
		const subPlane = idx.map((i) => planePts[i]);
		const subImage = idx.map((i) => imagePts[i]);
		// A minimal subset is skipped when ANY of its four triples is
		// image-collinear (within the inlier threshold): its DLT is
		// underdetermined, so its "fit" would be an arbitrary member of a
		// one-parameter family — scoring it would fabricate consensus. The
		// collinear triple is not necessarily the subset's first three marks
		// (e.g. {c0,c1,c2,e0} hides the collinear {c0,e0,c1}), so all four
		// triples must be checked.
		let collinear = false;
		for (let a = 0; a < 4 && !collinear; a++) {
			for (let b = a + 1; b < 4 && !collinear; b++) {
				for (let c = b + 1; c < 4; c++) {
					if (maxLineDeviation([subImage[a], subImage[b], subImage[c]]) <= inlierThresholdPx) {
						collinear = true;
						break;
					}
				}
			}
		}
		if (collinear) {
			candidates.push({ ids, skipped: true, inliers: null, sse: null });
			continue;
		}
		const { H } = fitHomography(subPlane, subImage);
		let inliers = 0;
		let sse = 0;
		const errs = [];
		for (let i = 0; i < n; i++) {
			const [ex, ey] = reprojectError(H, planePts[i], imagePts[i]);
			const e = Math.sqrt(ex * ex + ey * ey);
			errs.push(e);
			if (e <= inlierThresholdPx) {
				inliers++;
				sse += e * e;
			}
		}
		// The candidate's margin: the error of the closest mark that is NOT
		// an inlier — how far the candidate is from admitting one more.
		errs.sort((a, b) => a - b);
		candidates.push({ ids, skipped: false, inliers, sse, margin: errs[Math.min(inliers, n - 1)] });
	}
	const scored = candidates.filter((c) => !c.skipped);
	if (scored.length === 0) {
		throw new Error("degenerate-calibration: fewer than 4 marks in general position");
	}

	// Deterministic ranking: inlier count descending, SSE over the inliers
	// ascending, then the sorted id tuple lexicographically ascending. The
	// comparator is total, so the winner is a pure function of the input.
	const idTuple = (ids) => [...ids].sort().join("\u0000");
	scored.sort((a, b) => {
		return (
			b.inliers - a.inliers ||
			a.sse - b.sse ||
			(idTuple(a.ids) < idTuple(b.ids) ? -1 : idTuple(a.ids) > idTuple(b.ids) ? 1 : 0)
		);
	});
	const winner = scored[0];
	const maxCompetingInliers = scored.length > 1 ? Math.max(...scored.slice(1).map((c) => c.inliers)) : 0;
	// The closest margin among the STRONGEST competitors (those tied at the
	// maximum competing inlier count): the smallest error of the mark closest
	// to joining a model that could actually threaten the winner. A margin
	// barely above the 2 px threshold means the consensus is one rounding
	// away from admitting another inlier — B-BG1 must fail loudly on that,
	// not silently. (Garbage-fit candidates with few inliers are excluded:
	// their own points do not fit, so their low margins are meaningless.)
	const maxCompetingMarginPx = (() => {
		const strongest = scored.slice(1).filter((c) => c.inliers === maxCompetingInliers);
		return strongest.length > 0 ? Math.min(...strongest.map((c) => c.margin)) : Infinity;
	})();

	// Refit ONCE over the winner's inliers, then recompute the inlier set
	// ONCE from the refit model; the recorded set is the refit one.
	const winnerIds = new Set(winner.ids);
	const wIdx = [];
	for (let i = 0; i < n; i++) {
		if (winnerIds.has(marks[i].id)) wIdx.push(i);
	}
	const Hmin = fitHomography(wIdx.map((i) => planePts[i]), wIdx.map((i) => imagePts[i])).H;
	const refitIdx = inlierIndices(Hmin, planePts, imagePts, inlierThresholdPx);
	const refit = fitHomography(refitIdx.map((i) => planePts[i]), refitIdx.map((i) => imagePts[i]));
	const H = refit.H;
	const postIdx = inlierIndices(H, planePts, imagePts, inlierThresholdPx);
	const postRefitInliers = postIdx.map((i) => marks[i].id);

	const { f, K, R, t } = decomposeHomography(H, principal, suppliedK);

	// Signal 1: the held-out check point, excluded from the fit, unprojected
	// through the winner model and compared in WORLD metres — the operation
	// that actually happens when a planted-foot pixel becomes a world point.
	const Hinv = mat3Inverse(H);
	const w = mat3Vec(Hinv, [heldOut.x, heldOut.y, 1]);
	const heldOutErrorM = Math.hypot(w[0] / w[2] - heldOut.worldX, w[1] / w[2] - heldOut.worldZ);

	// Signal 2: the overdetermined residual (RMS over the refit inliers) and
	// the refit design-matrix conditioning.
	let sseRefit = 0;
	for (const i of postIdx) {
		const [ex, ey] = reprojectError(H, planePts[i], imagePts[i]);
		sseRefit += ex * ex + ey * ey;
	}
	const reprojRmsPx = Math.sqrt(sseRefit / Math.max(1, postIdx.length));
	const conditionNumber = refit.condNonZero;

	const inlierRatio = postRefitInliers.length / n;

	return {
		H,
		K,
		R,
		t,
		f,
		selectedPreRefit: winner.ids,
		postRefitInliers,
		inlierRatio,
		heldOutErrorM,
		maxCompetingInliers,
		maxCompetingMarginPx,
		reprojRmsPx,
		conditionNumber,
		candidates,
		topCandidates: scored.slice(0, 3),
};
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Calibrate the ring camera (plan §9). `marks` are the fit marks (N ≥ 8,
 * coplanar, world plane coordinates given as worldX/worldZ metres with the
 * plane at Y = 0), `heldOut` is the check point that never enters the fit.
 * Returns the recovered K/R/t (y-down camera frame), the exhaustive
 * candidate record, the post-refit inlier set and ratio, the exact held-out
 * world error, the Monte-Carlo 1σ, and the verdict with per-signal codes.
 */
export function calibrateCamera({
	marks,
	heldOut,
	imageSize,
	K = null,
	inlierThresholdPx = INLIER_THRESHOLD_PX,
	clickSigmaPx = MC_CLICK_SIGMA_PX,
	mcSamples = MC_SAMPLES,
	mcSeed = MC_SEED,
}) {
	if (!Array.isArray(marks) || marks.length < 8) {
		throw new Error("CALIB-INPUT: at least 8 fit marks required (plan §9: N >= 8)");
	}
	if (!heldOut || typeof heldOut !== "object") {
		throw new Error("CALIB-INPUT: a held-out check mark is required");
	}
	if (!imageSize || !(imageSize.width > 0) || !(imageSize.height > 0)) {
		throw new Error("CALIB-INPUT: imageSize.width/height must be positive");
	}
	const ids = new Set();
	for (const m of [...marks, heldOut]) {
		if (typeof m.id !== "string" || m.id.length === 0) {
			throw new Error("CALIB-INPUT: every mark needs a non-empty string id");
		}
		if (ids.has(m.id)) {
			throw new Error(`CALIB-INPUT: duplicate mark id ${JSON.stringify(m.id)}`);
		}
		ids.add(m.id);
		for (const v of [m.x, m.y, m.worldX, m.worldZ]) {
			if (!Number.isFinite(v)) {
				throw new Error(`CALIB-INPUT: non-finite coordinate on mark ${JSON.stringify(m.id)}`);
			}
		}
	}
	if (K) {
		for (const row of K) {
			for (const v of row) {
				if (!Number.isFinite(v)) throw new Error("CALIB-INPUT: K must be finite");
			}
		}
	}

	const rec = coreCalibrate({ marks, heldOut, imageSize, suppliedK: K, inlierThresholdPx });

	// Signal 3: repeated-click σ propagated by Monte-Carlo on a fixed sample
	// grid. Each sample perturbs the fit observations and re-fits the
	// winner's POST-REFIT inlier set, then unprojects the held-out pixel
	// through the sample model. The consensus (WHICH marks are inliers) is
	// NOT re-decided per sample: consensus instability is already measured by
	// the exhaustive search's own scoring, and letting a 3 px click flip the
	// winner to a corrupted-mark model would inflate the 1σ with consensus
	// jumps that are not parameter noise (the plan's signal is the model's
	// world-position uncertainty at fighter depth under repeated clicks).
	let uncertainty1SigmaM = 0;
	if (mcSamples > 0) {
		const rng = mulberry32(mcSeed >>> 0);
		const inlierIds = new Set(rec.postRefitInliers);
		const inlierIdx = [];
		for (let i = 0; i < marks.length; i++) {
			if (inlierIds.has(marks[i].id)) inlierIdx.push(i);
		}
		const recovered = [];
		for (let s = 0; s < mcSamples; s++) {
			const perturbed = marks.map((m) => {
				const [gx, gy] = gaussianPair(rng);
				return { ...m, x: m.x + gx * clickSigmaPx, y: m.y + gy * clickSigmaPx };
			});
			const fit = fitHomography(
				inlierIdx.map((i) => [perturbed[i].worldX, perturbed[i].worldZ]),
				inlierIdx.map((i) => [perturbed[i].x, perturbed[i].y]),
			);
			const Hinv = mat3Inverse(fit.H);
			const w = mat3Vec(Hinv, [heldOut.x, heldOut.y, 1]);
			recovered.push([w[0] / w[2], w[1] / w[2]]);
		}
		let mx = 0;
		let mz = 0;
		for (const p of recovered) {
			mx += p[0];
			mz += p[1];
		}
		mx /= recovered.length;
		mz /= recovered.length;
		let ss = 0;
		for (const p of recovered) {
			ss += (p[0] - mx) ** 2 + (p[1] - mz) ** 2;
		}
		uncertainty1SigmaM = Math.sqrt(ss / Math.max(1, recovered.length - 1));
	}

	// The verdict: worst severity across the three independent signals; every
	// tripped signal carries its reason code, so "block" always names WHY.
	const reasons = [];
	if (rec.heldOutErrorM > BLOCK_HELDOUT_M) {
		reasons.push({ code: "calibration-heldout-error", severity: "block", value: rec.heldOutErrorM, threshold: BLOCK_HELDOUT_M });
	} else if (rec.heldOutErrorM > WARN_HELDOUT_M) {
		reasons.push({ code: "calibration-heldout-error", severity: "warn", value: rec.heldOutErrorM, threshold: WARN_HELDOUT_M });
	}
	if (rec.inlierRatio < BLOCK_RATIO) {
		reasons.push({ code: "calibration-inliers-low", severity: "block", value: rec.inlierRatio, threshold: BLOCK_RATIO });
	} else if (rec.inlierRatio < WARN_RATIO) {
		reasons.push({ code: "calibration-inliers-low", severity: "warn", value: rec.inlierRatio, threshold: WARN_RATIO });
	}
	if (uncertainty1SigmaM > BLOCK_SIGMA_M) {
		reasons.push({ code: "calibration-uncertainty-high", severity: "block", value: uncertainty1SigmaM, threshold: BLOCK_SIGMA_M });
	} else if (uncertainty1SigmaM > WARN_SIGMA_M) {
		reasons.push({ code: "calibration-uncertainty-high", severity: "warn", value: uncertainty1SigmaM, threshold: WARN_SIGMA_M });
	}
	const level = reasons.some((r) => r.severity === "block")
		? "block"
		: reasons.some((r) => r.severity === "warn")
			? "warn"
			: "ok";

	return {
		...rec,
		uncertainty1SigmaM,
		verdict: { level, reasons },
	};
}
