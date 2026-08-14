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
		m = computeMetrics(mk({
			frames: 0, frameIndex: [], timeS: [],
			subjects: [
				{ subjectId: "A", trackId: "p0", rootWorld: [], contactMask: [], confidence: [] },
				{ subjectId: "B", trackId: "p1", rootWorld: [], contactMask: [], confidence: [] },
			],
			// the fixture must be degenerate end to end: dangling groundTruth
			// or scored frames would make the rowOf mapping throw instead of
			// exercising the 0/0 paths this case pins
			association: { observations: [], groundTruth: [] },
			separation: { scoredFrameIndex: [], annotatedSeparationM: [] },
		}), emptyAnn);
	} catch (e) { m = `threw ${e.name}: ${e.message}`; }
	const out = typeof m === "string" ? m : `M1=${m.M1} M2=${m.M2} M3=${m.M3} M4=${m.M4} M5=${m.M5} M6=${m.M6}`;
	reg.record({
		id: "MEA-empty-frames-empty-ann", category: "measure", attack: "empty frames AND empty annotation",
		input: "frames=0, no contacts, no scored frames, no labels",
		expected: "every denominator-less metric undefined with a reason (M1/M5/M6 0/0, M2 no hand-labelled frames, M3 no contact runs, M4 no groundTruth entries) — NOT plausible zeros, never the NaN of an older convention",
		observed: out,
		verdict: typeof m === "string" ? "WEAKNESS" :
			(m.M1 === undefined && m.M2 === undefined && m.M3 === undefined && m.M4 === undefined && m.M5 === undefined && m.M6 === undefined) ? "PASS" : "WEAKNESS",
	});
	// finding gated on the OBSERVED defect: only while M3/M4 actually read 0
	// (which is also exactly when the case verdict is WEAKNESS)
	if (typeof m !== "string" && (m.M3 === 0 || m.M4 === 0)) {
		reg.finding("low", "M3/M4 read 0 on an empty fixture (vacuous zeros)", ["MEA-empty-frames-empty-ann"],
			`M3=0 with zero contact runs and M4=0 with zero groundTruth entries are indistinguishable from measured zeros; the undefined-with-reason convention exists so a degenerate fixture cannot read as a measured pass.`);
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
		// documented on the case, not as a finding: as an INFO finding it
		// referenced a PASSing case and could never clear under the
		// stale-finding guard — the convention note belongs to the case it
		// describes
		note: "By the within-run std convention a 1-frame run trivially has zero jitter; consistent between measure.mjs and the gate, so reproducible — noted, not a defect.",
	});
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
	// finding gated on the OBSERVED defect: only while M3 actually reads 0
	// (M1 is always 0 for this input, so this is exactly the WEAKNESS case)
	if (mN.M3 === 0) {
		reg.finding("low", "Zero-contact take: M3=0 from an empty run set is a vacuous pass of the jitter gate", ["MEA-no-contact"],
			`M3=0 with no contact runs; combined with M5=0/M6=0 (roots matching the annotation) the §10.3 step-2/step-3 branches can GO with no observed contact at all. Plan §10.2 does not define M3 for an empty run set; both implementations agree (reproducible), so this is a convention gap, not a drift.`);
	}
}

