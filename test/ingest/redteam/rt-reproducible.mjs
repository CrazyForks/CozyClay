/**
 * Red-team: the F2r reproducibility gate
 * (test/ingest/verify-feasibility-reproducible.mjs) vs its contract (plan
 * §10.2: "All six metrics must be reproducible from these fixtures alone,
 * asserted by verify-feasibility-reproducible.mjs ... The fixture's sha256
 * covers the whole document and is verified before replay").
 *
 * Method: the REAL gate is copied verbatim into a scratch tree together with
 * the pinned fixtures, FEASIBILITY.md and decision.mjs, and re-run after each
 * mutation. This exercises the actual gate code (not a re-implementation):
 * exit 0 = the gate ACCEPTED the tampered set, exit 1 = it REJECTED it.
 * The repo's own fixtures are never touched.
 *
 * The tamper classes the assignment names: preserve the declared sha256 field
 * but change meaning (hash recomputed — the only way such a document can
 * still verify), reorder keys, add unknown fields, truncate arrays, and
 * record drift. Expected behaviour: the gate rejects rather than silently
 * recomputing — except where the tamper is metric-inert, which is exactly the
 * class of finding this suite exists to surface.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newRegistry, canonical, sha256Of } from "./rt-common.mjs";

const reg = newRegistry();

const REPO = fileURLToPath(new URL("../../..", import.meta.url)); // repo root
const GATE = join(REPO, "test/ingest/verify-feasibility-reproducible.mjs");
const FIX_DIR = join(REPO, "test/ingest/fixtures/solver-output/synthetic-boxing-01");
const FEAS = join(REPO, "tools/ingest/FEASIBILITY.md");
const DECISION = join(REPO, "tools/ingest/decision.mjs");
const MODES = ["contact-head", "lowest-foot", "manual-anchor"];

const scratch = mkdtempSync(join(tmpdir(), "ccm-redteam-gate-"));
const scratchTest = join(scratch, "test/ingest");
const scratchFix = join(scratchTest, "fixtures/solver-output/synthetic-boxing-01");
const scratchTools = join(scratch, "tools/ingest");
mkdirSync(scratchFix, { recursive: true });
mkdirSync(scratchTools, { recursive: true });
copyFileSync(GATE, join(scratchTest, "verify-feasibility-reproducible.mjs"));
for (const f of [...MODES.map((m) => `${m}.json`), "annotation.json"]) {
	copyFileSync(join(FIX_DIR, f), join(scratchFix, f));
}
copyFileSync(FEAS, join(scratchTools, "FEASIBILITY.md"));
copyFileSync(DECISION, join(scratchTools, "decision.mjs"));

const fixPath = (name) => join(scratchFix, name);
const pristine = Object.fromEntries([...MODES.map((m) => `${m}.json`), "annotation.json"].map((f) => [f, readFileSync(fixPath(f), "utf8")]));
const pristineFeas = readFileSync(join(scratchTools, "FEASIBILITY.md"), "utf8");

const loadJson = (name) => JSON.parse(readFileSync(fixPath(name), "utf8"));
const writeJson = (name, doc) => writeFileSync(fixPath(name), JSON.stringify(doc, null, 2) + "\n");
const rehash = (doc) => { doc.sha256 = sha256Of(doc); return doc; };

const runGate = () => {
	const r = spawnSync("node", [join(scratchTest, "verify-feasibility-reproducible.mjs")], { encoding: "utf8", timeout: 60000 });
	const out = (r.stdout || "") + (r.stderr || "");
	return { code: r.status, out };
};

const restore = (name) => writeFileSync(fixPath(name), pristine[name]);

// classify: ACCEPTED (exit 0), REJECTED-hash (exit != 0, sha256 mismatch),
// REJECTED-metric (exit != 0, FAIL lines), REJECTED-shape (validateShape/
// validateAnnotation throw)
const classify = (r) => {
	if (r.code === 0) return "ACCEPTED";
	if (/sha256 mismatch/.test(r.out)) return "REJECTED-hash";
	if (/FAIL /.test(r.out)) return "REJECTED-metric";
	if (/Error:/.test(r.out)) return "REJECTED-shape";
	return `REJECTED-exit${r.code}`;
};

const lastLines = (r, n = 3) => {
	const lines = r.out.trim().split("\n");
	// prefer the first meaningful diagnostic over the metrics tail
	const diag = lines.find((l) => /sha256 mismatch|FAIL |Error:/.test(l));
	if (diag) return diag.slice(0, 220);
	return lines.slice(-n).join(" | ").slice(0, 220);
};

const record = (id, attack, input, expected, r, verdictNote = "", expectAccept = false) => {
	const cls = classify(r);
	reg.record({
		id, category: "reproducible-gate", attack,
		input,
		expected,
		observed: `${cls} (exit ${r.code}) — ${lastLines(r)}`,
		verdict: cls === "ACCEPTED" ? (expectAccept ? "PASS" : "WEAKNESS") : "PASS",
		note: verdictNote || undefined,
	});
	return cls;
};

// ---------------------------------------------------------------------------
// Baseline: the pristine set must pass (sanity of the harness itself)
// ---------------------------------------------------------------------------
{
	const r = runGate();
	record("REP-baseline", "pristine fixture set", "unchanged pinned set", "gate green (exit 0)", r,
		r.code === 0 ? "" : "HARNESS BROKEN: pristine set rejected", true);
}

// ---------------------------------------------------------------------------
// Textual tamper WITHOUT hash recompute: every edit must be rejected at the
// hash layer before any replay — "rejects rather than silently recomputing".
// ---------------------------------------------------------------------------
{
	const r1 = runGate();
	restore("contact-head.json");
	const text = pristine["contact-head.json"].replace(/"frames":\s*186/, '"frames": 99999');
	writeFileSync(fixPath("contact-head.json"), text);
	const a = runGate();
	restore("contact-head.json");
	record("REP-tamper-frames", "edit frames field, keep declared sha256", "frames 186 -> 99999, sha256 untouched",
		"rejected at the hash layer (sha256 mismatch), nothing replayed", a);

	const doc = loadJson("contact-head.json");
	// scoredFrameIndex holds SOURCE frame keys; rootWorld is a row array, so
	// the row must come from frameIndex (they coincide only on the pinned
	// contiguous fixture — the hiding place the decimated regressions exist
	// to break)
	const tamperRow = doc.frameIndex.indexOf(doc.separation.scoredFrameIndex[0]);
	doc.subjects[0].rootWorld[tamperRow][0] += 0.1;
	writeJson("contact-head.json", doc);
	const b = runGate();
	restore("contact-head.json");
	record("REP-tamper-root", "edit a scored rootWorld value, keep declared sha256", "rootWorld[scored][x] += 0.1",
		"rejected at the hash layer", b);

	const doc2 = loadJson("contact-head.json");
	doc2.timeS[0] = 999;
	writeJson("contact-head.json", doc2);
	const c = runGate();
	restore("contact-head.json");
	record("REP-tamper-times", "edit a timeS sync key, keep declared sha256", "timeS[0] = 999",
		"rejected at the hash layer (timeS is part of the pinned document)", c);

	const doc3 = loadJson("contact-head.json");
	doc3.unknownField = { injected: true };
	writeJson("contact-head.json", doc3);
	const d = runGate();
	restore("contact-head.json");
	record("REP-tamper-unknown", "add an unknown top-level field, keep declared sha256", 'add "unknownField"',
		"rejected at the hash layer", d);
}

// ---------------------------------------------------------------------------
// Key reordering: the canonical form is JSON.stringify of the PARSED document
// minus the sha256 field — file key order survives parsing, so a reordered
// file hashes differently and must be rejected (not silently replayed).
// ---------------------------------------------------------------------------
{
	const doc = loadJson("contact-head.json");
	const reversed = {};
	for (const k of Object.keys(doc).reverse()) reversed[k] = doc[k];
	writeFileSync(fixPath("contact-head.json"), JSON.stringify(reversed, null, 2) + "\n");
	const a = runGate();
	restore("contact-head.json");
	record("REP-reorder-keys", "reorder top-level keys, keep declared sha256", "keys written in reverse order",
		"rejected at the hash layer (key order is part of the canonical form)", a);

	// reorder + rehash: semantic no-op — the gate may accept, but must
	// reproduce every metric
	const doc2 = loadJson("contact-head.json");
	const reversed2 = {};
	for (const k of Object.keys(doc2).reverse()) reversed2[k] = doc2[k];
	rehash(reversed2);
	writeJson("contact-head.json", reversed2);
	const b = runGate();
	restore("contact-head.json");
	record("REP-reorder-rehash", "reorder keys AND recompute the declared sha256", "same object, reversed key order, rehashed",
		"semantically identical document: gate accepts and reproduces all six metrics", b,
		b.code === 0 ? "no-op confirmed: all recomputed metrics equal the record" : "", true);
}

// ---------------------------------------------------------------------------
// Hash-recomputed tamper: the attacker keeps the sha256 field consistent, so
// only the metric-recompute layer can catch the edit. Each metric-affecting
// edit must still be rejected.
// ---------------------------------------------------------------------------
{
	const doc = loadJson("contact-head.json");
	// source frame key -> row, via frameIndex (see REP-tamper-root)
	const scored = doc.separation.scoredFrameIndex[0];
	const scoredRow = doc.frameIndex.indexOf(scored);
	doc.subjects[0].rootWorld[scoredRow][0] += 0.1;
	rehash(doc);
	writeJson("contact-head.json", doc);
	const a = runGate();
	restore("contact-head.json");
	record("REP-tamper-root-rehash", "scored rootWorld edit WITH recomputed sha256", "rootWorld[scored][x] += 0.1, rehashed",
		"rejected at the metric layer (M3/M5/M6 move vs the record)", a);

	const doc2 = loadJson("contact-head.json");
	const ann = loadJson("annotation.json");
	ann.handContact.label.A[0][0] = !ann.handContact.label.A[0][0];
	rehash(ann);
	writeJson("annotation.json", ann);
	const b = runGate();
	restore("annotation.json");
	record("REP-tamper-label-rehash", "hand-label flip WITH recomputed sha256", "annotation handContact.label.A[0][0] flipped",
		"rejected at the metric layer (M2 moves)", b);

	const doc3 = loadJson("contact-head.json");
	doc3.subjects[0].contactMask = doc3.subjects[0].contactMask.slice(0, 100);
	rehash(doc3);
	writeJson("contact-head.json", doc3);
	const c = runGate();
	restore("contact-head.json");
	record("REP-truncate-mask-rehash", "truncate contactMask WITH recomputed sha256", "contactMask 186 -> 100 rows",
		"rejected by the shape validator (rows !== frames)", c);

	const doc4 = loadJson("contact-head.json");
	doc4.separation.scoredFrameIndex = doc4.separation.scoredFrameIndex.slice(0, 10);
	doc4.separation.annotatedSeparationM = doc4.separation.annotatedSeparationM.slice(0, 10);
	rehash(doc4);
	writeJson("contact-head.json", doc4);
	const d = runGate();
	restore("contact-head.json");
	record("REP-truncate-separation-rehash", "truncate the separation pair WITH recomputed sha256", "scoredFrameIndex + annotatedSeparationM 20 -> 10",
		"rejected (annotation footWorld.frameIndex must equal scoredFrameIndex)", d);

	const ann2 = loadJson("annotation.json");
	ann2.handContact.frameIndex = ann2.handContact.frameIndex.slice(0, 99);
	ann2.handContact.label.A = ann2.handContact.label.A.slice(0, 99);
	ann2.handContact.label.B = ann2.handContact.label.B.slice(0, 99);
	rehash(ann2);
	writeJson("annotation.json", ann2);
	const e = runGate();
	restore("annotation.json");
	record("REP-truncate-annotation-rehash", "truncate the 100 label frames WITH recomputed sha256", "handContact 100 -> 99 frames",
		"rejected (annotation must carry exactly 100 label frames)", e);

	const doc5 = loadJson("contact-head.json");
	doc5.subjects.push(structuredClone(doc5.subjects[0]));
	rehash(doc5);
	writeJson("contact-head.json", doc5);
	const f = runGate();
	restore("contact-head.json");
	record("REP-extra-subject-rehash", "add a third subject WITH recomputed sha256", "subjects gains a clone of A",
		"rejected (v1 pins exactly two subjects)", f);
}

// ---------------------------------------------------------------------------
// Hash-recomputed tamper that is METRIC-INERT: the meaning changes but no
// metric moves. These are the silent-accept cases the assignment asks to hunt.
// ---------------------------------------------------------------------------
{
	// groundTruth emptied: identity evidence destroyed, M4 still recomputes 0
	const doc = loadJson("contact-head.json");
	doc.association.groundTruth = [];
	rehash(doc);
	writeJson("contact-head.json", doc);
	const a = runGate();
	restore("contact-head.json");
	record("REP-groundTruth-truncate", "empty groundTruth WITH recomputed sha256", "association.groundTruth = []",
		"REJECTED: destroying the identity evidence must not reproduce the recorded m4=0", a);
	if (a.code === 0) {
		reg.finding("medium", "Gate accepts a fixture whose identity evidence was deleted", ["REP-groundTruth-truncate"],
			"groundTruth=[] with a recomputed sha256 reproduces the recorded m4=0 and the whole gate chain passes (validateShape never checks association sizes). The identity gate is vacuous on such a fixture. See also MEA-m4-empty-gt.");
	}

	// confidence truncated: part of the (F) per-subject schema, read by nothing
	const doc2 = loadJson("contact-head.json");
	doc2.subjects[0].confidence = doc2.subjects[0].confidence.slice(0, 10);
	rehash(doc2);
	writeJson("contact-head.json", doc2);
	const b = runGate();
	restore("contact-head.json");
	record("REP-confidence-truncate", "truncate confidence WITH recomputed sha256", "subjects[0].confidence 186 -> 10",
		"REJECTED: the (F) shape is part of the pinned schema", b);
	if (b.code === 0) {
		reg.finding("low", "Gate accepts a fixture with a truncated confidence array", ["REP-confidence-truncate"],
			"validateShape checks rootWorld/contactMask rows but not confidence rows; no metric reads confidence, so the tamper is silent.");
	}

	// y-coordinate drift on a non-scored frame: M3 reads axes 0/2 only, M5/M6
	// only scored frames — the edit changes the document but no metric
	const doc3 = loadJson("contact-head.json");
	const scoredSet = new Set(doc3.separation.scoredFrameIndex);
	const nonScored = doc3.frameIndex.findIndex((f) => !scoredSet.has(f));
	doc3.subjects[0].rootWorld[nonScored][1] = 0.5;
	rehash(doc3);
	writeJson("contact-head.json", doc3);
	const c = runGate();
	restore("contact-head.json");
	record("REP-inert-y-tamper", "rootWorld y-drift on a non-scored frame WITH recomputed sha256",
		`subjects[0].rootWorld[${nonScored}][1] = 0.5`,
		"REJECTED: any meaning change in the pinned document should surface", c);
	if (c.code === 0) {
		reg.finding("low", "Metric-inert edits pass the gate once the hash is recomputed", ["REP-inert-y-tamper"],
			"rootWorld y on non-scored frames feeds no metric (M3 reads axes 0/2, M5/M6 only scored frames). The sha256 is self-declared, so a rehashed inert edit is undetectable by design — the metric layer only guarantees the RECORDED TABLE, not the fixture bytes. Low severity: Phase 0 consumes only the six metrics; Stage B replays the full fixture.");
	}

	// association.observations truncated: missing observations count as
	// disagreeing -> M4 moves -> must be caught (control for the two above)
	const doc4 = loadJson("contact-head.json");
	doc4.association.observations = doc4.association.observations.slice(0, 10);
	rehash(doc4);
	writeJson("contact-head.json", doc4);
	const d = runGate();
	restore("contact-head.json");
	record("REP-truncate-observations", "truncate observations WITH recomputed sha256", "observations 372 -> 10",
		"rejected: missing observations count as identity disagreements -> M4 moves", d);
}

// ---------------------------------------------------------------------------
// Record drift: the FEASIBILITY.md record itself is edited. The gate must
// compare a FRESH recomputation against the record and fail — never
// "recompute the record from the fixtures".
// ---------------------------------------------------------------------------
{
	const text = pristineFeas.replace(/"m1": 1, "m2": 1, "m4": 0, "m3": 1.7671049808617076e-16, "m5": 0, "m6": 0/,
		'"m1": 0.5, "m2": 1, "m4": 0, "m3": 1.7671049808617076e-16, "m5": 0, "m6": 0');
	writeFileSync(join(scratchTools, "FEASIBILITY.md"), text);
	const r = runGate();
	writeFileSync(join(scratchTools, "FEASIBILITY.md"), pristineFeas);
	record("REP-record-drift", "edit the recorded m1 in FEASIBILITY.md", "contact-head m1 recorded as 0.5 (fixtures unchanged)",
		"rejected: recomputed m1=1 must not match the drifted record 0.5", r);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
rmSync(scratch, { recursive: true, force: true });

export const run = async () => {
	console.log("== rt-reproducible: gate tamper matrix (real gate, scratch copy) ==");
	return { cases: reg.cases, findings: reg.findings };
};

const isMain = process.argv[1] && process.argv[1].endsWith("rt-reproducible.mjs");
if (isMain) {
	await run();
	for (const c of reg.cases) console.log(`${c.verdict.padEnd(9)} ${c.id.padEnd(26)} ${c.observed.slice(0, 90)}`);
	console.log(`\nrt-reproducible: ${reg.cases.length} cases, ${reg.findings.length} findings`);
}
