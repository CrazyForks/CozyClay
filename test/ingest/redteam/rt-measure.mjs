/**
 * Red-team: the M1–M6 measurement (tools/ingest/feasibility/measure.mjs) vs
 * the plan §10.2 metric definitions and FEASIBILITY.md §3 conventions.
 *
 * Attack inputs: empty frames, single frame, all-contact, no-contact,
 * mismatched array lengths between subjects, duplicate frameIndex, unsorted
 * frameIndex, subjects with different frame counts, NaN coordinates, and the
 * identity/separation edge cases where M4/M6 must be undefined rather than
 * silently 0.
 *
 * All fixtures are the pinned solver-output set (sha256-verified before any
 * mutation); mutations are in-memory only — nothing under test is modified.
 */

import { readFileSync } from "node:fs";
import { computeMetrics } from "../../../tools/ingest/feasibility/measure.mjs";
import { newRegistry, verifySha256, describe } from "./rt-common.mjs";

const reg = newRegistry();
const FIX = new URL("../fixtures/solver-output/synthetic-boxing-01/", import.meta.url);
const load = (n) => JSON.parse(readFileSync(new URL(n, FIX), "utf8"));

const chDoc = load("contact-head.json");
const annDoc = load("annotation.json");
if (!verifySha256(chDoc) || !verifySha256(annDoc)) {
	throw new Error("rt-measure: pinned fixture sha256 mismatch — refusing to attack unverified fixtures");
}

const mk = (over = {}) => {
	const d = structuredClone(chDoc);
	return Object.assign(d, over);
};
// annotation with the same shape but overridable
const mkAnn = (over = {}) => {
	const a = structuredClone(annDoc);
	return Object.assign(a, over);
};

const isNaNv = (x) => typeof x === "number" && Number.isNaN(x);

// ---------------------------------------------------------------------------
// Empty frames
// ---------------------------------------------------------------------------
{
	// (a) zero frames + full annotation: M2 must index contactMask[f] for the
	// 100 label frames -> out of range. Loud, or silent?
	let threw = null;
	try {
		computeMetrics(mk({ frames: 0, frameIndex: [], timeS: [], subjects: [
			{ subjectId: "A", trackId: "p0", rootWorld: [], contactMask: [], confidence: [] },
			{ subjectId: "B", trackId: "p1", rootWorld: [], contactMask: [], confidence: [] },
		] }), annDoc);
	} catch (e) { threw = e; }
	reg.record({
		id: "MEA-empty-frames-full-ann", category: "measure", attack: "empty frames with the full 100-frame annotation",
		input: "frames=0, empty subject arrays, annotation untouched",
		expected: "must not silently compute a plausible metric; a loud failure is acceptable, a named one better",
		observed: threw ? `${threw.name}: ${threw.message}` : "no throw",
		verdict: threw ? "PASS" : "WEAKNESS",
	});
	// (b) zero frames + empty annotation: what do the metrics degenerate to?
	const emptyAnn = mkAnn({
		handContact: { frameIndex: [], label: { A: [], B: [] } },
		footWorld: { frameIndex: [], A: [], B: [] },
	});
	let m = null;
	try {
		m = computeMetrics(mk({ frames: 0, frameIndex: [], timeS: [], subjects: [
			{ subjectId: "A", trackId: "p0", rootWorld: [], contactMask: [], confidence: [] },
			{ subjectId: "B", trackId: "p1", rootWorld: [], contactMask: [], confidence: [] },
		] }), emptyAnn);
	} catch (e) { m = `threw ${e.name}: ${e.message}`; }
	const out = typeof m === "string" ? m : `M1=${m.M1} M2=${m.M2} M3=${m.M3} M4=${m.M4} M5=${m.M5} M6=${m.M6}`;
	reg.record({
		id: "MEA-empty-frames-empty-ann", category: "measure", attack: "empty frames AND empty annotation",
		input: "frames=0, no contacts, no scored frames, no labels",
		expected: "M1 undefined (0/0), M5/M6 undefined (0/0) — NOT plausible zeros; M2=1.0 only per the documented 'no predicted contacts' convention; M3/M4 must not silently read 0 where 'no data' is the truth",
		observed: out,
		verdict: typeof m === "string" ? "WEAKNESS" :
			(isNaNv(m.M1) && isNaNv(m.M5) && isNaNv(m.M6) && m.M2 === 1 && m.M3 === 0 && m.M4 === 0) ? "WEAKNESS" : "PASS",
	});
	if (typeof m !== "string") {
		reg.finding("low", "M3/M4 read 0 on an empty fixture (vacuous zeros)", ["MEA-empty-frames-empty-ann"],
			`M3=0 with zero contact runs and M4=0 with zero groundTruth entries are indistinguishable from measured zeros; M5/M6 correctly degrade to NaN.`);
	}
}

