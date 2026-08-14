#!/usr/bin/env node
// make-calib-fixtures.mjs - C4a fixture build (plan §9.1-§9.3).
//
// Why this exists: the two calibration fixtures are PINNED EVIDENCE, not
// sample data. The generator projects the pinned ring geometry through the
// pinned camera, rounds every observation to 1e-6 px (the plan's rounding),
// applies the fixture's corruption, runs THE estimator (src/ingest/
// calibration.js — the same module the verifier exercises), and persists the
// full enumeration record plus every value the tests assert. The build-time
// invariants B-O1 and B-BG1 are asserted HERE first: if either fails, the
// build exits 1 and the geometry must be re-parameterised (plan §9.1) — a
// fixture is never shipped on an unproven claim.
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { calibrateCamera } from "../../../src/ingest/calibration.js";

const OUT_DIR = fileURLToPath(new URL("../../../test/ingest/fixtures/calibration/", import.meta.url));

// ---------------------------------------------------------------------------
// §9.1 pinned synthetic geometry (shared by both fixtures).
// ---------------------------------------------------------------------------
const K = [[1200, 0, 960], [0, 1200, 540], [0, 0, 1]];
const IMAGE_SIZE = { width: 1920, height: 1080 };
const CENTRE = [0, 2.6, -7.5];
const LOOK_AT = [0, 0, 0.6];
const UP = [0, 1, 0];
const MARKS = [
	{ id: "c0", world: [-3.05, 0, -3.05] },
	{ id: "c1", world: [3.05, 0, -3.05] },
	{ id: "c2", world: [3.05, 0, 3.05] },
	{ id: "c3", world: [-3.05, 0, 3.05] },
	{ id: "e0", world: [0, 0, -3.05] },
	{ id: "e1", world: [3.05, 0, 0] },
	{ id: "e2", world: [0, 0, 3.05] },
	{ id: "e3", world: [-3.05, 0, 0] },
];
const HELDOUT = { id: "h0", world: [0, 0, 0] };

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
const normalize = (v) => {
	const len = Math.hypot(v[0], v[1], v[2]);
	return [v[0] / len, v[1] / len, v[2] / len];
};

// The y-down camera rotation (rows of R_wc, world -> cam): image x right,
// y down, z forward — the same convention K⁻¹·[u,v,1] lives in, so the
// projected pixels and the ray→plane math in ray-plane.js agree with the
// calibration decomposition without any axis flip.
function worldToCamRows(centre, lookAt, up) {
	const z = normalize(sub(lookAt, centre));
	const x = normalize(cross(up, z));
	const y = cross(x, z);
	return [x, y, z];
}

function projectPoint(p) {
	const Rwc = worldToCamRows(CENTRE, LOOK_AT, UP);
	const rel = sub(p, CENTRE);
	const pc = [dot(Rwc[0], rel), dot(Rwc[1], rel), dot(Rwc[2], rel)];
	if (pc[2] <= 0) throw new Error(`point behind camera: ${JSON.stringify(p)}`);
	return [K[0][0] * pc[0] / pc[2] + K[0][2], K[1][1] * pc[1] / pc[2] + K[1][2]];
}

// §9.1: every observation is rounded to 1e-6 px so the fixture's numbers are
// exactly what a JSON round trip preserves.
const round6 = (v) => Math.round(v * 1e6) / 1e6;

// §9.3: the plane similarity A anchored at c0 — uniform scale s about c0
// composed with rotation theta about the plane normal through c0, acting on
// (X, Z) plane coords. c0 is fixed by A, so its observation is unchanged.
// THETA (1.5 deg) is the plan's pinned constant; T-bad-geometry uses
// THETA_BG (6 deg) — the B-BG1 re-parameterisation documented in its
// purpose block (plan §9.3's escape hatch: "s, theta or the corrupted set
// are re-parameterised").
const THETA = 0.0261799; // 1.5 deg — the plan's pinned constant
const THETA_BG = 0.1047198; // 6 deg — the T-bad-geometry re-parameterisation
const SCALE = 1.06;
const ANCHOR = [-3.05, -3.05]; // c0 in (X, Z)
function applySimilarity(p, theta) {
	const dx = p[0] - ANCHOR[0];
	const dz = p[1] - ANCHOR[1];
	const cosT = Math.cos(theta);
	const sinT = Math.sin(theta);
	return [ANCHOR[0] + SCALE * (cosT * dx - sinT * dz), ANCHOR[1] + SCALE * (sinT * dx + cosT * dz)];
}
const applySimilarityBg = (p) => applySimilarity(p, THETA_BG);

