/**
 * C4b: the ray→plane intersection (plan §8.2) — how a planted-foot pixel
 * becomes a world position.
 *
 * Why this test exists: the intersection is the last step between a clicked
 * foot and a fighter standing on the floor, so a silently wrong intersection
 * is a silently wrong fighter placement. The pinned camera comes from the
 * C4a calibration fixture (the clean T-outlier model — the same K/R/t a
 * FloorFrame would carry), and the 50 floor-point round trips are the
 * fixture's own projected pixels, so this verifier exercises the exact
 * numbers the rest of the pipeline will consume.
 *
 * The three rejection modes are the point of the test: a ray parallel to the
 * floor (|d_ring.y| < 1e-6) NEVER meets it and must be rejected BY NAME —
 * approximating it would invent a floor crossing that does not exist; a
 * ray pointing away from the floor (λ ≤ 0) meets the plane behind the ray
 * origin; a degenerate plane normal makes the plane itself undefined. Each
 * has a negative control: the parallel/away pixels DO lie inside the image
 * (they are real rays, not synthetic nonsense), the λ = 0 boundary is
 * asserted on both sides, and a singular K must be rejected rather than
 * propagate NaN. The round-trip < 5 mm bound proves the happy path, and the
 * held-out ring-centre pixel ties back to C4a: the clean calibration's
 * h0 pixel unprojects to the ring centre.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { rayPlaneIntersect } from "../../src/ingest/ray-plane.js";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/calibration/${name}`, import.meta.url), "utf8"));
const canonical = (doc) => {
	const { sha256, ...rest } = doc;
	return JSON.stringify(rest);
};
const sha256Of = (doc) => createHash("sha256").update(canonical(doc)).digest("hex");

// The clean calibration (T-outlier) carries the recovered K/R/t — the
// FloorFrame-equivalent camera — plus the 50 round-trip floor points.
const doc = load("calib-outlier.json");
const K = doc.calibration.K;
const R = doc.calibration.R;
const t = doc.calibration.t;
const FLOOR_Y = 0;

ok("fixture sha256 pin (T-outlier)", sha256Of(doc) === doc.sha256, doc.sha256);
ok("round-trip evidence present", Array.isArray(doc.roundTrip.floorPoints) && doc.roundTrip.floorPoints.length === 50,
	`${doc.roundTrip.floorPoints.length} floor points, bound ${doc.roundTrip.boundM} m`);

// ---------------------------------------------------------------------------
// 1. The happy path: 50 known floor points round-trip within 5 mm (plan
//    §8.2 C4b). The pixels are the generator's projections; the intersection
//    must recover the world points they were projected from.
// ---------------------------------------------------------------------------
{
	let worst = 0;
	let worstPt = null;
	for (const fp of doc.roundTrip.floorPoints) {
		let point;
		try {
			point = rayPlaneIntersect({ pixel: fp.pixel, K, R, t, floorY: FLOOR_Y }).point;
		} catch (e) {
			ok(`round-trip ${JSON.stringify(fp.world)}: unexpected rejection ${e.message}`, false);
			continue;
		}
		const err = Math.hypot(point[0] - fp.world[0], point[1] - fp.world[1], point[2] - fp.world[2]);
		if (err > worst) {
			worst = err;
			worstPt = fp;
		}
	}
	ok("50 floor points round-trip < 5 mm", worst < doc.roundTrip.boundM,
		`worst ${(worst * 1000).toFixed(4)} mm at ${JSON.stringify(worstPt && worstPt.world)}`);
}

// ---------------------------------------------------------------------------
// 2. The C4a tie: the clean calibration's held-out pixel unprojects to the
//    ring centre — the same camera, the same h0, now through the ray path.
// ---------------------------------------------------------------------------
{
	const p = rayPlaneIntersect({ pixel: [doc.observations.heldOut.x, doc.observations.heldOut.y], K, R, t, floorY: FLOOR_Y }).point;
	const err = Math.hypot(p[0], p[1], p[2]);
	ok("held-out h0 pixel unprojects to the ring centre within 5 mm", err < doc.roundTrip.boundM, `${(err * 1000).toFixed(4)} mm`);
}

// ---------------------------------------------------------------------------
// 3. Parallel rays: pixels on the floor's vanishing line map to rays with
//    d_ring.y = 0 — they never meet the floor and must be REJECTED by name,
//    never approximated. The canonical RED of this stage (plan §13): a
//    non-rejecting implementation returns a point here.
// ---------------------------------------------------------------------------
{
	// The vanishing line: d_cam = normalize((0, R[1][2], -R[1][1])) has
	// d_ring.y = R[1]·d_cam = R[1][1]·R[1][2] - R[1][2]·R[1][1] = 0 exactly.
	// All pixels on that row are parallel to the floor (R[1][0] = 0 for the
	// pinned camera, so d_x never enters d_ring.y).
	const dz = -R[1][1];
	const dy = R[1][2];
	const len = Math.hypot(dy, dz);
	const [u, v] = [K[0][2] + (K[0][0] * 0) / dz, K[1][2] + (K[1][1] * dy / len) / (dz / len)];
	for (const ux of [K[0][2] - 320, K[0][2], K[0][2] + 320]) {
		let point = null;
		let code = null;
		try {
			const r = rayPlaneIntersect({ pixel: [ux, v], K, R, t, floorY: FLOOR_Y });
			point = r.point;
		} catch (e) {
			code = e.message;
		}
		ok(`parallel ray at pixel (${ux}, ${v.toFixed(2)}): expected reject, returned a point`,
			code !== null && /ray-parallel-to-plane/.test(code), code || JSON.stringify(point));
	}
}

// ---------------------------------------------------------------------------
// 4. Rays pointing away from the plane: pixels above the vanishing line
//    (u_y < v) map to rays whose floor meeting point sits behind the ray
//    origin (λ ≤ 0) — rejected by name. Both pixels are inside the image.
// ---------------------------------------------------------------------------
{
	for (const uy of [100, 0]) {
		let code = null;
		let point = null;
		try {
			const r = rayPlaneIntersect({ pixel: [K[0][2], uy], K, R, t, floorY: FLOOR_Y });
			point = r.point;
		} catch (e) {
			code = e.message;
		}
		ok(`away ray at pixel (${K[0][2]}, ${uy}): expected reject, returned a point`,
			code !== null && /ray-away-from-plane/.test(code), code || JSON.stringify(point));
	}
	// The λ = 0 boundary: a floor plane through the camera centre meets the
	// ray exactly at the origin — λ = 0 is a rejection (λ <= 0), and the
	// plane just below it must intersect normally.
	let boundaryCode = null;
	try {
		rayPlaneIntersect({ pixel: [K[0][2], K[1][2]], K, R, t, floorY: t[1] });
	} catch (e) {
		boundaryCode = e.message;
	}
	ok("lambda=0 boundary: floorY at the camera centre is rejected (lambda <= 0)",
		boundaryCode !== null && /ray-away-from-plane/.test(boundaryCode), boundaryCode || "returned a point");
	const below = rayPlaneIntersect({ pixel: [K[0][2], K[1][2]], K, R, t, floorY: t[1] - 0.001 });
	ok("lambda>0 side: floorY just below the camera centre returns a point", Number.isFinite(below.point[0]) && Number.isFinite(below.point[1]) && Number.isFinite(below.point[2]), JSON.stringify(below.point));
}

// ---------------------------------------------------------------------------
// 5. Degenerate plane normals: a zero-length or non-finite normal makes the
//    plane undefined — rejected by name, never intersected.
// ---------------------------------------------------------------------------
for (const [label, normal, floorY] of [
	["zero-length normal", [0, 0, 0], FLOOR_Y],
	["NaN normal", [NaN, 1, 0], FLOOR_Y],
	["non-finite floorY", [0, 1, 0], NaN],
]) {
	let code = null;
	try {
		rayPlaneIntersect({ pixel: [K[0][2], K[1][2]], K, R, t, floorY, planeNormal: normal });
	} catch (e) {
		code = e.message;
	}
	ok(`degenerate plane: ${label} rejected by name`, code !== null && /plane-normal-degenerate/.test(code), code || "returned a point");
}

// ---------------------------------------------------------------------------
// 6. Degenerate intrinsics: a singular K cannot produce a ray — rejecting
//    beats propagating NaN into a "point".
// ---------------------------------------------------------------------------
{
	let code = null;
	try {
		rayPlaneIntersect({ pixel: [K[0][2], K[1][2]], K: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], R, t, floorY: FLOOR_Y });
	} catch (e) {
		code = e.message;
	}
	ok("singular K rejected by name", code !== null && /camera-intrinsics-degenerate/.test(code), code || "returned a point");
	let code2 = null;
	try {
		rayPlaneIntersect({ pixel: [NaN, K[1][2]], K, R, t, floorY: FLOOR_Y });
	} catch (e) {
		code2 = e.message;
	}
	ok("non-finite pixel rejected by name", code2 !== null && /ray-plane-input/.test(code2), code2 || "returned a point");
}

// ---------------------------------------------------------------------------
// 7. Determinism: the same ray always lands on the same point.
// ---------------------------------------------------------------------------
{
	const a = rayPlaneIntersect({ pixel: doc.roundTrip.floorPoints[0].pixel, K, R, t, floorY: FLOOR_Y });
	const b = rayPlaneIntersect({ pixel: doc.roundTrip.floorPoints[0].pixel, K, R, t, floorY: FLOOR_Y });
	ok("intersection is deterministic", JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a.point));
}

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
