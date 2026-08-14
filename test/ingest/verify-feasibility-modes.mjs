/**
 * F2a-F2c synthetic-GT gate: the three Phase-0 feasibility runners and the M1-M6
 * measurement (plan 10.2, 13).
 *
 * WHY this test exists: the decision function (F3) may only select a mode whose runner AND
 * measurement path are both green, and nobody on this workstation can run GVHMR -- so the
 * only executable proof is a synthetic scene with known roots, contacts, identity and
 * separation, projected through the plan's pinned camera, whose observations the runners
 * must invert exactly. The canonical RED for these commits (plan 13) is "contact-head
 * measurement on synthetic GT: M5 expected 0.000, got 0.412"; the first metric assertion
 * below is that exact check.
 *
 * What would be circular or wrong: deriving the GT from a runner's own output (the GT
 * comes from make-synthetic.mjs scene constants only, and the runners never see it),
 * asserting metrics only on clean input (every measurement has a negative control that
 * must FAIL by design), or trusting a fixture's sha256 without recomputing it (every
 * pinned document is re-hashed here, and the whole set must regenerate byte-for-byte).
 */
import { readFileSync } from "node:fs";
import { buildSyntheticScene, verifySha256, SCENE } from "../../tools/ingest/feasibility/make-synthetic.mjs";
import { solveContactHead } from "../../tools/ingest/feasibility/contact-head.mjs";
import { solveLowestFoot } from "../../tools/ingest/feasibility/lowest-foot.mjs";
import { solveManualAnchor } from "../../tools/ingest/feasibility/manual-anchor.mjs";
import { computeMetrics } from "../../tools/ingest/feasibility/measure.mjs";

const load = (n) =>
	JSON.parse(
		readFileSync(new URL(`./fixtures/solver-output/synthetic-boxing-01/${n}`, import.meta.url), "utf8"),
	);
const rawTrack = load("rawtrack.json");
const floorFrame = load("floorframe.json");
const annotation = load("annotation.json");
const fixtures = {
	"contact-head": load("contact-head.json"),
	"lowest-foot": load("lowest-foot.json"),
	"manual-anchor": load("manual-anchor.json"),
};

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// worst |runnerRoot - fixtureRoot| over every frame of every subject; Infinity if any
// ray was rejected (a null root), because the synthetic control must never reject one
function maxRootError(runner, fixture) {
	let worst = 0;
	for (const rs of runner.subjects) {
		const fs = fixture.subjects.find((x) => x.trackId === rs.trackId);
		for (let f = 0; f < rs.rootWorld.length; f += 1) {
			if (rs.rootWorld[f] === null || fs.rootWorld[f] === null) return Infinity;
			worst = Math.max(worst, dist(rs.rootWorld[f], fs.rootWorld[f]));
		}
	}
	return worst;
}

// worst |runnerRoot - annotatedFootWorld| over the scored frames (the frames M5 uses)
function maxRootErrorVsAnnotation(runner) {
	// annotation.footWorld.frameIndex holds SOURCE frame keys, while the
	// runner's rootWorld is a row array of the emitted slice: the row must
	// come from rawTrack.frameIndex, never from the key itself (the two
	// coincide only on contiguous zero-based fixtures — the hiding place the
	// decimated regressions exist to break)
	const rowOf = new Map(rawTrack.frameIndex.map((f, row) => [f, row]));
	let worst = 0;
	for (const rs of runner.subjects) {
		const subjectId = SCENE.subjects.find((s) => s.trackId === rs.trackId).subjectId;
		annotation.footWorld.frameIndex.forEach((f, i) => {
			const row = rowOf.get(f);
			if (row === undefined) throw new Error(`maxRootErrorVsAnnotation: source frame ${f} absent from rawTrack.frameIndex`);
			worst = Math.max(worst, dist(rs.rootWorld[row], annotation.footWorld[subjectId][i]));
		});
	}
	return worst;
}

// --- pinned fixture integrity ----------------------------------------------------------

for (const [mode, fx] of Object.entries(fixtures)) {
	ok(`fixture ${mode}: sha256 covers the document and verifies`, verifySha256(fx));
}
ok("rawtrack sha256 verifies", verifySha256(rawTrack));
ok("floorframe sha256 verifies", verifySha256(floorFrame));
ok("annotation sha256 verifies", verifySha256(annotation));