// ---------------------------------------------------------------------------
// Single frame
// ---------------------------------------------------------------------------
{
	const one = mk({
		frames: 1, frameIndex: [0], timeS: [0],
		subjects: [
			{ subjectId: "A", trackId: "p0", rootWorld: [[0, 0, 0]], contactMask: [[0.93, 0.07]], confidence: [0.9] },
			{ subjectId: "B", trackId: "p1", rootWorld: [[1.5, 0, 0]], contactMask: [[0.07, 0.93]], confidence: [0.9] },
		],
		separation: { scoredFrameIndex: [0], annotatedSeparationM: [1.5] },
		association: { observations: [{ frameIndex: 0, trackId: "p0", assignedSubjectId: "A", evidence: "bbox", value: [0] }], groundTruth: [{ frameIndex: 0, trackId: "p0", subjectId: "A" }] },
	});
	const ann1 = mkAnn({
		handContact: { frameIndex: [0], label: { A: [[true, false]], B: [[false, true]] } },
		footWorld: { frameIndex: [0], A: [[0, 0, 0]], B: [[1.5, 0, 0]] },
	});
	let m = null;
	try { m = computeMetrics(one, ann1); } catch (e) { m = `threw ${e.name}: ${e.message}`; }
	const out = typeof m === "string" ? m : `M1=${m.M1} M2=${m.M2} M3=${m.M3} M4=${m.M4} M5=${m.M5} M6=${m.M6}`;
	reg.record({
		id: "MEA-single-frame", category: "measure", attack: "single-frame fixture",
		input: "frames=1, both feet planted, scored frame 0, separation 1.5 m",
		expected: "M1=1, M2=1, M4=0, M5=0, M6=0; M3: a 1-frame run has std 0 -> 0 (convention: within-run std)",
		observed: out,
		verdict: typeof m === "string" ? "WEAKNESS" : (m.M1 === 1 && m.M2 === 1 && m.M4 === 0 && m.M5 === 0 && m.M6 === 0 && m.M3 === 0) ? "PASS" : "WEAKNESS",
	});
	if (typeof m !== "string") {
		reg.finding("info", "M3 is 0 for single-frame contact runs (std of one sample)", ["MEA-single-frame"],
			"By the within-run std convention a 1-frame run trivially has zero jitter; consistent between measure.mjs and the gate, so reproducible — noted, not a defect.");
	}
}