// ---------------------------------------------------------------------------
// Clean projections shared by both fixtures.
// ---------------------------------------------------------------------------
const cleanPixels = MARKS.map((m) => {
	const [u, v] = projectPoint(m.world);
	return { x: round6(u), y: round6(v) };
});
const cleanHeldOut = (() => {
	const [u, v] = projectPoint(HELDOUT.world);
	return { id: HELDOUT.id, x: round6(u), y: round6(v) };
})();

const toFitMarks = (pixels) =>
	MARKS.map((m, i) => ({ id: m.id, x: pixels[i].x, y: pixels[i].y, worldX: m.world[0], worldZ: m.world[2] }));
const toHeldOut = (p) => ({ id: HELDOUT.id, x: p.x, y: p.y, worldX: HELDOUT.world[0], worldZ: HELDOUT.world[2] });

// ---------------------------------------------------------------------------
// Fixture definitions and build-time invariant gates.
// ---------------------------------------------------------------------------
const failures = [];
const assert = (fixture, cond, msg) => {
	if (!cond) {
		console.error(`FIXTURE-BUILD-FAIL ${fixture}: ${msg}`);
		failures.push(`${fixture}: ${msg}`);
	}
};
const setEq = (ids, expected) => ids.length === expected.length && [...ids].sort().join(",") === [...expected].sort().join(",");

