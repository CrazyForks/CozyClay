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