// ---------------------------------------------------------------------------
// Mismatched array lengths between subjects / different frame counts
// ---------------------------------------------------------------------------
{
	// subject B truncated to maxScored+1 rows (so M5/M6 still find their
	// frames): B's coverage is then divided by A's frame count.
	// scoredFrameIndex holds SOURCE keys; contactMask/rootWorld are row
	// arrays, so the boundary is max(mapped ROW)+1, never max(key)+1 — the
	// two coincide only on contiguous zero-based fixtures, which is exactly
	// the hiding place the decimated case below breaks.
	const maxScoredRowPlus1 = (doc) => Math.max(...doc.separation.scoredFrameIndex.map((f) => doc.frameIndex.indexOf(f))) + 1;
	const keep = maxScoredRowPlus1(chDoc);
	const short = structuredClone(chDoc);
	short.subjects[1].contactMask = short.subjects[1].contactMask.slice(0, keep);
	short.subjects[1].rootWorld = short.subjects[1].rootWorld.slice(0, keep);
	short.subjects[1].confidence = short.subjects[1].confidence.slice(0, keep);
	let m = null;
	try { m = computeMetrics(short, annDoc); } catch (e) { m = `threw ${e.name}: ${e.message}`; }
	const out = typeof m === "string" ? m : `M1=${m.M1.toFixed(4)} (B has ${keep} rows, frames=186)`;
	// the LONGER-subject case runs first so the mismatch case's note can cite
	// it: the note replaces an INFO finding that referenced a PASSing case
	// and could never clear under the stale-finding guard
	const long = structuredClone(chDoc);
	long.subjects[1].contactMask = [...long.subjects[1].contactMask, ...long.subjects[1].contactMask.slice(0, 14)];
	long.subjects[1].rootWorld = [...long.subjects[1].rootWorld, ...long.subjects[1].rootWorld.slice(0, 14)];
	let mL = null;
	try { mL = computeMetrics(long, annDoc); } catch (e) { mL = `threw ${e.name}: ${e.message}`; }
	reg.record({
		id: "MEA-subject-length-mismatch", category: "measure", attack: "subject B has fewer rows than frames",
		input: `B.contactMask/rootWorld truncated to ${keep} rows while frames=186 and A untouched`,
		expected: "the length mismatch must be detected loudly — a plausible-looking M1 computed from mismatched shapes is the failure mode",
		observed: out,
		verdict: typeof m === "string" ? "PASS" : "WEAKNESS",
		note: typeof m === "string"
			? `${m} — the failure is loud but unnamed (the gate's validateShape names the shape error first); asymmetric with MEA-subject-length-over where a LONGER subject silently yields M1=${typeof mL === "string" ? "?" : mL.M1.toFixed(4)} > 1`
			: undefined,
	});
	if (typeof m !== "string") {
		reg.finding("low", "measure.mjs computes over mismatched subject lengths without complaint", ["MEA-subject-length-mismatch"],
			`B's ${keep} contact rows are divided by fixture.frames=186 -> M1=${m.M1.toFixed(4)}, a plausible-looking fraction for corrupt input. The reproducibility gate's validateShape rejects this shape (rootWorld/contactMask rows !== frames); measure.mjs alone (feasibility-only code) does not.`);
	}
	reg.record({
		id: "MEA-subject-length-over", category: "measure", attack: "subject B has 200 rows while frames=186",
		input: "B arrays extended to 200 rows (all contacts)",
		expected: "a coverage fraction above 1 is impossible; B's M1 contribution must not exceed 1",
		observed: typeof mL === "string" ? mL : `M1=${mL.M1.toFixed(4)}`,
		verdict: typeof mL === "string" ? "PASS" : (mL.M1 <= 1 ? "PASS" : "WEAKNESS"),
	});
	// decimated regression: the key-derived boundary above is only correct
	// while a source key equals its row. Decimate the pinned fixture (93 rows
	// over source keys [0,2,...,184]) and score keys [14,50,86,122,158]: max
	// scored KEY is 158 while the max scored ROW is 79, so a key-derived keep
	// (159) slices nothing off a 93-row subject and the mismatch vanishes,
	// while the row-derived keep (80) must truncate B to exactly the scored
	// rows M5/M6 need.
	const dec = structuredClone(chDoc);
	const decFrameIndex = chDoc.frameIndex.filter((f) => f % 2 === 0);
	const decScored = [14, 50, 86, 122, 158];
	// row of a source key within the PINNED chDoc: its frameIndex is contiguous
	// zero-based, so row==key there — but the decimated rows must be selected
	// by an explicit key->row map, never by the key-as-index coincidence
	const chRowOf = new Map(chDoc.frameIndex.map((f, row) => [f, row]));
	const decDoc = {
		...dec,
		frames: decFrameIndex.length,
		frameIndex: decFrameIndex,
		timeS: decFrameIndex.map((f) => f / dec.fps),
		subjects: dec.subjects.map((s) => ({
			...s,
			rootWorld: decFrameIndex.map((f) => s.rootWorld[chRowOf.get(f)]),
			contactMask: decFrameIndex.map((f) => s.contactMask[chRowOf.get(f)]),
			confidence: decFrameIndex.map((f) => s.confidence[chRowOf.get(f)]),
		})),
		separation: {
			scoredFrameIndex: decScored,
			annotatedSeparationM: decScored.map((f) =>
				chDoc.separation.annotatedSeparationM[chDoc.separation.scoredFrameIndex.indexOf(f)]),
		},
	};
	// decimated annotation covering the decimated keys: hand labels at keys
	// 8/14/20 (both fighters plant left throughout phase 0), foot world at the
	// scored keys — same values the decimated rows carry, so a correct
	// measurement reads M2=1/M5=0/M6=0 on the truncated B.
	const decAnn = {
		handContact: {
			frameIndex: [8, 14, 20],
			label: {
				A: [[true, false], [true, false], [true, false]],
				B: [[true, false], [true, false], [true, false]],
			},
		},
		footWorld: {
			frameIndex: decScored,
			A: decScored.map((f) => chDoc.subjects[0].rootWorld[chRowOf.get(f)]),
			B: decScored.map((f) => chDoc.subjects[1].rootWorld[chRowOf.get(f)]),
		},
	};
	const keyBoundary = Math.max(...decScored) + 1;
	const decKeep = maxScoredRowPlus1(decDoc);
	const shortDec = structuredClone(decDoc);
	shortDec.subjects[1].contactMask = shortDec.subjects[1].contactMask.slice(0, decKeep);
	shortDec.subjects[1].rootWorld = shortDec.subjects[1].rootWorld.slice(0, decKeep);
	shortDec.subjects[1].confidence = shortDec.subjects[1].confidence.slice(0, decKeep);
	let mDec = null;
	try { mDec = computeMetrics(shortDec, decAnn); } catch (e) { mDec = `threw ${e.name}: ${e.message}`; }
	reg.record({
		id: "MEA-subject-length-mismatch-decimated", category: "measure", attack: "decimated truncation boundary: a ROW count, never a source-key count",
		input: `93 rows over keys [0,2,...,184]; scored keys [14,50,86,122,158] (max key 158 vs max scored row 79); B truncated to ${decKeep} rows`,
		expected: "the truncation boundary is max(scored ROW)+1 = 80: a key-derived boundary (159) slices nothing off a 93-row subject and hides the mismatch; M5/M6 must still find their frames on the truncated B",
		observed: `B has ${shortDec.subjects[1].rootWorld.length} rows${typeof mDec === "string" ? `; ${mDec}` : `; M1=${mDec.M1.toFixed(4)} M2=${mDec.M2} M5=${mDec.M5.toExponential(2)} M6=${mDec.M6.toExponential(2)}`}`,
		verdict: typeof mDec === "string" ? "WEAKNESS" :
			(keyBoundary !== decKeep && shortDec.subjects[1].rootWorld.length === decKeep &&
				mDec.M1 < 1 && mDec.M2 === 1 && Math.abs(mDec.M5) < 1e-12 && Math.abs(mDec.M6) < 1e-12) ? "PASS" : "WEAKNESS",
	});
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
	// scoredF is a SOURCE frame key; rootWorld is a row array, so the row must
	// come from frameIndex (on the pinned contiguous fixture the two coincide,
	// which is exactly the hiding place the decimated fixtures exist to break)
	const scoredF = chDoc.separation.scoredFrameIndex[0];
	const scoredRow = chDoc.frameIndex.indexOf(scoredF);
	nanRoot.subjects[0].rootWorld[scoredRow] = [NaN, 0, 0];
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
	nanContact.subjects[0].contactMask[chDoc.frameIndex.indexOf(10)] = [NaN, 0.07];
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
	// frames 10/15/20 are SOURCE keys; rootWorld/contactMask are row arrays,
	// so the rows come from frameIndex (the keys equal rows only on the
	// pinned contiguous fixture)
	const jitterRows = [10, 15, 20].map((f) => chDoc.frameIndex.indexOf(f));
	for (const r of jitterRows) jittered.subjects[0].rootWorld[r][0] += r === jitterRows[1] ? -0.01 : 0.01;
	const mJ = computeMetrics(jittered, annDoc);
	jittered.subjects[0].contactMask = jittered.subjects[0].contactMask.map((c, r) => (jitterRows.includes(r) ? [NaN, NaN] : c));
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
	// finding gated on the OBSERVED defect: only while M4 actually reads 0
	// (exactly when the case verdict is WEAKNESS)
	if (m4e.M4 === 0) {
		reg.finding("medium", "Empty groundTruth reads M4=0 (identity gate passes vacuously)", ["MEA-m4-empty-gt"],
			"computeMetrics returns M4=0 when no frame was hand-checked, and the reproducibility gate's validateShape does not require a minimum groundTruth size, so a fixture with groundTruth=[] (hash recomputed) reproduces the recorded m4=0 and passes the whole gate chain (see REP-groundTruth-truncate). The per-entry 'missing observation counts as disagreeing' rule protects individual gaps, not wholesale truncation.");
	}

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

// ---------------------------------------------------------------------------
// Pass-3: the source-key/row class fix, attacked with decimated, trimmed,
// offset, non-monotonic and type-colliding keys. frameIndex entries are
// SOURCE frame numbers (RAWTRACK-CONTRACT §4.1); the emitted arrays are ROWS
// of the slice, so row p belongs to source frame frameIndex[p]. Every case
// below breaks the "key == row" coincidence differently and asserts either a
// mapped-row measurement (oracle computed in this file from the fixture's
// own key map — never from the code under test) or a named rejection.
// ---------------------------------------------------------------------------
{
	const chRowOf = new Map(chDoc.frameIndex.map((f, row) => [f, row]));
	const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
	// decimate the PINNED fixture onto an arbitrary key list (mapped through
	// the pinned key map, never through key-as-index); keyToPinned translates
	// a fixture key to the pinned source frame it was trimmed/decimated from
	// (identity for keys that are pinned frames themselves)
	const decimate = (keys, keyToPinned = (f) => f) => {
		const d = structuredClone(chDoc);
		d.frames = keys.length;
		d.frameIndex = keys;
		d.timeS = keys.map((f) => f / d.fps);
		d.subjects = d.subjects.map((s) => ({
			...s,
			rootWorld: keys.map((f) => s.rootWorld[chRowOf.get(keyToPinned(f))]),
			contactMask: keys.map((f) => s.contactMask[chRowOf.get(keyToPinned(f))]),
			confidence: keys.map((f) => s.confidence[chRowOf.get(keyToPinned(f))]),
		}));
		d.association = { observations: [], groundTruth: [] };
		return d;
	};
	// annotation covering the decimated fixture: labels DERIVED from the
	// fixture's own rows through the fixture's key map (the synthetic GT
	// property: predictions match labels on GT), so a misread row makes M2
	// drop below 1 instead of silently matching
	const annFor = (fx, handKeys, scoredKeys) => {
		const rm = new Map(fx.frameIndex.map((f, row) => [f, row]));
		const labelOf = (s, f) => {
			const c = s.contactMask[rm.get(f)];
			return [c[0] >= c[1], c[0] < c[1]];
		};
		return {
			handContact: {
				frameIndex: handKeys,
				label: { A: handKeys.map((f) => labelOf(fx.subjects[0], f)), B: handKeys.map((f) => labelOf(fx.subjects[1], f)) },
			},
			footWorld: {
				frameIndex: scoredKeys,
				A: scoredKeys.map((f) => fx.subjects[0].rootWorld[rm.get(f)]),
				B: scoredKeys.map((f) => fx.subjects[1].rootWorld[rm.get(f)]),
			},
		};
	};
	const sepFor = (fx, scoredKeys) => ({
		scoredFrameIndex: scoredKeys,
		annotatedSeparationM: scoredKeys.map((f) => {
			const rm = new Map(fx.frameIndex.map((g, row) => [g, row]));
			return dist3(fx.subjects[0].rootWorld[rm.get(f)], fx.subjects[1].rootWorld[rm.get(f)]);
		}),
	});
	const ideal = (m) => m.M1 === 1 && m.M2 === 1 && Math.abs(m.M5) < 1e-9 && Math.abs(m.M6) < 1e-9;

	// (a) every key offset far from zero: 93 rows over source keys
	//     [1000, 1002, ..., 1184]. A row-position read of key 1000+ is out of
	//     bounds (undefined row), so the fixture cannot measure "correctly"
	//     by luck — the mapped row is the only path to finite metrics.
	const offsetKeys = Array.from({ length: 93 }, (_, i) => 1000 + 2 * i);
	const offsetFx = decimate(offsetKeys, (f) => f - 1000);
	offsetFx.separation = sepFor(offsetFx, [1014, 1050, 1086, 1122, 1158]);
	const offsetAnn = annFor(offsetFx, [1008, 1014, 1020], [1014, 1050, 1086, 1122, 1158]);
	let mOff = null;
	try { mOff = computeMetrics(offsetFx, offsetAnn); } catch (e) { mOff = `threw ${e.name}: ${e.message}`; }
	reg.record({
		id: "MEA-keys-offset-1000", category: "measure", attack: "all source keys far from zero (1000..1184, 93 rows)",
		input: "frameIndex [1000, 1002, ..., 1184]; scored keys [1014, 1050, 1086, 1122, 1158]; hand keys [1008, 1014, 1020]",
		expected: "mapped-row measurement: M1=1, M2=1, M5=0, M6=0 (roots equal the annotation on their own rows); a key-as-row read of contactMask[1000] would be undefined and crash, never a plausible number",
		observed: typeof mOff === "string" ? mOff : `M1=${mOff.M1} M2=${mOff.M2} M5=${mOff.M5} M6=${mOff.M6}`,
		verdict: typeof mOff === "string" ? "WEAKNESS" : ideal(mOff) ? "PASS" : "WEAKNESS",
	});

	// (b) gaps at BOTH ends: 71 rows over keys [20, 22, ..., 160] — the take
	//     starts at source frame 20 and ends at 160, so first/last keys are
	//     far from rows 0/70 and the scored frames include both endpoints.
	const gapKeys = Array.from({ length: 71 }, (_, i) => 20 + 2 * i);
	const gapFx = decimate(gapKeys);
	const gapScored = [20, 60, 120, 160];
	gapFx.separation = sepFor(gapFx, gapScored);
	const gapAnn = annFor(gapFx, [22, 60, 120, 160], gapScored);
	let mGap = null;
	try { mGap = computeMetrics(gapFx, gapAnn); } catch (e) { mGap = `threw ${e.name}: ${e.message}`; }
	reg.record({
		id: "MEA-keys-gaps-both-ends", category: "measure", attack: "frameIndex with gaps at the start AND the end",
		input: "keys [20, 22, ..., 160] (0..18 and 162..185 trimmed); scored keys include the first (20) and last (160) emitted keys",
		expected: "mapped-row measurement: M1=1, M2=1, M5=0, M6=0 on the 71-row slice; the endpoint scored keys must resolve to rows 0 and 70",
		observed: typeof mGap === "string" ? mGap : `M1=${mGap.M1} M2=${mGap.M2} M5=${mGap.M5} M6=${mGap.M6}`,
		verdict: typeof mGap === "string" ? "WEAKNESS" : ideal(mGap) ? "PASS" : "WEAKNESS",
	});

	// (c) non-monotonic frameIndex: keys [1, 0, 3, 2] — a permutation, so
	//     EVERY key differs from its own row and a key-as-row read lands on a
	//     DIFFERENT row that still exists (a plausible wrong number, not a
	//     crash). Row values are distinct per row, so any misread moves M5.
	const perm = [1, 0, 3, 2];
	const permFx = {
		...structuredClone(chDoc),
		frames: 4,
		frameIndex: perm,
		timeS: [0, 0, 0, 0],
		subjects: [
			{ subjectId: "A", trackId: "p0", rootWorld: [[0, 0, 0], [0.5, 0, 0], [1, 0, 0], [1.5, 0, 0]], contactMask: Array.from({ length: 4 }, () => [0.93, 0.07]), confidence: Array.from({ length: 4 }, () => 1) },
			{ subjectId: "B", trackId: "p1", rootWorld: [[2, 0, 0], [2.5, 0, 0], [3, 0, 0], [3.5, 0, 0]], contactMask: Array.from({ length: 4 }, () => [0.93, 0.07]), confidence: Array.from({ length: 4 }, () => 1) },
		],
		association: { observations: [], groundTruth: [] },
		separation: { scoredFrameIndex: [1, 3], annotatedSeparationM: [2, 2] },
	};
	const permAnn = {
		handContact: { frameIndex: [1, 2], label: { A: [[true, false], [true, false]], B: [[true, false], [true, false]] } },
		footWorld: { frameIndex: [1, 3], A: [[0, 0, 0], [1, 0, 0]], B: [[2, 0, 0], [3, 0, 0]] },
	};
	let mPerm = null;
	try { mPerm = computeMetrics(permFx, permAnn); } catch (e) { mPerm = `threw ${e.name}: ${e.message}`; }
	reg.record({
		id: "MEA-keys-non-monotonic", category: "measure", attack: "non-monotonic frameIndex (a permutation of 0..3)",
		input: "frameIndex [1, 0, 3, 2]; every key differs from its row; scored [1, 3] map to rows 0 and 2; A rows carry distinct x = [0, 0.5, 1, 1.5]",
		expected: "mapped-row measurement: M1=1, M2=1, M5=0 (root of key 1 = row 0 = [0,0,0] matches the annotation), M6=0; a key-as-row read of key 1 would take row 1 (x=0.5) and measure M5 = sqrt(0.25/2) > 0 — a silent plausible number",
		observed: typeof mPerm === "string" ? mPerm : `M1=${mPerm.M1} M2=${mPerm.M2} M5=${mPerm.M5} M6=${mPerm.M6}`,
		verdict: typeof mPerm === "string" ? "WEAKNESS" : ideal(mPerm) ? "PASS" : "WEAKNESS",
	});

	// (d) single-row take at key 37 — one row whose source key is not 0
	const single = {
		...structuredClone(chDoc),
		frames: 1,
		frameIndex: [37],
		timeS: [37 / chDoc.fps],
		subjects: [
			{ subjectId: "A", trackId: "p0", rootWorld: [[0, 0, 0]], contactMask: [[0.93, 0.07]], confidence: [0.9] },
			{ subjectId: "B", trackId: "p1", rootWorld: [[1.5, 0, 0]], contactMask: [[0.07, 0.93]], confidence: [0.9] },
		],
		association: {
			observations: [{ frameIndex: 37, trackId: "p0", assignedSubjectId: "A", evidence: "bbox", value: [0] }],
			groundTruth: [{ frameIndex: 37, trackId: "p0", subjectId: "A" }],
		},
		separation: { scoredFrameIndex: [37], annotatedSeparationM: [1.5] },
	};
	const singleAnn = {
		handContact: { frameIndex: [37], label: { A: [[true, false]], B: [[false, true]] } },
		footWorld: { frameIndex: [37], A: [[0, 0, 0]], B: [[1.5, 0, 0]] },
	};
	let mSingle = null;
	try { mSingle = computeMetrics(single, singleAnn); } catch (e) { mSingle = `threw ${e.name}: ${e.message}`; }
	const singleOk = typeof mSingle !== "string" &&
		mSingle.M1 === 1 && mSingle.M2 === 1 && mSingle.M3 === 0 && mSingle.M4 === 0 &&
		Math.abs(mSingle.M5) < 1e-12 && Math.abs(mSingle.M6) < 1e-12;
	reg.record({
		id: "MEA-single-row-offset", category: "measure", attack: "single-row take whose only row is source key 37",
		input: "frames=1, frameIndex [37]; scored [37]; hand label at 37; separation 1.5 m",
		expected: "M1=1, M2=1, M3=0, M4=0, M5=0, M6=0 — the row is addressed through frameIndex; a key-as-row read of contactMask[37] would be undefined and crash",
		observed: typeof mSingle === "string" ? mSingle : `M1=${mSingle.M1} M2=${mSingle.M2} M3=${mSingle.M3} M4=${mSingle.M4} M5=${mSingle.M5} M6=${mSingle.M6}`,
		verdict: singleOk ? "PASS" : "WEAKNESS",
	});

	// (e) named rejections: keys absent from frameIndex must reject by name —
	//     the handContact side and the scored side, plus a scored key present
	//     in frameIndex but absent from the annotation
	{
		const decFx = decimate(Array.from({ length: 93 }, (_, i) => 2 * i));
		decFx.separation = sepFor(decFx, [14, 50, 86, 122, 158]);
		const badHandAnn = annFor(decFx, [8, 14, 20], [14, 50, 86, 122, 158]);
		badHandAnn.handContact.frameIndex = [8, 14, 1]; // 1 is odd: absent from even keys
		let hErr = null;
		try { computeMetrics(decFx, badHandAnn); } catch (e) { hErr = e; }
		const namedHand = hErr instanceof Error && /handContact references source frame 1, absent from frameIndex/.test(hErr.message);
		reg.record({
			id: "MEA-handkey-absent-rejects", category: "measure", attack: "hand-labelled key absent from frameIndex",
			input: "decimated fixture keys [0, 2, ..., 184]; annotation handContact key 1",
			expected: "named rejection naming the consumer (handContact) and the key (1) — never a silent row misread",
			observed: hErr ? `${hErr.name}: ${hErr.message}` : "no throw",
			verdict: namedHand ? "PASS" : "WEAKNESS",
		});
		const superset = structuredClone(decFx);
		superset.separation = { scoredFrameIndex: [14, 50, 86, 122, 158, 185], annotatedSeparationM: [14, 50, 86, 122, 158, 185].map((f) => f) };
		let sErr = null;
		try { computeMetrics(superset, annFor(decFx, [8, 14, 20], [14, 50, 86, 122, 158])); } catch (e) { sErr = e; }
		const namedSuperset = sErr instanceof Error && /separation\.scoredFrameIndex references source frame 185, absent from frameIndex/.test(sErr.message);
		reg.record({
			id: "MEA-scored-superset-rejects", category: "measure", attack: "scoredFrameIndex a superset of frameIndex",
			input: "scored keys [14, 50, 86, 122, 158, 185] on a fixture whose keys are the even frames 0..184",
			expected: "named rejection naming separation.scoredFrameIndex and key 185 — a scored frame outside the take cannot read as row 0 or any other row",
			observed: sErr ? `${sErr.name}: ${sErr.message}` : "no throw",
			verdict: namedSuperset ? "PASS" : "WEAKNESS",
		});
		// scored key present in frameIndex but absent from the annotation:
		// the M5 annPos guard must reject by name
		const annMissing = structuredClone(annDoc);
		const victim = chDoc.separation.scoredFrameIndex[3]; // 32
		const vi = annMissing.footWorld.frameIndex.indexOf(victim);
		annMissing.footWorld.frameIndex.splice(vi, 1);
		annMissing.footWorld.A.splice(vi, 1);
		annMissing.footWorld.B.splice(vi, 1);
		let aErr = null;
		try { computeMetrics(chDoc, annMissing); } catch (e) { aErr = e; }
		const namedAnn = aErr instanceof Error && /M5: no annotated foot world position for frame 32/.test(aErr.message);
		reg.record({
			id: "MEA-scored-present-ann-absent", category: "measure", attack: "scored key in frameIndex but missing from the annotation footWorld",
			input: "pinned fixture, annotation footWorld entry for scored frame 32 removed",
			expected: "named rejection 'M5: no annotated foot world position for frame 32' — the annotation must cover every scored frame",
			observed: aErr ? `${aErr.name}: ${aErr.message}` : "no throw",
			verdict: namedAnn ? "PASS" : "WEAKNESS",
		});
	}

	// (f) keys that collide after numeric coercion: "6" vs 6. A JS Map keeps
	//     them distinct, so the duplicate-key guards never fire and the
	//     take is measured as if two frames existed.
	{
		// fixture frameIndex ["6" and 6 as separate entries]: the named
		// duplicate rejection is bypassable by type
		const dupFx = {
			...structuredClone(chDoc),
			frames: 2,
			frameIndex: [6, "6"],
			timeS: [0, 0],
			subjects: [
				{ subjectId: "A", trackId: "p0", rootWorld: [[0, 0, 0], [0, 0, 0]], contactMask: [[0.93, 0.07], [0, 0]], confidence: [0.9, 0.9] },
				{ subjectId: "B", trackId: "p1", rootWorld: [[2, 0, 0], [2, 0, 0]], contactMask: [[0.93, 0.07], [0.93, 0.07]], confidence: [0.9, 0.9] },
			],
			association: { observations: [], groundTruth: [] },
			separation: { scoredFrameIndex: [6], annotatedSeparationM: [2] },
		};
		const dupAnn = { handContact: { frameIndex: [], label: { A: [], B: [] } }, footWorld: { frameIndex: [6], A: [[0, 0, 0]], B: [[2, 0, 0]] } };
		let dErr = null;
		let mDup = null;
		try { mDup = computeMetrics(dupFx, dupAnn); } catch (e) { dErr = e; }
		reg.record({
			id: "MEA-key-string-dup-frameIndex", category: "measure", attack: "frameIndex entries '6' and 6 (numeric coercion collision)",
			input: "frameIndex [6, \"6\"] for 2 frames; one row has contacts, the other none",
			expected: "the two entries are the SAME source frame after coercion: the named duplicate-frameIndex rejection must fire (or the duplicate must be detected); never a silent plausible M1 from two rows that are really one frame",
			observed: dErr ? `${dErr.name}: ${dErr.message}` : `no throw — the duplicate escaped the named check; M1=${mDup.M1} (one of two rows has contacts)`,
			verdict: dErr ? "PASS" : "WEAKNESS",
		});
		if (!dErr) {
			reg.finding("low", "measure.mjs duplicate-frameIndex check is bypassable by string-typed keys ('6' vs 6)", ["MEA-key-string-dup-frameIndex"],
				"rowByFrame uses a JS Map (SameValueZero), so '6' and 6 are distinct keys and the named duplicate rejection never fires for a fixture that declares the same source frame twice with different types. The take then measures a plausible M1 over two rows that are really one frame. The schema validator rejects wrong dtypes earlier in the pipeline; measure.mjs alone does not.");
		}
		// M4's observation map: `${frameIndex}:${trackId}` coerces "6" and 6
		// to the SAME string key, so one observation silently shadows the
		// other and the shadowed one is never judged
		const obsFx = {
			...structuredClone(chDoc),
			frames: 2,
			frameIndex: [6, 12],
			timeS: [0, 0],
			subjects: [
				{ subjectId: "A", trackId: "p0", rootWorld: [[0, 0, 0], [0, 0, 0]], contactMask: [[0.93, 0.07], [0.93, 0.07]], confidence: [0.9, 0.9] },
				{ subjectId: "B", trackId: "p1", rootWorld: [[2, 0, 0], [2, 0, 0]], contactMask: [[0.93, 0.07], [0.93, 0.07]], confidence: [0.9, 0.9] },
			],
			association: {
				observations: [
					{ frameIndex: "6", trackId: "p0", assignedSubjectId: "B", evidence: "bbox", value: [0] },
					{ frameIndex: 6, trackId: "p0", assignedSubjectId: "A", evidence: "bbox", value: [0] },
				],
				groundTruth: [{ frameIndex: 6, trackId: "p0", subjectId: "A" }],
			},
			separation: { scoredFrameIndex: [6], annotatedSeparationM: [2] },
		};
		const obsAnn = { handContact: { frameIndex: [], label: { A: [], B: [] } }, footWorld: { frameIndex: [6], A: [[0, 0, 0]], B: [[2, 0, 0]] } };
		const mObs = computeMetrics(obsFx, obsAnn);
		const reversed = structuredClone(obsFx);
		reversed.association.observations.reverse();
		const mObsRev = computeMetrics(reversed, obsAnn);
		reg.record({
			id: "MEA-key-string-obs-shadow", category: "measure", attack: "observations at frameIndex '6' and 6 (coercion collision in the M4 map)",
			input: "groundTruth (6, p0, A); observations (\"6\", p0, B) then (6, p0, A) — the B claim is the DISAGREEING duplicate",
			expected: "both observations are for the same source frame; the disagreeing one must not vanish — named rejection, or M4 must not silently read 0 while a disagreeing observation exists",
			observed: `M4=${mObs.M4} in this order (the disagreeing \"6\" observation was shadowed by the later numeric one); reversed order M4=${mObsRev.M4} — the count is array-order-dependent`,
			verdict: mObs.M4 === 0 ? "WEAKNESS" : "PASS",
		});
		if (mObs.M4 === 0) {
			reg.finding("medium", "M4's observation map coerces '6' and 6 to one key: a disagreeing duplicate observation silently shadows the other", ["MEA-key-string-obs-shadow"],
				"`obsBy` keys on `${frameIndex}:${trackId}` (template-literal coercion), so observations at numeric 6 and string '6' collide and last-write-wins. With the disagreeing claim first, M4 reads 0 — 'no swaps' — while the groundTruth entry's disagreement was never judged. The count flips to 1 when the array order is reversed: the result depends on input order, not on the data.");
		}
	}
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