const FIXTURES = [
	{
		name: "T-outlier",
		file: "calib-outlier.json",
		purpose: "Minority corruption: exactly one mark (e1) displaced by (+30.0, 0.0) px; every other observation exact. The 35 subsets excluding e1 recover the true homography to within 1e-6 px rounding, so rejection must SUCCEED: verdict warn (inlierRatio 0.875 trips warn, not block), e1 excluded from the refit inlier set, held-out error <= 0.02 m. Invariant B-O1.",
		corruption: {
			mode: "minority",
			markIds: ["e1"],
			offsetPx: [30.0, 0.0],
			description: "exactly one mark, e1, displaced by (+30.0, 0.0) px (plan §9.2)",
		},
		observations() {
			return MARKS.map((m, i) => {
				const p = { ...cleanPixels[i] };
				if (m.id === "e1") {
					p.x = round6(cleanPixels[i].x + 30.0);
				}
				return p;
			});
		},
		invariants(rec, obs) {
			const winnerRow = rec.candidates.find((c) => c.ids.join(",") === rec.selectedPreRefit.join(","));
			assert(this.name, winnerRow && winnerRow.inliers === 7, `winner reaches 7 inliers, got ${winnerRow && winnerRow.inliers}`);
			assert(this.name, !rec.selectedPreRefit.includes("e1"), "pre-refit subset must contain no corrupted mark");
			assert(this.name, setEq(rec.postRefitInliers, ["c0", "c1", "c2", "c3", "e0", "e2", "e3"]), `post-refit inliers = ${JSON.stringify(rec.postRefitInliers)}`);
			assert(this.name, !rec.postRefitInliers.includes("e1"), "e1 must be excluded from the refit inlier set");
			assert(this.name, rec.inlierRatio === 0.875, `inlierRatio = ${rec.inlierRatio}`);
			assert(this.name, rec.heldOutErrorM <= 0.02, `held-out error ${rec.heldOutErrorM} > 0.02 m`);
			assert(this.name, rec.verdict.level === "warn", `verdict = ${rec.verdict.level}`);
			assert(this.name, !rec.verdict.reasons.some((r) => r.severity === "block"), `block reason emitted: ${JSON.stringify(rec.verdict.reasons)}`);
			// B-O1: no subset containing e1 reaches >= 7 inliers.
			const e1Rows = rec.candidates.filter((c) => c.ids.includes("e1") && !c.skipped);
			assert(this.name, e1Rows.every((c) => c.inliers < 7), `B-O1 violated: subset containing e1 reached ${Math.max(...e1Rows.map((c) => c.inliers))} inliers`);
			// Deterministic geometry: the corrupted e1 breaks exactly the
			// {c1,e1,c2} collinearity, so 3 ring-edge triples stay collinear
			// (15 skipped candidates); {c1,e1,c2,x} subsets are scored.
			const skipped = rec.candidates.filter((c) => c.skipped);
			assert(this.name, skipped.length === 15, `skipped candidates = ${skipped.length}, expected 15`);
			assert(this.name, rec.candidates.some((c) => c.ids.join(",") === "c1,c2,e0,e1" && !c.skipped), "{c1,c2,e0,e1} must be scored (its collinear triple is broken by the corruption)");
		},
		extra(rec) {
			// C4b round-trip evidence: 50 known floor points inside the ring,
			// projected through the true camera — the ray→plane verifier
			// intersects these exact pixels and must recover the world points
			// within 5 mm (plan §8.2).
			const xs = [-3.0, -1.5, 0, 1.5, 3.0];
			const zs = [];
			for (let k = 0; k < 10; k++) zs.push(-3.0 + (k * 2) / 3);
			const floorPoints = [];
			for (const x of xs) {
				for (const z of zs) {
					const [u, v] = projectPoint([x, 0, z]);
					floorPoints.push({ world: [x, 0, z], pixel: [round6(u), round6(v)] });
				}
			}
			assert(this.name, floorPoints.length === 50, `floorPoints = ${floorPoints.length}`);
			return { floorPoints, boundM: 0.005 };
		},
	},
	{
		name: "T-bad-geometry",
		file: "calib-bad-geometry.json",
		purpose: "Majority corruption: fit marks c1, c2, e0, e1 re-projected through the deliberately wrong planar model H_wrong = H_true ∘ A, where A is the plane similarity s = 1.06, theta = 6 deg anchored at c0 (whose observation A fixes, unchanged) — the realistic operator error of tracing the apron edge instead of the ring boundary. The dominant consensus is WRONG (5 inliers), so robust-model failure detection must fire: verdict block on two INDEPENDENT signals (inlierRatio 0.625 < 0.75; held-out error 0.5019 m computed through the INVERSE map). Invariant B-BG1. RE-PARAMETERISATION (plan §9.3 escape hatch: 'If B-BG1 fails, the build fails and s, theta or the corrupted set are re-parameterised'). At the plan's original theta = 1.5 deg B-BG1 is MATHEMATICALLY UNSATISFIABLE, not merely unmet: A fixes its anchor c0, so the rotated near edge (the A-image of z = -3.05) passes through c0; the mixed model determined by {c1', e0'} (two wrong marks on the rotated near edge) and {c3, e3} (two clean marks on the left edge) therefore maps the corner c0 = near ∩ left to A(near) ∩ left = c0 EXACTLY — a second exact 5-consensus {c0, c1', c3, e0', e3} for ANY anchored similarity. Measured across the re-parameterisation scan: with e3 displaced 30 px, mixed 5-consensi persist at every theta from 1.5 deg to 4 deg, and again at 7.5-8 deg and 12 deg (the near-miss family re-forms) ({c1,c2,c3,e0}-type models keep e1 within 0.5-2.6 px; e3'-models keep a 5th within 1.6-1.8 px). Final re-parameterisation: theta raised to 6 deg (0.1047198 rad) and e3 displaced by an independent (+100.0, 0.0) px; measured at build over all 70 candidates: winner {c0,c2,e0,e1} strict at 5 inliers, every non-selected candidate <= 4 inliers, closest 5th-inlier margin 5.0 px (2.5x the 2 px threshold; maxComp stays 4 across e3 offsets 80-150 px, measured at the pinned theta) (maxCompetingMarginPx > 2, asserted). Held-out error re-pins from the plan.s 0.2677 m to 0.5019 m (ledger delta).",
		corruption: {
			mode: "majority-similarity",
			markIds: ["c0", "c1", "c2", "e0", "e1"],
			similarity: { anchorId: "c0", scale: SCALE, thetaRad: THETA_BG },
			extraDisplacements: [{ id: "e3", offsetPx: [100.0, 0.0] }],
			description: "c1, c2, e0, e1 re-projected through H_wrong = H_true ∘ A with A the plane similarity s = 1.06, theta = 6 deg about c0 (c0 fixed by A, unchanged); e3 displaced by an independent (+100.0, 0.0) px so no mixed model can form a second 5-consensus (B-BG1 repair, plan §9.3)",
		},
		observations() {
			return MARKS.map((m, i) => {
				let x = cleanPixels[i].x;
				let y = cleanPixels[i].y;
				if (this.corruption.markIds.includes(m.id) && m.id !== "c0") {
					const [ax, az] = applySimilarityBg([m.world[0], m.world[2]]);
					const [u, v] = projectPoint([ax, 0, az]);
					x = round6(u);
					y = round6(v);
				}
				const extra = (this.corruption.extraDisplacements || []).find((d) => d.id === m.id);
				if (extra) {
					x = round6(x + extra.offsetPx[0]);
					y = round6(y + extra.offsetPx[1]);
				}
				return { x, y };
			});
		},
		invariants(rec, obs) {
			const winnerRow = rec.candidates.find((c) => c.ids.join(",") === rec.selectedPreRefit.join(","));
			assert(this.name, rec.selectedPreRefit.join(",") === "c0,c2,e0,e1", `pre-refit subset = ${JSON.stringify(rec.selectedPreRefit)}`);
			assert(this.name, winnerRow && winnerRow.inliers === 5, `winner reaches 5 inliers, got ${winnerRow && winnerRow.inliers}`);
			assert(this.name, setEq(rec.postRefitInliers, ["c0", "c1", "c2", "e0", "e1"]), `post-refit inliers = ${JSON.stringify(rec.postRefitInliers)}`);
			assert(this.name, rec.inlierRatio === 0.625, `inlierRatio = ${rec.inlierRatio}`);
			// B-BG1: every non-selected candidate — clean, all-wrong or
			// mixed — has <= 4 inliers, so the winner is strict at 5 and no
			// tie-break is reached. Measured, never assumed (plan §9.3).
			const scored = rec.candidates.filter((c) => !c.skipped);
			const competing = scored.filter((c) => c.ids.join(",") !== rec.selectedPreRefit.join(","));
			assert(this.name, rec.maxCompetingInliers <= 4, `B-BG1 violated: max competing candidate inliers = ${rec.maxCompetingInliers}`);
			assert(this.name, competing.every((c) => c.inliers <= 4), "B-BG1 violated: a non-selected candidate reached > 4 inliers");
			// The margin makes B-BG1 loud: a competitor whose closest
			// non-inlier mark sits barely above 2 px is one rounding away from
			// admitting a 5th inlier — the geometry must keep clear headroom.
			assert(this.name, rec.maxCompetingMarginPx > 2, `B-BG1 margin violated: closest competing 5th-inlier margin = ${rec.maxCompetingMarginPx} px (must be > 2)`);
			assert(this.name, Math.abs(rec.heldOutErrorM - 0.5019) <= 1e-4, `held-out error ${rec.heldOutErrorM} deviates from 0.5019 m`);
			assert(this.name, rec.heldOutErrorM > 0.05, `held-out error ${rec.heldOutErrorM} not > 0.05 m`);
			assert(this.name, rec.verdict.level === "block", `verdict = ${rec.verdict.level}`);
			const codes = rec.verdict.reasons.filter((r) => r.severity === "block").map((r) => r.code);
			assert(this.name, codes.includes("calibration-inliers-low"), `missing block code calibration-inliers-low: ${JSON.stringify(codes)}`);
			assert(this.name, codes.includes("calibration-heldout-error"), `missing block code calibration-heldout-error: ${JSON.stringify(codes)}`);
			// The four wrong-set subsets each contain a collinear triple
			// ({c0,e0,c1} on z = -3.05 or {c1,e1,c2} on x = 3.05) and are
			// skipped; the e3 displacement breaks the {c0,e3,c3} collinearity,
			// so the plan's fifth named subset {c0,c3,e2,e3} is now SCORED.
			const skipNames = ["c0,c1,c2,e0", "c0,c1,c2,e1", "c0,c1,e0,e1", "c1,c2,e0,e1"];
			for (const name of skipNames) {
				const row = rec.candidates.find((c) => c.ids.join(",") === name);
				assert(this.name, row && row.skipped, `${name} must be skipped (collinear triple)`);
			}
			const scoredRow = rec.candidates.find((c) => c.ids.join(",") === "c0,c3,e2,e3");
			assert(this.name, scoredRow && !scoredRow.skipped, "{c0,c3,e2,e3} must be scored (its collinear triple is broken by the e3 displacement)");
			const skipped = rec.candidates.filter((c) => c.skipped);
			assert(this.name, skipped.length === 10, `skipped candidates = ${skipped.length}, expected 10`);
		},
		extra() {
			return null;
		},
	},
];