function validateSolverOutputFixture(fx) {
	const issues = [];
	const need = (cond, msg) => {
		if (!cond) issues.push(msg);
	};
	need(fx.schemaVersion === 2, "schemaVersion !== 2");
	need(fx.clipId === SCENE.clipId, "clipId mismatch");
	need(["contact-head", "lowest-foot", "manual-anchor"].includes(fx.mode), "mode not in enum");
	need(fx.fps === SCENE.fps, "fps mismatch");
	need(fx.frames === SCENE.frames, "frames mismatch");
	need(fx.frameIndex.length === fx.frames, "frameIndex length");
	need(fx.timeS.length === fx.frames, "timeS length");
	need(
		fx.frameIndex.every((f, i) => i === 0 || f > fx.frameIndex[i - 1]),
		"frameIndex not strictly increasing",
	);
	need(fx.timeS.every((t, f) => Math.abs(t - f / SCENE.fps) < 1e-9), "timeS !== f/fps");
	need(fx.subjects.length === 2, "subjects.length !== 2");
	need(
		fx.subjects.map((s) => s.trackId).sort().join() === "p0,p1",
		"trackIds not exactly p0,p1",
	);
	for (const s of fx.subjects) {
		need(typeof s.subjectId === "string", "subjectId missing");
		need(
			s.rootWorld.length === fx.frames &&
				s.rootWorld.every((p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)),
			`${s.trackId} rootWorld not (F,3) finite`,
		);
		need(s.rootWorld.every((p) => p[1] === 0), `${s.trackId} rootWorld not floor-level`);
		need(
			s.contactMask.length === fx.frames &&
				s.contactMask.every((c) => Array.isArray(c) && c.length === 2 && c.every((v) => v >= 0 && v <= 1)),
			`${s.trackId} contactMask not (F,2) in [0,1]`,
		);
		need(
			s.confidence.length === fx.frames && s.confidence.every(Number.isFinite),
			`${s.trackId} confidence not (F)`,
		);
	}
	need(
		fx.association.observations.length === fx.frames * 2,
		"observations count !== frames*2",
	);
	for (const o of fx.association.observations) {
		need(
			Number.isInteger(o.frameIndex) && typeof o.trackId === "string" && typeof o.assignedSubjectId === "string",
			"observation fields",
		);
		need(["bbox", "mask", "keypoints"].includes(o.evidence), "evidence not in enum");
		need(Array.isArray(o.value), "observation value missing");
	}
	need(
		fx.association.groundTruth.length === SCENE.scoredFrames.length * 2,
		"groundTruth count !== 20 frames * 2",
	);
	for (const g of fx.association.groundTruth) {
		need(
			Number.isInteger(g.frameIndex) && typeof g.trackId === "string" && typeof g.subjectId === "string",
			"groundTruth fields",
		);
	}
	need(
		JSON.stringify(fx.separation.scoredFrameIndex) === JSON.stringify(SCENE.scoredFrames),
		"scoredFrameIndex mismatch",
	);
	need(
		fx.separation.annotatedSeparationM.length === SCENE.scoredFrames.length &&
			fx.separation.annotatedSeparationM.every(Number.isFinite),
		"annotatedSeparationM",
	);
	const p = fx.provenance;
	need(
		p && typeof p.command === "string" && typeof p.sourceUrl === "string" && typeof p.licence === "string",
		"provenance strings",
	);
	need(
		typeof p.sourceSha256 === "string" && (p.sourceSha256 === "" || /^[0-9a-f]{64}$/.test(p.sourceSha256)),
		"sourceSha256",
	);
	need(Number.isFinite(p.trimStartS) && Number.isFinite(p.trimEndS), "trim bounds");
	need(
		p.trimStartS === SCENE.trimStartS && p.trimEndS === SCENE.trimStartS + SCENE.frames / SCENE.fps,
		"trim bounds values",
	);
	// FEASIBILITY.md §1: a synthetic fixture must never be mistaken for a real
	// one — provenance carries synthetic:true and the pinned-solver fields are
	// zero-hex sentinels (never ""), exactly what the §1 promise names.
	need(p.synthetic === true, "provenance.synthetic !== true");
	need(p.gvhmrCommit === "0".repeat(40), "provenance.gvhmrCommit not the 40-hex zero sentinel");
	need(p.weightsSha256 === "0".repeat(64), "provenance.weightsSha256 not the 64-hex zero sentinel");
	need(typeof p.annotationPath === "string" && p.annotationPath.endsWith("annotation.json"), "annotationPath");
	need(typeof fx.sha256 === "string" && /^[0-9a-f]{64}$/.test(fx.sha256), "sha256 format");
	return issues;
}

for (const [mode, fx] of Object.entries(fixtures)) {
	const issues = validateSolverOutputFixture(fx);
	ok(`fixture ${mode}: matches the 10.2 solver-output schema`, issues.length === 0, issues.join("; "));
}

// the fixture set must be exactly what the generator produces today, or F2r's
// reproducibility gate has nothing pinned to replay
const fresh = buildSyntheticScene();
const docs = { rawTrack, floorFrame, annotation, ...fixtures };
const freshDocs = {
	rawTrack: fresh.rawTrack,
	floorFrame: fresh.floorFrame,
	annotation: fresh.annotation,
	...fresh.fixtures,
};
ok(
	"checked-in fixture set is byte-identical to a fresh generation (canonical JSON)",
	Object.entries(docs).every(([k, v]) => JSON.stringify(v) === JSON.stringify(freshDocs[k])),
);

// --- F2a contact-head ----------------------------------------------------------------

const chRunner = solveContactHead(rawTrack, floorFrame);
const chFx = fixtures["contact-head"];
// THE behavioural RED (plan 13): on synthetic GT the solved root equals the annotated
// foot on every scored frame, so M5 must print 0.000
const chMetrics = computeMetrics(chFx, annotation);
ok(
	"contact-head measurement on synthetic GT: M5 expected 0.000",
	Math.abs(chMetrics.M5) < 1e-6,
	`M5=${chMetrics.M5.toFixed(3)}`,
);
ok(
	"contact-head runner reproduces the synthetic GT roots on every frame",
	maxRootError(chRunner, chFx) < 1e-6,
	`maxErr=${maxRootError(chRunner, chFx).toExponential(3)}`,
);
ok("contact-head M1 contact coverage on GT", chMetrics.M1 === 1, `M1=${chMetrics.M1}`);
ok("contact-head M2 contact precision on GT", chMetrics.M2 === 1, `M2=${chMetrics.M2}`);
ok("contact-head M3 plant jitter on GT", chMetrics.M3 < 1e-12, `M3=${chMetrics.M3}`);
ok("contact-head M4 identity swaps on GT", chMetrics.M4 === 0, `M4=${chMetrics.M4}`);
ok("contact-head M6 separation error on GT", chMetrics.M6 < 1e-9, `M6=${chMetrics.M6.toExponential(3)}`);

// --- F2b lowest-foot ------------------------------------------------------------------

