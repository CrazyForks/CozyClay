/**
 * F2r — the Phase-0 reproducibility gate (plan §10.2, commit F2r).
 *
 * Why this gate exists: F3's decision is only auditable if the six metrics it
 * consumes can be recomputed, GPU-free, from the pinned solver-output fixtures
 * alone, forever. This file recomputes M1–M6 from the hashed fixtures and
 * asserts they equal the table recorded in tools/ingest/FEASIBILITY.md
 * exactly, so a drifted record or a tampered fixture fails loudly.
 *
 * What would be circular or wrong to assert: importing the runner-side
 * measure.mjs and calling it — a gate that calls the same code it audits
 * proves nothing, so the metrics are reimplemented here, independently, from
 * the fixture JSON only (conventions mirrored from the runner-side
 * measure.mjs: M1 mean over subjects of per-subject contact coverage; M2
 * pooled per-foot TP/(TP+FP) over the 100 label frames; M3 mean over subjects
 * of mean over planted-side contact runs of (stdX + stdZ)/2; M4 counts
 * disagreeing groundTruth entries with a missing observation treated as
 * disagreeing). Skipping the
 * sha256 verification before replay would let an edited fixture silently
 * re-record the table; asserting the table against a hand-typed copy of the
 * same numbers would test nothing. The negative control mutates a fixture
 * and asserts the gate fails on both layers: the hash check and the metric
 * recomputation.
 *
 * This gate is GPU-free and re-runnable forever: `node
 * test/ingest/verify-feasibility-reproducible.mjs`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { decideFeasibility } from "../../tools/ingest/decision.mjs";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

const FIXTURE_DIR = new URL("./fixtures/solver-output/synthetic-boxing-01/", import.meta.url);
const FEASIBILITY_URL = new URL("../../tools/ingest/FEASIBILITY.md", import.meta.url);
const MODE_FILES = ["contact-head", "lowest-foot", "manual-anchor"];

// The fixture's sha256 covers the whole document with the sha256 field itself
// excluded (plan §10.2): hash of JSON.stringify of the parsed document minus
// the sha256 field. That is what the generator hashes, it is invariant to
// file formatting, and it is verified before anything is replayed.

// ---------------------------------------------------------------------------
// Fixture loading: hash verification comes before anything is replayed.
// ---------------------------------------------------------------------------
const readFixture = (name) => {
	const text = readFileSync(new URL(name, FIXTURE_DIR), "utf8");
	return JSON.parse(hashVerify(text, name));
};

// Hash verification is the first thing that touches a fixture; it is separate
// from file reading so the negative control can feed tampered text through it.
const hashVerify = (text, name) => {
	const doc = JSON.parse(text);
	const declared = doc.sha256;
	if (typeof declared !== "string" || !/^[0-9a-f]{64}$/.test(declared)) throw new Error(`${name}: no sha256 field`);
	const { sha256, ...rest } = doc;
	const computed = createHash("sha256").update(JSON.stringify(rest), "utf8").digest("hex");
	if (declared !== computed) {
		throw new Error(`${name}: sha256 mismatch (declared ${declared.slice(0, 12)}…, computed ${computed.slice(0, 12)}…)`);
	}
	return text;
};

// Replay preconditions: a fixture that passes its hash but is structurally
// malformed must still be rejected before any metric touches it. The foot
// truth lives in annotation.json (footWorld), not on the subjects, so only
// the mode fixture's own arrays are checked here.
const validateShape = (doc, name) => {
	if (doc.schemaVersion !== 2) throw new Error(`${name}: schemaVersion ${doc.schemaVersion} !== 2`);
	if (doc.subjects.length !== 2) throw new Error(`${name}: ${doc.subjects.length} subjects, v1 pins exactly two`);
	for (const s of doc.subjects) {
		if (s.rootWorld.length !== doc.frames) throw new Error(`${name}: rootWorld rows ${s.rootWorld.length} !== frames ${doc.frames}`);
		if (s.contactMask.length !== doc.frames) throw new Error(`${name}: contactMask rows ${s.contactMask.length} !== frames ${doc.frames}`);
		if (s.contactMask.some((c) => c.length !== 2)) throw new Error(`${name}: contactMask row not [l,r]`);
	}
	if (doc.frameIndex.length !== doc.frames || doc.timeS.length !== doc.frames) throw new Error(`${name}: frameIndex/timeS rows !== frames`);
	if (doc.separation.scoredFrameIndex.length !== doc.separation.annotatedSeparationM.length) throw new Error(`${name}: scoredFrameIndex/annotatedSeparationM length mismatch`);
};

const rowOf = (frameIndex, f, name) => {
	const i = frameIndex.indexOf(f);
	if (i < 0) throw new Error(`${name}: frame ${f} absent from frameIndex`);
	return i;
};

// The annotation is replayed for M2 (handContact, the 100 label frames) and
// M5 (footWorld, the 20 hand-annotated foot positions). Its frames must be a
// subset of the mode fixture's own frameIndex, and M5's reference frames must
// be exactly the separation frames M6 is scored on, or the two metrics would
// silently disagree about which frames they measure.
const validateAnnotation = (annotation, doc, name) => {
	if (annotation.schemaVersion !== 2) throw new Error(`annotation: schemaVersion ${annotation.schemaVersion} !== 2`);
	if (annotation.clipId !== doc.clipId) throw new Error(`annotation: clipId ${annotation.clipId} !== ${doc.clipId}`);
	const hc = annotation.handContact;
	if (hc.frameIndex.length !== 100) throw new Error(`annotation: ${hc.frameIndex.length} hand-label frames, expected 100`);
	for (const sid of doc.subjects.map((s) => s.subjectId)) {
		if (!hc.label[sid] || hc.label[sid].length !== 100) throw new Error(`annotation: handContact.label.${sid} missing or not 100 rows`);
		if (hc.label[sid].some((row) => row.length !== 2 || row.some((v) => typeof v !== "boolean"))) throw new Error(`annotation: handContact.label.${sid} row not [bool,bool]`);
	}
	const fw = annotation.footWorld;
	if (fw.frameIndex.length !== doc.separation.scoredFrameIndex.length) throw new Error(`annotation: footWorld frames ${fw.frameIndex.length} !== separation frames ${doc.separation.scoredFrameIndex.length}`);
	if (JSON.stringify(fw.frameIndex) !== JSON.stringify(doc.separation.scoredFrameIndex)) throw new Error(`annotation: footWorld.frameIndex !== separation.scoredFrameIndex`);
	for (const sid of doc.subjects.map((s) => s.subjectId)) {
		if (!fw[sid] || fw[sid].length !== fw.frameIndex.length) throw new Error(`annotation: footWorld.${sid} missing or misaligned`);
		if (fw[sid].some((p) => p.length !== 3)) throw new Error(`annotation: footWorld.${sid} row not [x,y,z]`);
	}
	for (const f of [...hc.frameIndex, ...fw.frameIndex]) rowOf(doc.frameIndex, f, name);
};

// ---------------------------------------------------------------------------
// The six metrics, reimplemented here from the fixture JSON alone. Conventions
// mirror the runner-side measure.mjs (see the header); the gate must never
// depend on runner-internal state.
// ---------------------------------------------------------------------------
const recomputeMetrics = (doc, annotation) => {
	const name = `${doc.clipId}/${doc.mode}`;
	validateShape(doc, name);
	validateAnnotation(annotation, doc, name);

	// M1 — contact coverage: mean over subjects of the fraction of the
	// subject's own frames with max(l,r) > 0.5 (the runner-side convention;
	// a "frame with contact" is judged per subject, not as a union over
	// subjects).
	const coverage = (s) =>
		s.contactMask.reduce((n, c) => n + (Math.max(c[0], c[1]) > 0.5 ? 1 : 0), 0) / doc.frames;
	const m1 = (coverage(doc.subjects[0]) + coverage(doc.subjects[1])) / 2;

	// M2 — contact precision vs the 100 hand-labelled frames: pooled per-foot
	// TP/(TP+FP) over (label frame, subject, foot side); a foot is predicted
	// when its own contactMask value exceeds 0.5 and judged against the same
	// foot's label. No predicted contacts score 1.0 (nothing claimed, nothing
	// wrong).
	let tp = 0;
	let fp = 0;
	for (let k = 0; k < annotation.handContact.frameIndex.length; k += 1) {
		const f = annotation.handContact.frameIndex[k];
		const i = rowOf(doc.frameIndex, f, name);
		for (const s of doc.subjects) {
			const c = s.contactMask[i];
			const label = annotation.handContact.label[s.subjectId][k];
			for (let side = 0; side < 2; side += 1) {
				if (c[side] > 0.5) {
					if (label[side]) tp += 1;
					else fp += 1;
				}
			}
		}
	}
	const m2 = tp + fp === 0 ? 1.0 : tp / (tp + fp);

	// M3 — plant jitter: mean over subjects of the mean over contact runs of
	// (stdX + stdZ)/2 of the solved root within the run. A run is a maximal
	// span of consecutive frames where max(l,r) > 0.5 AND the planted side
	// (argmax of l,r; ties plant left) stays constant — a new plant is a new
	// stance even without a contact gap, so the run breaks there too. This
	// mirrors the runner-side measurement exactly (the "std within a contact
	// run" of plan §10.2, as implemented).
	const popStd = (xs) => {
		const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
		return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
	};
	const contactRuns = (s) => {
		const runs = [];
		let cur = null;
		for (let f = 0; f < doc.frames; f += 1) {
			const [l, r] = s.contactMask[f];
			const planted = l >= r ? 0 : 1;
			const active = Math.max(l, r) > 0.5;
			if (active && cur && cur.planted === planted) {
				cur.to = f;
			} else {
				if (cur) runs.push(cur);
				cur = active ? { planted, from: f, to: f } : null;
			}
		}
		if (cur) runs.push(cur);
		return runs;
	};
	const runJitter = (s) => {
		const runs = contactRuns(s);
		if (runs.length === 0) return 0;
		const xs = (run, axis) => {
			const out = [];
			for (let f = run.from; f <= run.to; f += 1) out.push(s.rootWorld[f][axis]);
			return out;
		};
		return runs.reduce((sum, run) => sum + (popStd(xs(run, 0)) + popStd(xs(run, 2))) / 2, 0) / runs.length;
	};
	const m3 = (runJitter(doc.subjects[0]) + runJitter(doc.subjects[1])) / 2;

	// M4 — identity swaps: groundTruth entries, walked ascending frameIndex,
	// whose observation with the same trackId+frameIndex disagrees on
	// assignedSubjectId; a missing observation counts as disagreeing.
	const obsByTrackFrame = new Map(doc.association.observations.map((o) => [`${o.trackId}@${o.frameIndex}`, o]));
	const m4 = doc.association.groundTruth
		.slice()
		.sort((a, b) => a.frameIndex - b.frameIndex)
		.filter((g) => {
			const o = obsByTrackFrame.get(`${g.trackId}@${g.frameIndex}`);
			return !o || o.assignedSubjectId !== g.subjectId;
		}).length;

	// M5 — solved-root RMS vs hand-annotated foot world positions on the 20
	// scored frames: 3D distance between rootWorld[subject][f] and
	// footWorld[subjectId][k], where k indexes the annotation's footWorld
	// frames (asserted equal to separation.scoredFrameIndex) and f is the
	// matching row of the fixture's frameIndex.
	let sq5 = 0;
	let n5 = 0;
	for (let k = 0; k < doc.separation.scoredFrameIndex.length; k += 1) {
		const f = rowOf(doc.frameIndex, doc.separation.scoredFrameIndex[k], name);
		for (const s of doc.subjects) {
			const [x1, y1, z1] = s.rootWorld[f];
			const [x2, y2, z2] = annotation.footWorld[s.subjectId][k];
			sq5 += (x1 - x2) ** 2 + (y1 - y2) ** 2 + (z1 - z2) ** 2;
			n5 += 1;
		}
	}
	const m5 = Math.sqrt(sq5 / n5);

	// M6 — inter-fighter separation error: RMS over scored frames of
	// (|rootWorld_A[f] − rootWorld_B[f]|) − annotatedSeparationM[k].
	const [A, B] = doc.subjects;
	let sq6 = 0;
	for (let k = 0; k < doc.separation.scoredFrameIndex.length; k += 1) {
		const f = rowOf(doc.frameIndex, doc.separation.scoredFrameIndex[k], name);
		const dist = Math.hypot(
			A.rootWorld[f][0] - B.rootWorld[f][0],
			A.rootWorld[f][1] - B.rootWorld[f][1],
			A.rootWorld[f][2] - B.rootWorld[f][2],
		);
		sq6 += (dist - doc.separation.annotatedSeparationM[k]) ** 2;
	}
	const m6 = Math.sqrt(sq6 / doc.separation.scoredFrameIndex.length);

	return { m1, m2, m3, m4, m5, m6 };
};

// ---------------------------------------------------------------------------
// The FEASIBILITY.md record: the machine-readable ```json block is canonical.
// ---------------------------------------------------------------------------
const recordedBlock = () => {
	const text = readFileSync(FEASIBILITY_URL, "utf8");
	const m = text.match(/```json\n([\s\S]*?)\n```/);
	if (!m) throw new Error("FEASIBILITY.md: no ```json block");
	return JSON.parse(m[1]);
};

const approx = (a, b) => Math.abs(a - b) <= 1e-12;

// ---------------------------------------------------------------------------
// Main replay.
// ---------------------------------------------------------------------------
const docs = {};
for (const mode of MODE_FILES) {
	const doc = readFixture(`${mode}.json`);
	docs[mode] = doc;
	ok(`${mode}.json sha256 verified before replay`, true, `schemaVersion ${doc.schemaVersion}, ${doc.frames} frames, clip ${doc.clipId}`);
}
const annotation = readFixture("annotation.json");
ok("annotation.json sha256 verified before replay", true, `clip ${annotation.clipId}`);
ok("annotation clipId matches the fixture clipId", annotation.clipId === docs["contact-head"].clipId,
	`annotation=${annotation.clipId} fixture=${docs["contact-head"].clipId}`);

const record = recordedBlock();
ok("recorded metrics are labelled synthetic", record.synthetic === true, `synthetic=${record.synthetic}`);
ok("recorded fixtureDir matches the pinned path", record.fixtureDir === "test/ingest/fixtures/solver-output/synthetic-boxing-01", record.fixtureDir);

const metricsByMode = {};
for (const mode of MODE_FILES) {
	const m = recomputeMetrics(docs[mode], annotation);
	metricsByMode[mode] = m;
	const rec = record.metrics[mode];
	// The plan's F2r RED names M4 first; the per-mode replay asserts M4 before
	// the mode-dependent metrics so a drifted record fails on the named line.
	ok(`${mode} M4 recomputes to the recorded value`, approx(m.m4, rec.m4), `recomputed=${m.m4} recorded=${rec.m4}`);
	ok(`${mode} M1 recomputes to the recorded value`, approx(m.m1, rec.m1), `recomputed=${m.m1} recorded=${rec.m1}`);
	ok(`${mode} M2 recomputes to the recorded value`, approx(m.m2, rec.m2), `recomputed=${m.m2} recorded=${rec.m2}`);
	ok(`${mode} M3 recomputes to the recorded value`, approx(m.m3, rec.m3), `recomputed=${m.m3} recorded=${rec.m3}`);
	ok(`${mode} M5 recomputes to the recorded value`, approx(m.m5, rec.m5), `recomputed=${m.m5} recorded=${rec.m5}`);
	ok(`${mode} M6 recomputes to the recorded value`, approx(m.m6, rec.m6), `recomputed=${m.m6} recorded=${rec.m6}`);
}

// M1/M2/M4 are mode-independent and the three mode fixtures share
// contactMask/association; a per-mode divergence means the fixture set is not
// the paired set the plan requires.
for (const metric of ["m1", "m2", "m4"]) {
	const values = MODE_FILES.map((mode) => metricsByMode[mode][metric]);
	ok(`mode-independent ${metric.toUpperCase()} agrees across the three fixtures`,
		values.every((v) => approx(v, values[0])), values.join(" vs "));
}

// The §10.3 decision recomputed from the replayed metrics must equal the
// recorded decision, and the operator sign-off must still be blank — a signed
// synthetic record would be a real-footage claim wearing a synthetic label.
const decision = decideFeasibility({
	m1: metricsByMode["contact-head"].m1,
	m2: metricsByMode["contact-head"].m2,
	m4: metricsByMode["contact-head"].m4,
	modes: Object.fromEntries(MODE_FILES.map((mode) => [mode, {
		m3: metricsByMode[mode].m3,
		m5: metricsByMode[mode].m5,
		m6: metricsByMode[mode].m6,
		runnerGreen: true,
		measurementGreen: true,
	}])),
});
ok("recorded decision equals the decision recomputed from the replayed metrics",
	record.decision.verdict === decision.verdict && record.decision.mode === decision.mode &&
	record.decision.degraded === decision.degraded && record.decision.reason === decision.reason,
	`recorded=${JSON.stringify(record.decision)} recomputed=${JSON.stringify(decision)}`);
ok("operator sign-off is blank", record.decision.signOff === "", `signOff=${JSON.stringify(record.decision.signOff)}`);
ok("decision record states no real-footage decision", record.decision.syntheticOnly === true, `syntheticOnly=${record.decision.syntheticOnly}`);

// ---------------------------------------------------------------------------
// The escalation sign-off (plan §14.1) is a SEPARATE decision from §5's
// real-footage operator line. §14.1 wants the escalation itself recorded and
// signed; §5's line must stay blank because signing the synthetic record would
// be a real-footage claim wearing a synthetic label. The danger is that the two
// get conflated later — either by someone filling §5 to "satisfy §14.1", or by
// the escalation block quietly growing footage language. Both directions are
// asserted here so neither can drift in unnoticed.
{
	const doc = readFileSync(new URL("../../tools/ingest/FEASIBILITY.md", import.meta.url), "utf8");
	const block = doc.match(/## 5b\. Stage-A escalation sign-off[\s\S]*?(?=\n## )/);
	ok("FEASIBILITY.md carries the §14.1 escalation sign-off block", block !== null,
		block ? `${block[0].length} chars` : "section 5b absent");

	const text = block ? block[0] : "";
	ok("the escalation block is signed", /\*\*Signed:\*\*\s*\S/.test(text),
		`signed line=${JSON.stringify((text.match(/\*\*Signed:\*\*.*/) || [""])[0])}`);
	ok("the escalation block records F1 as escalated, not satisfied",
		/escalated, not satisfied/.test(text) && /UNRESOLVED/.test(text),
		"expected both 'escalated, not satisfied' and UNRESOLVED");

	// The escalation signature must disclaim footage in the same breath. A
	// signature that merely omits footage language is one edit away from being
	// read as a footage approval.
	ok("the escalation signature disclaims any footage claim",
		/attests to the escalation and to\s+nothing about any footage/.test(text),
		"expected the signature to state what it does NOT attest to");
	ok("the escalation block states no real-footage decision exists",
		/no real-footage GO\/STOP exists/.test(text), "expected an explicit no-decision statement");

	// Non-conflation, the direction that actually bites: the escalation
	// signature must not be reachable through the record's operator field.
	// If someone ever copies it in, §5's blank assertion above fires — but that
	// assertion alone would also fire on an unrelated value, so pin the pair.
	ok("the escalation signature is not reachable via record.decision.signOff",
		record.decision.signOff === "" && !String(record.decision.signOff).includes("GJC"),
		`signOff=${JSON.stringify(record.decision.signOff)}`);
	ok("the synthetic record still declares itself synthetic alongside the escalation",
		record.decision.syntheticOnly === true, `syntheticOnly=${record.decision.syntheticOnly}`);

	// Sensitivity: the block must actually be load-bearing. Strip the signature
	// from a copy and the signed assertion must flip.
	const stripped = text.replace(/\*\*Signed:\*\*[\s\S]*?\n(?=- )/, "");
	ok("negative control: removing the signature makes the signed check fail",
		!/\*\*Signed:\*\*\s*\S/.test(stripped), "stripped copy still matched the signature pattern");
}

// ---------------------------------------------------------------------------
// Negative control: a mutated fixture must fail the gate on both layers.
// ---------------------------------------------------------------------------
{
	// Layer 1 — textual tamper: the declared sha256 no longer matches.
	const text = readFileSync(new URL("contact-head.json", FIXTURE_DIR), "utf8");
	const tampered = text.replace(/"frames":\s*\d+/, '"frames": 99999');
	let rejected = false;
	try {
		hashVerify(tampered, "contact-head.json");
	} catch (e) {
		rejected = /sha256 mismatch/.test(e.message);
	}
	ok("negative control: tampered fixture rejected on sha256", rejected);

	// Layer 2 — in-memory value tamper past the hash check: the recomputed
	// metrics must move, so a gate that verified the hash but compared the
	// metrics against themselves would be caught. The tampered row is a scored
	// frame — the one place a rootWorld edit is guaranteed to feed M5 and M6.
	const mutated = structuredClone(docs["contact-head"]);
	const scored = docs["contact-head"].separation.scoredFrameIndex[0];
	const row = rowOf(docs["contact-head"].frameIndex, scored, "negative control");
	mutated.subjects[0].rootWorld[row][0] += 0.1; // 10 cm of planted-foot drift
	const m = recomputeMetrics(mutated, annotation);
	const rec = record.metrics["contact-head"];
	const moved = !approx(m.m3, rec.m3) || !approx(m.m5, rec.m5) || !approx(m.m6, rec.m6);
	ok("negative control: mutated rootWorld changes M3/M5/M6 vs the record", moved,
		`m3 ${rec.m3} -> ${m.m3}, m5 ${rec.m5} -> ${m.m5}, m6 ${rec.m6} -> ${m.m6}`);
}

console.log("\nrecomputed metrics (from the pinned fixtures):");
for (const mode of MODE_FILES) {
	const m = metricsByMode[mode];
	console.log(`  ${mode}: m1=${m.m1} m2=${m.m2} m4=${m.m4} m3=${m.m3} m5=${m.m5} m6=${m.m6}`);
}

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