// ---------------------------------------------------------------------------
// Build.
// ---------------------------------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true });

for (const fx of FIXTURES) {
	const obs = fx.observations();
	const heldOut = { ...cleanHeldOut };
	const rec = calibrateCamera({
		marks: toFitMarks(obs),
		heldOut: toHeldOut(heldOut),
		imageSize: IMAGE_SIZE,
	});

	// The clean control: the estimator must ACCEPT the uncorrupted geometry,
	// or the warn/block verdicts below would prove nothing (a detector that
	// rejects everything detects nothing).
	const cleanRec = calibrateCamera({
		marks: toFitMarks(cleanPixels),
		heldOut: toHeldOut(cleanHeldOut),
		imageSize: IMAGE_SIZE,
	});
	assert(fx.name, cleanRec.inlierRatio === 1, `clean control inlierRatio = ${cleanRec.inlierRatio}`);
	assert(fx.name, cleanRec.verdict.level === "ok", `clean control verdict = ${cleanRec.verdict.level}`);

	fx.invariants(rec, obs);

	const winnerRow = rec.candidates.find((c) => c.ids.join(",") === rec.selectedPreRefit.join(","));
	const extra = fx.extra ? fx.extra(rec) : null;

	const doc = {
		schemaVersion: 1,
		kind: "CalibrationFixture",
		fixture: fx.name,
		purpose: fx.purpose,
		geometry: {
			ringInnerSquareM: 6.1,
			plane: { axis: "Y", origin: [0, 0, 0], normal: [0, 1, 0] },
			camera: {
				centre: CENTRE,
				lookAt: LOOK_AT,
				up: UP,
				K,
				imageSize: IMAGE_SIZE,
				convention: "y-down (OpenCV): image x right, y down, z forward",
			},
			marks: MARKS.map((m) => ({ id: m.id, world: m.world })),
			heldOut: { id: HELDOUT.id, world: HELDOUT.world },
		},
		corruption: fx.corruption,
		observations: { fit: obs.map((p, i) => ({ id: MARKS[i].id, x: p.x, y: p.y })), heldOut },
		cleanObservations: { fit: cleanPixels.map((p, i) => ({ id: MARKS[i].id, x: p.x, y: p.y })), heldOut: cleanHeldOut },
		expected: {
			selectedPreRefit: rec.selectedPreRefit,
			postRefitInliers: rec.postRefitInliers,
			inlierRatio: rec.inlierRatio,
			heldOutErrorM: rec.heldOutErrorM,
			maxCompetingInliers: rec.maxCompetingInliers,
			maxCompetingMarginPx: rec.maxCompetingMarginPx,
			winnerInliers: winnerRow ? winnerRow.inliers : null,
			skippedRows: rec.candidates.filter((c) => c.skipped).length,
			verdict: rec.verdict,
			invariants: fx.name === "T-outlier" ? ["B-O1"] : ["B-BG1"],
		},
		enumeration: {
			count: rec.candidates.length,
			candidates: rec.candidates,
			topCandidates: rec.topCandidates,
			maxCompetingInliers: rec.maxCompetingInliers,
		},
		calibration: {
			K: rec.K,
			R: rec.R,
			t: rec.t,
			f: rec.f,
			reprojRmsPx: rec.reprojRmsPx,
			conditionNumber: rec.conditionNumber,
			uncertainty1SigmaM: rec.uncertainty1SigmaM,
		},
		roundTrip: extra,
	};

	const sha256 = createHash("sha256").update(JSON.stringify(doc)).digest("hex");
	writeFileSync(fileURLToPath(new URL(`../../../test/ingest/fixtures/calibration/${fx.file}`, import.meta.url)), `${JSON.stringify({ ...doc, sha256 }, null, 2)}\n`);

	// The plan §9.4 per-fixture record, printed for the test output.
	console.log(
		`built ${fx.file}: selected=${JSON.stringify(rec.selectedPreRefit)} inliers=${JSON.stringify(rec.postRefitInliers)} ` +
		`ratio=${rec.inlierRatio} heldOutErrorM=${rec.heldOutErrorM} maxCompeting=${rec.maxCompetingInliers} ` +
		`verdict=${rec.verdict.level} sha256=${sha256}`,
	);
}

if (failures.length) {
	console.error(`fixture build FAILED: ${failures.length} invariant(s) violated`);
	process.exit(1);
}
console.log("fixture build OK: B-O1 and B-BG1 satisfied at build time");