// ---------------------------------------------------------------------------
// All-contact / no-contact
// ---------------------------------------------------------------------------
{
	const all = mk({
		subjects: [
			{ subjectId: "A", trackId: "p0", rootWorld: chDoc.subjects[0].rootWorld.map((p) => [p[0], p[1], p[2]]), contactMask: chDoc.subjects[0].contactMask.map(() => [0.93, 0.07]), confidence: chDoc.subjects[0].confidence },
			{ subjectId: "B", trackId: "p1", rootWorld: chDoc.subjects[1].rootWorld.map((p) => [p[0], p[1], p[2]]), contactMask: chDoc.subjects[1].contactMask.map(() => [0.07, 0.93]), confidence: chDoc.subjects[1].confidence },
		],
	});
	const mA = computeMetrics(all, annDoc);
	reg.record({
		id: "MEA-all-contact", category: "measure", attack: "every frame a planted contact",
		input: "all 186 frames max(l,r)=0.93 > 0.5, roots unchanged",
		expected: "M1=1; M3 finite (one long run per subject per stance); M2 recomputed against the same labels",
		observed: `M1=${mA.M1} M2=${mA.M2.toFixed(4)} M3=${mA.M3.toExponential(2)} M4=${mA.M4} M5=${mA.M5.toExponential(2)} M6=${mA.M6.toExponential(2)}`,
		verdict: mA.M1 === 1 && Number.isFinite(mA.M3) && Number.isFinite(mA.M5) && Number.isFinite(mA.M6) ? "PASS" : "WEAKNESS",
	});
	const none = mk({
		subjects: [
			{ subjectId: "A", trackId: "p0", rootWorld: chDoc.subjects[0].rootWorld.map((p) => [p[0], p[1], p[2]]), contactMask: chDoc.subjects[0].contactMask.map(() => [0, 0]), confidence: chDoc.subjects[0].confidence },
			{ subjectId: "B", trackId: "p1", rootWorld: chDoc.subjects[1].rootWorld.map((p) => [p[0], p[1], p[2]]), contactMask: chDoc.subjects[1].contactMask.map(() => [0, 0]), confidence: chDoc.subjects[1].confidence },
		],
	});
	const mN = computeMetrics(none, annDoc);
	reg.record({
		id: "MEA-no-contact", category: "measure", attack: "zero contacts anywhere",
		input: "all contactMask [0,0], roots unchanged (still equal the annotated foot truth)",
		expected: "M1=0; M2=1.0 only by the documented 'no predicted contacts' convention; M3 must NOT read a plausible 0 from an empty run set",
		observed: `M1=${mN.M1} M2=${mN.M2} M3=${mN.M3} M4=${mN.M4} M5=${mN.M5.toExponential(2)} M6=${mN.M6.toExponential(2)}`,
		verdict: mN.M1 === 0 && mN.M3 === 0 ? "WEAKNESS" : "PASS",
	});
	reg.finding("low", "Zero-contact take: M3=0 from an empty run set is a vacuous pass of the jitter gate", ["MEA-no-contact"],
		`M3=0 with no contact runs; combined with M5=0/M6=0 (roots matching the annotation) the §10.3 step-2/step-3 branches can GO with no observed contact at all. Plan §10.2 does not define M3 for an empty run set; both implementations agree (reproducible), so this is a convention gap, not a drift.`);
}

// ---------------------------------------------------------------------------
// Mismatched array lengths between subjects / different frame counts
// ---------------------------------------------------------------------------
{
	// subject B truncated to maxScored+1 rows (so M5/M6 still find their
	// frames): B's coverage is then divided by A's frame count.
	const short = structuredClone(chDoc);
	const keep = Math.max(...chDoc.separation.scoredFrameIndex) + 1;
	short.subjects[1].contactMask = short.subjects[1].contactMask.slice(0, keep);
	short.subjects[1].rootWorld = short.subjects[1].rootWorld.slice(0, keep);
	short.subjects[1].confidence = short.subjects[1].confidence.slice(0, keep);
	let m = null;
	try { m = computeMetrics(short, annDoc); } catch (e) { m = `threw ${e.name}: ${e.message}`; }
	const out = typeof m === "string" ? m : `M1=${m.M1.toFixed(4)} (B has ${keep} rows, frames=186)`;
	reg.record({
		id: "MEA-subject-length-mismatch", category: "measure", attack: "subject B has fewer rows than frames",
		input: `B.contactMask/rootWorld truncated to ${keep} rows while frames=186 and A untouched`,
		expected: "the length mismatch must be detected loudly — a plausible-looking M1 computed from mismatched shapes is the failure mode",
		observed: out,
		verdict: typeof m === "string" ? "PASS" : "WEAKNESS",
	});
	if (typeof m !== "string") {
		reg.finding("low", "measure.mjs computes over mismatched subject lengths without complaint", ["MEA-subject-length-mismatch"],
			`B's ${keep} contact rows are divided by fixture.frames=186 -> M1=${m.M1.toFixed(4)}, a plausible-looking fraction for corrupt input. The reproducibility gate's validateShape rejects this shape (rootWorld/contactMask rows !== frames); measure.mjs alone (feasibility-only code) does not.`);
	}
	const long = structuredClone(chDoc);
	long.subjects[1].contactMask = [...long.subjects[1].contactMask, ...long.subjects[1].contactMask.slice(0, 14)];
	long.subjects[1].rootWorld = [...long.subjects[1].rootWorld, ...long.subjects[1].rootWorld.slice(0, 14)];
	let mL = null;
	try { mL = computeMetrics(long, annDoc); } catch (e) { mL = `threw ${e.name}: ${e.message}`; }
	reg.record({
		id: "MEA-subject-length-over", category: "measure", attack: "subject B has 200 rows while frames=186",
		input: "B arrays extended to 200 rows (all contacts)",
		expected: "a coverage fraction above 1 is impossible; B's M1 contribution must not exceed 1",
		observed: typeof mL === "string" ? mL : `M1=${mL.M1.toFixed(4)}`,
		verdict: typeof mL === "string" ? "PASS" : (mL.M1 <= 1 ? "PASS" : "WEAKNESS"),
	});
	if (typeof m === "string") {
		reg.finding("info", "Shorter subject arrays fail loudly in measure.mjs (unnamed TypeError)", ["MEA-subject-length-mismatch"],
			`A subject with fewer rows than the annotation's label frames crashes M2 with an unhelpful TypeError; the gate's validateShape would reject the shape with a named error first. Asymmetric with MEA-subject-length-over, where a LONGER subject silently yields M1=${typeof mL === "string" ? "?" : mL.M1.toFixed(4)} > 1.`);
	}
}