const lfRunner = solveLowestFoot(rawTrack, floorFrame);
const lfFx = fixtures["lowest-foot"];
const lfMetrics = computeMetrics(lfFx, annotation);
ok(
	"lowest-foot runner reproduces the synthetic GT roots on every frame",
	maxRootError(lfRunner, lfFx) < 1e-6,
	`maxErr=${maxRootError(lfRunner, lfFx).toExponential(3)}`,
);
ok("lowest-foot M5 on synthetic GT", Math.abs(lfMetrics.M5) < 1e-6, `M5=${lfMetrics.M5.toFixed(3)}`);
ok("lowest-foot M1 contact coverage on GT", lfMetrics.M1 === 1, `M1=${lfMetrics.M1}`);
ok("lowest-foot M2 contact precision on GT", lfMetrics.M2 === 1, `M2=${lfMetrics.M2}`);
ok("lowest-foot M3 plant jitter on GT", lfMetrics.M3 < 1e-12, `M3=${lfMetrics.M3}`);
ok("lowest-foot M4 identity swaps on GT", lfMetrics.M4 === 0, `M4=${lfMetrics.M4}`);
ok("lowest-foot M6 separation error on GT", lfMetrics.M6 < 1e-9, `M6=${lfMetrics.M6.toExponential(3)}`);

// the degraded mode must be contact-blind: flipping every contact value changes nothing
const flippedContacts = structuredClone(rawTrack);
for (const s of flippedContacts.subjects) {
	for (let f = 0; f < flippedContacts.frames; f += 1) {
		const tmp = s.leftContact[f];
		s.leftContact[f] = s.rightContact[f];
		s.rightContact[f] = tmp;
	}
}
ok(
	"lowest-foot ignores contact values by design",
	maxRootError(solveLowestFoot(flippedContacts, floorFrame), lfFx) < 1e-6,
);

// --- F2c manual-anchor ----------------------------------------------------------------

// anchors at every stance start AND end with the stance's own value: a lerp between equal
// values is constant, and a zero-width anchor pair jumps exactly at the plant frame
const anchors = {};
for (const s of SCENE.subjects) {
	anchors[s.trackId] = SCENE.phases[s.trackId].flatMap((p) => [
		{ frameIndex: p.from, world: [p.pos[0], SCENE.floorY, p.pos[1]] },
		// phases close at EXCLUSIVE ends; the take's last source frame is
		// frames-1 and the runner rejects out-of-span anchor keys, so the end
		// anchor clamps there (mirrors make-synthetic.mjs's construction)
		{ frameIndex: Math.min(p.to, SCENE.frames - 1), world: [p.pos[0], SCENE.floorY, p.pos[1]] },
	]);
}
const maRunner = solveManualAnchor(rawTrack, floorFrame, anchors);
const maFx = fixtures["manual-anchor"];
const maMetrics = computeMetrics(maFx, annotation);

