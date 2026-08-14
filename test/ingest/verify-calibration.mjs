/**
 * C4a: the calibration estimator (plan §9) — exhaustive C(N,4) minimal-sample
 * search with deterministic scoring, on the two pinned fixtures.
 *
 * Why this test exists: the estimator is the gate between "raw pixels" and
 * "world metres" — a silently wrong calibration is a silently wrong fighter
 * placement. The two fixtures prove the estimator's robustness SUCCEEDS on
 * minority corruption (T-outlier: the corrupted mark is rejected, verdict
 * warn, NOT block) and its failure detection FIRES on majority corruption
 * (T-bad-geometry: the dominant consensus is wrong, verdict block on two
 * INDEPENDENT signals). A design where both fixtures merely "fail" would
 * prove nothing — the divergence between the two outcomes IS the proof, and
 * each fixture carries its build-time invariant asserted here BY NAME
 * (B-O1: no subset containing the corrupted mark reaches the winner's
 * consensus; B-BG1: every non-selected candidate has ≤ 4 inliers).
 *
 * What would be circular: asserting the estimator against a re-implementation
 * of its own literals, or trusting the fixture's numbers because the fixture
 * says so. Every fixture is pinned by its sha256 (a tampered fixture fails
 * before any check replays), every persisted value is asserted against the
 * PLAN's bounds (0.875, 0.625, ≤ 0.02 m, 0.5019 ± 1e-4 m, verdict strings),
 * and the estimator is re-run on the fixture's observations and must
 * reproduce the persisted record exactly — a drifted estimator fails even
 * though both sides would "agree" with each other. The clean-observation
 * control (verdict must be ok, ratio 1.0) proves the warn/block verdicts are
 * detections, not defaults.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { calibrateCamera } from "../../src/ingest/calibration.js";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/calibration/${name}`, import.meta.url), "utf8"));
// Canonical form: the parsed document minus the sha256 field, stringified —
// the same form the generator hashes, so the pin is stable across builds.
const canonical = (doc) => {
	const { sha256, ...rest } = doc;
	return JSON.stringify(rest);
};
const sha256Of = (doc) => createHash("sha256").update(canonical(doc)).digest("hex");

const outlier = load("calib-outlier.json");
const badGeometry = load("calib-bad-geometry.json");

// ---------------------------------------------------------------------------
// 1. Identity gates: the sha256 pins fail FIRST, before anything replays.
// ---------------------------------------------------------------------------
for (const [name, doc] of [["T-outlier", outlier], ["T-bad-geometry", badGeometry]]) {
	ok(`${name}: sha256 pin`, sha256Of(doc) === doc.sha256, `declared ${doc.sha256}`);
	ok(`${name}: fixture identity`, doc.kind === "CalibrationFixture" && doc.schemaVersion === 1 && doc.expected.invariants.length > 0, JSON.stringify({ fixture: doc.fixture, invariants: doc.expected.invariants }));
}

// ---------------------------------------------------------------------------
// 2. Input assembly and recomputation helpers.
// ---------------------------------------------------------------------------
const fitMarksOf = (doc) =>
	doc.geometry.marks.map((m, i) => ({
		id: m.id,
		x: doc.observations.fit[i].x,
		y: doc.observations.fit[i].y,
		worldX: m.world[0],
		worldZ: m.world[2],
	}));
const heldOutOf = (doc) => ({
	id: doc.geometry.heldOut.id,
	x: doc.observations.heldOut.x,
	y: doc.observations.heldOut.y,
	worldX: doc.geometry.heldOut.world[0],
	worldZ: doc.geometry.heldOut.world[2],
});
const cleanMarksOf = (doc) =>
	doc.geometry.marks.map((m, i) => ({
		id: m.id,
		x: doc.cleanObservations.fit[i].x,
		y: doc.cleanObservations.fit[i].y,
		worldX: m.world[0],
		worldZ: m.world[2],
	}));
const runCalib = (doc, over = {}) =>
	calibrateCamera({ marks: fitMarksOf(doc), heldOut: heldOutOf(doc), imageSize: doc.geometry.camera.imageSize, ...over });

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameIdSet = (a, b) => a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

// Recompute must reproduce the persisted record: same module, same input,
// same doubles. Any drift — a changed DLT, a changed ranking, a changed
// tie-break — fails here with the offending field named.
const compareRecord = (doc, label, rec) => {
	const e = doc.expected;
	ok(`${label}: recompute reproduces pre-refit subset`, sameIds(rec.selectedPreRefit, e.selectedPreRefit), JSON.stringify(rec.selectedPreRefit));
	ok(`${label}: recompute reproduces post-refit inliers`, sameIds(rec.postRefitInliers, e.postRefitInliers), JSON.stringify(rec.postRefitInliers));
	ok(`${label}: recompute reproduces inlierRatio`, rec.inlierRatio === e.inlierRatio, `${rec.inlierRatio}`);
	ok(`${label}: recompute reproduces heldOutErrorM`, near(rec.heldOutErrorM, e.heldOutErrorM), `${rec.heldOutErrorM}`);
	ok(`${label}: recompute reproduces maxCompetingInliers`, rec.maxCompetingInliers === e.maxCompetingInliers, `${rec.maxCompetingInliers}`);
	ok(`${label}: recompute reproduces maxCompetingMarginPx`, near(rec.maxCompetingMarginPx, e.maxCompetingMarginPx), `${rec.maxCompetingMarginPx}`);
	ok(`${label}: recompute reproduces verdict level`, rec.verdict.level === e.verdict.level, rec.verdict.level);
	ok(`${label}: recompute reproduces verdict reasons`, rec.verdict.reasons.length === e.verdict.reasons.length &&
		rec.verdict.reasons.every((r, i) => r.code === e.verdict.reasons[i].code && r.severity === e.verdict.reasons[i].severity &&
			near(r.value, e.verdict.reasons[i].value) && near(r.threshold, e.verdict.reasons[i].threshold)), JSON.stringify(rec.verdict.reasons));
	ok(`${label}: recompute reproduces candidate table (${doc.enumeration.count} rows)`,
		rec.candidates.length === doc.enumeration.candidates.length &&
		rec.candidates.every((c, i) => {
			const p = doc.enumeration.candidates[i];
			return sameIds(c.ids, p.ids) && c.skipped === p.skipped && c.inliers === p.inliers &&
				near(c.sse, p.sse) && (c.skipped || near(c.margin, p.margin));
		}), "70 rows: ids/skipped/inliers/sse/margin all match");
	ok(`${label}: recompute reproduces recovered camera`, near(rec.f, doc.calibration.f) &&
		rec.K.every((row, i) => row.every((v, j) => near(v, doc.calibration.K[i][j], 1e-6))) &&
		rec.R.every((row, i) => row.every((v, j) => near(v, doc.calibration.R[i][j], 1e-6))) &&
		rec.t.every((v, i) => near(v, doc.calibration.t[i], 1e-6)), `f=${rec.f}`);
	ok(`${label}: recompute reproduces quality signals`, near(rec.reprojRmsPx, doc.calibration.reprojRmsPx) &&
		near(rec.conditionNumber, doc.calibration.conditionNumber) &&
		near(rec.uncertainty1SigmaM, doc.calibration.uncertainty1SigmaM), `reprojRms=${rec.reprojRmsPx} cond=${rec.conditionNumber} 1σ=${rec.uncertainty1SigmaM}`);
};

// ---------------------------------------------------------------------------
// 3. Enumeration-table integrity: 70 rows, every C(8,4) subset exactly once,
//    in the deterministic lexicographic order, with the per-row shape.
// ---------------------------------------------------------------------------
const combos = [];
{
	const n = 8;
	const k = 4;
	const idx = [0, 1, 2, 3];
	while (true) {
		combos.push([...idx]);
		let i = k - 1;
		while (i >= 0 && idx[i] === n - k + i) i--;
		if (i < 0) break;
		idx[i]++;
		for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
	}
}
for (const [name, doc] of [["T-outlier", outlier], ["T-bad-geometry", badGeometry]]) {
	const ids = doc.geometry.marks.map((m) => m.id);
	const rows = doc.enumeration.candidates;
	ok(`${name}: exactly 70 candidates`, doc.enumeration.count === 70 && rows.length === 70, `${rows.length}`);
	ok(`${name}: every C(8,4) subset appears exactly once`,
		rows.length === combos.length &&
		combos.every((c, i) => sameIds(rows[i].ids, c.map((j) => ids[j]))), "lexicographic index order");
	ok(`${name}: row shape`, rows.every((r) => r.skipped
		? r.inliers === null && r.sse === null && r.margin === undefined
		: Number.isInteger(r.inliers) && r.inliers >= 0 && r.inliers <= 8 && Number.isFinite(r.sse) && r.sse >= 0 && Number.isFinite(r.margin) && r.margin >= 0));
}

// ---------------------------------------------------------------------------
// 4. T-outlier: minority corruption ⇒ successful rejection, verdict warn.
//    Invariant B-O1, asserted BY NAME.
// ---------------------------------------------------------------------------
{
	const doc = outlier;
	const e = doc.expected;
	const rec = runCalib(doc);
	compareRecord(doc, "T-outlier", rec);

	// The canonical RED of this stage: the estimator must reject the
	// corrupted mark — a subset containing e1 may never reach the winner's
	// 7-inlier consensus (B-O1).
	const e1Rows = doc.enumeration.candidates.filter((c) => !c.skipped && c.ids.includes("e1"));
	const maxE1 = Math.max(...e1Rows.map((c) => c.inliers));
	ok("T-outlier B-O1: no subset containing e1 reaches >= 7 inliers", maxE1 < 7, `max e1-subset inliers = ${maxE1}`);

	ok("T-outlier: winner carries 7 inliers", e.winnerInliers === 7, `${e.winnerInliers}`);
	ok("T-outlier: pre-refit subset contains no corrupted mark", !e.selectedPreRefit.includes("e1"), JSON.stringify(e.selectedPreRefit));
	ok("T-outlier: post-refit inlier set is the 7 clean marks", sameIdSet(e.postRefitInliers, ["c0", "c1", "c2", "c3", "e0", "e2", "e3"]), JSON.stringify(e.postRefitInliers));
	ok("T-outlier: e1 excluded from the refit inlier set", !e.postRefitInliers.includes("e1"), JSON.stringify(e.postRefitInliers));
	ok("T-outlier: inlierRatio === 0.875", e.inlierRatio === 0.875, `${e.inlierRatio}`);
	ok("T-outlier: held-out world error <= 0.02 m", e.heldOutErrorM <= 0.02, `${e.heldOutErrorM} m`);
	ok("T-outlier: verdict is warn, NOT block", e.verdict.level === "warn", e.verdict.level);
	ok("T-outlier: no block reason code emitted", !e.verdict.reasons.some((r) => r.severity === "block"), JSON.stringify(e.verdict.reasons));

	// Deterministic geometry: e1's displacement breaks exactly the
	// {c1,e1,c2} collinearity; the other three ring-edge triples stay
	// collinear (15 skipped rows), and {c1,c2,e0,e1} — whose collinear
	// triple is the broken one — must be scored, not skipped.
	ok("T-outlier: 15 candidates skipped (3 intact ring-edge triples)", e.skippedRows === 15, `${e.skippedRows}`);
	const skippedSet = new Set(doc.enumeration.candidates.filter((c) => c.skipped).map((c) => c.ids.join(",")));
	ok("T-outlier: {c0,c1,e0,e1} skipped (c0,e0,c1 collinear)", skippedSet.has("c0,c1,e0,e1"));
	ok("T-outlier: {c0,c3,e2,e3} skipped (c0,e3,c3 collinear)", skippedSet.has("c0,c3,e2,e3"));
	ok("T-outlier: {c1,c2,e0,e1} scored (its collinear triple is the corrupted one)", !skippedSet.has("c1,c2,e0,e1"));
}

// ---------------------------------------------------------------------------
// 5. T-bad-geometry: dominant wrong consensus ⇒ block on two independent
//    signals. Invariant B-BG1, asserted BY NAME.
// ---------------------------------------------------------------------------
{
	const doc = badGeometry;
	const e = doc.expected;
	const rec = runCalib(doc);
	compareRecord(doc, "T-bad-geometry", rec);

	// The canonical RED of this stage (plan §13): B-BG1 must fail loudly if
	// a competing candidate ever reaches the winner's consensus.
	const maxComp = rec.maxCompetingInliers;
	ok(`T-bad-geometry: max competing candidate inliers expected <=4, got ${maxComp} (B-BG1 violated)`, maxComp <= 4, `measured maxCompetingInliers=${maxComp}`);
	const competing = rec.candidates.filter((c) => !c.skipped && c.ids.join(",") !== e.selectedPreRefit.join(","));
	ok("T-bad-geometry B-BG1: every non-selected candidate has <= 4 inliers", competing.every((c) => c.inliers <= 4), `worst=${Math.max(...competing.map((c) => c.inliers))}`);
	// The margin makes B-BG1 loud: the closest non-selected candidate's
	// would-be 5th inlier must sit clear of the 2 px threshold, or the
	// consensus is one rounding away from admitting it.
	ok("T-bad-geometry B-BG1: closest competing 5th-inlier margin > 2 px", rec.maxCompetingMarginPx > 2, `${rec.maxCompetingMarginPx.toFixed(2)} px`);

	ok("T-bad-geometry: winner is the plan's pinned subset", sameIds(e.selectedPreRefit, ["c0", "c2", "e0", "e1"]), JSON.stringify(e.selectedPreRefit));
	ok("T-bad-geometry: winner carries 5 inliers", e.winnerInliers === 5, `${e.winnerInliers}`);
	ok("T-bad-geometry: post-refit inlier set is exactly the wrong-consistent set", sameIdSet(e.postRefitInliers, ["c0", "c1", "c2", "e0", "e1"]), JSON.stringify(e.postRefitInliers));
	ok("T-bad-geometry: inlierRatio === 0.625", e.inlierRatio === 0.625, `${e.inlierRatio}`);
	ok("T-bad-geometry: held-out error = 0.5019 m +- 1e-4", Math.abs(e.heldOutErrorM - 0.5019) <= 1e-4, `${e.heldOutErrorM} m`);
	ok("T-bad-geometry: held-out error > 0.05 m (block signal 2)", e.heldOutErrorM > 0.05, `${e.heldOutErrorM} m`);
	ok("T-bad-geometry: verdict is block", e.verdict.level === "block", e.verdict.level);
	const blockCodes = e.verdict.reasons.filter((r) => r.severity === "block").map((r) => r.code);
	ok("T-bad-geometry: block code calibration-inliers-low present", blockCodes.includes("calibration-inliers-low"), JSON.stringify(blockCodes));
	ok("T-bad-geometry: block code calibration-heldout-error present", blockCodes.includes("calibration-heldout-error"), JSON.stringify(blockCodes));

	// The four wrong-set subsets each contain a collinear triple and are
	// skipped; the e3 displacement breaks {c0,e3,c3}, so the plan's fifth
	// named subset {c0,c3,e2,e3} is scored now (B-BG1 repair).
	const skippedSet = new Set(doc.enumeration.candidates.filter((c) => c.skipped).map((c) => c.ids.join(",")));
	for (const name of ["c0,c1,c2,e0", "c0,c1,c2,e1", "c0,c1,e0,e1", "c1,c2,e0,e1"]) {
		ok(`T-bad-geometry: ${name} skipped (collinear triple)`, skippedSet.has(name));
	}
	ok("T-bad-geometry: {c0,c3,e2,e3} scored (e3 displacement broke its collinearity)", !skippedSet.has("c0,c3,e2,e3"));
	ok("T-bad-geometry: 10 candidates skipped (2 intact ring-edge triples)", e.skippedRows === 10, `${e.skippedRows}`);
}

// ---------------------------------------------------------------------------
// 6. The two fixtures must diverge — a design where both merely "fail"
//    (or both pass) proves nothing.
// ---------------------------------------------------------------------------
ok("distinct outcomes: T-outlier warn vs T-bad-geometry block",
	outlier.expected.verdict.level === "warn" && badGeometry.expected.verdict.level === "block",
	`${outlier.expected.verdict.level} vs ${badGeometry.expected.verdict.level}`);
ok("distinct outcomes: 7 vs 5 inliers, 0.875 vs 0.625 ratio",
	outlier.expected.winnerInliers === 7 && badGeometry.expected.winnerInliers === 5 &&
	outlier.expected.inlierRatio === 0.875 && badGeometry.expected.inlierRatio === 0.625,
	`${outlier.expected.winnerInliers}/${badGeometry.expected.winnerInliers} inliers`);
ok("distinct outcomes: held-out error below warn threshold vs above block threshold",
	outlier.expected.heldOutErrorM <= 0.02 && badGeometry.expected.heldOutErrorM > 0.05,
	`${outlier.expected.heldOutErrorM} m vs ${badGeometry.expected.heldOutErrorM} m`);

// ---------------------------------------------------------------------------
// 7. Negative controls: the estimator must ACCEPT clean geometry, or the
//    warn/block verdicts above would be defaults, not detections.
// ---------------------------------------------------------------------------
for (const [name, doc] of [["T-outlier", outlier], ["T-bad-geometry", badGeometry]]) {
	const clean = calibrateCamera({ marks: cleanMarksOf(doc), heldOut: heldOutOf(doc), imageSize: doc.geometry.camera.imageSize });
	ok(`${name} clean control: inlierRatio === 1`, clean.inlierRatio === 1, `${clean.inlierRatio}`);
	ok(`${name} clean control: verdict is ok`, clean.verdict.level === "ok", clean.verdict.level);
}

// ---------------------------------------------------------------------------
// 8. Determinism (plan §9: "Determinism is the point"): the same input must
//    always produce the same chosen subset, and the winner must not depend
//    on the input ORDER of the marks (the scoring and the tie-break are
//    order-independent by design — only the recorded array order follows
//    the input).
// ---------------------------------------------------------------------------
{
	const doc = outlier;
	const a = runCalib(doc);
	const b = runCalib(doc);
	ok("determinism: repeated runs are byte-identical", JSON.stringify(a) === JSON.stringify(b));

	const shuffled = fitMarksOf(doc).slice().reverse();
	const perm = calibrateCamera({ marks: shuffled, heldOut: heldOutOf(doc), imageSize: doc.geometry.camera.imageSize });
	ok("determinism: permuted input order picks the same winner subset",
		sameIdSet(perm.selectedPreRefit, a.selectedPreRefit) && sameIdSet(perm.postRefitInliers, a.postRefitInliers) &&
		perm.inlierRatio === a.inlierRatio && near(perm.heldOutErrorM, a.heldOutErrorM) &&
		perm.maxCompetingInliers === a.maxCompetingInliers && perm.verdict.level === a.verdict.level &&
		perm.verdict.reasons.length === a.verdict.reasons.length,
		`winner=${JSON.stringify(perm.selectedPreRefit)}`);
}

// ---------------------------------------------------------------------------
// 9. Operator-supplied K path (plan §9: "or from an operator-supplied K"):
//    with the true K pinned, the focal length is exact and the recovered
//    pose matches the estimated-K run.
// ---------------------------------------------------------------------------
{
	const doc = outlier;
	const rec = runCalib(doc, { K: doc.geometry.camera.K });
	ok("operator K: f is exactly the supplied value", rec.f === 1200, `${rec.f}`);
	const est = runCalib(doc);
	ok("operator K: same winner and pose as the estimated-K run",
		sameIds(rec.selectedPreRefit, est.selectedPreRefit) &&
		rec.R.every((row, i) => row.every((v, j) => near(v, est.R[i][j], 1e-6))) &&
		rec.t.every((v, i) => near(v, est.t[i], 1e-6)) && near(rec.heldOutErrorM, est.heldOutErrorM, 1e-6),
		`f=${rec.f} heldOut=${rec.heldOutErrorM}`);
}

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
