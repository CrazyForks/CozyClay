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
import { newRegistry, describe } from "./rt-common.mjs";

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
baselineCase("INT-baseline-fail-stderr-exit0", "baseline exits 0 while printing FAIL lines on stderr",
	"console.error('FAIL boom');",
	"recorded { exit 0, pass 0, fail 1 } (stderr merged); isRedBaseline true — stderr FAIL must count exactly like stdout FAIL",
	true);

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

// ---------------------------------------------------------------------------
// Findings: what pass 2 changed in the orchestrator itself
// ---------------------------------------------------------------------------
reg.finding("info", "run-all.mjs baseline capture hardened: stderr is now merged on every exit path", ["INT-baseline-fail-stderr-exit0"],
	"At 634fd45 the capture used execSync, which returns stdout only on exit 0: a baseline that printed FAIL to stderr and exited 0 was recorded as { exit 0, fail 0 } and the gate exited 0 with the artifact carrying a red baseline. captureBaseline (this module) merges stderr on all paths and is what run-all.mjs now runs; INT-baseline-fail-stderr-exit0 pins it.");

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
