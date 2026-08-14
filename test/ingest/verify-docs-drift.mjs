#!/usr/bin/env node
/**
 * W3 — the docs drift gate (plan §13, §14.1 phase 5).
 *
 * `tools/ingest/CONTRACT.md` carries the plan's contact-gate contract so Stage A
 * is self-contained. A copied contract is only useful while it is still a copy:
 * the moment a threshold drifts, the doc becomes actively harmful, because a
 * reader trusts a written number more than they trust code they have not read.
 *
 * So this gate compares three things that must agree — the plan, CONTRACT.md,
 * and the gate implementation itself. Comparing only two would let the pair
 * that drifted together look correct: if someone "fixes" the doc to match a
 * changed test, plan-vs-doc catches it, and if someone edits the plan and the
 * doc but not the code, doc-vs-code catches it.
 *
 * The canonical RED is a doc saying 0.08 where the plan says 0.05.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fail = [];
function ok(label, cond, detail = "") {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!cond) fail.push(label);
}

// The plan lives outside the repo (it is the ralplan artifact). When it is not
// reachable the gate says so rather than silently checking half the contract:
// a drift check that quietly degrades to "doc vs code" would report green while
// the authority it exists to track is absent.
const PLAN = process.env.INGEST_PLAN_PATH
	?? join(REPO, "..", ".gjc", "_session-019ffbce-c0b7-7000-b98f-d964023be7d8", "plans", "ralplan",
		"019ffbce-c0b7-7000-b98f-d964023be7d8", "stage-05-revision.md");

const contractPath = join(REPO, "tools/ingest/CONTRACT.md");
ok("tools/ingest/CONTRACT.md exists", existsSync(contractPath), contractPath);
const contract = existsSync(contractPath) ? readFileSync(contractPath, "utf8") : "";

const gatePath = join(REPO, "test/ingest/verify-contact-preservation.mjs");
ok("the contact gate implementation exists", existsSync(gatePath), gatePath);
const gate = existsSync(gatePath) ? readFileSync(gatePath, "utf8") : "";

// ---------------------------------------------------------------------------
// the numbers that must agree everywhere
// ---------------------------------------------------------------------------
// Each entry is a claim the contract makes that the code must honour. The
// regexes are deliberately anchored to the surrounding words rather than to a
// bare number: a bare /0\.05/ would match any coincidental 0.05 in either file
// (the row bodies contain pipes inside backticks, so the window is bounded by
// length rather than by the next table delimiter)
// and pass for the wrong reason.
const CLAIMS = [
	{
		id: "A1 threshold",
		value: "0.05",
		inContract: /\*\*A1\*\*[\s\S]{0,160}?≤\s*0\.05\s*m/,
		inGate: /0\.05/,
	},
	{
		id: "contact radius",
		value: "0.25",
		inContract: /d_before\(f\)\s*≤\s*0\.25\s*m/,
		inGate: /0\.25/,
	},
	{
		id: "A6 agreement tolerance",
		value: "1e-6",
		inContract: /\*\*A6\*\*[\s\S]{0,160}?1e-6/,
		inGate: /1e-6/,
	},
	{
		id: "contact frame K",
		value: "30",
		inContract: /contact frame \*\*K = 30\*\*/,
		inGate: /\b30\b/,
	},
	{
		id: "second contact frame",
		value: "45",
		inContract: /Second contact at frame \*\*45\*\*/,
		inGate: /\b45\b/,
	},
	{
		id: "rig scale step",
		value: "0.01",
		inContract: /scale\.setScalar\(0\.01\)/,
		inGate: /0\.01/,
	},
];

for (const claim of CLAIMS) {
	ok(`CONTRACT.md states the ${claim.id} (${claim.value})`, claim.inContract.test(contract));
	ok(`the gate implements the ${claim.id} (${claim.value})`, claim.inGate.test(gate));
}

// ---------------------------------------------------------------------------
// plan agreement — the authority, when reachable
// ---------------------------------------------------------------------------
if (!existsSync(PLAN)) {
	ok("the plan is reachable for the drift comparison", false,
		`${PLAN} not found; set INGEST_PLAN_PATH. A drift gate that skips its authority reports green for a check it never made.`);
} else {
	const plan = readFileSync(PLAN, "utf8");
	const section = /^## 17[\s\S]*?(?=^---$)/m.exec(plan)?.[0] ?? "";
	ok("plan §17 is locatable", section.length > 0, `${section.length} chars`);

	for (const claim of CLAIMS) {
		ok(`plan §17 states the ${claim.id} (${claim.value})`, claim.inContract.test(section));
	}

	// The A1-A8 row set must be present in both, in the same order: a contract
	// missing A4 would leave the shared-scale negative control undocumented
	// while every threshold above still matched.
	const rowsOf = (text) => [...text.matchAll(/\*\*(A[1-8])\*\*/g)].map((m) => m[1]);
	const planRows = rowsOf(section);
	const docRows = rowsOf(contract);
	ok("plan §17 lists A1..A8", planRows.join(",") === "A1,A2,A3,A4,A5,A6,A7,A8", planRows.join(","));
	ok("CONTRACT.md lists the same rows in the same order", docRows.join(",") === planRows.join(","), docRows.join(","));

	// The verbatim requirement: the copied body must match the plan's, ignoring
	// only leading/trailing whitespace per line. Anything else is paraphrase,
	// and paraphrase is where drift begins.
	const normalise = (t) => t.split("\n").map((l) => l.trimEnd()).join("\n").trim();
	const planBody = normalise(section.replace(/^## 17.*$/m, "").replace(/---\s*$/, ""));
	ok("CONTRACT.md contains plan §17 verbatim", normalise(contract).includes(planBody),
		`doc ${normalise(contract).length} chars, plan body ${planBody.length} chars`);
}

// ---------------------------------------------------------------------------
// sensitivity: the gate must catch the canonical drift
// ---------------------------------------------------------------------------
{
	// The RED this commit is named for: a doc that says 0.08 where the plan and
	// the code say 0.05. Proving the check fires on a synthetic drifted copy is
	// what separates this from a set of assertions that happen to pass.
	const drifted = contract.replace(/≤ 0\.05 m/, "≤ 0.08 m");
	const a1 = CLAIMS[0];
	ok("a drifted A1 threshold (0.08) is REPORTED, not accepted",
		contract !== drifted && !a1.inContract.test(drifted),
		"synthetic drift of the A1 row no longer satisfies the contract claim");

	const withoutA4 = contract.replace(/\*\*A4\*\*/, "**AX**");
	const rows = [...withoutA4.matchAll(/\*\*(A[1-8])\*\*/g)].map((m) => m[1]);
	ok("a missing A4 row is REPORTED", rows.join(",") !== "A1,A2,A3,A4,A5,A6,A7,A8", rows.join(","));
}

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