// the interpolation math itself, exercised independently of the fixture: halfway between
// a (0, [0,0,0]) and a (10, [1,1,1]) anchor the runner must report exactly [0.5,0.5,0.5],
// and hold the ends outside the first/last anchor
const lerpProbe = solveManualAnchor(rawTrack, floorFrame, {
	p0: [
		{ frameIndex: 0, world: [0, 0, 0] },
		{ frameIndex: 10, world: [1, 1, 1] },
	],
	p1: [
		{ frameIndex: 0, world: [0, 0, 0] },
		{ frameIndex: 10, world: [1, 1, 1] },
	],
}).subjects[0].rootWorld;
ok(
	"manual-anchor interpolates linearly between anchors",
	lerpProbe[5].every((v) => Math.abs(v - 0.5) < 1e-12) &&
		lerpProbe[0].every((v) => v === 0) &&
		lerpProbe[185].every((v) => Math.abs(v - 1) < 1e-12),
	`mid=${lerpProbe[5].join(",")}`,
);
// the input contract: anchors are operator marks, so out-of-order input must be
// REJECTED with a named error, never silently re-sorted -- re-ordering the
// operator's marks hides the mistake the rejection exists to surface
let anchorOrderErr = null;
try {
	solveManualAnchor(rawTrack, floorFrame, {
		p0: [
			{ frameIndex: 34, world: [0, 0, 0] },
			{ frameIndex: 0, world: [1, 1, 1] },
		],
		p1: [
			{ frameIndex: 0, world: [0.7, 0, 0.3] },
			{ frameIndex: 40, world: [0.95, 0, 0.45] },
		],
	});
} catch (e) {
	anchorOrderErr = e;
}
ok(
	"manual-anchor rejects out-of-order anchors (ANCHOR-ORDER) instead of silently re-sorting them",
	anchorOrderErr !== null && anchorOrderErr instanceof Error && /ANCHOR-ORDER/.test(anchorOrderErr.message) && /p0/.test(anchorOrderErr.message),
	anchorOrderErr === null ? "no error thrown: the anchors were silently re-ordered" : `${anchorOrderErr.name}: ${anchorOrderErr.message}`,
);
ok(
	"manual-anchor runner output equals the pinned manual-anchor fixture",
	maxRootError(maRunner, maFx) < 1e-12,
	`maxErr=${maxRootError(maRunner, maFx).toExponential(3)}`,
);
ok(
	"manual-anchor runner reproduces the synthetic GT roots on the scored frames",
	maxRootErrorVsAnnotation(maRunner) < 1e-9,
	`maxErr=${maxRootErrorVsAnnotation(maRunner).toExponential(3)}`,
);
ok("manual-anchor M5 on synthetic GT", Math.abs(maMetrics.M5) < 1e-6, `M5=${maMetrics.M5.toFixed(3)}`);
ok("manual-anchor M1 contact coverage on GT", maMetrics.M1 === 1, `M1=${maMetrics.M1}`);
ok("manual-anchor M2 contact precision on GT", maMetrics.M2 === 1, `M2=${maMetrics.M2}`);
ok("manual-anchor M3 plant jitter on GT", maMetrics.M3 < 1e-12, `M3=${maMetrics.M3}`);
ok("manual-anchor M4 identity swaps on GT", maMetrics.M4 === 0, `M4=${maMetrics.M4}`);
ok("manual-anchor M6 separation error on GT", maMetrics.M6 < 1e-9, `M6=${maMetrics.M6.toExponential(3)}`);
// --- F2c decimated manual-anchor: anchor keys are SOURCE frames, rows are
// --- positions. A trimmed/decimated rawTrack (the operator path) breaks the
// --- row == source-frame coincidence the pinned fixtures hide; the runner
// --- must evaluate every emitted row at its own source frame and
// --- interpolate between anchors in source-key space. Reverting to
// --- row-position comparison holds the first anchor on every row below it
// --- and this block fails — the regression lock for that defect.
{
	// five emitted rows covering source frames 10..26 (trim + stride 4): the
	// max source key exceeds the row count, so row/ID conflation is visible
	const decimatedTrack = {
		schemaVersion: 1,
		clipId: "manual-anchor-decimated-probe",
		fps: 29.97,
		frames: 5,
		frameIndex: [10, 14, 18, 22, 26],
		timeS: [10, 14, 18, 22, 26].map((f) => f / 29.97),
		subjects: [
			{
				trackId: "p0",
				footObservations2d: { left: { keypoints: [] }, right: { keypoints: [] } },
				leftContact: [],
				rightContact: [],
			},
		],
	};
	// anchors are operator marks on the FOOTAGE: source frame 10 -> x=0,
	// source frame 26 -> x=2, a linear ramp in source-key space
	const decAnchors = {
		p0: [
			{ frameIndex: 10, world: [0, 0, 0] },
			{ frameIndex: 26, world: [2, 0, 0] },
		],
	};
	const decRoots = solveManualAnchor(decimatedTrack, floorFrame, decAnchors).subjects[0].rootWorld;
	const rampX = (f) => ((f - 10) / (26 - 10)) * 2;
	ok(
		"decimated manual-anchor: every emitted row interpolates at its own source frame",
		decimatedTrack.frameIndex.every((f, row) => {
			const p = decRoots[row];
			return p !== undefined && Math.abs(p[0] - rampX(f)) < 1e-12 && p[1] === 0 && p[2] === 0;
		}),
		decRoots.map((p, row) => `row${row}(src${decimatedTrack.frameIndex[row]})=${p ? p[0].toFixed(3) : "?"}`).join(" "),
	);
	// an anchor key BRACKETED by the track's source keys but not an emitted
	// row (source frame 16 sits between emitted keys 14 and 18) is accepted,
	// and the interpolant runs between the bracketing anchor keys
	const bracketed = solveManualAnchor(decimatedTrack, floorFrame, {
		p0: [
			{ frameIndex: 10, world: [0, 0, 0] },
			{ frameIndex: 16, world: [1, 0, 0] },
			{ frameIndex: 26, world: [3, 0, 0] },
		],
	}).subjects[0].rootWorld;
	ok(
		"decimated manual-anchor: an anchor key bracketed by the track's source keys is accepted",
		bracketed.every((p) => Array.isArray(p) && p.every(Number.isFinite)),
		bracketed.map((p) => (p ? p[0].toFixed(3) : "?")).join(" "),
	);
	ok(
		"decimated manual-anchor: the interpolant runs in source-key space between bracketing anchors",
		Math.abs(bracketed[1][0] - (0 + ((14 - 10) / (16 - 10)) * 1)) < 1e-12 &&
			Math.abs(bracketed[2][0] - (1 + ((18 - 16) / (26 - 16)) * 2)) < 1e-12 &&
			Math.abs(bracketed[3][0] - (1 + ((22 - 16) / (26 - 16)) * 2)) < 1e-12,
		`src14=${bracketed[1][0].toFixed(4)} src18=${bracketed[2][0].toFixed(4)} src22=${bracketed[3][0].toFixed(4)}`,
	);
	// an anchor key OUTSIDE the track's source-key span is operator error:
	// rejected with the named error, never clamped or silently held
	for (const [badKey, where, pair] of [
		// keep each pair non-decreasing so the SPAN check (not ANCHOR-ORDER)
		// is the invariant under test
		[5, "below", [{ frameIndex: 5, world: [0, 0, 0] }, { frameIndex: 26, world: [2, 0, 0] }]],
		[30, "above", [{ frameIndex: 10, world: [0, 0, 0] }, { frameIndex: 30, world: [2, 0, 0] }]],
	]) {
	let spanErr = null;
	try {
		solveManualAnchor(decimatedTrack, floorFrame, { p0: pair });
	} catch (e) {
			spanErr = e;
		}
		ok(
			`decimated manual-anchor: anchor key ${badKey} (${where} the track's source keys) rejected with ANCHOR-OUT-OF-SPAN`,
			spanErr !== null && spanErr instanceof Error && /ANCHOR-OUT-OF-SPAN/.test(spanErr.message),
			spanErr === null ? "no error thrown: the out-of-span anchor was accepted" : spanErr.message,
		);
	}
}