// ---------------------------------------------------------------------------
// Duplicate frameIndex / unsorted frameIndex in the association
// ---------------------------------------------------------------------------
{
	// duplicate (frameIndex, trackId): a wrong observation inserted BEFORE the
	// correct one. Map keyed "frameIndex:trackId" -> last write wins.
	const dup = structuredClone(chDoc);
	const target = dup.association.observations.find((o) => o.frameIndex === chDoc.separation.scoredFrameIndex[0] && o.trackId === "p0");
	dup.association.observations.unshift({ frameIndex: target.frameIndex, trackId: target.trackId, assignedSubjectId: "B", evidence: "bbox", value: [0] });
	const mD = computeMetrics(dup, annDoc);
	reg.record({
		id: "MEA-duplicate-observation", category: "measure", attack: "duplicate (frameIndex, trackId) observation with a WRONG identity, inserted before the right one",
		input: "one extra observation {frameIndex:5, trackId:p0, assignedSubjectId:B} prepended",
		expected: "a duplicate key is ambiguous input; silently taking the last record hides the wrong one — M4 must not silently stay 0 if the duplicate contradicts",
		observed: `M4=${mD.M4} (the wrong duplicate was silently shadowed by the later correct record)`,
		verdict: mD.M4 === 0 ? "WEAKNESS" : "PASS",
	});
	// duplicate groundTruth entries: both must be judged, not deduped
	const dupGt = structuredClone(chDoc);
	dupGt.association.groundTruth.push({ frameIndex: chDoc.association.groundTruth[0].frameIndex, trackId: chDoc.association.groundTruth[0].trackId, subjectId: "B" });
	const mG = computeMetrics(dupGt, annDoc);
	reg.record({
		id: "MEA-duplicate-groundtruth", category: "measure", attack: "duplicate groundTruth entry with a different subjectId",
		input: "groundTruth gains a second entry for the same (frame, track) claiming subjectId B",
		expected: "both entries are judged against their observation; the duplicate disagreement must count",
		observed: `M4=${mG.M4}`,
		verdict: mG.M4 > 0 ? "PASS" : "WEAKNESS",
	});
	// unsorted groundTruth: the gate walks ascending; measure walks array order.
	// The COUNT must agree either way (order-independent predicate). A fixed
	// reversal is the deterministic shuffle.
	const unsorted = structuredClone(chDoc);
	unsorted.association.groundTruth = [...unsorted.association.groundTruth].reverse();
	const mU = computeMetrics(unsorted, annDoc);
	reg.record({
		id: "MEA-unsorted-gt", category: "measure", attack: "groundTruth entries shuffled",
		input: "same 40 entries in reverse order",
		expected: "M4 is a count of disagreeing entries — order-independent; must equal the sorted result",
		observed: `M4=${mU.M4}`,
		verdict: mU.M4 === 0 ? "PASS" : "WEAKNESS",
	});
}

