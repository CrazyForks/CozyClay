/**
 * Red-team: the RawTrack schema validator (test/ingest/verify-gvhmr-schema.mjs)
 * vs the F1 contract (RAWTRACK-CONTRACT.md §2 acceptance table, plan §8.4).
 *
 * Attack inputs: a slot resolved with the wrong dtype/units, a slot named but
 * empty, a slot escalated with an empty reason, contradictory
 * handedness/up-axis, F1-δ named-without-derivation vs derived-without-name,
 * and sync-key/tensor-length integrity the structure check does not cover.
 *
 * Method — two layers of evidence:
 *   1. REAL CODE: verify-gvhmr-schema.mjs is copied verbatim into a scratch
 *      tree with the rawtrack fixtures; rawtrack-good.json is mutated (and
 *      rehashed) per case, the real test is re-run, and the
 *      "good fixture: zero contract violations" line is grepped for the
 *      validator's verdict. (The file self-executes and process.exit()s on
 *      import, so it cannot be imported directly.)
 *   2. HARNESS: a line-by-line transcription of validateRawTrack/assertRawTrackValid
 *      for the full case matrix. The transcription is validated for
 *      behavioural equivalence against the pinned corpus first: good -> []
 *      and neg-f1d -> F1-DELTA-UNRESOLVED are asserted by the real test's own
 *      expectations, and one spawn case (good replaced by neg-alpha) cross-
 *      checks a third corpus point against the real code.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newRegistry, sha256Of } from "./rt-common.mjs";

const reg = newRegistry();
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const TEST_FILE = join(REPO, "test/ingest/verify-gvhmr-schema.mjs");
const RT_DIR = join(REPO, "test/ingest/fixtures/rawtrack");
const RT_FILES = [
	"rawtrack-good.json", "rawtrack-neg-f1d-missing.json", "rawtrack-neg-alpha-yaw.json",
	"rawtrack-neg-beta-rest.json", "rawtrack-neg-gamma-velocity.json",
	"rawtrack-neg-delta-ankle.json", "rawtrack-neg-eta-roundtrip.json",
	"rawtrack-dump-roundtrip.json", // the A1 round-trip fixture the real test's --selftest drift guard requires
];

// ---------------------------------------------------------------------------
// The transcribed validator (behavioural twin of the real one)
// ---------------------------------------------------------------------------
const SLOT_ORDER = ["F1-α", "F1-β", "F1-γ", "F1-δ", "F1-ε", "F1-ζ", "F1-η"];
const LATIN = { "F1-α": "ALPHA", "F1-β": "BETA", "F1-γ": "GAMMA", "F1-δ": "DELTA", "F1-ε": "EPSILON", "F1-ζ": "ZETA", "F1-η": "ETA" };
const CROP_FIELDS = ["offsetX", "offsetY", "scale", "cropW", "cropH", "fullW", "fullH"];

const shapeOf = (v) =>
	Array.isArray(v) ? [v.length, ...(Array.isArray(v[0]) ? shapeOf(v[0]) : [])] : null;

export class RawTrackContractErrorRT extends Error {
	constructor(code, message) {
		super(message);
		this.name = "RawTrackContractError";
		this.code = code;
	}
}

export function validateRawTrackRT(track) {
	const violations = [];
	const v = (code, message, slot) => violations.push({ code, message, slot });

	if (typeof track !== "object" || track === null || Array.isArray(track)) {
		v("F1-STRUCTURE", "RawTrack must be a JSON object");
		return violations;
	}

	if (typeof track.sha256 !== "string" || sha256Of(track) !== track.sha256) {
		v("SHA256-MISMATCH", "fixture sha256 does not match the canonical document");
		return violations;
	}

	const k = shapeOf(track.data && track.data.K);
	const structureOk =
		track.schemaVersion === 1 &&
		track.kind === "RawTrack" &&
		typeof track.clipId === "string" &&
		track.clipId.length > 0 &&
		typeof track.fps === "number" &&
		Number.isFinite(track.fps) &&
		track.fps > 0 &&
		Number.isInteger(track.frames) &&
		track.frames > 0 &&
		Array.isArray(track.frameIndex) &&
		track.frameIndex.length === track.frames &&
		track.frameIndex.every((f) => Number.isInteger(f) && f >= 0) &&
		Array.isArray(track.timeS) &&
		track.timeS.length === track.frames &&
		track.timeS.every((t) => typeof t === "number" && Number.isFinite(t)) &&
		k !== null &&
		k.length === 2 &&
		k[0] === 3 &&
		k[1] === 3;
	if (!structureOk) v("F1-STRUCTURE", "schemaVersion/kind/clipId/fps/frames/frameIndex/timeS/K (§8.1) must match the RawTrack shape");

	const p = track.provenance;
	if (typeof p !== "object" || p === null) {
		v("PROVENANCE-FIELDS", "provenance must be an object");
	} else if (p.synthetic !== true) {
		if (typeof p.gvhmrCommit !== "string" || !/^[0-9a-f]{40}$/.test(p.gvhmrCommit)) {
			v("PROVENANCE-GVHMR-COMMIT", "non-synthetic RawTrack must pin the GVHMR commit (40 hex) in provenance");
		} else if (typeof p.weightsSha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.weightsSha256)) {
			v("PROVENANCE-WEIGHTS-SHA256", "non-synthetic RawTrack must pin the weights sha256 (64 hex) in provenance");
		} else if ([p.sourceUrl, p.licence, p.sourceSha256, p.command].some((x) => typeof x !== "string" || x.length === 0)) {
			v("PROVENANCE-FIELDS", "provenance must carry sourceUrl, licence, sourceSha256 and command");
		} else if (typeof p.trimStartS !== "number" || typeof p.trimEndS !== "number" || p.trimStartS > p.trimEndS) {
			v("PROVENANCE-TRIM", "provenance trimStartS must be <= trimEndS");
		}
	}

	for (const id of SLOT_ORDER) {
		const lat = LATIN[id];
		const record = track.slots && track.slots[id];
		if (typeof record !== "object" || record === null) {
			v(`F1-${lat}-MISSING`, `${id}: slot record absent from the fixture`, id);
			continue;
		}
		if (record.status !== "resolved" && record.status !== "UNRESOLVED") {
			v(`F1-${lat}-STATUS`, `${id}: status must be "resolved" or "UNRESOLVED", got ${JSON.stringify(record.status)}`, id);
			continue;
		}
		if (record.status === "UNRESOLVED") {
			if (typeof record.reason !== "string" || record.reason.length === 0) {
				v(`F1-${lat}-ESCALATION`, `${id}: UNRESOLVED slot must carry a reason (escalation, not silence)`, id);
			}
			continue;
		}

		if (id === "F1-η") {
			const crop = record.crop;
			const cropOk =
				typeof crop === "object" && crop !== null &&
				CROP_FIELDS.every((key) => typeof crop[key] === "number" && Number.isFinite(crop[key]));
			if (
				typeof record.handedness !== "string" || record.handedness.length === 0 ||
				typeof record.upAxis !== "string" || record.upAxis.length === 0 ||
				typeof record.fps !== "number" || !cropOk
			) {
				v("F1-ETA-FIELDS", "F1-η: resolved slot must name handedness, upAxis, fps and the full crop transform", id);
			}
			continue;
		}

		const named = typeof record.tensor === "string" && record.tensor.length > 0;
		if (id === "F1-δ" && !named) {
			const d = record.derivation;
			const derived = typeof d === "object" && d !== null && typeof d.from === "string" && typeof d.via === "string";
			if (!derived) {
				v("F1-DELTA-UNRESOLVED", "F1-δ: no full-image foot observation named and no derivation supplied", id);
			}
			continue;
		}
		if (!named) {
			v(`F1-${lat}-FIELDS`, `${id}: resolved slot must name a tensor`, id);
			continue;
		}

		const shapeOk =
			Array.isArray(record.shape) && record.shape.length > 0 &&
			record.shape.every((s) => Number.isInteger(s) && s > 0);
		if (
			typeof record.dtype !== "string" || record.dtype.length === 0 ||
			!shapeOk ||
			typeof record.units !== "string" || record.units.length === 0
		) {
			v(`F1-${lat}-FIELDS`, `${id}: resolved slot must carry dtype, shape and units alongside the tensor`, id);
			continue;
		}

		// F1-δ's satisfaction was already decided above: a named tensor is
		// sufficient (plan §8.4: "named, or the exact derivation ...") — only a
		// slot that is NEITHER named nor derived is the canonical RED.
		if (id === "F1-ε" && (typeof record.convention !== "string" || typeof record.threshold !== "string")) {
			v(`F1-${lat}-CONVENTION`, "F1-ε: resolved slot must state the logit/probability convention and threshold semantics", id);
		}
		if (id === "F1-ζ" && (typeof record.jointOrder !== "string" || typeof record.restBasis !== "string")) {
			v(`F1-${lat}-MODEL`, "F1-ζ: resolved slot must name the joint ordering and rest basis", id);
		}

		const actual = track.data && track.data[record.tensor];
		if (!Array.isArray(actual)) {
			v(`F1-${lat}-TENSOR-MISMATCH`, `${id}: named tensor ${record.tensor} is absent from data`, id);
		} else {
			const a = shapeOf(actual);
			const s = record.shape;
			if (a === null || a.length !== s.length || !a.every((dim, i) => dim === s[i])) {
				v(`F1-${lat}-TENSOR-MISMATCH`, `${id}: named tensor ${record.tensor} has shape ${JSON.stringify(a)}, declared ${JSON.stringify(s)}`, id);
			}
		}
	}

	return violations;
}

export function assertRawTrackValidRT(track) {
	const violations = validateRawTrackRT(track);
	if (violations.length > 0) {
		const first = violations[0];
		throw new RawTrackContractErrorRT(first.code, first.message);
	}
}

// ---------------------------------------------------------------------------
// Corpus validation: the transcription must agree with the real validator on
// every pinned fixture before its verdicts on novel mutations are trusted.
// ---------------------------------------------------------------------------
const load = (n) => JSON.parse(readFileSync(join(RT_DIR, n), "utf8"));
const good = load("rawtrack-good.json");
const corpus = {
	"rawtrack-good.json": [],
	"rawtrack-neg-alpha-yaw.json": [],          // numeric-acceptance negative; validator passes it
	"rawtrack-neg-beta-rest.json": [],          // numeric-acceptance negative
	"rawtrack-neg-gamma-velocity.json": [],     // numeric-acceptance negative
	"rawtrack-neg-delta-ankle.json": [],        // numeric-acceptance negative
	"rawtrack-neg-eta-roundtrip.json": [],      // one-off round-trip negative; validator passes it
	"rawtrack-neg-f1d-missing.json": ["F1-DELTA-UNRESOLVED"], // the plan's canonical RED
};
let corpusOk = true;
for (const [name, wantCodes] of Object.entries(corpus)) {
	const doc = load(name);
	const vs = validateRawTrackRT(doc).map((x) => x.code);
	const ok = vs.length === wantCodes.length && wantCodes.every((c) => vs.includes(c));
	if (!ok) corpusOk = false;
}
reg.record({
	id: "SCH-corpus", category: "schema", attack: "harness transcription vs the pinned corpus",
	input: "7 checked-in fixtures (1 good, 6 negatives)",
	expected: "transcribed validator agrees with the real one: good -> [], the five acceptance negatives -> [], neg-f1d -> F1-DELTA-UNRESOLVED",
	observed: corpusOk ? "behaviourally equivalent on all 7 pinned fixtures" : "TRANSCRIPTION DIVERGED — harness verdicts untrustworthy",
	verdict: corpusOk ? "PASS" : "DEFECT",
});

// ---------------------------------------------------------------------------
// Real-code spawn evidence (scratch copy of the real test)
// ---------------------------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), "ccm-redteam-schema-"));
const scratchTest = join(scratch, "test/ingest");
const scratchRt = join(scratchTest, "fixtures/rawtrack");
const scratchTools = join(scratch, "tools/ingest");
mkdirSync(scratchRt, { recursive: true });
mkdirSync(scratchTools, { recursive: true });
copyFileSync(TEST_FILE, join(scratchTest, "verify-gvhmr-schema.mjs"));
copyFileSync(join(REPO, "tools/ingest/dump-gvhmr.py"), join(scratchTools, "dump-gvhmr.py"));
// verify-gvhmr-schema.mjs imports the F2a/F2b feasibility runners (A1 round
// trip), so the scratch tree must mirror them too — a spawn harness that
// cannot load the real test file proves nothing.
mkdirSync(join(scratchTools, "feasibility"), { recursive: true });
copyFileSync(join(REPO, "tools/ingest/feasibility/contact-head.mjs"), join(scratchTools, "feasibility/contact-head.mjs"));
copyFileSync(join(REPO, "tools/ingest/feasibility/lowest-foot.mjs"), join(scratchTools, "feasibility/lowest-foot.mjs"));
for (const f of RT_FILES) copyFileSync(join(RT_DIR, f), join(scratchRt, f));

const runRealTest = () => {
	const r = spawnSync("node", [join(scratchTest, "verify-gvhmr-schema.mjs")], { encoding: "utf8", timeout: 60000 });
	return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
};
const contractLine = (out) => {
	const l = out.split("\n").find((x) => x.includes("good fixture: zero contract violations"));
	return l ? l.trim().slice(0, 160) : "(line not found)";
};
const spawnRecord = (id, attack, mutate, expected, expectRejected = true) => {
	const doc = JSON.parse(readFileSync(join(scratchRt, "rawtrack-good.json"), "utf8"));
	mutate(doc);
	doc.sha256 = sha256Of(doc);
	writeFileSync(join(scratchRt, "rawtrack-good.json"), JSON.stringify(doc, null, 2) + "\n");
	const r = runRealTest();
	const line = contractLine(r.out);
	writeFileSync(join(scratchRt, "rawtrack-good.json"), readFileSync(join(RT_DIR, "rawtrack-good.json"), "utf8"));
	const rejected = line.startsWith("FAIL");
	const matched = expectRejected ? rejected : !rejected;
	reg.record({
		id, category: "schema", attack,
		input: "rawtrack-good.json mutated + rehashed; real verify-gvhmr-schema.mjs re-run",
		expected,
		observed: `real validator: ${line}`,
		verdict: matched ? "PASS" : "WEAKNESS",
	});
	return { rejected, line };
};

// baseline: pristine copy of the real test must be green
{
	const r = runRealTest();
	const line = contractLine(r.out);
	reg.record({
		id: "SCH-spawn-baseline", category: "schema", attack: "pristine scratch copy of the real test",
		input: "no mutation",
		expected: "real test exits 0",
		observed: `exit ${r.code} — ${line}`,
		verdict: r.code === 0 ? "PASS" : "DEFECT",
	});
}
// F1-η contradiction: slots say upAxis Z, data says Y — validator blind?
spawnRecord("SCH-spawn-upaxis", "contradictory up-axis (slots Z vs data Y)",
	(d) => { d.slots["F1-η"].upAxis = "Z"; },
	"validator: slots.F1-η.upAxis is a non-empty string -> 'PASS good fixture: zero contract violations' (the round-trip consistency check is a one-off ok(), not part of validateRawTrack)");
// escalated slot with an empty reason must be rejected
spawnRecord("SCH-spawn-empty-reason", "UNRESOLVED slot with an empty reason",
	(d) => { Object.assign(d.slots["F1-ε"], { status: "UNRESOLVED", reason: "" }); },
	"rejected: F1-EPSILON-ESCALATION ('FAIL good fixture: zero contract violations')");
// wrong units on a self-consistent fixture: neither layer can see the label
spawnRecord("SCH-spawn-units", "wrong units label on F1-γ (metres data labelled centimetres)",
	(d) => { d.slots["F1-γ"].units = "centimetres"; },
	"validator: units is a non-empty string -> PASS; the §8.4 numeric acceptance compares data vs annotation (both metres) and also passes — the wrong label is undetected");
// F1-δ named-only (full-image tensor, no derivation) — the §8.4 acceptance
// path. The validator must ACCEPT it (plan §8.4: "named, or the exact
// derivation"); the old rejection was blocker B1.
spawnRecord("SCH-spawn-f1d-named-only", "F1-δ resolved by name only, no derivation",
	(d) => { delete d.slots["F1-δ"].derivation; },
	"contract §2 F1-δ row: 'named, or the exact derivation' — named-only must be accepted ('PASS good fixture: zero contract violations')",
	false);
// neg-alpha as the good fixture: validator must still pass it (cross-check)
{
	const r = runRealTest();
	const doc = JSON.parse(readFileSync(join(scratchRt, "rawtrack-neg-alpha-yaw.json"), "utf8"));
	writeFileSync(join(scratchRt, "rawtrack-good.json"), JSON.stringify(doc, null, 2) + "\n");
	const r2 = runRealTest();
	writeFileSync(join(scratchRt, "rawtrack-good.json"), readFileSync(join(RT_DIR, "rawtrack-good.json"), "utf8"));
	reg.record({
		id: "SCH-spawn-negalpha-as-good", category: "schema", attack: "neg-alpha content as the good fixture (corpus cross-check)",
		input: "rawtrack-good.json replaced by rawtrack-neg-alpha-yaw.json (12° yaw corruption, hash-valid)",
		expected: "validator passes it (the corruption is a numeric-acceptance negative, not a contract negative) while the yaw acceptance FAILs",
		observed: `baseline exit ${r.code}; with neg-alpha: ${contractLine(r2.out)}`,
		verdict: contractLine(r2.out).startsWith("PASS") ? "PASS" : "DEFECT",
	});
}

// ---------------------------------------------------------------------------
// Harness case matrix (each mutation rehashed — the sha256 gate is passed by
// construction so the case reaches the contract logic)
// ---------------------------------------------------------------------------
const clone = () => JSON.parse(JSON.stringify(good));
const hCase = (id, attack, mutate, expectedCodes, verdict, note) => {
	const doc = clone();
	mutate(doc);
	doc.sha256 = sha256Of(doc);
	const codes = validateRawTrackRT(doc).map((x) => x.code);
	const match = expectedCodes.length === codes.length && expectedCodes.every((c) => codes.includes(c));
	reg.record({
		id, category: "schema", attack,
		input: "good fixture mutated + rehashed, validateRawTrackRT",
		expected: expectedCodes.length ? `rejected with ${expectedCodes.join("/")}` : "accepted (zero violations)",
		observed: codes.length ? `violations: ${codes.join("/")}` : "accepted (zero violations)",
		verdict: match ? verdict : verdict === "PASS" ? "DEFECT" : "PASS",
		note,
	});
	return codes;
};

// wrong dtype / wrong units on a resolved slot
hCase("SCH-wrong-dtype", "resolved slot with a wrong dtype label",
	(d) => { d.slots["F1-γ"].dtype = "int32"; }, [],
	"WEAKNESS", "dtype is an opaque non-empty string; no check ties it to the data. The F1 table names dtype only as part of 'named tensor + dtype/shape/units' — the field's correctness is operator-attested.");
hCase("SCH-wrong-units", "resolved slot with a wrong units label",
	(d) => { d.slots["F1-γ"].units = "centimetres"; }, [],
	"WEAKNESS", "units is an opaque non-empty string; the §8.4 acceptance only catches units that contradict the data scale (see SCH-spawn-units: self-consistent data passes everything).");
// slot named but empty / hollow
hCase("SCH-empty-tensor-name", "resolved slot with an empty tensor name",
	(d) => { d.slots["F1-α"].tensor = ""; }, ["F1-ALPHA-FIELDS"], "PASS");
hCase("SCH-empty-shape", "resolved slot with an empty shape array",
	(d) => { d.slots["F1-α"].shape = []; }, ["F1-ALPHA-FIELDS"], "PASS");
hCase("SCH-empty-units", "resolved slot with an empty units string",
	(d) => { d.slots["F1-γ"].units = ""; }, ["F1-GAMMA-FIELDS"], "PASS");
hCase("SCH-tensor-absent", "named tensor absent from data",
	(d) => { delete d.data.global_orient_cam; }, ["F1-ALPHA-TENSOR-MISMATCH"], "PASS");
hCase("SCH-tensor-empty", "named tensor present but an empty array",
	(d) => { d.data.global_orient_cam = []; }, ["F1-ALPHA-TENSOR-MISMATCH"], "PASS");
// escalated with an empty / missing reason
hCase("SCH-escalation-empty-reason", "UNRESOLVED slot with an empty reason",
	(d) => { Object.assign(d.slots["F1-ε"], { status: "UNRESOLVED", reason: "" }); }, ["F1-EPSILON-ESCALATION"], "PASS");
hCase("SCH-escalation-missing-reason", "UNRESOLVED slot with no reason key",
	(d) => { Object.assign(d.slots["F1-ε"], { status: "UNRESOLVED" }); delete d.slots["F1-ε"].reason; }, ["F1-EPSILON-ESCALATION"], "PASS");
// contradictory handedness / up-axis / crop round-trip
hCase("SCH-contradict-upaxis", "slots upAxis contradicts data.upAxis",
	(d) => { d.slots["F1-η"].upAxis = "Z"; }, [],
	"WEAKNESS", "F1-η contract: 'handedness, up-axis, fps, crop transform — named and asserted by fixture round-trip'. The round-trip assertion exists only as a one-off ok() on the checked-in good fixture; validateRawTrack never cross-checks slots vs data.");
hCase("SCH-contradict-handedness", "slots handedness contradicts data.handedness",
	(d) => { d.slots["F1-η"].handedness = "left-handed"; }, [],
	"WEAKNESS", "same class as SCH-contradict-upaxis.");
hCase("SCH-contradict-crop", "slots.F1-η.crop.scale contradicts data.crop.scale",
	(d) => { d.slots["F1-η"].crop.scale = 3; }, [],
	"WEAKNESS", "crop round-trip (named crop == data crop) is asserted only by the one-off ok() on the good fixture; the validator accepts a contradictory crop.");
// F1-δ satisfaction paths (plan §8.4: "named, or the exact derivation ...")
hCase("SCH-f1d-named-only", "F1-δ resolved by name, no derivation",
	(d) => { delete d.slots["F1-δ"].derivation; }, [],
	"PASS", "Blocker B1 closed: RAWTRACK-CONTRACT §2 F1-δ 'named, or the exact derivation' — a named full-image observation needs no derivation. dump-gvhmr.py emits exactly this form for full-image tensors (rt-dump DMP-full-image-slot); the validator's old second F1-δ block rejected it. Regression guard: this case and SCH-f1d-neither-named-or-derived pin both sides of the §8.4 row.");
hCase("SCH-f1d-neither-named-or-derived", "F1-δ neither names a tensor nor supplies a derivation",
	(d) => { delete d.slots["F1-δ"].tensor; delete d.slots["F1-δ"].derivation; }, ["F1-DELTA-UNRESOLVED"],
	"PASS", "The plan's canonical F1 RED (stage-05 §13) must survive the named-only fix: a slot that is NEITHER named nor derived is rejected with F1-DELTA-UNRESOLVED. Sibling of SCH-f1d-named-only.");
hCase("SCH-f1d-derived-only", "F1-δ derived without a named tensor",
	(d) => { delete d.slots["F1-δ"].tensor; d.slots["F1-δ"].derivation = { from: "crop-space keypoints", via: "full = crop / scale + offset" }; }, [],
	"PASS", "contract §4: 'F1-δ may instead supply derivation' — accepted.");
// sync-key and tensor-length integrity
hCase("SCH-unsorted-frameIndex", "frameIndex shuffled (sync key order destroyed)",
	(d) => { d.frameIndex = [...d.frameIndex].reverse(); }, [],
	"WEAKNESS", "structure check requires integers >= 0 but not sortedness or uniqueness; frameIndex is the synchronization key (RAWTRACK-CONTRACT §1).");
hCase("SCH-duplicate-frameIndex", "frameIndex contains duplicates",
	(d) => { d.frameIndex[5] = d.frameIndex[4]; }, [],
	"WEAKNESS", "duplicate source frame numbers break frame synchronization; undetected.");
hCase("SCH-tensor-length-vs-frames", "data tensor rows disagree with frames",
	(d) => { d.frames = 10; d.frameIndex = d.frameIndex.slice(0, 10); d.timeS = d.timeS.slice(0, 10); }, [],
	"WEAKNESS", "no cross-check that data tensors have `frames` rows; a decimated slice whose tensors are longer than the sync keys passes the validator (cf. rt-dump DMP-length-mismatch).");
// fps sanity and unknown fields
hCase("SCH-fps-nan", "fps = NaN",
	(d) => { d.fps = NaN; }, ["F1-STRUCTURE"], "PASS");
hCase("SCH-extra-field", "unknown top-level field added",
	(d) => { d.notes = "tampered"; }, [],
	"PASS", "unknown fields are tolerated by the contract shape (forward compatibility); the hash gate pins them.");
// ---------------------------------------------------------------------------
// Pass-2: attack the F1-δ named-or-derived fix and the fps gate. Each variant
// targets the boundary the pass-1 fix left open:
//   - a hollow NAME (empty string) or a hollow DERIVATION ({from:"",via:""})
//     must not satisfy §8.4's "named, or the exact derivation" — the good
//     fixture's F1-δ resolves by derivation, so an empty tensor name with the
//     derivation retained is still a legitimately derived slot (PASS), while
//     an empty derivation with no named tensor resolves NOTHING yet is
//     accepted (WEAKNESS).
//   - fps 0 / negative / string must fail the structure gate like NaN does.
//   - a body-model tensor present with the wrong rank must be rejected by the
//     tensor/shape cross-check.
// ---------------------------------------------------------------------------
// tensor "" with the derivation retained: the derivation carries the
// resolution, so acceptance is contract-correct (§8.4 "named, OR the exact
// derivation").
hCase("SCH-f1d-empty-name", "F1-δ tensor name empty, derivation retained",
	(d) => { d.slots["F1-δ"].tensor = ""; }, [],
	"PASS", "the good fixture's F1-δ resolves by derivation; with the exact derivation present an empty tensor name does not hollow the slot.");
// tensor 42 (non-string) with the derivation retained: same reasoning
hCase("SCH-f1d-name-nonstring", "F1-δ tensor name a non-string, derivation retained",
	(d) => { d.slots["F1-δ"].tensor = 42; }, [],
	"PASS", "non-string tensor with a valid derivation: the derivation carries the resolution; §8.4 is an OR.");
// whitespace-only tensor name: 'named' is a non-empty string, so the slot
// claims a tensor named "   " that does not exist -> the tensor cross-check
// must catch it
hCase("SCH-f1d-whitespace-name", "F1-δ tensor name whitespace-only",
	(d) => { d.slots["F1-δ"].tensor = "   "; }, ["F1-DELTA-TENSOR-MISMATCH"], "PASS");
// the hollow-derivation variant: no tensor, derivation strings empty — the
// slot "resolves" without naming anything. RAWTRACK-CONTRACT §7: the
// derivation "must state the exact recipe (crop-space keypoints + crop
// transform)"; {from:"",via:""} states nothing.
hCase("SCH-f1d-empty-derivation", "F1-δ with no tensor and an all-empty derivation",
	(d) => { delete d.slots["F1-δ"].tensor; d.slots["F1-δ"].derivation = { from: "", via: "" }; }, [],
	"WEAKNESS", "derived = 'from and via are strings' — empty strings qualify. A hollow derivation satisfies the §8.4 'named, or the exact derivation' row and the slot records as resolved with no supplier cited (subjects: [] downstream, but the fixture claims F1-δ resolved).");
hCase("SCH-f1d-derivation-empty-from", "F1-δ with no tensor and a derivation whose from is empty",
	(d) => { delete d.slots["F1-δ"].tensor; d.slots["F1-δ"].derivation = { from: "", via: "full = crop / scale + offset" }; }, [],
	"WEAKNESS", "from names the supplier; an empty from means the derivation names no observation, yet the string-type check accepts it (same class as SCH-f1d-empty-derivation).");
// fps gate variants: 0 / negative / string-typed
hCase("SCH-fps-zero", "fps = 0",
	(d) => { d.fps = 0; }, ["F1-STRUCTURE"], "PASS");
hCase("SCH-fps-negative", "fps = -5",
	(d) => { d.fps = -5; }, ["F1-STRUCTURE"], "PASS");
hCase("SCH-fps-string", "fps = \"29.97\"",
	(d) => { d.fps = "29.97"; }, ["F1-STRUCTURE"], "PASS");
// a named body-model tensor present with the wrong rank: the declared shape
// [30,24,3] vs data [30,24] must be caught by the tensor/shape cross-check
hCase("SCH-tensor-wrong-rank", "F1-ζ tensor exists but with the wrong rank (2D instead of (F,24,3))",
	(d) => { d.data.body_pose_smpl = [[0, 0], [0, 0]]; }, ["F1-ZETA-TENSOR-MISMATCH"], "PASS");

// ---------------------------------------------------------------------------
// Findings: validator blind spots (each verified against the real code where
// noted)
// ---------------------------------------------------------------------------
reg.finding("medium", "F1-η round-trip consistency is not enforced by validateRawTrack", ["SCH-spawn-upaxis", "SCH-contradict-upaxis", "SCH-contradict-handedness", "SCH-contradict-crop"],
	"RAWTRACK-CONTRACT §2 F1-η: handedness, up-axis, fps, crop transform 'named and asserted by fixture round-trip'. The round-trip assertion exists only as one-off ok() lines on the checked-in good fixture; validateRawTrack accepts a fixture whose slots.F1-η.upAxis/handedness/crop contradict data.* — confirmed with the real test (SCH-spawn-upaxis: 'PASS good fixture: zero contract violations').");
reg.finding("low", "frameIndex sync-key integrity (sortedness, uniqueness) unchecked; data-tensor length vs frames unchecked", ["SCH-unsorted-frameIndex", "SCH-duplicate-frameIndex", "SCH-tensor-length-vs-frames"],
	"frameIndex is the synchronization key (RAWTRACK-CONTRACT §1); duplicates or reordering pass the validator, and a data tensor whose row count disagrees with frames passes too (cf. DMP-length-mismatch).");
reg.finding("low", "dtype/units labels are opaque strings — a wrong label on self-consistent data is undetected", ["SCH-wrong-dtype", "SCH-wrong-units", "SCH-spawn-units"],
	"The §8.4 numeric acceptance catches units that contradict the data scale, but a wrong label on self-consistent data (data and annotation both metres, label says centimetres) passes both the validator and the acceptance — confirmed with the real test (SCH-spawn-units). dtype is never tied to the data at all.");
reg.finding("medium", "F1-δ 'the exact derivation' accepts hollow derivations ({from:'',via:''} or empty from)", ["SCH-f1d-empty-derivation", "SCH-f1d-derivation-empty-from"],
	"RAWTRACK-CONTRACT §7: F1-δ's derivation 'must state the exact recipe (crop-space keypoints + crop transform)' and §2 allows it 'or the exact derivation'. validateRawTrackRT treats 'from and via are strings' as derived, so a slot with NO named tensor and {from:'',via:''} records as resolved — no supplier cited, no recipe stated. The fixture then claims F1-δ resolved (with subjects: [] downstream) while the operator gate believes the slot is satisfied.");

rmSync(scratch, { recursive: true, force: true });

export const run = async () => {
	console.log("== rt-schema: RawTrack validator attacks ==");
	return { cases: reg.cases, findings: reg.findings };
};

const isMain = process.argv[1] && process.argv[1].endsWith("rt-schema.mjs");
if (isMain) {
	await run();
	for (const c of reg.cases) console.log(`${c.verdict.padEnd(9)} ${c.id.padEnd(28)} ${c.observed.slice(0, 110)}`);
	console.log(`\nrt-schema: ${reg.cases.length} cases, ${reg.findings.length} findings`);
}