// --- duplicate anchor keys resolve to the LATER anchor at every position ------
//
// The module documents "input order decides ties (the later anchor wins)". The
// hold-the-ends branch used to fire before a zero-width pair was considered, so
// mid-list and end-list duplicates resolved to the later anchor while a pair at
// the take START resolved to the earlier one -- position-dependent semantics,
// and the jump landed one frame late exactly where a stance boundary matters.
// The rule is only meaningful if it holds at all three positions.
{
	const solve = (p0) => solveManualAnchor(rawTrack, floorFrame, {
		p0,
		p1: [{ frameIndex: 0, world: [9, 0, 0] }, { frameIndex: 185, world: [9, 0, 0] }],
	}).subjects[0].rootWorld;

	const start = solve([
		{ frameIndex: 0, world: [0, 0, 0] },
		{ frameIndex: 0, world: [5, 0, 0] },
		{ frameIndex: 185, world: [15, 0, 0] },
	]);
	ok("duplicate anchors at the take START resolve to the later anchor",
		Math.abs(start[0][0] - 5) < 1e-9, `row0 x=${start[0][0]}, expected 5`);

	const end = solve([
		{ frameIndex: 0, world: [0, 0, 0] },
		{ frameIndex: 185, world: [10, 0, 0] },
		{ frameIndex: 185, world: [15, 0, 0] },
	]);
	ok("duplicate anchors at the take END resolve to the later anchor",
		Math.abs(end[185][0] - 15) < 1e-9, `row185 x=${end[185][0]}, expected 15`);

	const mid = solve([
		{ frameIndex: 0, world: [0, 0, 0] },
		{ frameIndex: 90, world: [1, 0, 0] },
		{ frameIndex: 90, world: [7, 0, 0] },
		{ frameIndex: 185, world: [15, 0, 0] },
	]);
	ok("duplicate anchors MID-list resolve to the later anchor",
		Math.abs(mid[90][0] - 7) < 1e-9, `row90 x=${mid[90][0]}, expected 7`);
}

// --- fixture internal consistency: the pinned rootWorld equals the annotation ----------

for (const [mode, fx] of Object.entries(fixtures)) {
	// annotation.footWorld.frameIndex entries are SOURCE frame keys; the
	// fixture's rootWorld is a row array, so the row comes from the fixture's
	// own frameIndex, never from the key (they coincide only on the pinned
	// contiguous fixtures — the class this audit exists to close)
	const rowOf = new Map(fx.frameIndex.map((f, row) => [f, row]));
	let worst = 0;
	for (const s of SCENE.subjects) {
		const fs = fx.subjects.find((x) => x.trackId === s.trackId);
		annotation.footWorld.frameIndex.forEach((f, i) => {
			const row = rowOf.get(f);
			if (row === undefined) throw new Error(`fixture ${mode}: source frame ${f} absent from frameIndex`);
			worst = Math.max(worst, dist(fs.rootWorld[row], annotation.footWorld[s.subjectId][i]));
		});
	}
	ok(
		`fixture ${mode}: rootWorld equals the annotated foot world on every scored frame`,
		worst < 1e-12,
		`maxDiff=${worst.toExponential(3)}`,
	);
}

// --- negative controls: every measurement must fail on known-bad input ----------------

const THRESHOLD = { M1: 0.6, M2: 0.85, M3: 0.03, M5: 0.05, M6: 0.08 }; // plan 10.3, contact-head GO branch

// SCENE.scoredFrames / SCENE.handContactFrames hold SOURCE keys, while
// rootWorld / contactMask are row arrays of the emitted slice: a mutation row
// must come from chFx.frameIndex, never from the key itself (the two coincide
// only on the pinned contiguous fixture — the hiding place the decimated
// negative controls below exist to break).
const rowOf = new Map(chFx.frameIndex.map((f, row) => [f, row]));
// M5: displace A's solved root by 0.10 m on every scored frame; RMS must clear 0.05
const perturbedRoots = structuredClone(chFx);
for (const f of SCENE.scoredFrames) perturbedRoots.subjects[0].rootWorld[rowOf.get(f)][0] += 0.1;
const m5p = computeMetrics(perturbedRoots, annotation).M5;
ok(
	"negative control: +0.10 m root perturbation pushes M5 above the 0.05 GO threshold",
	m5p > THRESHOLD.M5,
	`M5=${m5p.toFixed(3)}`,
);

// M4: one swapped identity label on a scored frame must register a swap
const swappedIdentity = structuredClone(chFx);
const badObs = swappedIdentity.association.observations.find(
	(o) => o.frameIndex === SCENE.scoredFrames[0] && o.trackId === "p0",
);
badObs.assignedSubjectId = "B";
const m4p = computeMetrics(swappedIdentity, annotation).M4;
ok("negative control: a swapped identity label pushes M4 above 0", m4p > 0, `M4=${m4p}`);

// M6: widen B's solved roots by 0.20 m on every scored frame; RMS must clear 0.08
const widened = structuredClone(chFx);
for (const f of SCENE.scoredFrames) widened.subjects[1].rootWorld[rowOf.get(f)][0] += 0.2;
const m6p = computeMetrics(widened, annotation).M6;
ok(
	"negative control: +0.20 m wider separation pushes M6 above the 0.08 threshold",
	m6p > THRESHOLD.M6,
	`M6=${m6p.toFixed(3)}`,
);

// M3: in-stance root jitter must show up as plant jitter
const jittered = structuredClone(chFx);
for (const f of [10, 15, 20]) jittered.subjects[0].rootWorld[rowOf.get(f)][0] += f === 15 ? -0.01 : 0.01;
const m3p = computeMetrics(jittered, annotation).M3;
ok("negative control: in-stance root jitter pushes M3 above zero", m3p > 1e-4, `M3=${m3p.toExponential(3)}`);
// M1: erase every contact on 75 frames that are NOT among the 100 hand-labelled
// ones (both subjects), so M2 -- which judges only those 100 frames -- cannot
// move. Coverage = (186-75)/186 = 0.597 per subject, below the 0.60 GO branch.
const unlabelledFrames = Array.from({ length: SCENE.frames }, (_, f) => f).filter(
	(f) => !SCENE.handContactFrames.includes(f),
);
const contactErased = structuredClone(chFx);
for (const f of unlabelledFrames.slice(0, 75)) {
	for (const s of contactErased.subjects) s.contactMask[rowOf.get(f)] = [0, 0];
}
const m1p = computeMetrics(contactErased, annotation);
ok(
	"negative control: erasing contacts on 75 unlabelled frames pushes M1 below the 0.60 GO threshold",
	m1p.M1 < THRESHOLD.M1 && m1p.M1 < 1,
	`M1=${m1p.M1.toFixed(4)}`,
);
ok(
	"negative control: the M1 mutation leaves M2 and M3 untouched",
	m1p.M2 === 1 && m1p.M3 < 1e-12,
	`M2=${m1p.M2}, M3=${m1p.M3.toExponential(3)}`,
);