// ---------------------------------------------------------------------------
// NaN coordinates
// ---------------------------------------------------------------------------
{
	const nanRoot = structuredClone(chDoc);
	const scoredF = chDoc.separation.scoredFrameIndex[0];
	nanRoot.subjects[0].rootWorld[scoredF] = [NaN, 0, 0];
	let m = null;
	try { m = computeMetrics(nanRoot, annDoc); } catch (e) { m = `threw ${e.name}: ${e.message}`; }
	const out = typeof m === "string" ? m : `M5=${m.M5} M6=${m.M6} M3=${m.M3.toExponential(2)}`;
	reg.record({
		id: "MEA-nan-root", category: "measure", attack: "NaN in a scored frame's rootWorld",
		input: "A.rootWorld[5] = [NaN,0,0] (frame 5 is scored)",
		expected: "NaN must propagate to M5/M6 (loud at the gate), never become a plausible number",
		observed: out,
		verdict: typeof m === "string" ? "WEAKNESS" : (isNaNv(m.M5) && isNaNv(m.M6)) ? "PASS" : "WEAKNESS",
	});
	// NaN in contactMask: NaN > 0.5 is false -> silently counts as "no contact"
	const nanContact = structuredClone(chDoc);
	nanContact.subjects[0].contactMask[10] = [NaN, 0.07];
	const mC = computeMetrics(nanContact, annDoc);
	reg.record({
		id: "MEA-nan-contact", category: "measure", attack: "NaN in a contactMask row",
		input: "A.contactMask[10] = [NaN, 0.07]",
		expected: "NaN contact is invalid input; it must not silently read as 'no contact' (M1 undercount)",
		observed: `M1=${mC.M1.toFixed(4)} (frame 10 silently dropped from A's coverage)`,
		verdict: mC.M1 === 1 ? "PASS" : "WEAKNESS",
	});
	// NaN contact splitting runs into singletons zeroes M3
	const jittered = structuredClone(chDoc);
	for (const f of [10, 15, 20]) jittered.subjects[0].rootWorld[f][0] += f === 15 ? -0.01 : 0.01;
	const mJ = computeMetrics(jittered, annDoc);
	jittered.subjects[0].contactMask = jittered.subjects[0].contactMask.map((c, f) => (f === 10 || f === 15 || f === 20 ? [NaN, NaN] : c));
	const mJN = computeMetrics(jittered, annDoc);
	reg.record({
		id: "MEA-nan-contact-hides-jitter", category: "measure", attack: "NaN contacts split jittery runs into single-frame runs (std 0)",
		input: "real jitter at frames 10/15/20 (M3 would read ~0.008), then those frames' contacts set to NaN",
		expected: "the jitter must still be measurable; NaN must not launder it into 0",
		observed: `M3 with real contacts = ${mJ.M3.toExponential(3)}; M3 with NaN contacts = ${mJN.M3.toExponential(3)}`,
		verdict: mJN.M3 < 1e-6 ? "WEAKNESS" : "PASS",
	});
	if (mJN.M3 < 1e-6) {
		reg.finding("low", "NaN contact values can zero M3 by splitting runs into singletons", ["MEA-nan-contact-hides-jitter"],
			`Real jitter of ${mJ.M3.toExponential(2)} m reads as ${mJN.M3.toExponential(2)} after NaN contacts break each run: single-frame runs have zero within-run std. Loud for rootWorld NaN, silent for contactMask NaN.`);
	}
}

