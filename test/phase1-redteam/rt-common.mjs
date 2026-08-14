/**
 * Shared plumbing for the Phase-1 adversarial red-team suite (G002).
 *
 * Conventions follow the Phase-0 red-team (test/ingest/redteam/rt-common.mjs):
 * ESM, tabs, no framework. A case verdict is one of:
 *   PASS     — behaviour matches the contract obligation exactly
 *   WEAKNESS — invalid/non-contract input was accepted, coerced or
 *              normalized instead of rejected, or a documented residual was
 *              observed (never a crash; a silent wrong-but-plausible value or
 *              a gate bypass)
 *   DEFECT   — contract/code mismatch (reported as a blocker in the report)
 *   INFO     — observed behaviour recorded; no contract obligation applies
 *
 * Every case is gated on an OBSERVED predicate: `record` computes the
 * verdict from the observation the case itself produced. A case whose
 * observation step throws is a harness failure (verdict "HARNESS-FAIL"),
 * which fails the suite: a suite that cannot observe must not fabricate a
 * verdict.
 *
 * Each suite writes its own evidence JSON under
 * artifacts/phase1-redteam/evidence/<suite>.mjs.json; run-all.mjs merges the
 * evidence into artifacts/phase1-adversarial-report.json and writes a
 * reproducing replay artifact for every DEFECT.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const EVIDENCE_DIR = join(REPO_ROOT, "artifacts", "phase1-redteam", "evidence");
export const REPLAY_DIR = join(REPO_ROOT, "artifacts", "phase1-redteam", "replays");
export const SCRATCH_DIR = join(REPO_ROOT, "artifacts", "phase1-redteam", "scratch");

export const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	return cond;
};

// Per-suite recorder. `record` receives a function that performs the attack
// and returns { verdict, observed } — the verdict must be DERIVED from the
// observation, never supplied as a constant.
export function createRecorder({ suite, category }) {
	const cases = [];
	const findings = [];
	let harnessFailures = 0;
	return {
		record(c) {
			const { id, kind, title, input, expected, planRef, run } = c;
			const entry = {
				id,
				category,
				kind,
				title,
				input,
				expected,
				planRef: planRef ?? null,
				verdict: "PENDING",
				observed: null,
			};
			cases.push(entry);
			// run() may be synchronous or return a promise; the verdict is
			// always DERIVED from the observation, never a constant. A run
			// that throws (or rejects) is a HARNESS-FAIL: a suite that cannot
			// observe must not fabricate a verdict.
			const finish = (outcome) => {
				entry.verdict = outcome.verdict;
				entry.observed = outcome.observed;
				console.log(`[CASE] ${id.padEnd(10)} ${String(outcome.verdict).padEnd(11)} ${title}`);
				if (outcome.verdict !== "PASS") console.log(`       observed: ${String(outcome.observed).slice(0, 400)}`);
			};
			try {
				const result = run();
				if (result && typeof result.then === "function") {
					entry.done = result.then(
						(outcome) => {
							finish(outcome);
							return entry;
						},
						(err) => {
							harnessFailures += 1;
							finish({ verdict: "HARNESS-FAIL", observed: `observation threw: ${err.message}` });
							return entry;
						},
					);
				} else {
					finish(result);
					entry.done = Promise.resolve(entry);
				}
			} catch (err) {
				harnessFailures += 1;
				finish({ verdict: "HARNESS-FAIL", observed: `observation threw: ${err.message}` });
				entry.done = Promise.resolve(entry);
			}
			return entry;
		},
		async flush() {
			// await every case (sync or async) so the evidence file is only
			// written after every observation has landed
			await Promise.all(cases.map((c) => c.done ?? Promise.resolve(c)));
		},
		finding(severity, title, refs, detail) {
			findings.push({ severity, title, refs, detail });
		},
		async write() {
			await this.flush();
			mkdirSync(EVIDENCE_DIR, { recursive: true });
			const path = join(EVIDENCE_DIR, `${suite}.json`);
			writeFileSync(path, JSON.stringify({ suite, category, cases, findings, harnessFailures }, null, 2) + "\n");
			return path;
		},
		get cases() {
			return cases;
		},
		get findings() {
			return findings;
		},
		get harnessFailures() {
			return harnessFailures;
		},
	};
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
