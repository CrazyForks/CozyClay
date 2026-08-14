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
	let worst = 0;
	for (const rs of runner.subjects) {
		const subjectId = SCENE.subjects.find((s) => s.trackId === rs.trackId).subjectId;
		annotation.footWorld.frameIndex.forEach((f, i) => {
			worst = Math.max(worst, dist(rs.rootWorld[f], annotation.footWorld[subjectId][i]));
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
	need(p.gvhmrCommit === "" || /^[0-9a-f]{40}$/.test(p.gvhmrCommit), "gvhmrCommit");
	need(p.weightsSha256 === "" || /^[0-9a-f]{64}$/.test(p.weightsSha256), "weightsSha256");
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
		{ frameIndex: p.to, world: [p.pos[0], SCENE.floorY, p.pos[1]] },
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

// --- fixture internal consistency: the pinned rootWorld equals the annotation ----------

for (const [mode, fx] of Object.entries(fixtures)) {
	let worst = 0;
	for (const s of SCENE.subjects) {
		const fs = fx.subjects.find((x) => x.trackId === s.trackId);
		annotation.footWorld.frameIndex.forEach((f, i) => {
			worst = Math.max(worst, dist(fs.rootWorld[f], annotation.footWorld[s.subjectId][i]));
		});
	}
	ok(
		`fixture ${mode}: rootWorld equals the annotated foot world on every scored frame`,
		worst < 1e-12,
		`maxDiff=${worst.toExponential(3)}`,
	);
}

// --- negative controls: every measurement must fail on known-bad input ----------------

const THRESHOLD = { M3: 0.03, M5: 0.05, M6: 0.08 }; // plan 10.3, contact-head GO branch

// M5: displace A's solved root by 0.10 m on every scored frame; RMS must clear 0.05
const perturbedRoots = structuredClone(chFx);
for (const f of SCENE.scoredFrames) perturbedRoots.subjects[0].rootWorld[f][0] += 0.1;
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
for (const f of SCENE.scoredFrames) widened.subjects[1].rootWorld[f][0] += 0.2;
const m6p = computeMetrics(widened, annotation).M6;
ok(
	"negative control: +0.20 m wider separation pushes M6 above the 0.08 threshold",
	m6p > THRESHOLD.M6,
	`M6=${m6p.toFixed(3)}`,
);

// M3: in-stance root jitter must show up as plant jitter
const jittered = structuredClone(chFx);
for (const f of [10, 15, 20]) jittered.subjects[0].rootWorld[f][0] += f === 15 ? -0.01 : 0.01;
const m3p = computeMetrics(jittered, annotation).M3;
ok("negative control: in-stance root jitter pushes M3 above zero", m3p > 1e-4, `M3=${m3p.toExponential(3)}`);

// the runner must consume the FloorFrame: a wrong floor height moves every solved root
const wrongFloor = { ...floorFrame, floorY: 0.2 };
ok(
	"negative control: wrong floorY shifts contact-head roots off GT",
	maxRootError(solveContactHead(rawTrack, wrongFloor), chFx) > THRESHOLD.M5,
);

// the runner must consume the observations: a 5 px shift of the planted foot moves the root
const shiftedPixels = structuredClone(rawTrack);
shiftedPixels.subjects[0].footObservations2d.left.keypoints[5][0] += 5;
const shiftedRoot = solveContactHead(shiftedPixels, floorFrame).subjects[0].rootWorld[5];
ok(
	"negative control: a 5 px pixel shift moves the solved root",
	dist(shiftedRoot, chFx.subjects[0].rootWorld[5]) > 0.02,
	`moved=${dist(shiftedRoot, chFx.subjects[0].rootWorld[5]).toFixed(3)} m`,
);

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
