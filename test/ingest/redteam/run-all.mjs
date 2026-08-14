/**
 * run-all.mjs — the Phase-0 adversarial red-team orchestrator.
 *
 * Imports the six attack modules (each registers cases + findings at import),
 * runs the CLI replay, and writes:
 *   artifacts/ingest-phase0-adversarial-report.json  (kind: adversarial-test-report)
 *   artifacts/ingest-phase0-cli-replay.json         (kind: cli-replay, exact shape)
 *
 * Usage: node test/ingest/redteam/run-all.mjs   (from the repo root)
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const ARTIFACT_DIR = join(REPO, "artifacts");
mkdirSync(ARTIFACT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 1. Attack modules (register cases/findings at import)
// ---------------------------------------------------------------------------
const rtDecision = await import("./rt-decision.mjs");
const rtMeasure = await import("./rt-measure.mjs");
const rtReproducible = await import("./rt-reproducible.mjs");
const rtSchema = await import("./rt-schema.mjs");
const rtDump = await import("./rt-dump.mjs");
const rtIntegrity = await import("./rt-integrity.mjs");
import { captureBaseline, isRedBaseline, replayMatches } from "./rt-integrity.mjs";
import { newRegistry, staleFindings, ok } from "./rt-common.mjs";

const modules = {
	decision: await rtDecision.run(),
	measure: await rtMeasure.run(),
	reproducible: await rtReproducible.run(),
	schema: await rtSchema.run(),
	dump: await rtDump.run(),
	integrity: await rtIntegrity.run(),
};
const allCases = modules.decision.cases.concat(
	modules.measure.cases, modules.reproducible.cases,
	modules.schema.cases, modules.dump.cases, modules.integrity.cases,
);
const allFindings = modules.decision.findings.concat(
	modules.measure.findings, modules.reproducible.findings,
	modules.schema.findings, modules.dump.findings, modules.integrity.findings,
);
//
// ---------------------------------------------------------------------------
// Class-B structural guard: no finding may be registered while every case it
// references PASSes (or the refs name unknown cases) — a finding describing
// a weakness no observed case shows is stale by construction and can never
// clear (rt-measure's M3/M4=0 findings survived their own fixes until this
// guard existed). The self-test below proves the guard fires, so the guard
// itself is not another unobserved assertion.
// ---------------------------------------------------------------------------
{
	const staleReg = newRegistry();
	staleReg.record({ id: "GUARD-self-pass", category: "self", attack: "synthetic", input: "", expected: "", observed: "", verdict: "PASS" });
	staleReg.finding("low", "synthetic stale finding", ["GUARD-self-pass"], "deliberately stale: its only referenced case passes");
	const observedReg = newRegistry();
	observedReg.record({ id: "GUARD-self-weak", category: "self", attack: "synthetic", input: "", expected: "", observed: "", verdict: "WEAKNESS" });
	observedReg.finding("low", "synthetic observed finding", ["GUARD-self-weak"], "referenced case shows the weakness");
	const missingReg = newRegistry();
	missingReg.record({ id: "GUARD-self-pass", category: "self", attack: "synthetic", input: "", expected: "", observed: "", verdict: "PASS" });
	missingReg.finding("low", "synthetic unknown-ref finding", ["GUARD-self-no-such-case"], "references a case that does not exist");
	const staleHits = staleFindings(staleReg.findings, staleReg.cases);
	const observedHits = staleFindings(observedReg.findings, observedReg.cases);
	const missingHits = staleFindings(missingReg.findings, missingReg.cases);
	ok("guard self-test: a finding whose referenced cases all PASS is flagged stale",
		staleHits.length === 1 && staleHits[0] === staleReg.findings[0],
		`hits=${staleHits.map((f) => f.title).join(", ") || "none"}`);
	ok("guard self-test: a finding whose referenced case shows the defect is not stale",
		observedHits.length === 0,
		`hits=${observedHits.map((f) => f.title).join(", ") || "none"}`);
	ok("guard self-test: a finding referencing an unknown case id is flagged stale",
		missingHits.length === 1 && missingHits[0] === missingReg.findings[0],
		`hits=${missingHits.map((f) => f.title).join(", ") || "none"}`);
	if (staleHits.length !== 1 || observedHits.length !== 0 || missingHits.length !== 1) {
		throw new Error("GUARD-SELFTEST-FAILED: the stale-finding guard did not behave as its own scratch registries require");
	}
}
const staleFindingsHit = staleFindings(allFindings, allCases);
if (staleFindingsHit.length) {
	throw new Error(
		"STALE-FINDINGS " +
			staleFindingsHit.map((f) => `"${f.title}" (refs: ${(f.refs || []).join(", ") || "none"})`).join("; ") +
			" — a registered finding references cases that all PASS (or unknown case ids), so it can never clear; " +
			"gate each finding on its referenced cases' observed verdicts (findingWhenObserved) or convert it to a case note",
	);
}
//
// ---------------------------------------------------------------------------
// Verdict-derived blockers: the report must not claim an obligation is clear
// (or blocked) independently of what actually ran this session. A DEFECT
// verdict is the contract/code-mismatch class (rt-common.mjs), so blockers
// are exactly the DEFECT cases observed; the two F1 obligations flip to
// "blocker" only while any case pinning them does not PASS.
// ---------------------------------------------------------------------------
const verdictOf = (id) => {
	const c = allCases.find((x) => x.id === id);
	return c ? c.verdict : "MISSING";
};
const allPass = (ids) => ids.every((id) => verdictOf(id) === "PASS");
const blockers = allCases
	.filter((c) => c.verdict === "DEFECT")
	.map((c) => ({
		id: c.id,
		severity: "high",
		title: c.attack,
		planRef: "derived from the red-team case verdict (DEFECT = contract/code mismatch)",
		evidence: [c.id],
		detail: `${c.expected} — observed: ${c.observed}`,
	}));
const F1_DELTA_REFS = ["SCH-spawn-f1d-named-only", "SCH-f1d-named-only", "SCH-f1d-neither-named-or-derived", "DMP-full-image-slot"];
const DUMP_EMIT_REFS = ["DMP-model-crash"];
const INT_REFS = ["INT-baseline-green", "INT-baseline-pass-exit1", "INT-baseline-fail-exit0", "INT-baseline-fail-stderr-exit0", "INT-replay-byte-identical", "INT-replay-exit-drift", "INT-replay-stderr-drift", "INT-replay-error-word", "INT-replay-missing-marker"];

// ---------------------------------------------------------------------------
// 2. The CLI replay artifact (exact shape, deterministic node -e)
// ---------------------------------------------------------------------------
const REPLAY_CODE =
	`import('./tools/ingest/decision.mjs').then(m=>{const r=m.decideFeasibility({m1:0.8,m2:0.9,m4:0,modes:{'contact-head':{m3:0.01,m5:0.01,m6:0.01,runnerGreen:true,measurementGreen:true},'lowest-foot':{m3:0.5,m5:0.5,m6:0.5,runnerGreen:true,measurementGreen:true},'manual-anchor':{m3:0.5,m5:0.5,m6:0.5,runnerGreen:true,measurementGreen:true}}});console.log('REDTEAM-CLI-REPLAY-OK '+r.verdict+':'+r.mode+':'+r.reason)}).catch(e=>{console.error('REDTEAM-CLI-REPLAY-FAIL '+e);process.exit(1)})`;

const REPLAY = {
	schemaVersion: 1,
	kind: "cli-replay",
	replaySafe: true,
	command: ["node", "-e", REPLAY_CODE],
	cwd: ".",
	env: { ...process.env, LC_ALL: "C" },
	timeoutMs: 30000,
	expectedExitCode: 0,
	recordedStdout: "",
	recordedStderr: "",
	invariants: [
		{ type: "substring", value: "REDTEAM-CLI-REPLAY-OK" },
		{ type: "not-substring", value: "error" },
	],
};

const runReplay = () =>
	spawnSync("node", ["-e", REPLAY_CODE], {
		cwd: REPO,
		encoding: "utf8",
		timeout: 30000,
		env: { ...process.env, LC_ALL: "C" },
	});

const first = runReplay();
const replayVerified = first.status === 0 && (first.stderr || "") === "";
if (!replayVerified) {
	throw new Error(`CLI replay failed to run: exit ${first.status}, stderr=${(first.stderr || "").slice(0, 200)}`);
}
REPLAY.recordedStdout = first.stdout;
REPLAY.recordedStderr = first.stderr;

// re-run to prove the artifact reproduces byte-for-byte (the predicate is
// rt-integrity.mjs's replayMatches — the same code the attack cases pin)
const second = runReplay();
const reproduces = replayMatches(second, {
	expectedExitCode: REPLAY.expectedExitCode,
	recordedStdout: REPLAY.recordedStdout,
	recordedStderr: REPLAY.recordedStderr,
	okMarker: "REDTEAM-CLI-REPLAY-OK",
});
REPLAY.replaySafe = reproduces;

const replayPath = join(ARTIFACT_DIR, "ingest-phase0-cli-replay.json");
writeFileSync(replayPath, JSON.stringify(REPLAY, null, 2) + "\n");

// ---------------------------------------------------------------------------
// 3. The adversarial report artifact
// ---------------------------------------------------------------------------
const commit = execSync("git rev-parse HEAD", { cwd: REPO, encoding: "utf8" }).trim();
const nodeVer = execSync("node --version", { encoding: "utf8" }).trim();
const pyVer = execSync("python3 --version", { encoding: "utf8" }).trim();

// Scope and baseline are DERIVED and EXECUTED, never asserted. An evidence
// artifact that hard-codes a revision or a result it did not observe is worse
// than no artifact: it survives the change that invalidates it and reads as
// proof. A previous revision of this file pinned "main..dd008dd (5 commits)"
// and claimed exit-0 baselines it never ran, which is exactly the failure this
// suite exists to catch elsewhere.
const mergeBase = execSync("git merge-base main HEAD", { cwd: REPO, encoding: "utf8" }).trim();
const commitCount = execSync("git rev-list --count main..HEAD", { cwd: REPO, encoding: "utf8" }).trim();
const subjects = execSync("git log --format=%s main..HEAD", { cwd: REPO, encoding: "utf8" })
	.trim().split("\n").filter(Boolean).reverse();

const BASELINE_SUITES = [
	"test/ingest/verify-gvhmr-schema.mjs",
	"test/ingest/verify-feasibility-modes.mjs",
	"test/ingest/verify-feasibility-reproducible.mjs",
	"test/ingest/verify-decision-function.mjs",
];
// run each baseline for real and record what actually happened, including the
// observed assertion count -- a hard-coded count silently rots
const baselineRun = {};
const baselineCommands = [];
for (const suite of BASELINE_SUITES) {
	const cmd = `node ${suite}`;
	// captureBaseline (rt-integrity.mjs) merges stdout AND stderr on every
	// exit path — a FAIL line on stderr counts exactly like one on stdout,
	// and a failed spawn records as exit 1, never as a silent green.
	const rec = captureBaseline(cmd, REPO);
	baselineRun[cmd] = { observedExitCode: rec.observedExitCode, passAssertions: rec.passAssertions, failAssertions: rec.failAssertions };
	baselineCommands.push(cmd);
}

// Branch and numpy availability were the last two asserted-not-observed fields.
// numpy matters because the dump's emission path is driven through
// rt-dump-stub.py when numpy is absent; recording "absent" without probing can
// contradict the cases actually collected.
const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: REPO, encoding: "utf8" }).trim();
let numpy;
try {
	const v = execSync("python3 -c \"import numpy; print(numpy.__version__)\"", {
		encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
	}).trim();
	numpy = `present (${v})`;
} catch {
	numpy = "absent (dump emission paths driven via rt-dump-stub.py)";
}

const report = {
	schemaVersion: 1,
	kind: "adversarial-test-report",
	title: "Phase-0 ingest feasibility — adversarial QA / red-team report",
	scope: {
		repo: "CozyClay",
		branch,
		commit,
		mergeBase,
		changeSet: `main..HEAD (${commitCount} commit${commitCount === "1" ? "" : "s"}: ${subjects.join(" | ")})`,
		date: new Date().toISOString(),
		environment: { node: nodeVer, python: pyVer, numpy },
	},
	baseline: baselineRun,
	suiteFiles: [
		"test/ingest/redteam/rt-common.mjs",
		"test/ingest/redteam/rt-decision.mjs",
		"test/ingest/redteam/rt-measure.mjs",
		"test/ingest/redteam/rt-reproducible.mjs",
		"test/ingest/redteam/rt-schema.mjs",
		"test/ingest/redteam/rt-dump.mjs",
		"test/ingest/redteam/rt-integrity.mjs",
		"test/ingest/redteam/rt-dump-stub.py",
		"test/ingest/redteam/run-all.mjs",
	],
	// only commands this orchestrator actually executed in this run
	commandsRun: [
		"git rev-parse HEAD",
		"git merge-base main HEAD",
		"git rev-list --count main..HEAD",
		"git log --format=%s main..HEAD",
		...baselineCommands,
		...Object.keys(modules).map((m) => `test/ingest/redteam/rt-${m}.mjs (imported and run in-process)`),
		"node -e <recorded CLI replay> (capture + byte-for-byte reproduction check)",
	],
	summary: {
		totalCases: allCases.length,
		byVerdict: Object.fromEntries(
			[...new Set(allCases.map((c) => c.verdict))].map((v) => [v, allCases.filter((c) => c.verdict === v).length]),
		),
		totalFindings: allFindings.length,
		cliReplayReproduces: reproduces,
		cliReplayArtifact: "artifacts/ingest-phase0-cli-replay.json",
	},
	contractCoverage: [
		{ obligation: "§10.3 ordered, mutually exclusive, exhaustive decision procedure; Step 4 unconditional else", status: "covered", refs: ["DEC-sweep-wellformed", "DEC-sweep-malformed", "DEC-multibranch-all", "DEC-multibranch-23", "DEC-threshold-M1", "DEC-threshold-M2", "DEC-threshold-M3_ch", "DEC-threshold-M5_ch", "DEC-threshold-M6_ch", "DEC-threshold-M3_lf-exact", "DEC-threshold-M5_lf-exact", "DEC-threshold-M6_lf-exact"] },
		{ obligation: "§10.3 Step 0: M4 > 0 -> STOP:identity", status: "covered", refs: ["DEC-threshold-M4", "DEC-Inf-m4", "DEC-NaN-m4-reason", "DEC-missing-m4", "DEC-sweep-wellformed"] },
		{ obligation: "§10.3 exact thresholds (>= / <= inclusive semantics)", status: "covered", refs: ["DEC-threshold-*", "DEC-float-m5-ulp", "DEC-float-m2-ulp", "DEC-float-m6-ulp"] },
		{ obligation: "§10.2 green gate: a mode whose runner/measurement path is not green can never be selected", status: "covered", refs: ["DEC-notgreen-wins", "DEC-notgreen-measurement", "DEC-green-strict", "DEC-all-notgreen", "DEC-missing-mode-fields"] },
		{ obligation: "§10.2 M1-M6 recomputed from the pinned fixtures; gate asserts equality with FEASIBILITY.md", status: "covered", refs: ["REP-baseline", "REP-record-drift", "REP-tamper-root-rehash", "REP-tamper-label-rehash", "REP-truncate-observations", "REP-truncate-mask-rehash", "REP-truncate-separation-rehash", "REP-truncate-annotation-rehash"] },
		{ obligation: "§10.2 sha256 covers the whole document and is verified before replay", status: "covered", refs: ["REP-tamper-frames", "REP-tamper-root", "REP-tamper-times", "REP-tamper-unknown", "REP-reorder-keys", "REP-reorder-rehash"] },
		{ obligation: "§10.2 fixture schema: paired subjects, sync keys, association, separation", status: "covered", refs: ["REP-extra-subject-rehash", "REP-truncate-mask-rehash", "REP-confidence-truncate", "REP-groundTruth-truncate", "MEA-subject-length-mismatch", "MEA-subject-length-over"] },
		{ obligation: "§10.2 M1 contact coverage definition", status: "covered", refs: ["MEA-all-contact", "MEA-no-contact", "MEA-empty-frames-empty-ann", "MEA-nan-contact"] },
		{ obligation: "§10.2 M2 precision vs 100 hand-labelled frames (labels checked in as JSON)", status: "covered", refs: ["MEA-single-frame", "REP-tamper-label-rehash", "REP-truncate-annotation-rehash"] },
		{ obligation: "§10.2 M3 plant jitter within contact runs (std of root XZ)", status: "covered", refs: ["MEA-single-frame", "MEA-nan-contact-hides-jitter", "MEA-no-contact"] },
		{ obligation: "§10.2 M4 identity swaps; missing observation counts as disagreeing (FEASIBILITY.md §3)", status: "covered", refs: ["MEA-m4-missing-obs", "MEA-m4-empty-gt", "MEA-duplicate-observation", "MEA-duplicate-groundtruth", "MEA-unsorted-gt", "REP-groundTruth-truncate"] },
		{ obligation: "§10.2 M5 solved-root RMS vs annotated foot world on the scored frames", status: "covered", refs: ["MEA-nan-root", "MEA-m6-empty-scored", "MEA-single-frame"] },
		{ obligation: "§10.2 M6 inter-fighter separation RMS; empty/mismatched input must not read 0", status: "covered", refs: ["MEA-m6-empty-scored", "MEA-m6-short-annotation", "MEA-m6-long-annotation", "MEA-single-frame"] },
		{ obligation: "RAWTRACK-CONTRACT §2 F1-δ: 'named, or the exact derivation'", status: allPass(F1_DELTA_REFS) ? "covered" : "blocker", refs: F1_DELTA_REFS },
		{ obligation: "RAWTRACK-CONTRACT §5/§6 + plan §8.4: the operator dump must emit the pinned fixture (all seven slots resolvable)", status: allPass(DUMP_EMIT_REFS) ? "covered" : "blocker", refs: DUMP_EMIT_REFS },
		{ obligation: "RAWTRACK-CONTRACT §5: nonexistent input fails cleanly with exit 1", status: "covered", refs: ["DMP-nonexistent", "DMP-empty-dir", "DMP-file-as-dir", "DMP-npz-no-numpy", "DMP-trim-inverted"] },
		{ obligation: "RAWTRACK-CONTRACT §7: UNRESOLVED slots escalate with a reason, never filled by hand", status: "covered", refs: ["SCH-escalation-empty-reason", "SCH-escalation-missing-reason", "DMP-partial-emission", "DMP-unknown-only"] },
		{ obligation: "never emit a fixture claiming resolved slots it did not observe", status: "covered", refs: ["DMP-unknown-only", "DMP-partial-emission", "DMP-trim-empty", "DMP-full-image-slot"] },
		{ obligation: "F1-η: handedness/up-axis/fps/crop 'named and asserted by fixture round-trip'", status: "covered-with-gap", refs: ["SCH-spawn-upaxis", "SCH-contradict-upaxis", "SCH-contradict-handedness", "SCH-contradict-crop"] },
		{ obligation: "§14.1 phase-0 acceptance: STOP is legitimate; synthetic record must not carry a real-footage claim", status: "covered", refs: ["REP-baseline", "REP-record-drift", "SCH-spawn-baseline"] },
		{ obligation: "determinism and totality of the decision function", status: "covered", refs: ["DEC-sweep-wellformed", "DEC-sweep-malformed", "DEC-NaN-*"] },
		{ obligation: "evidence integrity: the gate exits 0 only when every recorded baseline is green, no blocker is open and the CLI replay reproduces — FAIL lines on stderr and exit-code drift included", status: allPass(INT_REFS) ? "covered" : "blocker", refs: INT_REFS },
	],
	surfaceEvidence: [
		{ surface: "decision function — NaN/Infinity/-0/negative metrics", refs: ["DEC-NaN-m1", "DEC-NaN-m2", "DEC-NaN-m4", "DEC-NaN-m4-reason", "DEC-Inf-m4", "DEC-Inf-m12", "DEC-Inf-m3", "DEC--Inf-m12", "DEC-neg0", "DEC-neg-metrics"] },
		{ surface: "decision function — missing/extra keys, string-typed numbers", refs: ["DEC-missing-modes", "DEC-modes-null", "DEC-missing-m4", "DEC-missing-m1", "DEC-missing-mode-entry", "DEC-missing-mode-fields", "DEC-extra-keys", "DEC-strings", "DEC-strings-m4", "DEC-strings-empty"] },
		{ surface: "decision function — exactly-on-threshold, float edges, multi-branch, not-green, sweeps", refs: ["DEC-threshold-*", "DEC-float-*", "DEC-multibranch-*", "DEC-notgreen-*", "DEC-green-strict", "DEC-all-notgreen", "DEC-sweep-wellformed", "DEC-sweep-malformed"] },
		{ surface: "metrics — empty/single/all-contact/no-contact frames", refs: ["MEA-empty-frames-full-ann", "MEA-empty-frames-empty-ann", "MEA-single-frame", "MEA-all-contact", "MEA-no-contact"] },
		{ surface: "metrics — mismatched lengths, duplicate/unsorted frameIndex, NaN coordinates", refs: ["MEA-subject-length-mismatch", "MEA-subject-length-over", "MEA-duplicate-observation", "MEA-duplicate-groundtruth", "MEA-unsorted-gt", "MEA-nan-root", "MEA-nan-contact", "MEA-nan-contact-hides-jitter"] },
		{ surface: "metrics — M4/M6 undefined-not-0 edge cases", refs: ["MEA-m4-empty-gt", "MEA-m4-missing-obs", "MEA-m6-empty-scored", "MEA-m6-short-annotation", "MEA-m6-long-annotation"] },
		{ surface: "fixture integrity — tamper preserving declared sha256, reorder, unknown fields, truncation", refs: ["REP-tamper-frames", "REP-tamper-root", "REP-tamper-times", "REP-tamper-unknown", "REP-reorder-keys", "REP-reorder-rehash", "REP-tamper-root-rehash", "REP-tamper-label-rehash", "REP-truncate-mask-rehash", "REP-truncate-separation-rehash", "REP-truncate-annotation-rehash", "REP-extra-subject-rehash", "REP-groundTruth-truncate", "REP-confidence-truncate", "REP-inert-y-tamper", "REP-truncate-observations", "REP-record-drift"] },
		{ surface: "schema validator — wrong dtype/units, empty slot, empty escalation reason, contradictory handedness/up-axis", refs: ["SCH-wrong-dtype", "SCH-wrong-units", "SCH-empty-tensor-name", "SCH-empty-shape", "SCH-empty-units", "SCH-tensor-absent", "SCH-tensor-empty", "SCH-escalation-empty-reason", "SCH-escalation-missing-reason", "SCH-spawn-upaxis", "SCH-contradict-upaxis", "SCH-contradict-handedness", "SCH-contradict-crop", "SCH-f1d-named-only", "SCH-f1d-derived-only"] },
		{ surface: "schema validator — sync-key and tensor-length integrity", refs: ["SCH-unsorted-frameIndex", "SCH-duplicate-frameIndex", "SCH-tensor-length-vs-frames", "SCH-fps-nan", "SCH-extra-field"] },
		{ surface: "dump-gvhmr.py — nonexistent/empty/file-as-dir/partial-output CLI failures", refs: ["DMP-nonexistent", "DMP-empty-dir", "DMP-file-as-dir", "DMP-npz-no-numpy", "DMP-missing-args", "DMP-trim-inverted", "DMP-selftest"] },
		{ surface: "dump-gvhmr.py — emission paths (full-image F1-δ, model-named metadata, length mismatch, unknown-only, trim, non-finite)", refs: ["DMP-full-image-slot", "DMP-model-crash", "DMP-partial-emission", "DMP-no-K", "DMP-length-mismatch", "DMP-unknown-only", "DMP-trim-empty", "DMP-trim-clamp", "DMP-nonfinite"] },
		{ surface: "orchestrator evidence integrity — adversarial baselines (PASS-exit-1, FAIL-exit-0, FAIL-on-stderr-exit-0, silent) and replay drift (exit/stdout/stderr/marker/error-word)", refs: ["INT-baseline-green", "INT-baseline-pass-exit1", "INT-baseline-fail-exit0", "INT-baseline-fail-stderr-exit0", "INT-baseline-silent-exit0", "INT-replay-byte-identical", "INT-replay-exit-drift", "INT-replay-stdout-drift", "INT-replay-stderr-drift", "INT-replay-error-word", "INT-replay-missing-marker"] },
	],
	adversarialCases: allCases,
	findings: allFindings,
	blockers,
};

const reportPath = join(ARTIFACT_DIR, "ingest-phase0-adversarial-report.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");

// ---------------------------------------------------------------------------
// 4. Summary
// ---------------------------------------------------------------------------
console.log("\n=== Phase-0 red-team summary ===");
for (const [name, mod] of Object.entries(modules)) {
	const counts = {};
	for (const c of mod.cases) counts[c.verdict] = (counts[c.verdict] || 0) + 1;
	console.log(`${name.padEnd(13)} ${mod.cases.length} cases ${JSON.stringify(counts)}`);
}
console.log(`findings: ${allFindings.length}`);
console.log(`CLI replay: ${reproduces ? "reproduces byte-for-byte" : "REPRODUCTION FAILED"}`);
console.log(`artifacts: ${reportPath}\n           ${replayPath}`);

// This artifact is consumed as completion-gate evidence, so the orchestrator
// must fail whenever the evidence it just wrote is not clean. Exiting 0 while
// recording a red baseline, an open blocker, or a broken replay would hand the
// gate a green receipt for a red run.
const redBaselines = Object.entries(baselineRun)
	.filter(([, r]) => isRedBaseline(r))
	.map(([cmd]) => cmd);
const problems = [];
if (redBaselines.length) problems.push(`baseline not green: ${redBaselines.join(", ")}`);
if (blockers.length) problems.push(`${blockers.length} open blocker(s)`);
if (!reproduces) problems.push("CLI replay did not reproduce");
if (problems.length) {
	console.error(`\nRED-TEAM GATE FAILED: ${problems.join("; ")}`);
	process.exit(1);
}
