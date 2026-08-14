/**
 * Shared plumbing for the Phase-0 adversarial red-team suite.
 *
 * This suite is deliberately NOT a copy of the green-path tests: every module
 * attacks a surface with inputs the contract does not bless and records a
 * verdict per case. A case verdict is one of:
 *   PASS     — behaviour matches the contract obligation exactly
 *   WEAKNESS — invalid/non-contract input was accepted, coerced or
 *              normalized instead of rejected (never a crash; a silent
 *              wrong-but-plausible value or a gate bypass)
 *   DEFECT   — contract/code mismatch (reported as a blocker in the report)
 *   INFO     — observed behaviour recorded; no contract obligation applies
 *
 * Conventions follow the repo: ESM, tabs, ok()/PASS/FAIL, no framework.
 */

import { createHash } from "node:crypto";

export const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	return cond;
};

// The fixture sha256 canonical form used by every pinned document: the whole
// parsed document minus the sha256 field, JSON.stringify'd — identical to the
// form dump-gvhmr.py's canonical_json emits and verify-*.mjs verify.
export const canonical = (doc) => {
	const { sha256, ...rest } = doc;
	return JSON.stringify(rest);
};
export const sha256Of = (doc) => createHash("sha256").update(canonical(doc), "utf8").digest("hex");

export const verifySha256 = (doc) => typeof doc.sha256 === "string" && sha256Of(doc) === doc.sha256;

// Registry for case records. Each module registers {id, category, attack,
// input, expected, observed, verdict, severity?} and returns them for the
// report artifact.
export const newRegistry = () => {
	const cases = [];
	const findings = [];
	return {
		cases,
		findings,
		record(c) {
			cases.push(c);
			return c;
		},
		finding(severity, title, refs, detail) {
			findings.push({ severity, title, refs, detail });
		},
	};
};
// Class-B guard: a finding must be DERIVED from an observed failing
// predicate. A registered finding whose referenced cases all PASS describes a
// weakness nothing observed — it is stale by construction and can never
// clear, which is the assert-don't-observe failure this suite exists to
// catch. run-all.mjs fails the gate on anything this returns; the same rule
// is enforced at registration time by findingWhenObserved. A ref that names
// no registered case is stale too: it can never be observed to show the
// defect.
export const staleFindings = (findings, cases) => {
	const verdictOf = new Map(cases.map((c) => [c.id, c.verdict]));
	return findings.filter((f) => {
		if (!Array.isArray(f.refs) || f.refs.length === 0) return true;
		const verdicts = f.refs.map((id) => verdictOf.get(id));
		if (verdicts.some((v) => v === undefined)) return true; // unknown case id
		return verdicts.every((v) => v === "PASS");
	});
};

// Registration-time gate: emit the finding only while at least one referenced
// case actually shows the weakness (verdict WEAKNESS or DEFECT). Registering
// it unconditionally means it survives its own fix — the same defect class
// staleFindings guards against at the orchestrator level.
export const findingWhenObserved = (reg, severity, title, refs, detail) => {
	const verdictOf = new Map(reg.cases.map((c) => [c.id, c.verdict]));
	const observed = refs.some((id) => verdictOf.get(id) === "WEAKNESS" || verdictOf.get(id) === "DEFECT");
	if (observed) reg.finding(severity, title, refs, detail);
	return observed;
};

export const describe = (v) => {
	if (typeof v === "number") {
		if (Number.isNaN(v)) return "NaN";
		if (v === Infinity) return "Infinity";
		if (v === -Infinity) return "-Infinity";
		if (Object.is(v, -0)) return "-0";
		return String(v);
	}
	if (v === undefined) return "undefined";
	if (v === null) return "null";
	if (typeof v === "string") return JSON.stringify(v);
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
};

export const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Deterministic LCG so property sweeps are reproducible across runs.
export const lcg = (seed) => {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x100000000;
	};
};

export const R = newRegistry();
