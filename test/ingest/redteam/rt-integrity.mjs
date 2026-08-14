/**
 * Red-team: the orchestrator's OWN evidence-integrity logic (run-all.mjs's
 * baseline capture and CLI-replay verification) vs the completion-gate
 * contract: the gate may exit 0 only when every piece of evidence it just
 * wrote is clean, and the artifact must not be able to carry a contradiction
 * (a red baseline recorded as green, a replay that no longer reproduces
 * byte-for-byte, an open blocker hidden behind a green receipt).
 *
 * This module is ALSO the home of the capture/verify primitives run-all.mjs
 * uses, so the attack cases exercise the exact code the gate runs — the
 * attack inputs are adversarial BASELINE PROGRAMS and adversarial REPLAY
 * results, spawned or constructed here.
 *
 * Pass-2 hardening (this module's reason to exist): the 634fd45 baseline
 * capture used execSync, which returns stdout only — a baseline that printed
 * FAIL lines to STDERR and exited 0 recorded as failAssertions: 0, i.e. green.
 * captureBaseline() below merges stderr on every exit path, and
 * INT-baseline-fail-stderr-exit0 pins the merged capture.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { newRegistry, describe, staleFindings } from "./rt-common.mjs";

const reg = newRegistry();
const REPO = fileURLToPath(new URL("../../..", import.meta.url));

// ---------------------------------------------------------------------------
// The evidence-integrity primitives (used verbatim by run-all.mjs)
// ---------------------------------------------------------------------------

// Count PASS/FAIL lines exactly as the orchestrator reports them: a line
// starting with PASS counts as an assertion passed, FAIL as an assertion
// failed. Line-anchored, so "not PASS" or indented lines do not count.
export const countAssertions = (out) => ({
	passAssertions: (out.match(/^PASS/gm) ?? []).length,
	failAssertions: (out.match(/^FAIL/gm) ?? []).length,
});

// Run one baseline command and record what ACTUALLY happened. stdout and
// stderr are merged on every exit path — a FAIL line on stderr must count
// exactly like one on stdout, and a process that failed to spawn records as
// exit 1, never as a silent green. (The 634fd45 capture dropped stderr on
// exit 0; that is the integrity hole this function exists to close.)
export const captureBaseline = (cmd, cwd) => {
	const r = spawnSync(cmd, { cwd, encoding: "utf8", shell: true, timeout: 120000 });
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`;
	return {
		observedExitCode: r.status === null ? 1 : r.status,
		...countAssertions(out),
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
	};
};

// A baseline record is red when the process did not exit 0 or any assertion
// FAILed — regardless of which stream the FAIL line came from.
export const isRedBaseline = (rec) => rec.observedExitCode !== 0 || rec.failAssertions > 0;

// The CLI-replay reproduction predicate: the re-run must match the recorded
// exit code, stdout AND stderr byte-for-byte, the recorded stdout must carry
// the success marker, and neither recorded stream may contain "error".
export const replayMatches = (run, expected) =>
	run.status === expected.expectedExitCode &&
	run.stdout === expected.recordedStdout &&
	(run.stderr || "") === expected.recordedStderr &&
	expected.recordedStdout.includes(expected.okMarker) &&
	!/error/i.test(expected.recordedStdout + (expected.recordedStderr || ""));

// ---------------------------------------------------------------------------
// Attack cases: adversarial baselines and replay results
// ---------------------------------------------------------------------------

// The recorded side of the CLI replay (what run-all captures on its first
// run). The adversarial re-runs below mutate ONE property at a time so a
// drift in exit code, stdout, stderr or marker content is isolated.
const REPLAY_EXPECTED = {
	expectedExitCode: 0,
	recordedStdout: "REDTEAM-CLI-REPLAY-OK STOP:identity:identity\n",
	recordedStderr: "",
	okMarker: "REDTEAM-CLI-REPLAY-OK",
};

const baselineCase = (id, attack, code, expected, wantRed) => {
	const rec = captureBaseline(`node -e ${JSON.stringify(code)}`, REPO);
	const red = isRedBaseline(rec);
	reg.record({
		id, category: "integrity", attack,
		input: `adversarial baseline: node -e ${JSON.stringify(code)}`,
		expected,
		observed: `recorded { exit ${rec.observedExitCode}, pass ${rec.passAssertions}, fail ${rec.failAssertions} } -> ${red ? "RED (gate fails)" : "green (gate passes)"}`,
		verdict: red === wantRed ? "PASS" : "DEFECT",
	});
	return rec;
};

// (1) a healthy baseline: PASS lines, exit 0 -> recorded green, gate may pass
baselineCase("INT-baseline-green", "healthy baseline (PASS x2, exit 0)",
	"console.log('PASS a');console.log('PASS b');",
	"recorded { exit 0, pass 2, fail 0 }; isRedBaseline false — the gate may pass",
	false);

// (2) PASS lines but exit 1: the recorded exit code must turn it red
baselineCase("INT-baseline-pass-exit1", "baseline prints PASS lines but exits non-zero",
	"console.log('PASS a');console.log('PASS b');process.exit(1);",
	"recorded { exit 1, pass 2, fail 0 }; isRedBaseline true — a red baseline must never pass the gate (the 634fd45 code already caught this)",
	true);

// (3) exit 0 while printing FAIL lines on stdout: the fail count must turn it red
baselineCase("INT-baseline-fail-exit0", "baseline exits 0 while printing FAIL lines (stdout)",
	"console.log('FAIL boom');",
	"recorded { exit 0, pass 0, fail 1 }; isRedBaseline true — failAssertions > 0 must never pass the gate",
	true);

// (4) exit 0 while printing FAIL lines on STDERR: the merged capture must
//     count them. This is the pass-2 hardening: at 634fd45 the execSync
//     capture returned stdout only on exit 0, so this baseline recorded as
//     { exit 0, fail 0 } and the gate exited 0 with a red baseline in the
//     artifact — the exact contradiction this suite exists to catch.
const recFailStderr = baselineCase("INT-baseline-fail-stderr-exit0", "baseline exits 0 while printing FAIL lines on stderr",
	"console.error('FAIL boom');",
	"recorded { exit 0, pass 0, fail 1 } (stderr merged); isRedBaseline true — stderr FAIL must count exactly like stdout FAIL",
	true);
// the hardening story lives on the case as a note, not as a finding: an INFO
// finding here referenced a PASSing case (the capture works, which is what
// makes the case green) and could never clear under the stale-finding guard
recFailStderr.note = "At 634fd45 the capture used execSync, which returns stdout only on exit 0: a baseline that printed FAIL to stderr and exited 0 was recorded as { exit 0, fail 0 } and the gate exited 0 with the artifact carrying a red baseline. captureBaseline (this module) merges stderr on all paths and is what run-all.mjs now runs; this case pins it.";

// (5) exit 0 with zero assertions: the record is accurate (pass 0 / fail 0),
//     the emptiness is visible in the artifact — not a contradiction.
baselineCase("INT-baseline-silent-exit0", "baseline exits 0 printing nothing (zero assertions)",
	"",
	"recorded { exit 0, pass 0, fail 0 }; not red — the artifact shows passAssertions 0 so the empty run is visible, not disguised",
	false);

// Replay attacks: the recorded side stays fixed; the re-run drifts.
const replayCase = (id, attack, run, expected, wantMatch) => {
	const matches = replayMatches(run, expected);
	reg.record({
		id, category: "integrity", attack,
		input: `recorded stdout=${JSON.stringify(expected.recordedStdout)} stderr=${JSON.stringify(expected.recordedStderr)} exit=${expected.expectedExitCode}; re-run ${JSON.stringify(run)}`,
		expected,
		observed: `replayMatches -> ${matches} (re-run exit ${run.status}, stdout ${run.stdout === expected.recordedStdout ? "identical" : "DIFFERS"}, stderr ${(run.stderr || "") === expected.recordedStderr ? "identical" : "DIFFERS"})`,
		verdict: matches === wantMatch ? "PASS" : "DEFECT",
	});
	return matches;
};

replayCase("INT-replay-byte-identical", "re-run identical to the recorded run",
	{ status: 0, stdout: REPLAY_EXPECTED.recordedStdout, stderr: "" }, REPLAY_EXPECTED, true);
replayCase("INT-replay-exit-drift", "re-run stdout matches but the exit code differs",
	{ status: 1, stdout: REPLAY_EXPECTED.recordedStdout, stderr: "" }, REPLAY_EXPECTED, false);
replayCase("INT-replay-stdout-drift", "re-run exit code matches but stdout differs",
	{ status: 0, stdout: "REDTEAM-CLI-REPLAY-OK STOP:accuracy:accuracy\n", stderr: "" }, REPLAY_EXPECTED, false);
replayCase("INT-replay-stderr-drift", "re-run stdout+exit match but stderr gained content",
	{ status: 0, stdout: REPLAY_EXPECTED.recordedStdout, stderr: "warning: x\n" }, REPLAY_EXPECTED, false);
replayCase("INT-replay-error-word", "recorded stdout carries the OK marker and the word 'error'",
	{ status: 0, stdout: "REDTEAM-CLI-REPLAY-OK — no error state to report\n", stderr: "" },
	{ ...REPLAY_EXPECTED, recordedStdout: "REDTEAM-CLI-REPLAY-OK — no error state to report\n" }, false);
replayCase("INT-replay-missing-marker", "recorded stdout matches but lacks the success marker",
	{ status: 0, stdout: "STOP:identity:identity\n", stderr: "" },
	{ ...REPLAY_EXPECTED, recordedStdout: "STOP:identity:identity\n" }, false);

// The pass-2 hardening story is recorded on the INT-baseline-fail-stderr-exit0
// case record as a note (see above): a finding about a FIX that works would
// reference a PASSing case and could never clear — the note keeps the story
// in the artifact without violating the observed-finding rule.
// ---------------------------------------------------------------------------
// Pass-3: attack the STALE-FINDINGS guard itself (run-all.mjs Class-B
// structural guard, staleFindings in rt-common.mjs). Question under test:
// can any stale finding still reach a green report? The three paths:
//   (a) all referenced cases PASS -> flagged stale -> run-all throws
//   (b) at least one referenced case fails -> kept (correct: the failing
//       case justifies it)
//   (c) registered AFTER the aggregate snapshot -> invisible to BOTH the
//       guard and the report artifact
// The self-test block in run-all.mjs pins (a) and the plain unknown-id and
// single-weak case; these cases pin the MIXED refs, the unknown-id-dominates
// rule, and the post-aggregate window.
// ---------------------------------------------------------------------------
{
	// (a) mixed refs: a finding referencing a PASSING and a FAILING case is
	// NOT stale — the failing case is observed evidence for it. The guard
	// must keep it (and the report shows it), and it must clear itself the
	// moment the failing case is fixed.
	const mixedReg = newRegistry();
	mixedReg.record({ id: "GUARD-case-pass", category: "self", attack: "synthetic", input: "", expected: "", observed: "", verdict: "PASS" });
	mixedReg.record({ id: "GUARD-case-weak", category: "self", attack: "synthetic", input: "", expected: "", observed: "", verdict: "WEAKNESS" });
	mixedReg.finding("low", "synthetic mixed-ref finding", ["GUARD-case-pass", "GUARD-case-weak"], "one referenced case shows the weakness");
	const mixedHits = staleFindings(mixedReg.findings, mixedReg.cases);
	reg.record({
		id: "INT-guard-mixed-refs", category: "integrity", attack: "finding referencing a mix of passing and failing cases",
		input: "refs [PASS case, WEAKNESS case]",
		expected: "not stale (one ref genuinely fails) -> staleFindings returns 0 hits; the finding stays in the report while the weakness is observed and clears itself when the case is fixed",
		observed: `staleFindings hits = ${mixedHits.length} (${mixedHits.map((f) => f.title).join(", ") || "none"})`,
		verdict: mixedHits.length === 0 ? "PASS" : "DEFECT",
	});
	// (b) mixed refs where one id is UNKNOWN: the unknown id can never be
	// observed to show the defect, so the finding can never clear — the
	// unknown-id rule dominates even when a real failing case is referenced.
	const mixedUnknownReg = newRegistry();
	mixedUnknownReg.record({ id: "GUARD-case-weak", category: "self", attack: "synthetic", input: "", expected: "", observed: "", verdict: "WEAKNESS" });
	mixedUnknownReg.finding("low", "synthetic mixed-unknown finding", ["GUARD-case-weak", "GUARD-no-such-case"], "one real ref, one unknown");
	const mixedUnknownHits = staleFindings(mixedUnknownReg.findings, mixedUnknownReg.cases);
	reg.record({
		id: "INT-guard-mixed-unknown", category: "integrity", attack: "finding referencing a failing case AND an unknown case id",
		input: "refs [WEAKNESS case, no-such-case]",
		expected: "stale: the unknown id can never be observed, so the finding can never clear -> staleFindings flags it (1 hit) and run-all would throw",
		observed: `staleFindings hits = ${mixedUnknownHits.length} (${mixedUnknownHits.map((f) => f.title).join(", ") || "none"})`,
		verdict: mixedUnknownHits.length === 1 ? "PASS" : "DEFECT",
	});
	// (c) the post-aggregate window: run-all snapshots cases/findings at
	// import time (the `modules` literal) and derives the report AND the
	// blocker list from that snapshot. Simulate the exact flow: snapshot,
	// then register a stale finding + a DEFECT case after the snapshot, and
	// show neither can reach the rendered report.
	const snapReg = newRegistry();
	snapReg.record({ id: "GUARD-snap-pass", category: "self", attack: "synthetic", input: "", expected: "", observed: "", verdict: "PASS" });
	snapReg.record({ id: "GUARD-snap-weak", category: "self", attack: "synthetic", input: "", expected: "", observed: "", verdict: "WEAKNESS" });
	snapReg.finding("low", "synthetic snapshot finding", ["GUARD-snap-pass", "GUARD-snap-weak"], "one referenced case shows the weakness");
	const snapshot = { cases: [...snapReg.cases], findings: [...snapReg.findings] }; // the aggregate window closes here
	// post-aggregate registrations (what a module doing work in run() or
	// later would produce):
	const lateStale = { severity: "low", title: "synthetic LATE stale finding", refs: ["GUARD-snap-pass"], detail: "registered after the aggregate" };
	const lateDefect = { id: "GUARD-snap-late-defect", category: "self", attack: "synthetic late DEFECT", input: "", expected: "", observed: "", verdict: "DEFECT" };
	snapReg.finding(lateStale.severity, lateStale.title, lateStale.refs, lateStale.detail);
	snapReg.record(lateDefect);
	const snapStale = staleFindings(snapshot.findings, snapshot.cases);
	const rendered = JSON.stringify({
		adversarialCases: snapshot.cases,
		findings: snapshot.findings,
		blockers: snapshot.cases.filter((c) => c.verdict === "DEFECT"),
	});
	const lateInvisible = !rendered.includes(lateStale.title) && !rendered.includes(lateDefect.id) && !rendered.includes("GUARD-snap-late-defect");
	reg.record({
		id: "INT-guard-post-aggregate", category: "integrity", attack: "finding registered after the aggregate snapshot",
		input: "snapshot taken (the run-all `modules` window); then a stale finding AND a DEFECT case registered into the same registry",
		expected: "the snapshot is what the guard AND the report consume: the late registrations cannot reach a green report (absent from the rendered artifact and from the snapshot-derived blocker list) — so no stale finding can reach a green report through the report path; the window's soundness rests on the suite convention that all registrations happen at import time",
		observed: `snapshot staleFindings hits = ${snapStale.length} (late finding NOT flagged — the guard has no jurisdiction past the window); rendered report contains late finding: ${rendered.includes(lateStale.title)}, contains late DEFECT case: ${rendered.includes(lateDefect.id)}, snapshot-derived blockers: ${snapshot.cases.filter((c) => c.verdict === "DEFECT").length}`,
		verdict: snapStale.length === 0 && lateInvisible ? "PASS" : "DEFECT",
	});
}

export const run = async () => {
	console.log("== rt-integrity: orchestrator evidence-integrity attacks ==");
	return { cases: reg.cases, findings: reg.findings };
};

const isMain = process.argv[1] && process.argv[1].endsWith("rt-integrity.mjs");
if (isMain) {
	await run();
	for (const c of reg.cases) console.log(`${c.verdict.padEnd(9)} ${c.id.padEnd(28)} ${c.observed.slice(0, 110)}`);
	console.log(`\nrt-integrity: ${reg.cases.length} cases, ${reg.findings.length} findings`);
}