// M2: on 36 of the 100 hand-labelled frames, raise the swing foot's contact to
// 0.51 on both subjects -- one false positive per foot. tp stays 200 (planted
// predictions untouched) so precision = 200/272 = 0.735, below the 0.85 GO
// branch. 0.51 stays below the planted 0.93, so the planted side (argmax) and
// M1's "any contact above 0.5" are both unchanged.
const falsePositives = structuredClone(chFx);
for (const f of SCENE.handContactFrames.slice(0, 36)) {
	for (const s of falsePositives.subjects) {
		const c = s.contactMask[rowOf.get(f)];
		if (c[0] < c[1]) c[0] = 0.51;
		else c[1] = 0.51;
	}
}
const m2p = computeMetrics(falsePositives, annotation);
ok(
	"negative control: swing-foot false positives on 36 labelled frames push M2 below the 0.85 GO threshold",
	m2p.M2 < THRESHOLD.M2 && m2p.M2 < 1,
	`M2=${m2p.M2.toFixed(4)}`,
);
ok(
	"negative control: the M2 mutation leaves M1 and M3 untouched",
	m2p.M1 === 1 && m2p.M3 < 1e-12,
	`M1=${m2p.M1}, M3=${m2p.M3.toExponential(3)}`,
);

// --- decimated negative controls: the mutations above index row arrays by
// --- source keys; on the pinned contiguous fixture the two coincide, which
// --- is the hiding place. A decimated fixture (25 rows over source keys
// --- [0,3,...,72]) breaks the coincidence: key 9 is NOT row 9. These
// --- controls lock the mapped-row semantics AND that each mutation still
// --- flips exactly its own metric while the others stay put.
{
	const dFrameIndex = Array.from({ length: 25 }, (_, i) => i * 3); // keys 0..72, 25 rows
	const dScored = [6, 15, 24]; // rows 2, 5, 8
	const dHand = [9, 21]; // rows 3, 7
	const dMk = (subjectId, trackId, x) => ({
		subjectId, trackId,
		rootWorld: Array.from({ length: dFrameIndex.length }, () => [x, 0, 0]),
		// alternate planted side every row: every contact run is a singleton,
		// so a root perturbation can never move M3
		contactMask: Array.from({ length: dFrameIndex.length }, (_, r) => (r % 2 === 0 ? [1, 0] : [0, 1])),
		confidence: Array.from({ length: dFrameIndex.length }, () => 1),
	});
	const dFx = {
		schemaVersion: 2, clipId: "decimated-negative-controls", mode: "contact-head", fps: 29.97,
		frames: dFrameIndex.length, frameIndex: dFrameIndex,
		timeS: dFrameIndex.map((f) => f / 29.97),
		subjects: [dMk("A", "p0", 0), dMk("B", "p1", 2)],
		association: { observations: [], groundTruth: [] },
		separation: { scoredFrameIndex: dScored, annotatedSeparationM: dScored.map(() => 2) },
	};
	const dAnn = {
		handContact: {
			frameIndex: dHand,
			// odd rows plant right, so the labels mirror the predictions
			label: { A: [[false, true], [false, true]], B: [[false, true], [false, true]] },
		},
		footWorld: {
			frameIndex: dScored,
			A: dScored.map(() => [0, 0, 0]),
			B: dScored.map(() => [2, 0, 0]),
		},
	};
	const dRowOf = new Map(dFrameIndex.map((f, row) => [f, row]));
	const dScoredRows = dScored.map((f) => dRowOf.get(f));
	const dHandRows = dHand.map((f) => dRowOf.get(f));
	// every key must differ from its own row AND stay in-bounds as an index,
	// so a key-indexed mutation lands on the wrong row instead of crashing
	ok("decimated negative controls: every source key differs from its row",
		dScored.every((f, i) => f !== dScoredRows[i]) && dHand.every((f, i) => f !== dHandRows[i]),
		`scored ${dScored.join(",")} -> rows ${dScoredRows.join(",")}; hand ${dHand.join(",")} -> rows ${dHandRows.join(",")}`);
	const dBase = computeMetrics(dFx, dAnn);
	ok("decimated negative controls: base fixture measures ideal values",
		dBase.M1 === 1 && dBase.M2 === 1 && dBase.M3 === 0 && Math.abs(dBase.M5) < 1e-12 && Math.abs(dBase.M6) < 1e-12,
		`M1=${dBase.M1} M2=${dBase.M2} M3=${dBase.M3} M5=${dBase.M5} M6=${dBase.M6}`);

	// M5: the same +0.10 m perturbation as the pinned control, on the decimated fixture
	const dPerturbed = structuredClone(dFx);
	for (const f of dScored) dPerturbed.subjects[0].rootWorld[dRowOf.get(f)][0] += 0.1;
	const dM5p = computeMetrics(dPerturbed, dAnn);
	ok(
		"decimated negative control: +0.10 m root perturbation at the MAPPED scored rows pushes M5 above the 0.05 GO threshold",
		dM5p.M5 > THRESHOLD.M5,
		`M5=${dM5p.M5.toFixed(3)}`,
	);
	ok(
		"decimated negative control: exactly the mapped scored rows carry the M5 perturbation",
		dPerturbed.subjects[0].rootWorld.every((p, r) => Math.abs(p[0] - (dScoredRows.includes(r) ? 0.1 : 0)) < 1e-12),
		dPerturbed.subjects[0].rootWorld.map((p, r) => `row${r}(key${dFrameIndex[r]})=${p[0].toFixed(2)}`).join(" "),
	);
	ok(
		// M5 and M6 share the root positions: displacing A's roots moves the
		// A-B separation by definition, so the invariant set is the metrics
		// whose inputs the mutation never touches (contacts, and runs stay
		// singleton so M3 cannot move either)
		"decimated negative control: the M5 mutation leaves M1, M2 and M3 untouched",
		dM5p.M1 === 1 && dM5p.M2 === 1 && dM5p.M3 === 0,
		`M1=${dM5p.M1} M2=${dM5p.M2} M3=${dM5p.M3}`,
	);
	ok(
		"decimated negative control: M6 moves only through the shared root positions",
		Math.abs(dM5p.M6 - 0.1) < 1e-9,
		`M6=${dM5p.M6}`,
	);

	// M6: the same +0.20 m widening as the pinned control
	const dWidened = structuredClone(dFx);
	for (const f of dScored) dWidened.subjects[1].rootWorld[dRowOf.get(f)][0] += 0.2;
	const dM6p = computeMetrics(dWidened, dAnn);
	ok(
		"decimated negative control: +0.20 m wider separation at the MAPPED scored rows pushes M6 above the 0.08 threshold",
		dM6p.M6 > THRESHOLD.M6,
		`M6=${dM6p.M6.toFixed(3)}`,
	);
	ok(
		"decimated negative control: exactly the mapped scored rows carry the M6 widening",
		dWidened.subjects[1].rootWorld.every((p, r) => Math.abs(p[0] - (dScoredRows.includes(r) ? 2.2 : 2)) < 1e-12),
		dWidened.subjects[1].rootWorld.map((p, r) => `row${r}(key${dFrameIndex[r]})=${p[0].toFixed(2)}`).join(" "),
	);
	ok(
		// the same coupling as the M5 control: widening B's roots moves B's
		// root-vs-annotation RMS (M5) by exactly the shared-input amount
		"decimated negative control: the M6 mutation leaves M1, M2 and M3 untouched",
		dM6p.M1 === 1 && dM6p.M2 === 1 && dM6p.M3 === 0,
		`M1=${dM6p.M1} M2=${dM6p.M2} M3=${dM6p.M3}`,
	);
	ok(
		"decimated negative control: M5 moves only through the shared root positions",
		Math.abs(dM6p.M5 - Math.sqrt(0.02)) < 1e-9,
		`M5=${dM6p.M5}`,
	);

	// M2: the same swing-foot false positives as the pinned control, at the
	// decimated fixture's hand-labelled rows
	const dFalsePositives = structuredClone(dFx);
	for (const f of dHand) {
		for (const s of dFalsePositives.subjects) {
			const c = s.contactMask[dRowOf.get(f)];
			if (c[0] < c[1]) c[0] = 0.51;
			else c[1] = 0.51;
		}
	}
	const dM2p = computeMetrics(dFalsePositives, dAnn);
	ok(
		"decimated negative control: swing-foot false positives at the MAPPED labelled rows push M2 below the 0.85 GO threshold",
		dM2p.M2 < THRESHOLD.M2 && dM2p.M2 < 1,
		`M2=${dM2p.M2.toFixed(4)}`,
	);
	ok(
		"decimated negative control: exactly the mapped handContact rows carry the false positives",
		dFalsePositives.subjects.every((s) => s.contactMask.every((c, r) =>
			dHandRows.includes(r) ? (c[0] === 0.51 && c[1] === 1) : (r % 2 === 0 ? c[0] === 1 && c[1] === 0 : c[0] === 0 && c[1] === 1))),
		dFalsePositives.subjects.map((s) => `${s.trackId}: ${s.contactMask.map((c, r) => `r${r}=${c.join("/")}`).join(" ")}`).join("  "),
	);
	ok(
		"decimated negative control: the M2 mutation leaves M1, M3, M5 and M6 untouched",
		dM2p.M1 === 1 && dM2p.M3 === 0 && Math.abs(dM2p.M5) < 1e-12 && Math.abs(dM2p.M6) < 1e-12,
		`M1=${dM2p.M1} M3=${dM2p.M3} M5=${dM2p.M5} M6=${dM2p.M6}`,
	);
}