// ---------------------------------------------------------------------------
// M4/M6 must be undefined, not silently 0
// ---------------------------------------------------------------------------
{
	// M4 with an empty groundTruth: the 20 sampled frames were never checked
	const noGt = structuredClone(chDoc);
	noGt.association.groundTruth = [];
	const m4e = computeMetrics(noGt, annDoc);
	reg.record({
		id: "MEA-m4-empty-gt", category: "measure", attack: "groundTruth empty (no frames hand-checked)",
		input: "association.groundTruth = []",
		expected: "identity was never measured: M4 must be undefined/NaN, NOT the green 0 that lets step 0 pass",
		observed: `M4=${m4e.M4}`,
		verdict: m4e.M4 === 0 ? "WEAKNESS" : "PASS",
	});
	reg.finding("medium", "Empty groundTruth reads M4=0 (identity gate passes vacuously)", ["MEA-m4-empty-gt"],
		"computeMetrics returns M4=0 when no frame was hand-checked, and the reproducibility gate's validateShape does not require a minimum groundTruth size, so a fixture with groundTruth=[] (hash recomputed) reproduces the recorded m4=0 and passes the whole gate chain (see REP-groundTruth-truncate). The per-entry 'missing observation counts as disagreeing' rule protects individual gaps, not wholesale truncation.");

	// M4 with observations missing -> counts as disagreeing (safe direction)
	const droppedObs = structuredClone(chDoc);
	const victim = droppedObs.association.observations.find((o) => o.frameIndex === chDoc.separation.scoredFrameIndex[0] && o.trackId === "p0");
	droppedObs.association.observations = droppedObs.association.observations.filter((o) => o !== victim);
	const m4d = computeMetrics(droppedObs, annDoc);
	reg.record({
		id: "MEA-m4-missing-obs", category: "measure", attack: "observation missing for a groundTruth entry",
		input: "delete the p0 observation for scored frame 5",
		expected: "missing observation counts as disagreeing -> M4 > 0 (FEASIBILITY.md §3)",
		observed: `M4=${m4d.M4}`,
		verdict: m4d.M4 > 0 ? "PASS" : "WEAKNESS",
	});

	// M6 with empty scored frames: 0/0 must be NaN, not 0
	const noScored = structuredClone(chDoc);
	noScored.separation = { scoredFrameIndex: [], annotatedSeparationM: [] };
	const annNoScored = mkAnn({ footWorld: { frameIndex: [], A: [], B: [] } });
	let m6e = null;
	try { m6e = computeMetrics(noScored, annNoScored); } catch (e) { m6e = `threw ${e.name}: ${e.message}`; }
	const out6 = typeof m6e === "string" ? m6e : `M5=${m6e.M5} M6=${m6e.M6}`;
	reg.record({
		id: "MEA-m6-empty-scored", category: "measure", attack: "no scored frames for M6",
		input: "separation.scoredFrameIndex = [] (and matching empty annotation)",
		expected: "M6 is RMS over zero samples: 0/0 -> NaN (undefined), never the 0 that passes the 0.08 budget",
		observed: out6,
		verdict: typeof m6e === "string" ? "WEAKNESS" : (isNaNv(m6e.M6) && isNaNv(m6e.M5)) ? "PASS" : "WEAKNESS",
	});

	// M6 with a SHORTER annotatedSeparationM: dist - undefined = NaN (loud);
	// with a LONGER one: extra entries silently ignored
	const shortAnn = structuredClone(chDoc);
	shortAnn.separation.annotatedSeparationM = shortAnn.separation.annotatedSeparationM.slice(0, 10);
	let m6s = null;
	try { m6s = computeMetrics(shortAnn, annDoc); } catch (e) { m6s = `threw ${e.name}: ${e.message}`; }
	reg.record({
		id: "MEA-m6-short-annotation", category: "measure", attack: "annotatedSeparationM shorter than scoredFrameIndex",
		input: "10 separation values for 20 scored frames",
		expected: "length mismatch is corrupt input; NaN propagation is acceptable, silent truncation is not",
		observed: typeof m6s === "string" ? m6s : `M6=${m6s.M6}`,
		verdict: typeof m6s === "string" ? "WEAKNESS" : isNaNv(m6s.M6) ? "PASS" : "WEAKNESS",
	});
	const longAnn = structuredClone(chDoc);
	longAnn.separation.annotatedSeparationM = [...longAnn.separation.annotatedSeparationM, ...longAnn.separation.annotatedSeparationM.slice(0, 5)];
	const m6l = computeMetrics(longAnn, annDoc);
	reg.record({
		id: "MEA-m6-long-annotation", category: "measure", attack: "annotatedSeparationM longer than scoredFrameIndex",
		input: "25 separation values for 20 scored frames",
		expected: "extra values must not silently vanish",
		observed: `M6=${m6l.M6.toExponential(2)} (extra 5 entries ignored positionally)`,
		verdict: "WEAKNESS",
	});
}

export const run = async () => {
	console.log("== rt-measure: M1-M6 measurement attacks ==");
	return { cases: reg.cases, findings: reg.findings };
};

const isMain = process.argv[1] && process.argv[1].endsWith("rt-measure.mjs");
if (isMain) {
	await run();
	for (const c of reg.cases) console.log(`${c.verdict.padEnd(9)} ${c.id}`);
	console.log(`\nrt-measure: ${reg.cases.length} cases, ${reg.findings.length} findings`);
}
