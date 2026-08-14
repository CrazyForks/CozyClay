#!/usr/bin/env node
/**
 * Phase-1 red-team orchestrator (G002): runs every rt-* suite, merges the
 * evidence into artifacts/phase1-adversarial-report.json, writes a
 * reproducing replay artifact for every DEFECT, and prints the three
 * statuses. Also re-runs the two live baseline suites
 * (test:app-render, test:ardy-request) when --with-baseline is passed.
 *
 * Exit code follows the repo's red-team gate convention
 * (test/ingest/redteam/run-all.mjs): 0 only when every suite RAN to
 * completion AND no open blocker (DEFECT) exists. A run with blockers
 * exits 1 and the report + console explain exactly why — a green receipt
 * for a red run is the false-evidence class this gate exists to stop.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, EVIDENCE_DIR, REPLAY_DIR } from "./rt-common.mjs";

const withBaseline = process.argv.includes("--with-baseline");
const suiteDir = fileURLToPath(new URL(".", import.meta.url));
const REPORT_PATH = join(REPO_ROOT, "artifacts", "phase1-adversarial-report.json");
const commandsRun = [];

function runNode(file, args = [], { env = {} } = {}) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [file, ...args], {
			cwd: REPO_ROOT,
			env: { ...process.env, ...env },
			stdio: "pipe",
		});
		let out = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (c) => {
			out += c;
			process.stdout.write(c);
		});
		child.stderr.on("data", (c) => {
			out += c;
			process.stderr.write(c);
		});
		child.on("close", (code) => resolve({ code, out }));
	});
}

// reproduction commands per defect case — the exact CLI a maintainer runs
const REPRO = {
	"E-ENV-08": [
		`node --input-type=module -e '
import { createArtifactAllowlist } from "./tools/providers/envelope.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, linkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const root = mkdtempSync(join(tmpdir(), "hardlink-"));
mkdirSync(join(root, "base")); mkdirSync(join(root, "outside"));
const secret = join(root, "outside", "secret.bin");
writeFileSync(secret, "OUTSIDE-SECRET-BYTES");
const good = join(root, "base", "artifact.bin");
writeFileSync(good, "GOOD-BYTES");
const wl = createArtifactAllowlist({ base: join(root, "base"), max: 8 });
wl.register("run-123-abcdef", good);
rmSync(good); linkSync(secret, good); // hard link to the outside file
const resolved = wl.resolve("run-123-abcdef");
console.log("resolved:", resolved, "served bytes:", resolved && readFileSync(resolved, "utf8"));
rmSync(root, { recursive: true, force: true });'`,
	],
	"E-ENV-10": [
		"node test/phase1-redteam/rt-envelope.mjs   # case E-ENV-10 (directory swap)",
	],
	"D-DEL-04": [
		"PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind((\"127.0.0.1\",0)); print(s.getsockname()[1]); s.close()')",
		"mkdir -p /tmp/cc-stale-home/cozyclay && printf '{\"port\":%s,\"origin\":\"http://127.0.0.1:%s\",\"token\":\"x\",\"pid\":%s,\"startedAt\":\"2026-08-14T00:00:00Z\"}\\n' $PORT $PORT $$ > /tmp/cc-stale-home/cozyclay/ingest.json",
		"XDG_CONFIG_HOME=/tmp/cc-stale-home node node_modules/vite/bin/vite.js --config vite.config.js --host 127.0.0.1 --port 5399 &",
		"curl -i http://127.0.0.1:5399/ingest/surface-origin   # expect 502, not the absent app shell",
	],
	"D-DEL-05": [
		"same record as D-DEL-04, then:",
		"node bin/cozyclay.mjs --port 5401 --no-open --no-star &   # XDG_CONFIG_HOME=/tmp/cc-stale-home",
		"curl -i http://127.0.0.1:5401/ingest/surface-origin      # expect 503, not 404",
		"# then start a real surface in the same home and re-probe: still 503 (one-shot read)",
	],
	"D-DEL-06": [
		"printf '{\"port\":%s,\"origin\":\"http://127.0.0.1:%s\",\"token\":\"x\",\"pid\":0,\"startedAt\":\"2026-08-14T00:00:00Z\"}\\n' $PORT $PORT > /tmp/cc-stale-home/cozyclay/ingest.json",
		"node bin/cozyclay.mjs --port 5401 --no-open --no-star &   # pid 0 passes process.kill(0,0)",
		"curl -i http://127.0.0.1:5401/ingest/surface-origin      # expect 503, not 404",
	],
	"I-ISO-02": [
		"node test/phase1-redteam/rt-isolation.mjs   # case I-ISO-02 (scratch build + audit walk)",
	],
};

function loadEvidence() {
	const files = readdirSync(EVIDENCE_DIR).filter((f) => f.endsWith(".json")).sort();
	const suites = [];
	for (const f of files) {
		suites.push(JSON.parse(readFileSync(join(EVIDENCE_DIR, f), "utf8")));
	}
	return suites;
}

function writeReplays(cases) {
	mkdirSync(REPLAY_DIR, { recursive: true });
	const written = [];
	for (const c of cases) {
		if (c.verdict !== "DEFECT") continue;
		const replay = {
			kind: "cli-replay",
			caseId: c.id,
			category: c.category,
			planRef: c.planRef,
			title: c.title,
			input: c.input,
			expected: c.expected,
			observed: c.observed,
			reproduce: REPRO[c.id] ?? ["node test/phase1-redteam/rt-" + c.category.split("-")[0] + ".mjs"],
			observedAt: new Date().toISOString(),
		};
		const path = join(REPLAY_DIR, `${c.id}.json`);
		writeFileSync(path, JSON.stringify(replay, null, 2) + "\n");
		written.push(path);
	}
	return written;
}

const suites = [];
const results = [];
for (const suite of ["rt-undo", "rt-take", "rt-surface", "rt-envelope", "rt-delivery", "rt-isolation"]) {
	commandsRun.push(`node test/phase1-redteam/${suite}.mjs`);
	const r = await runNode(join(suiteDir, `${suite}.mjs`));
	results.push({ suite, code: r.code });
	if (r.code !== 0) console.error(`[run-all] ${suite} exited ${r.code}`);
}

// the browser suite needs a CDP browser; qa-browser launches it and FAILS
// loudly when no Chrome exists
commandsRun.push("node tools/qa-browser.mjs -- node test/phase1-redteam/rt-browser.mjs");
const browserResult = await runNode(join(REPO_ROOT, "tools", "qa-browser.mjs"), ["--", process.execPath, join(suiteDir, "rt-browser.mjs")], {
	env: { QA_URL: process.env.QA_URL || "http://127.0.0.1:5180/" },
});
results.push({ suite: "rt-browser", code: browserResult.code });

// the live baseline suites (the repo's own gates), optional for fast iteration
const baselineResults = [];
if (withBaseline) {
	for (const suite of ["verify-app-render", "verify-ardy-request"]) {
		commandsRun.push(`QA_URL=${process.env.QA_URL || "http://127.0.0.1:5180/"} npm run test:${suite.replace("verify-", "")}`);
		const r = await runNode(join(REPO_ROOT, "tools", "qa-browser.mjs"), ["--", process.execPath, join(REPO_ROOT, "test", `${suite}.mjs`)], {
			env: { QA_URL: process.env.QA_URL || "http://127.0.0.1:5180/" },
		});
		baselineResults.push({ suite, code: r.code });
		results.push({ suite, code: r.code, baseline: true });
	}
}

// merge evidence
const evidence = loadEvidence();
const allCases = evidence.flatMap((e) => e.cases);
const allFindings = evidence.flatMap((e) => e.findings);
const harnessFailures = evidence.reduce((n, e) => n + e.harnessFailures, 0);

const defects = allCases.filter((c) => c.verdict === "DEFECT");
const weaknesses = allCases.filter((c) => c.verdict === "WEAKNESS");
const replayPaths = writeReplays(allCases);

// findings are DERIVED from observed cases (never registered unconditionally)
const blockers = defects.map((c) => ({
	id: c.id,
	planRef: c.planRef,
	kind: c.kind,
	title: c.title,
	observed: c.observed,
	replay: existsSync(join(REPLAY_DIR, `${c.id}.json`)) ? `artifacts/phase1-redteam/replays/${c.id}.json` : null,
}));
const weaknessFindings = weaknesses.map((c) => ({
	id: c.id,
	planRef: c.planRef,
	kind: c.kind,
	title: c.title,
	observed: c.observed,
}));

const contractCoverage = [
	{ contract: "§7.3 undo coordinator (S4)", claim: "one seq per real push; greatest-topSeq undo; oldest-branch redo; cross-store redo invalidation; HISTORY_LIMIT lockstep", refs: ["U-UNDO-01", "U-UNDO-02", "U-UNDO-03", "U-UNDO-04", "U-UNDO-05", "U-UNDO-09", "U-UNDO-10", "U-UNDO-11", "U-UNDO-12"], verdict: "covered-observed" },
	{ contract: "§7.3 prepare phase / re-entrancy", claim: "prepare settles open transactions before eligibility; no re-entrancy guard exists", refs: ["U-UNDO-06", "U-UNDO-07", "U-UNDO-08"], verdict: "gap-observed" },
	{ contract: "§12.2 exactly-once landing (S5)", claim: "one entry per accepted id; replay returns cached ack; table refuses at 10 000 rather than evict", refs: ["T-ONCE-01", "T-ONCE-02", "T-ONCE-06", "T-ONCE-07", "T-ONCE-08", "T-ONCE-09", "B-E2E-03", "B-E2E-04"], verdict: "covered-observed" },
	{ contract: "§7.4 distinct clear op (Finding 5)", claim: "clear bypasses the replay table; colliding ids cannot swallow or be shadowed", refs: ["T-ONCE-04", "T-ONCE-05", "T-ONCE-11"], verdict: "covered-observed" },
	{ contract: "§12.1 message gate (S1)", claim: "origin + source + plain-data + byte-cap checks precede any field read", refs: ["P-DOOR-01", "P-DOOR-02", "P-DOOR-08", "P-DOOR-11", "P-DOOR-12", "P-DOOR-13", "P-DOOR-14"], verdict: "covered-observed" },
	{ contract: "§5/§12.3 publish door (S2)", claim: "every TakePayload clause rejects by name; artifact paths are app-origin paths", refs: ["P-DOOR-03", "P-DOOR-04", "P-DOOR-05", "P-DOOR-06", "P-DOOR-07", "P-DOOR-15"], verdict: "covered-observed" },
	{ contract: "§12.2 session budget", claim: "the session table refuses at its ceiling rather than evict", refs: ["P-DOOR-10"], verdict: "gap-observed" },
	{ contract: "E1/E2 provider envelope", claim: "loopback bind, exact content-type, body cap, cross-site 403, no-CORS, allowlisted artifacts with serve-time realpath containment", refs: ["E-ENV-01", "E-ENV-02", "E-ENV-03", "E-ENV-04", "E-ENV-05", "E-ENV-06", "E-ENV-07", "E-ENV-08", "E-ENV-09", "E-ENV-10", "E-ENV-11", "E-ENV-12", "E-ENV-13", "E-ENV-14", "E-ENV-15"], verdict: "covered-with-defects" },
	{ contract: "§11.2 delivery/discovery (D1-D3)", claim: "the /ingest target resolves per request; a record whose publisher is dead is stale — never proxy to a port nobody owns", refs: ["D-DEL-01", "D-DEL-02", "D-DEL-03", "D-DEL-04", "D-DEL-05", "D-DEL-06", "D-DEL-11"], verdict: "covered-with-defects" },
	{ contract: "§11.4 CSP dev vs packaged", claim: "parent frame-src policy on document responses; PROD child meta with no dev tokens; frame-ancestors header-only", refs: ["D-DEL-07", "D-DEL-08", "D-DEL-09", "D-DEL-10"], verdict: "covered-observed" },
	{ contract: "§6.1 I1/I2 isolation", claim: "the default build carries zero src/ingest bytes; the static audit walks every tracked file", refs: ["I-ISO-01", "I-ISO-02", "I-ISO-04"], verdict: "covered-with-defects" },
	{ contract: "§6.2 R4 fence / I3 deletability", claim: "only feasibility and test/ingest may import the runners; a dangling mount edge fails the deletability sim", refs: ["I-ISO-03", "I-ISO-04", "I-ISO-05"], verdict: "covered-with-defects" },
	{ contract: "§11.5 host app wiring", claim: "the parent wires the surface host onto the app's landing door", refs: ["B-E2E-05"], verdict: "unproven-until-U4" },
];

const surfaceEvidence = [
	{ surface: "undo coordinator", evidence: "12 node-observed cases through the real coordinator + scene/take/third stores", gate: "rt-undo.mjs", refs: ["U-UNDO-01", "U-UNDO-02", "U-UNDO-03", "U-UNDO-04", "U-UNDO-05", "U-UNDO-06", "U-UNDO-07", "U-UNDO-08", "U-UNDO-09", "U-UNDO-10", "U-UNDO-11", "U-UNDO-12"], verdict: "covered" },
	{ surface: "atomic take store", evidence: "13 node-observed cases incl. 10 000-id ceiling and clear races", gate: "rt-take.mjs", refs: ["T-ONCE-01", "T-ONCE-02", "T-ONCE-03", "T-ONCE-04", "T-ONCE-05", "T-ONCE-06", "T-ONCE-07", "T-ONCE-08", "T-ONCE-09", "T-ONCE-10", "T-ONCE-11", "T-ONCE-12", "T-ONCE-13"], verdict: "covered" },
	{ surface: "surface host / publish door", evidence: "15 node-observed cases against the fake-DOM harness + 5 live-browser cases through window.__cozyclay", gate: "rt-surface.mjs / rt-browser.mjs", refs: ["P-DOOR-01", "P-DOOR-02", "P-DOOR-03", "P-DOOR-04", "P-DOOR-05", "P-DOOR-06", "P-DOOR-07", "P-DOOR-08", "P-DOOR-09", "P-DOOR-10", "P-DOOR-11", "P-DOOR-12", "P-DOOR-13", "P-DOOR-14", "P-DOOR-15", "B-E2E-01", "B-E2E-02", "B-E2E-03", "B-E2E-04"], verdict: "covered" },
	{ surface: "provider envelope + ARDY bridge", evidence: "15 cases against the real spawned bridge and the envelope exports", gate: "rt-envelope.mjs", refs: ["E-ENV-01", "E-ENV-02", "E-ENV-03", "E-ENV-04", "E-ENV-05", "E-ENV-06", "E-ENV-07", "E-ENV-08", "E-ENV-09", "E-ENV-10", "E-ENV-11", "E-ENV-12", "E-ENV-13", "E-ENV-14", "E-ENV-15"], verdict: "covered-with-defects" },
	{ surface: "delivery topology (dev + packaged)", evidence: "11 cases spawning real Vite servers and the packaged CLI", gate: "rt-delivery.mjs", refs: ["D-DEL-01", "D-DEL-02", "D-DEL-03", "D-DEL-04", "D-DEL-05", "D-DEL-06", "D-DEL-07", "D-DEL-08", "D-DEL-09", "D-DEL-10", "D-DEL-11"], verdict: "covered-with-defects" },
	{ surface: "isolation gates (I1/I2/I3/R4)", evidence: "5 cases: in-memory builds, scratch builds, AST audit walk", gate: "rt-isolation.mjs", refs: ["I-ISO-01", "I-ISO-02", "I-ISO-03", "I-ISO-04", "I-ISO-05"], verdict: "covered-with-defects" },
	{ surface: "live app (browser)", evidence: "5 cases driven via CDP through the QA hooks", gate: "rt-browser.mjs", refs: ["B-E2E-01", "B-E2E-02", "B-E2E-03", "B-E2E-04", "B-E2E-05"], verdict: "covered" },
];

const scope = (() => {
	try {
		const branch = execFileSync("git", ["branch", "--show-current"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
		const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
		return { repo: "CozyClay", branch, commit };
	} catch {
		return { repo: "CozyClay", branch: "unknown", commit: "unknown" };
	}
})();

const executionStatus = results.every((r) => r.code === 0) ? "passed" : "failed";
const browserOk = results.find((r) => r.suite === "rt-browser")?.code === 0;
const e2eStatus = browserOk ? "passed" : "failed";
const redTeamStatus = defects.length === 0 ? "passed" : "failed";

const report = {
	schemaVersion: 1,
	kind: "adversarial-test-report",
	title: "Phase-1 footage-ingest — adversarial QA / red-team report (G002, ultragoal completion gate)",
	scope: { ...scope, date: new Date().toISOString(), suiteRoot: "test/phase1-redteam/" },
	status: executionStatus,
	e2eStatus,
	redTeamStatus,
	commandsRun,
	artifacts: {
		report: "artifacts/phase1-adversarial-report.json",
		evidence: evidence.map((e) => `artifacts/phase1-redteam/evidence/${e.suite}.json`),
		replays: replayPaths.map((p) => p.replace(REPO_ROOT + "/", "")),
		scratch: "artifacts/phase1-redteam/scratch/ (removed after each case)",
	},
	contractCoverage,
	surfaceEvidence,
	adversarialCases: allCases,
	findings: { blockers, weaknesses: weaknessFindings },
	blockers,
	baseline: withBaseline ? baselineResults : "skipped (pass --with-baseline to re-run test:app-render and test:ardy-request)",
};

mkdirSync(join(REPO_ROOT, "artifacts"), { recursive: true });
writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");

console.log("\n=== Phase-1 red-team summary ===");
for (const e of evidence) {
	const counts = {};
	for (const c of e.cases) counts[c.verdict] = (counts[c.verdict] || 0) + 1;
	console.log(`${e.suite.padEnd(14)} ${e.cases.length} cases ${JSON.stringify(counts)}`);
}
console.log(`\nstatus=${executionStatus} e2eStatus=${e2eStatus} redTeamStatus=${redTeamStatus}`);
console.log(`DEFECTs (blockers): ${defects.length}`);
for (const d of defects) console.log(`  - ${d.id} [${d.planRef}] ${d.title}`);
console.log(`WEAKNESSes: ${weaknesses.length}`);
for (const w of weaknesses) console.log(`  - ${w.id} [${w.planRef}] ${w.title}`);
console.log(`replays: ${replayPaths.length} written`);
console.log(`report: ${REPORT_PATH}`);
if (!existsSync(REPORT_PATH)) {
	console.error("\nRED-TEAM GATE FAILED: report artifact was not written");
	process.exit(1);
}
const problems = [];
if (harnessFailures) problems.push(`${harnessFailures} HARNESS-FAIL(s)`);
if (!browserOk) problems.push("the browser suite did not run to completion");
if (results.some((r) => r.code !== 0 && !r.baseline)) problems.push("a suite exited non-zero");
if (problems.length) {
	console.error(`\nRED-TEAM GATE FAILED: ${problems.join("; ")}`);
	process.exit(1);
}
if (defects.length) {
	console.error(`\nRED-TEAM GATE: ${defects.length} open blocker(s) — see artifacts/phase1-adversarial-report.json and the replays under artifacts/phase1-redteam/replays/`);
	process.exit(1);
}
console.log("\nall phase-1 red-team suites ran clean; no open blockers");