// the runner must consume the FloorFrame: a wrong floor height moves every solved root
const wrongFloor = { ...floorFrame, floorY: 0.2 };
ok(
	"negative control: wrong floorY shifts contact-head roots off GT",
	maxRootError(solveContactHead(rawTrack, wrongFloor), chFx) > THRESHOLD.M5,
);

// the runner must consume the observations: a 5 px shift of the planted foot moves the root
const shiftedPixels = structuredClone(rawTrack);
shiftedPixels.subjects[0].footObservations2d.left.keypoints[rowOf.get(5)][0] += 5;
const shiftedRoot = solveContactHead(shiftedPixels, floorFrame).subjects[0].rootWorld[rowOf.get(5)];
ok(
	"negative control: a 5 px pixel shift moves the solved root",
	dist(shiftedRoot, chFx.subjects[0].rootWorld[rowOf.get(5)]) > 0.02,
	`moved=${dist(shiftedRoot, chFx.subjects[0].rootWorld[rowOf.get(5)]).toFixed(3)} m`,
);

// --- degenerate input: 0/0 must surface as undefined with a reason, never as
// --- a fabricated pass. The red-team defect: empty frames with an empty
// --- annotation read as M2=1 / M3=0 / M4=0 — a degenerate fixture that looks
// --- like a passing measurement. Every denominator-less metric must be
// --- undefined (with reasons naming the missing sample base), and consumers
// --- must check that explicitly instead of coercing undefined to 0.
{
	const emptyFixture = {
		frames: 0,
		subjects: [
			{ subjectId: "A", trackId: "p0", rootWorld: [], contactMask: [], confidence: [] },
			{ subjectId: "B", trackId: "p1", rootWorld: [], contactMask: [], confidence: [] },
		],
		separation: { scoredFrameIndex: [], annotatedSeparationM: [] },
		association: { observations: [], groundTruth: [] },
	};
	const emptyAnn = {
		handContact: { frameIndex: [], label: { A: [], B: [] } },
		footWorld: { frameIndex: [], A: [], B: [] },
	};
	const degen = computeMetrics(emptyFixture, emptyAnn);
	const undefWithReason = (m, key) => m[key] === undefined && typeof m.reasons[key] === "string";
	ok("degenerate input: M1 undefined with a reason, not a fabricated 0/0", undefWithReason(degen, "M1"), `M1=${degen.M1}`);
	ok("degenerate input: M2 undefined with a reason, not the 0/0->1 convention", undefWithReason(degen, "M2"), `M2=${degen.M2}`);
	ok("degenerate input: M3 undefined with a reason, not a vacuous 0", undefWithReason(degen, "M3"), `M3=${degen.M3}`);
	ok("degenerate input: M4 undefined with a reason, not a vacuous 0", undefWithReason(degen, "M4"), `M4=${degen.M4}`);
	ok("degenerate input: M5 undefined with a reason, not a fabricated 0/0", undefWithReason(degen, "M5"), `M5=${degen.M5}`);
	ok("degenerate input: M6 undefined with a reason, not a fabricated 0/0", undefWithReason(degen, "M6"), `M6=${degen.M6}`);
	ok("degenerate input: reasons name the missing sample base",
		Object.keys(degen.reasons).sort().join() === "M1,M2,M3,M4,M5,M6" &&
		typeof degen.reasons.M3 === "string" && /run/i.test(degen.reasons.M3) &&
		typeof degen.reasons.M4 === "string" && /groundTruth/i.test(degen.reasons.M4) &&
		typeof degen.reasons.M2 === "string" && /label/i.test(degen.reasons.M2),
		JSON.stringify(degen.reasons));
	// the well-formed control still measures: the pinned fixture must NOT go
	// undefined just because the degenerate path exists
	const control = computeMetrics(chFx, annotation);
	ok("degenerate-input control: well-formed fixture still measures finite numbers",
		[control.M1, control.M2, control.M3, control.M4, control.M5, control.M6].every((v) => typeof v === "number" && Number.isFinite(v)),
		`M1=${control.M1} M2=${control.M2} M3=${control.M3} M4=${control.M4} M5=${control.M5} M6=${control.M6}`);
}

// ---------------------------------------------------------------------------
// Decimated fixture: source frame IDs are NOT row offsets.
//
// Every checked-in fixture uses a contiguous zero-based frameIndex, so a source
// ID happens to equal its row position and a measurement that indexes arrays
// directly by frame ID looks correct. A trimmed/decimated dump -- which the
// operator path now legitimately produces -- breaks that coincidence. This is
// the regression lock for that defect: without it, reverting the row mapping in
// measure.mjs passes the entire suite.
// ---------------------------------------------------------------------------
{
	// six emitted rows covering source frames 6,8,10,12,14,16 (trim + stride 2)
	const frameIndex = [6, 8, 10, 12, 14, 16];
	const rows = frameIndex.length;
	// A stands still at x=0, B at x=2, so separation is exactly 2 m on every row:
	// a correct measurement returns M5 = M6 = 0, and any row/ID mix-up either
	// throws or reads a row that does not exist.
	const mk = (subjectId, trackId, x) => ({
		subjectId, trackId,
		rootWorld: Array.from({ length: rows }, () => [x, 0, 0]),
		contactMask: Array.from({ length: rows }, () => [1, 0]),
		confidence: Array.from({ length: rows }, () => 1),
	});
	const decimated = {
		schemaVersion: 2, clipId: "decimated-probe", mode: "contact-head", fps: 29.97, frames: rows,
		frameIndex, timeS: frameIndex.map((f) => f / 29.97),
		subjects: [mk("A", "p0", 0), mk("B", "p1", 2)],
		association: { observations: [], groundTruth: [] },
		separation: { scoredFrameIndex: [8, 12, 16], annotatedSeparationM: [2, 2, 2] },
	};
	const ann = {
		handContact: { frameIndex: [8, 12], label: { A: [[true, false], [true, false]], B: [[true, false], [true, false]] } },
		footWorld: { frameIndex: [8, 12, 16], A: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B: [[2, 0, 0], [2, 0, 0], [2, 0, 0]] },
	};

	// the bug is only observable when an ID can exceed the row count
	ok("decimated fixture: max source frame ID exceeds the emitted row count",
		Math.max(...frameIndex) > rows, `max=${Math.max(...frameIndex)} rows=${rows}`);

	const m = computeMetrics(decimated, ann);
	ok("decimated fixture: M2 is 1 (every predicted contact is labelled true on its own row)", m.M2 === 1, `M2=${m.M2}`);
	ok("decimated fixture: M5 is 0 (roots sit exactly on the annotated foot positions)", Math.abs(m.M5) < 1e-12, `M5=${m.M5}`);
	ok("decimated fixture: M6 is 0 (separation is exactly the annotated 2 m)", Math.abs(m.M6) < 1e-12, `M6=${m.M6}`);

	// a scored frame absent from frameIndex is malformed, not silently row 0
	const orphan = { ...decimated, separation: { scoredFrameIndex: [7], annotatedSeparationM: [2] } };
	let threw = false;
	try {
		computeMetrics(orphan, ann);
	} catch (e) {
		threw = /absent from frameIndex/.test(e.message);
	}
	ok("decimated fixture: a scored frame absent from frameIndex is rejected, not read as row 0", threw);
}

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
