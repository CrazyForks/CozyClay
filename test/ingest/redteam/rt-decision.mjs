/**
 * Red-team: the Phase-0 decision function (tools/ingest/decision.mjs) vs the
 * plan §10.3 contract. Contract recap (plan §10.3, §10.2 green gate):
 *
 *   Step 0  M4 > 0                                        -> STOP:identity
 *   Step 1  green(ch) && M1>=0.60 && M2>=0.85 && M3_ch<=0.03 && M5_ch<=0.05
 *           && M6_ch<=0.08                                -> GO contact-head
 *   Step 2  green(lf) && M3_lf<=0.05 && M5_lf<=0.08 && M6_lf<=0.12
 *                                                         -> GO lowest-foot (degraded)
 *   Step 3  green(ma) && M3_ma<=0.05 && M5_ma<=0.08 && M6_ma<=0.12
 *                                                         -> GO manual-anchor (degraded)
 *   Step 4  otherwise                                     -> STOP:accuracy
 *
 * The contract has two halves and this suite keeps them separate:
 *
 *   1. TOTALITY over WELL-FORMED input — every well-formed metric tuple
 *      (all metrics present, finite, in range; modes a plain object; every
 *      present mode entry a plain object with finite in-range m3/m5/m6)
 *      reaches exactly one branch, deterministically. Step 4 is the
 *      unconditional else; this is the §10.3 totality claim.
 *   2. FAIL-CLOSED on MALFORMED input — null/missing/non-finite/wrong-typed
 *      metrics or a malformed modes container reject with the named
 *      DECISION-INPUT error before any branch can read them. Unknown metric
 *      quality must never read as safe: a missing m4 must not silently
 *      become "0 identity swaps" and pass the Step-0 identity gate.
 *
 * Attack inputs: NaN, Infinity, -0, negative metrics, missing keys, extra
 * keys, string-typed numbers, exactly-on-threshold from both sides, float
 * representation edges, tuples satisfying several branches at once, a mode
 * marked not-green that would otherwise win, and property-based random sweeps
 * asserting totality + determinism on well-formed tuples and named rejection
 * on malformed tuples.
 */

import { decideFeasibility } from "../../../tools/ingest/decision.mjs";
import { ok, newRegistry, describe, deepEq, lcg } from "./rt-common.mjs";

const reg = newRegistry();

const MODES = ["contact-head", "lowest-foot", "manual-anchor"];
const pass = (over = {}) => ({ m3: 0.01, m5: 0.01, m6: 0.01, runnerGreen: true, measurementGreen: true, ...over });
const failHard = (over = {}) => ({ m3: 0.5, m5: 0.5, m6: 0.5, runnerGreen: true, measurementGreen: true, ...over });
const tuple = (over = {}) => ({
	m1: 0.8, m2: 0.9, m4: 0,
	modes: { "contact-head": pass(), "lowest-foot": failHard(), "manual-anchor": failHard() },
	...over,
});

// The contract oracle, written from plan §10.3 + §10.2 text (NOT from the
// implementation): used by the property sweep so the sweep asserts against
// the contract rather than against the code under test.
const oracle = (m) => {
	if (m.m4 > 0) return { verdict: "STOP", mode: null, degraded: false, reason: "identity", display: { spacingMayReadSoft: false } };
	const ch = m.modes["contact-head"];
	if (ch && ch.runnerGreen === true && ch.measurementGreen === true &&
		m.m1 >= 0.6 && m.m2 >= 0.85 && ch.m3 <= 0.03 && ch.m5 <= 0.05 && ch.m6 <= 0.08) {
		return { verdict: "GO", mode: "contact-head", degraded: false, reason: "contact-head", display: { spacingMayReadSoft: false } };
	}
	const lf = m.modes["lowest-foot"];
	if (lf && lf.runnerGreen === true && lf.measurementGreen === true &&
		lf.m3 <= 0.05 && lf.m5 <= 0.08 && lf.m6 <= 0.12) {
		return { verdict: "GO", mode: "lowest-foot", degraded: true, reason: "lowest-foot", display: { spacingMayReadSoft: true } };
	}
	const ma = m.modes["manual-anchor"];
	if (ma && ma.runnerGreen === true && ma.measurementGreen === true &&
		ma.m3 <= 0.05 && ma.m5 <= 0.08 && ma.m6 <= 0.12) {
		return { verdict: "GO", mode: "manual-anchor", degraded: true, reason: "manual-anchor", display: { spacingMayReadSoft: true } };
	}
	return { verdict: "STOP", mode: null, degraded: false, reason: "accuracy", display: { spacingMayReadSoft: false } };
};

const E = 1e-9;

// Run decideFeasibility and capture the outcome (branch result or thrown
// error) so both contract halves can be asserted without crashing the suite.
const tryCall = (fn) => {
	try { return { threw: null, value: fn() }; } catch (e) { return { threw: e }; }
};

// Fail-closed assertion: the input MUST reject with the named DECISION-INPUT
// error and the message MUST name the offending metric/container (fragment).
// A silent branch, a bare TypeError, or a message naming the wrong metric all
// fail this assertion. Returns the thrown error for the case record.
const expectDecisionInput = (label, input, fragment) => {
	const { threw } = tryCall(() => decideFeasibility(input));
	const named = threw instanceof Error && /DECISION-INPUT/.test(threw.message);
	const names = named && threw.message.includes(fragment);
	ok(label, named && names, threw ? threw.message : "no throw — malformed input reached a branch");
	return threw;
};

// ---------------------------------------------------------------------------
// NaN — fail-closed half: NaN is not a finite number; the contract rejects it
// with a named DECISION-INPUT error before any branch can read it.
// ---------------------------------------------------------------------------
{
	const inputs = {
		"m1": tuple({ m1: NaN }),
		"m2": tuple({ m2: NaN }),
		"m4": tuple({ m4: NaN }),
		"m3 (ch)": tuple({ modes: { "contact-head": pass({ m3: NaN }), "lowest-foot": failHard(), "manual-anchor": failHard() } }),
		"m5 (ch)": tuple({ modes: { "contact-head": pass({ m5: NaN }), "lowest-foot": failHard(), "manual-anchor": failHard() } }),
		"m6 (ch)": tuple({ modes: { "contact-head": pass({ m6: NaN }), "lowest-foot": failHard(), "manual-anchor": failHard() } }),
	};
	for (const [which, input] of Object.entries(inputs)) {
		const key = which.split(" ")[0];
		const e1 = tryCall(() => decideFeasibility(input));
		const e2 = tryCall(() => decideFeasibility(input));
		const named = e1.threw instanceof Error && /DECISION-INPUT/.test(e1.threw.message) && e1.threw.message.includes(key);
		const det = named && e2.threw instanceof Error && e2.threw.message === e1.threw.message;
		ok(`DEC-NaN-${which}: NaN ${key} rejects with DECISION-INPUT naming ${key}, deterministically`, named && det,
			e1.threw ? e1.threw.message : describe(e1.value));
		reg.record({
			id: `DEC-NaN-${which}`, category: "decision", attack: "NaN metric",
			input: `NaN in ${which}, rest of tuple GO-worthy`,
			expected: "fail-closed: named DECISION-INPUT rejection naming the NaN metric; no branch may read NaN",
			observed: e1.threw ? e1.threw.message : `no throw -> ${describe(e1.value)}`,
			verdict: named && det ? "PASS" : "WEAKNESS",
		});
	}
	// NaN m4 is the asymmetric one: it must NOT read as "no swaps" — the
	// rejection keeps unknown identity from passing the Step-0 gate silently.
	const r = tryCall(() => decideFeasibility(tuple({ m4: NaN })));
	const namedM4 = r.threw instanceof Error && r.threw.message.includes("DECISION-INPUT") && r.threw.message.includes("m4");
	ok("DEC-NaN-m4-reason: NaN m4 rejects with DECISION-INPUT naming m4 — never normalized to 'no swaps'", namedM4,
		r.threw ? r.threw.message : describe(r.value));
	reg.record({
		id: "DEC-NaN-m4-reason", category: "decision", attack: "NaN in the identity metric",
		input: "m4 = NaN, everything else GO-worthy",
		expected: "contract: m4 is a count; NaN is neither 0 nor a finite number. A NaN m4 must reject with DECISION-INPUT naming m4 — never silently pass the identity gate as 'no swaps'.",
		observed: r.threw ? r.threw.message : `no throw -> ${describe(r.value)}`,
		verdict: namedM4 ? "PASS" : "WEAKNESS",
	});
}

// ---------------------------------------------------------------------------
// Infinity / -Infinity — fail-closed: non-finite values reject; Infinity m4
// must not be read as a count, and Infinity fractions must not satisfy gates.
// ---------------------------------------------------------------------------
{
	const rInfM4 = tryCall(() => decideFeasibility(tuple({ m4: Infinity })));
	const infM4 = rInfM4.threw instanceof Error && rInfM4.threw.message.includes("DECISION-INPUT") && rInfM4.threw.message.includes("m4");
	ok("DEC-Inf-m4: Infinity m4 rejects with DECISION-INPUT naming m4", infM4,
		rInfM4.threw ? rInfM4.threw.message : describe(rInfM4.value));
	reg.record({
		id: "DEC-Inf-m4", category: "decision", attack: "Infinity in the identity metric",
		input: "m4 = Infinity",
		expected: "m4 is a count; Infinity is not a finite number -> named DECISION-INPUT rejection naming m4 (never STOP:identity, never GO)",
		observed: rInfM4.threw ? rInfM4.threw.message : describe(rInfM4.value),
		verdict: infM4 ? "PASS" : "WEAKNESS",
	});

	// M1/M2 are fractions in [0,1] per FEASIBILITY.md §3; Infinity must
	// reject, not satisfy "M1 >= 0.60" — a coverage fraction can never be
	// infinite.
	const rInf = tryCall(() => decideFeasibility(tuple({ m1: Infinity, m2: Infinity })));
	const infM1 = rInf.threw instanceof Error && rInf.threw.message.includes("DECISION-INPUT") && rInf.threw.message.includes("m1");
	ok("DEC-Inf-m12: Infinity M1/M2 reject with DECISION-INPUT naming m1", infM1,
		rInf.threw ? rInf.threw.message : describe(rInf.value));
	reg.record({
		id: "DEC-Inf-m12", category: "decision", attack: "Infinity in coverage/precision fractions",
		input: "m1 = Infinity, m2 = Infinity, all three modes green and in budget",
		expected: "fractions outside [0,1] are non-contract input -> named DECISION-INPUT rejection naming m1; no GO may fire",
		observed: rInf.threw ? rInf.threw.message : describe(rInf.value),
		verdict: infM1 ? "PASS" : "WEAKNESS",
	});

	const rInfM3 = tryCall(() => decideFeasibility(tuple({ modes: { "contact-head": pass({ m3: Infinity }), "lowest-foot": failHard(), "manual-anchor": failHard() } })));
	const infM3 = rInfM3.threw instanceof Error && rInfM3.threw.message.includes("DECISION-INPUT") && rInfM3.threw.message.includes("m3");
	ok("DEC-Inf-m3: Infinity jitter rejects with DECISION-INPUT naming m3", infM3,
		rInfM3.threw ? rInfM3.threw.message : describe(rInfM3.value));
	reg.record({
		id: "DEC-Inf-m3", category: "decision", attack: "Infinity in a <= branch",
		input: "m3 = Infinity (others in budget)",
		expected: "Infinity is not finite -> named DECISION-INPUT rejection naming m3; it must never satisfy '<= 0.03'",
		observed: rInfM3.threw ? rInfM3.threw.message : describe(rInfM3.value),
		verdict: infM3 ? "PASS" : "WEAKNESS",
	});

	const rNegInf = tryCall(() => decideFeasibility(tuple({ m1: -Infinity, m2: -Infinity })));
	const negInf = rNegInf.threw instanceof Error && rNegInf.threw.message.includes("DECISION-INPUT") && rNegInf.threw.message.includes("m1");
	ok("DEC--Inf-m12: -Infinity fractions reject with DECISION-INPUT naming m1", negInf,
		rNegInf.threw ? rNegInf.threw.message : describe(rNegInf.value));
	reg.record({
		id: "DEC--Inf-m12", category: "decision", attack: "-Infinity in fractions",
		input: "m1 = m2 = -Infinity",
		expected: "-Infinity is not finite -> named DECISION-INPUT rejection naming m1; no branch may read it",
		observed: rNegInf.threw ? rNegInf.threw.message : describe(rNegInf.value),
		verdict: negInf ? "PASS" : "WEAKNESS",
	});
}

// ---------------------------------------------------------------------------
// -0 and negative metrics
// ---------------------------------------------------------------------------
{
	// -0 IS a finite number and compares equal to 0 (-0 < 0 is false, -0 >= 0
	// is true), so -0 is IN contract range: this tuple is well-formed, not
	// malformed, and must reach a branch (totality half): m1=-0 < 0.6 ->
	// STOP:accuracy; -0 m3 passes its <= gate but the M1/M2 gate blocks GO.
	const rNeg0 = decideFeasibility(tuple({ m1: -0, m2: -0, m4: -0, modes: { "contact-head": pass({ m3: -0, m5: -0, m6: -0 }), "lowest-foot": failHard(), "manual-anchor": failHard() } }));
	ok("DEC-neg0: -0 tuple is well-formed and reaches STOP:accuracy, deterministic", rNeg0.verdict === "STOP" && rNeg0.reason === "accuracy", describe(rNeg0));
	reg.record({
		id: "DEC-neg0", category: "decision", attack: "-0 in every metric",
		input: "m1=m2=m4=-0, m3=m5=m6=-0, contact-head green",
		expected: "-0 is finite and equals 0, so the tuple is well-formed; m1=-0 < 0.6 -> STOP:accuracy; -0 m3 passes its <= gate",
		observed: describe(rNeg0),
		verdict: rNeg0.verdict === "STOP" && rNeg0.reason === "accuracy" ? "PASS" : "WEAKNESS",
	});

	// error metrics are std/RMS — non-negative by construction; a negative
	// value is outside the contract range [0, +inf) and must reject, not
	// silently satisfy the budget gate
	const rNeg = tryCall(() => decideFeasibility(tuple({ modes: { "contact-head": pass({ m3: -0.01, m5: -0.01, m6: -0.01 }), "lowest-foot": failHard(), "manual-anchor": failHard() } })));
	const negRej = rNeg.threw instanceof Error && rNeg.threw.message.includes("DECISION-INPUT") && rNeg.threw.message.includes("m3");
	ok("DEC-neg-metrics: negative error metrics reject with DECISION-INPUT naming m3", negRej,
		rNeg.threw ? rNeg.threw.message : describe(rNeg.value));
	reg.record({
		id: "DEC-neg-metrics", category: "decision", attack: "negative error metrics (impossible values)",
		input: "m3 = m5 = m6 = -0.01 (std/RMS cannot be negative), contact-head green",
		expected: "out of range [0, +inf) -> named DECISION-INPUT rejection naming m3; a negative 'jitter' must not satisfy '<= 0.03'",
		observed: rNeg.threw ? rNeg.threw.message : describe(rNeg.value),
		verdict: negRej ? "PASS" : "WEAKNESS",
	});
}

// ---------------------------------------------------------------------------
// Missing keys — fail-closed: absence is a contract violation, never a
// default. A missing m4 must not read as "0 swaps" (Step 0 is the gate that
// stops the whole pipeline, so unknown identity must never read as clean).
// ---------------------------------------------------------------------------
{
	// (a) totally empty object: named rejection, first missing metric (m1),
	//     never a TypeError from a null dereference
	const e1 = tryCall(() => decideFeasibility({}));
	const a = e1.threw instanceof Error && e1.threw.message.includes("DECISION-INPUT") && e1.threw.message.includes("m1") && !(e1.threw instanceof TypeError);
	ok("DEC-missing-modes: {} rejects with DECISION-INPUT naming m1, not a bare TypeError", a,
		e1.threw ? `${e1.threw.name}: ${e1.threw.message}` : "no throw");
	reg.record({
		id: "DEC-missing-modes", category: "decision", attack: "modes container missing",
		input: "{}",
		expected: "fail-closed: named DECISION-INPUT rejection (m1 is the first missing metric); the total gate must not crash with a bare TypeError on the missing modes container",
		observed: e1.threw ? `${e1.threw.name}: ${e1.threw.message}` : "no throw",
		verdict: a ? "PASS" : "WEAKNESS",
	});
	// (b) modes: null — named rejection naming the container
	const e2 = tryCall(() => decideFeasibility({ m1: 0.8, m2: 0.9, m4: 0, modes: null }));
	const b = e2.threw instanceof Error && e2.threw.message.includes("DECISION-INPUT") && e2.threw.message.includes("modes") && !(e2.threw instanceof TypeError);
	ok("DEC-modes-null: modes:null rejects with DECISION-INPUT naming modes, not a bare TypeError", b,
		e2.threw ? `${e2.threw.name}: ${e2.threw.message}` : "no throw");
	reg.record({
		id: "DEC-modes-null", category: "decision", attack: "modes container null",
		input: "modes: null",
		expected: "fail-closed: named DECISION-INPUT rejection naming modes; a null container must not crash with a bare TypeError",
		observed: e2.threw ? `${e2.threw.name}: ${e2.threw.message}` : "no throw",
		verdict: b ? "PASS" : "WEAKNESS",
	});
	// (c) m4 missing — the identity metric is the safety-critical one
	const e3 = tryCall(() => decideFeasibility({ m1: 0.8, m2: 0.9, modes: { "contact-head": pass(), "lowest-foot": failHard(), "manual-anchor": failHard() } }));
	const c = e3.threw instanceof Error && e3.threw.message.includes("DECISION-INPUT") && e3.threw.message.includes("m4");
	ok("DEC-missing-m4: absent identity metric rejects with DECISION-INPUT naming m4", c,
		e3.threw ? e3.threw.message : describe(e3.value));
	reg.record({
		id: "DEC-missing-m4", category: "decision", attack: "identity metric missing",
		input: "no m4 key; every other metric GO-worthy",
		expected: "identity unknown must not be normalized to '0 swaps' (the unsafe direction) -> named DECISION-INPUT rejection naming m4",
		observed: e3.threw ? e3.threw.message : `no throw -> ${describe(e3.value)}`,
		verdict: c ? "PASS" : "WEAKNESS",
	});
	// (d) m1/m2 missing -> fail-closed rejection, same as any missing metric
	const e4 = tryCall(() => decideFeasibility({ m2: 0.9, m4: 0, modes: { "contact-head": pass(), "lowest-foot": failHard(), "manual-anchor": failHard() } }));
	const d = e4.threw instanceof Error && e4.threw.message.includes("DECISION-INPUT") && e4.threw.message.includes("m1");
	ok("DEC-missing-m1: absent coverage metric rejects with DECISION-INPUT naming m1", d,
		e4.threw ? e4.threw.message : describe(e4.value));
	reg.record({
		id: "DEC-missing-m1", category: "decision", attack: "coverage metric missing",
		input: "no m1 key",
		expected: "missing metric -> named DECISION-INPUT rejection naming m1 (absence is a contract violation, not a default)",
		observed: e4.threw ? e4.threw.message : `no throw -> ${describe(e4.value)}`,
		verdict: d ? "PASS" : "WEAKNESS",
	});
	// (e) missing mode ENTRY is well-formed: that mode did not run and simply
	//     cannot be green -> falls through (totality half)
	const rNoMode = decideFeasibility({ m1: 0.8, m2: 0.9, m4: 0, modes: { "lowest-foot": failHard(), "manual-anchor": failHard() } });
	ok("DEC-missing-mode-entry: absent mode entry falls through to STOP:accuracy", rNoMode.verdict === "STOP" && rNoMode.reason === "accuracy", describe(rNoMode));
	reg.record({
		id: "DEC-missing-mode-entry", category: "decision", attack: "one mode entry absent",
		input: "no 'contact-head' entry at all",
		expected: "absent mode entry is well-formed (that mode did not run); cannot be green -> falls through",
		observed: describe(rNoMode), verdict: "PASS",
	});
	// (f) mode entry PRESENT but empty: a present entry claims that mode was
	//     measured, so its m3/m5/m6 must be present too -> named rejection
	//     naming the first missing mode metric (m3)
	const e5 = tryCall(() => decideFeasibility({ m1: 0.8, m2: 0.9, m4: 0, modes: { "contact-head": {}, "lowest-foot": failHard(), "manual-anchor": failHard() } }));
	const f = e5.threw instanceof Error && e5.threw.message.includes("DECISION-INPUT") && e5.threw.message.includes("m3");
	ok("DEC-missing-mode-fields: empty present mode entry rejects with DECISION-INPUT naming m3", f,
		e5.threw ? e5.threw.message : describe(e5.value));
	reg.record({
		id: "DEC-missing-mode-fields", category: "decision", attack: "mode entry present but empty",
		input: "'contact-head': {}",
		expected: "a PRESENT entry claims that mode was measured -> its m3/m5/m6 must be present; missing m3 rejects with DECISION-INPUT naming m3",
		observed: e5.threw ? e5.threw.message : `no throw -> ${describe(e5.value)}`,
		verdict: f ? "PASS" : "WEAKNESS",
	});
}

// ---------------------------------------------------------------------------
// Extra keys — well-formed half: unknown top-level keys, unknown mode keys
// and extra mode fields are ignored; the tuple still reaches the branch its
// contract-blessed metrics select.
// ---------------------------------------------------------------------------
{
	const r = decideFeasibility(tuple({ m7: 99, note: "x", modes: { "contact-head": pass({ extra: 1 }), "lowest-foot": failHard(), "manual-anchor": failHard(), "hack-mode": pass() } }));
	ok("DEC-extra-keys: unknown keys/mode are ignored; result identical to the base tuple", r.mode === "contact-head" && r.verdict === "GO", describe(r));
	reg.record({
		id: "DEC-extra-keys", category: "decision", attack: "unknown top-level keys, unknown mode, extra mode fields",
		input: "tuple + m7/note + 'hack-mode' mode + extra field on contact-head",
		expected: "unknown keys are ignored; result identical to the base tuple",
		observed: describe(r),
		verdict: r.mode === "contact-head" && r.verdict === "GO" ? "PASS" : "WEAKNESS",
	});
}

// ---------------------------------------------------------------------------
// String-typed numbers (JS coercion) — fail-closed: a string is not a
// number; "0.8" must not coerce into a passing fraction and "0" must not
// coerce into "no identity swaps".
// ---------------------------------------------------------------------------
{
	const e1 = tryCall(() => decideFeasibility({
		m1: "0.8", m2: "0.9", m4: "0",
		modes: { "contact-head": pass({ m3: "0.01", m5: "0.01", m6: "0.01" }), "lowest-foot": failHard(), "manual-anchor": failHard() },
	}));
	const s1 = e1.threw instanceof Error && e1.threw.message.includes("DECISION-INPUT") && e1.threw.message.includes("m1");
	ok("DEC-strings: string-typed metrics reject with DECISION-INPUT naming m1", s1,
		e1.threw ? e1.threw.message : describe(e1.value));
	reg.record({
		id: "DEC-strings", category: "decision", attack: "string-typed numbers (JSON allows them)",
		input: 'm1:"0.8", m2:"0.9", m4:"0", m3/m5/m6:"0.01"',
		expected: "contract metrics are numbers; string-typed values are non-contract input -> named DECISION-INPUT rejection naming m1 (never coerced into a GO)",
		observed: e1.threw ? e1.threw.message : `no throw -> ${describe(e1.value)}`,
		verdict: s1 ? "PASS" : "WEAKNESS",
	});
	// string m4 = "1" must reject, not coerce into STOP:identity
	const e2 = tryCall(() => decideFeasibility(tuple({ m4: "1" })));
	const s2 = e2.threw instanceof Error && e2.threw.message.includes("DECISION-INPUT") && e2.threw.message.includes("m4");
	ok("DEC-strings-m4: string m4 rejects with DECISION-INPUT naming m4", s2,
		e2.threw ? e2.threw.message : describe(e2.value));
	reg.record({
		id: "DEC-strings-m4", category: "decision", attack: 'string m4 = "1"',
		input: 'm4: "1"',
		expected: '"1" is not a number -> named DECISION-INPUT rejection naming m4 (never coerced to STOP:identity)',
		observed: e2.threw ? e2.threw.message : `no throw -> ${describe(e2.value)}`,
		verdict: s2 ? "PASS" : "WEAKNESS",
	});
	// empty strings reject like any string; "" must not coerce to 0
	const e3 = tryCall(() => decideFeasibility(tuple({ m1: "", m2: "", m4: "" })));
	const s3 = e3.threw instanceof Error && e3.threw.message.includes("DECISION-INPUT") && e3.threw.message.includes("m1");
	ok("DEC-strings-empty: empty-string metrics reject with DECISION-INPUT naming m1", s3,
		e3.threw ? e3.threw.message : describe(e3.value));
	reg.record({
		id: "DEC-strings-empty", category: "decision", attack: 'empty strings',
		input: 'm1: "", m2: "", m4: ""',
		expected: '"" is not a number -> named DECISION-INPUT rejection naming m1 (never coerced to 0)',
		observed: e3.threw ? e3.threw.message : `no throw -> ${describe(e3.value)}`,
		verdict: s3 ? "PASS" : "WEAKNESS",
	});
}

// ---------------------------------------------------------------------------
// Exactly-on-threshold, both sides — well-formed half: the inclusive side
// passes, the exclusive side fails, with the same tuple otherwise; the
// non-swept modes are pinned failing so a flipped value cannot be rescued by
// a lower branch.
// ---------------------------------------------------------------------------
{
	const base = () => tuple({ modes: { "contact-head": pass(), "lowest-foot": failHard(), "manual-anchor": failHard() } });
	// M1/M2 top-level
	for (const [name, field, t] of [["M1", "m1", 0.6], ["M2", "m2", 0.85]]) {
		const on = base(); on[field] = t;
		const off = base(); off[field] = t - E;
		const rOn = decideFeasibility(on);
		const rOff = decideFeasibility(off);
		ok(`DEC-threshold-${name}: ${t} inclusive -> GO contact-head; ${t - E} exclusive -> STOP:accuracy`,
			rOn.mode === "contact-head" && rOff.verdict === "STOP" && rOff.reason === "accuracy",
			`${field}=${t}: ${describe(rOn)}; ${field}=${t - E}: ${describe(rOff)}`);
		reg.record({
			id: `DEC-threshold-${name}`, category: "decision", attack: `${name} exactly on threshold and one epsilon below`,
			input: `${field} = ${t} vs ${t - E}`,
			expected: `${t} >= ${t} -> GO contact-head; ${t - E} < ${t} -> STOP:accuracy`,
			observed: `${field}=${t}: ${describe(rOn)}; ${field}=${t - E}: ${describe(rOff)}`,
			verdict: rOn.mode === "contact-head" && rOff.verdict === "STOP" && rOff.reason === "accuracy" ? "PASS" : "WEAKNESS",
		});
	}
	// M4 0 vs the first real count above it. The epsilon used for the continuous
	// thresholds is not a valid m4: the metric is a COUNT of label transitions,
	// so its domain is the non-negative integers and 1e-9 is now rejected as
	// producer garbage rather than treated as "just above zero".
	const rM40 = decideFeasibility(tuple({ m4: 0 }));
	const rM41 = decideFeasibility(tuple({ m4: 1 }));
	const rM4E = tryCall(() => decideFeasibility(tuple({ m4: E })));
	const epsRejected = rM4E.threw instanceof Error && /DECISION-INPUT/.test(rM4E.threw.message);
	ok("DEC-threshold-M4: m4=0 proceeds; m4=1 stops as identity; fractional epsilon is rejected",
		rM40.verdict === "GO" && rM41.reason === "identity" && epsRejected,
		`m4=0: ${describe(rM40)}; m4=1: ${describe(rM41)}; m4=1e-9: ${epsRejected ? "rejected" : describe(rM4E.value)}`);
	reg.record({
		id: "DEC-threshold-M4", category: "decision", attack: "M4 = 0 vs the first valid count vs a fractional epsilon",
		input: "m4 = 0, m4 = 1, m4 = 1e-9",
		expected: "0 -> proceeds; 1 -> STOP:identity; 1e-9 -> named DECISION-INPUT rejection (a count cannot be fractional)",
		observed: `m4=0: ${describe(rM40)}; m4=1: ${describe(rM41)}; m4=1e-9: ${epsRejected ? rM4E.threw.message : describe(rM4E.value)}`,
		verdict: rM40.verdict === "GO" && rM41.reason === "identity" && epsRejected ? "PASS" : "WEAKNESS",
	});
	// mode-level thresholds: contact-head 0.03/0.05/0.08
	for (const [name, field, t] of [
		["M3_ch", "m3", 0.03], ["M5_ch", "m5", 0.05], ["M6_ch", "m6", 0.08],
	]) {
		const on = tuple({ modes: { "contact-head": pass(), "lowest-foot": failHard(), "manual-anchor": failHard() } });
		on.modes["contact-head"][field] = t;
		const off = tuple({ modes: { "contact-head": pass(), "lowest-foot": failHard(), "manual-anchor": failHard() } });
		off.modes["contact-head"][field] = t + E;
		const rOn = decideFeasibility(on);
		const rOff = decideFeasibility(off);
		ok(`DEC-threshold-${name}: ${t} inclusive -> GO contact-head; ${t + E} exclusive -> STOP:accuracy`,
			rOn.mode === "contact-head" && rOff.verdict === "STOP" && rOff.reason === "accuracy",
			`${field}=${t}: ${describe(rOn)}; ${field}=${t + E}: ${describe(rOff)}`);
		reg.record({
			id: `DEC-threshold-${name}`, category: "decision", attack: `${name} exactly on threshold and one epsilon above`,
			input: `m3/m5/m6 = ${t} vs ${t + E} on contact-head`,
			expected: `${t} <= ${t} -> step 1 fires; ${t + E} > ${t} -> step 1 fails (falls to STOP:accuracy here, others pinned failing)`,
			observed: `${field}=${t}: ${describe(rOn)}; ${field}=${t + E}: ${describe(rOff)}`,
			verdict: rOn.mode === "contact-head" && rOff.verdict === "STOP" && rOff.reason === "accuracy" ? "PASS" : "WEAKNESS",
		});
	}
	// lowest-foot exact thresholds (the 0.05/0.08/0.12 budget) with step 1 blocked
	for (const [name, field, t] of [["M3_lf", "m3", 0.05], ["M5_lf", "m5", 0.08], ["M6_lf", "m6", 0.12]]) {
		const on = tuple({ modes: { "contact-head": pass({ m3: 0.2 }), "lowest-foot": pass(), "manual-anchor": failHard() } });
		on.modes["lowest-foot"][field] = t;
		const rOn = decideFeasibility(on);
		ok(`DEC-threshold-${name}-exact: ${t} exactly at the degraded budget -> GO lowest-foot degraded`,
			rOn.mode === "lowest-foot" && rOn.degraded === true, describe(rOn));
		reg.record({
			id: `DEC-threshold-${name}-exact`, category: "decision", attack: `${name} exactly at the degraded budget`,
			input: `lowest-foot ${field} = ${t} exactly, step 1 blocked`,
			expected: `<= ${t} -> GO lowest-foot degraded`,
			observed: describe(rOn),
			verdict: rOn.mode === "lowest-foot" && rOn.degraded === true ? "PASS" : "WEAKNESS",
		});
	}
}

// ---------------------------------------------------------------------------
// Float representation edges — well-formed half: every input here is a finite
// in-range number, so the <= / >= semantics are exact and deterministic. The
// IEEE754 facts (verified, not assumed): 0.02+0.03 rounds to the 0.05 double
// and 0.5+0.35 to the 0.85 double, so the gates fire; 0.2+0.4 lands one ulp
// ABOVE the 0.6 M1 threshold — '>= 0.6' is inclusive, so it fires too. A
// producer must not compute thresholds arithmetically; the gate is exact.
// ---------------------------------------------------------------------------
{
	const eq0805 = (0.05 + 0.03) === 0.08;   // true: the doubles sum to the double 0.08
	const sum053 = 0.02 + 0.03;              // === 0.05: rounds to the threshold double
	const sum085 = 0.5 + 0.35;               // === 0.85: rounds to the threshold double
	const sumM1 = 0.2 + 0.4;                 // 0.6000000000000001 > 0.6: the genuine 1-ulp drift
	reg.record({
		id: "DEC-float-ulp", category: "decision", attack: "arithmetically-on-threshold values land on the wrong side",
		input: "m5_ch = 0.02+0.03; m2 = 0.5+0.35; m1 = 0.2+0.4; m6_ch = 0.05+0.03",
		expected: "IEEE754: deterministic; the <= / >= semantics are exact. 0.02+0.03 rounds to the 0.05 double and 0.5+0.35 to the 0.85 double; 0.2+0.4 = 0.6000000000000001 lands one ulp above 0.6. A producer must not compute thresholds arithmetically.",
		observed: `0.05+0.03 === 0.08: ${eq0805}; 0.02+0.03 = ${sum053} (=== 0.05: ${sum053 === 0.05}); 0.5+0.35 = ${sum085} (=== 0.85: ${sum085 === 0.85}); 0.2+0.4 = ${sumM1} (> 0.6: ${sumM1 > 0.6})`,
		verdict: "INFO",
	});
	const rU1 = decideFeasibility({ m1: 0.8, m2: 0.9, m4: 0, modes: { "contact-head": pass({ m5: 0.02 + 0.03 }), "lowest-foot": failHard(), "manual-anchor": failHard() } });
	ok("DEC-float-m5-ulp: m5=0.02+0.03 rounds to the 0.05 double -> step 1 fires (GO), deterministic", rU1.mode === "contact-head", describe(rU1));
	reg.record({
		id: "DEC-float-m5-ulp", category: "decision", attack: "m5 = 0.02+0.03 vs the 0.05 budget",
		input: "m5_ch = 0.02+0.03",
		expected: "0.02+0.03 === 0.05 in doubles -> 'm5 <= 0.05' is true -> step 1 fires; deterministic",
		observed: describe(rU1),
		verdict: rU1.mode === "contact-head" ? "PASS" : "INFO",
	});
	const rU2 = decideFeasibility({ m1: 0.8, m2: 0.5 + 0.35, m4: 0, modes: { "contact-head": pass(), "lowest-foot": failHard(), "manual-anchor": failHard() } });
	ok("DEC-float-m2-ulp: m2=0.5+0.35 rounds to the 0.85 double -> M2 gate fires (GO), deterministic", rU2.mode === "contact-head", describe(rU2));
	reg.record({
		id: "DEC-float-m2-ulp", category: "decision", attack: "m2 = 0.5+0.35 vs the 0.85 gate",
		input: "m2 = 0.5+0.35",
		expected: "0.5+0.35 === 0.85 in doubles -> 'm2 >= 0.85' is true -> step 1 fires; deterministic",
		observed: describe(rU2),
		verdict: rU2.mode === "contact-head" ? "PASS" : "INFO",
	});
	const rU3 = decideFeasibility({ m1: 0.8, m2: 0.9, m4: 0, modes: { "contact-head": pass({ m6: 0.05 + 0.03 }), "lowest-foot": failHard(), "manual-anchor": failHard() } });
	ok("DEC-float-m6-ulp: m6=0.05+0.03 === 0.08 exactly -> step 1 fires (GO), deterministic", rU3.mode === "contact-head", describe(rU3));
	reg.record({
		id: "DEC-float-m6-ulp", category: "decision", attack: "m6 = 0.05+0.03 vs the 0.08 budget",
		input: "m6_ch = 0.05+0.03",
		expected: "0.05+0.03 === 0.08 exactly in doubles -> step 1 fires",
		observed: describe(rU3),
		verdict: rU3.mode === "contact-head" ? "PASS" : "WEAKNESS",
	});
	// the genuine 1-ulp drift on a real threshold: 0.2+0.4 = 0.6000000000000001,
	// one ulp ABOVE the 0.6 M1 threshold — '>= 0.6' is inclusive, so the M1
	// gate fires; deterministic
	const rU4 = decideFeasibility({ m1: 0.2 + 0.4, m2: 0.9, m4: 0, modes: { "contact-head": pass(), "lowest-foot": failHard(), "manual-anchor": failHard() } });
	ok("DEC-float-m1-ulp: m1=0.2+0.4 = 0.6000000000000001 (1 ulp above 0.6) -> M1 gate fires (GO), deterministic", rU4.mode === "contact-head", describe(rU4));
	reg.record({
		id: "DEC-float-m1-ulp", category: "decision", attack: "m1 = 0.2+0.4 vs the 0.6 gate (1-ulp drift)",
		input: "m1 = 0.2+0.4 (0.6000000000000001)",
		expected: "0.2+0.4 > 0.6 in doubles, and '>= 0.6' is inclusive -> step 1 fires; deterministic",
		observed: describe(rU4),
		verdict: rU4.mode === "contact-head" ? "PASS" : "WEAKNESS",
	});
}

// ---------------------------------------------------------------------------
// Tuples satisfying several branches at once; not-green mode that would win —
// well-formed half: ordering (first satisfied branch wins), the green gate
// (plan §10.2), and strict === true semantics for the green flags.
// ---------------------------------------------------------------------------
{
	const rAll = decideFeasibility(tuple({ modes: { "contact-head": pass(), "lowest-foot": pass(), "manual-anchor": pass() } }));
	ok("DEC-multibranch-all: all three branches satisfied -> first wins (GO contact-head, non-degraded)",
		rAll.mode === "contact-head" && rAll.degraded === false, describe(rAll));
	reg.record({
		id: "DEC-multibranch-all", category: "decision", attack: "all three GO branches satisfied",
		input: "all modes green and in budget",
		expected: "first satisfied branch wins -> GO contact-head, non-degraded",
		observed: describe(rAll),
		verdict: rAll.mode === "contact-head" && rAll.degraded === false ? "PASS" : "WEAKNESS",
	});
	const r23 = decideFeasibility(tuple({ modes: { "contact-head": pass({ m3: 0.04 }), "lowest-foot": pass(), "manual-anchor": pass() } }));
	ok("DEC-multibranch-23: steps 2+3 satisfied, step 1 not -> GO lowest-foot (degraded)",
		r23.mode === "lowest-foot" && r23.degraded === true, describe(r23));
	reg.record({
		id: "DEC-multibranch-23", category: "decision", attack: "steps 2 and 3 satisfied, step 1 not",
		input: "contact-head m3 = 0.04 (gap (0.03,0.05]); lowest-foot + manual-anchor in budget",
		expected: "-> GO lowest-foot (degraded)",
		observed: describe(r23),
		verdict: r23.mode === "lowest-foot" && r23.degraded === true ? "PASS" : "WEAKNESS",
	});
	const rNotGreen = decideFeasibility(tuple({ modes: { "contact-head": pass({ runnerGreen: false }), "lowest-foot": pass(), "manual-anchor": failHard() } }));
	ok("DEC-notgreen-wins: mode that would win is not green -> falls to lowest-foot",
		rNotGreen.mode === "lowest-foot" && rNotGreen.degraded === true, describe(rNotGreen));
	reg.record({
		id: "DEC-notgreen-wins", category: "decision", attack: "mode that would win is marked not green",
		input: "contact-head metrics in budget but runnerGreen: false; lowest-foot green and in budget",
		expected: "plan §10.2: cannot select a non-green mode -> falls to lowest-foot",
		observed: describe(rNotGreen),
		verdict: rNotGreen.mode === "lowest-foot" && rNotGreen.degraded === true ? "PASS" : "WEAKNESS",
	});
	const rNotGreenMeas = decideFeasibility(tuple({ modes: { "contact-head": pass({ measurementGreen: false }), "lowest-foot": failHard(), "manual-anchor": failHard() } }));
	ok("DEC-notgreen-measurement: measurement path not green -> STOP:accuracy",
		rNotGreenMeas.reason === "accuracy", describe(rNotGreenMeas));
	reg.record({
		id: "DEC-notgreen-measurement", category: "decision", attack: "measurement path not green",
		input: "contact-head in budget, measurementGreen: false, others failing",
		expected: "-> STOP:accuracy (blocked mode must not be selected)",
		observed: describe(rNotGreenMeas),
		verdict: rNotGreenMeas.reason === "accuracy" ? "PASS" : "WEAKNESS",
	});
	const rGreenTruthy = decideFeasibility(tuple({ modes: { "contact-head": pass({ runnerGreen: 1, measurementGreen: "true" }), "lowest-foot": failHard(), "manual-anchor": failHard() } }));
	ok("DEC-green-strict: truthy-but-not-true green flags fail closed -> STOP:accuracy",
		rGreenTruthy.reason === "accuracy", describe(rGreenTruthy));
	reg.record({
		id: "DEC-green-strict", category: "decision", attack: "truthy-but-not-true green flags",
		input: "runnerGreen: 1, measurementGreen: 'true'",
		expected: "=== true is the contract; truthy values must fail closed",
		observed: describe(rGreenTruthy),
		verdict: rGreenTruthy.reason === "accuracy" ? "PASS" : "WEAKNESS",
	});
	const rAllNotGreen = decideFeasibility(tuple({ modes: { "contact-head": pass({ runnerGreen: false }), "lowest-foot": pass({ measurementGreen: false }), "manual-anchor": pass({ runnerGreen: false, measurementGreen: false }) } }));
	ok("DEC-all-notgreen: no green mode at all -> nothing may GO (STOP:accuracy)",
		rAllNotGreen.reason === "accuracy", describe(rAllNotGreen));
	reg.record({
		id: "DEC-all-notgreen", category: "decision", attack: "no green mode at all",
		input: "all metrics in budget, no mode green",
		expected: "nothing may GO -> STOP:accuracy",
		observed: describe(rAllNotGreen),
		verdict: rAllNotGreen.reason === "accuracy" ? "PASS" : "WEAKNESS",
	});
}

// ---------------------------------------------------------------------------
// Pass-2: attack the fixes themselves. Each closed pass-1 finding gets a NEW
// variant that would slip past the specific fix if the fix only patched its
// exact repro:
//   - range fix (fractions above 1, negative counts): semantically impossible
//     but FINITE numbers — m1/m2 > 1 and negative m4 must reject; a FRACTIONAL
//     m4 (0.5 / 2.5 "swaps") is a count the code's own input contract cannot
//     mean, and recording STOP:identity for it is the "broken producer hidden
//     behind a signable verdict" class the fix's header forbids.
//   - modes-container fix (null -> named DECISION-INPUT): container and entry
//     type variants — arrays, strings, null entries — must name the container
//     and reject, never crash and never read as green.
//   - green-gate fix (truthy flags fail closed): a present mode entry with the
//     green flags ABSENT must fail closed exactly like runnerGreen: false.
//   - wrong-typed metrics (strings rejected): null / boolean / boxed-number
//     metrics must reject with the named error too.
// ---------------------------------------------------------------------------
{
	// --- the range fix's boundary: finite but semantically impossible values
	for (const [id, over, frag] of [
		["DEC-range-m1-over", { m1: 1.5 }, "m1"],
		["DEC-range-m2-over", { m2: 1.0001 }, "m2"],
		["DEC-range-m4-negative", { m4: -1 }, "m4"],
	]) {
		const r = tryCall(() => decideFeasibility(tuple(over)));
		const named = r.threw instanceof Error && /DECISION-INPUT/.test(r.threw.message) && r.threw.message.includes(frag);
		reg.record({
			id, category: "decision", attack: `finite but semantically impossible metric (${over[frag]})`,
			input: JSON.stringify(over),
			expected: `m4 is a count, m1/m2 are fractions; a value outside [0,1] or a negative count is impossible input -> named DECISION-INPUT rejection naming ${frag}, never a branch`,
			observed: r.threw ? r.threw.message : `no throw -> ${describe(r.value)}`,
			verdict: named ? "PASS" : "WEAKNESS",
		});
	}
	// --- m4 is a COUNT (FEASIBILITY.md §3: "count of association.groundTruth
	// entries whose matching observation disagrees"; measure.mjs emits an
	// integer). A fractional count is producer garbage; the range check admits
	// it and Step 0 then records STOP:identity — a signable Phase-0 outcome
	// for input the code's own contract says cannot exist. This is the DEFECT
	// class the missing-m4 fix was written against ("never record a legitimate
	// outcome for a broken producer").
	// A finding must be OBSERVED, not asserted. Registering it unconditionally
	// meant it could never clear once the defect was fixed, which is the same
	// assert-don't-observe failure this suite exists to catch elsewhere.
	const fractionalDefects = [];
	for (const [id, m4v] of [["DEC-m4-fractional", 0.5], ["DEC-m4-fractional-2p5", 2.5]]) {
		const r = tryCall(() => decideFeasibility(tuple({ m4: m4v })));
		const rejected = r.threw instanceof Error && r.threw.message.includes("DECISION-INPUT");
		if (!rejected) fractionalDefects.push(id);
		reg.record({
			id, category: "decision", attack: `fractional identity-swap count (m4 = ${m4v})`,
			input: `m4 = ${m4v}, everything else GO-worthy`,
			expected: `m4 is a count (FEASIBILITY.md §3); ${m4v} swaps cannot exist -> named DECISION-INPUT rejection naming m4`,
			observed: r.threw ? r.threw.message : `no throw -> ${describe(r.value)} (STOP:identity recorded for an impossible count)`,
			verdict: rejected ? "PASS" : "DEFECT",
		});
	}
	if (fractionalDefects.length) {
		reg.finding("high", "decision.mjs accepts fractional m4 and records STOP:identity for it (count contract not enforced)", fractionalDefects,
			"FEASIBILITY.md §3 and measure.mjs define M4 as a COUNT of disagreeing association.groundTruth entries (an integer). A range check alone admits 0.5 or 2.5, which then reaches Step 0 and records STOP:identity — a legitimate, signable Phase-0 outcome for input a working producer cannot emit. decision.mjs's own input-contract paragraph says exactly this must not happen. The fix: require Number.isInteger on m4.");
	}
	// --- the modes-container fix's boundary: type variants of the container
	//     and of present mode entries
	for (const [id, over, frag] of [
		["DEC-modes-array", { modes: [] }, "modes"],
		["DEC-modes-string", { modes: "x" }, "modes"],
		["DEC-mode-entry-array", { modes: { "contact-head": [] } }, "modes.contact-head"],
		["DEC-mode-entry-null", { modes: { "contact-head": null } }, "modes.contact-head"],
		["DEC-mode-entry-string", { modes: { "contact-head": "green" } }, "modes.contact-head"],
	]) {
		const r = tryCall(() => decideFeasibility(tuple(over)));
		const named = r.threw instanceof Error && /DECISION-INPUT/.test(r.threw.message) && r.threw.message.includes(frag) && !(r.threw instanceof TypeError);
		reg.record({
			id, category: "decision", attack: `wrong-typed ${frag}`,
			input: JSON.stringify(over).slice(0, 90),
			expected: `fail-closed: named DECISION-INPUT rejection naming ${frag}; never a bare TypeError, never a branch`,
			observed: r.threw ? `${r.threw.name}: ${r.threw.message.slice(0, 90)}` : `no throw -> ${describe(r.value)}`,
			verdict: named ? "PASS" : "WEAKNESS",
		});
	}
	// --- green flags ABSENT on a present mode entry: must fail closed exactly
	//     like runnerGreen: false (the pass-1 fix pinned false; absence is the
	//     variant that would slip past a fix that only checked the boolean)
	{
		const r = decideFeasibility(tuple({ modes: { "contact-head": { m3: 0.01, m5: 0.01, m6: 0.01 }, "lowest-foot": failHard(), "manual-anchor": failHard() } }));
		reg.record({
			id: "DEC-mode-green-absent", category: "decision", attack: "present mode entry with the green flags absent entirely",
			input: "'contact-head' in budget but no runnerGreen/measurementGreen keys",
			expected: "green === true is the contract; absent flags must fail closed -> STOP:accuracy (same outcome as runnerGreen: false)",
			observed: describe(r),
			verdict: r.reason === "accuracy" ? "PASS" : "WEAKNESS",
		});
	}
	// --- wrong-typed metrics beyond strings: null / boolean / boxed Number
	for (const [id, over, frag] of [
		["DEC-m4-null", { m4: null }, "m4"],
		["DEC-m4-boolean", { m4: true }, "m4"],
		["DEC-m4-number-object", { m4: new Number(2) }, "m4"],
		["DEC-m1-null", { m1: null }, "m1"],
		["DEC-m1-boolean", { m1: true }, "m1"],
	]) {
		const r = tryCall(() => decideFeasibility(tuple(over)));
		const named = r.threw instanceof Error && /DECISION-INPUT/.test(r.threw.message) && r.threw.message.includes(frag);
		reg.record({
			id, category: "decision", attack: `wrong-typed metric (${frag})`,
			input: `${frag} = ${describe(over[frag])}`,
			expected: `a non-number is not a metric -> named DECISION-INPUT rejection naming ${frag} (null/true/new Number(2) must not coerce)`,
			observed: r.threw ? r.threw.message.slice(0, 110) : `no throw -> ${describe(r.value)}`,
			verdict: named ? "PASS" : "WEAKNESS",
		});
	}
}

// ---------------------------------------------------------------------------
// Pass-3: the m4 integrality rule (2738e05 "reject fractional swap counts").
// m4 is a COUNT (FEASIBILITY.md §3: count of disagreeing groundTruth entries;
// measure.mjs emits an integer), so the contract domain is the non-negative
// integers. These cases attack the Number.isInteger boundary: -0 (integer,
// equals 0), absurd-but-integral magnitudes (1e21, MAX_SAFE_INTEGER+1), a
// fractional literal that IEEE754 rounds into an integer double, a numeric
// STRING that would coerce ("0" must not read as 'no swaps'), and a fraction
// one ulp away from an integer. Every verdict below is observed, never
// asserted.
// ---------------------------------------------------------------------------
{
	// -0: Number.isInteger(-0) is true and -0 === 0, so -0 is a well-formed
	// count of zero swaps and must proceed exactly like m4: 0 — never
	// rejected, never treated as a negative count.
	const negZero = tuple({ m4: -0 });
	const rNegZero = tryCall(() => decideFeasibility(negZero));
	const rNegZero2 = tryCall(() => decideFeasibility(negZero));
	const negZeroOk = Object.is(negZero.m4, -0) && rNegZero.threw === null &&
		rNegZero.value.verdict === "GO" && rNegZero.value.mode === "contact-head" &&
		deepEq(rNegZero.value, decideFeasibility(tuple({ m4: 0 }))) && deepEq(rNegZero.value, rNegZero2.value);
	reg.record({
		id: "DEC-m4-negzero", category: "decision", attack: "m4 = -0 at the integrality boundary",
		input: "m4 = -0 (Object.is true), everything else GO-worthy",
		expected: "-0 is an integer and equals 0: well-formed -> GO contact-head, byte-identical to the m4: 0 result, deterministic",
		observed: rNegZero.threw ? rNegZero.threw.message : describe(rNegZero.value),
		verdict: negZeroOk ? "PASS" : "WEAKNESS",
	});
	// 1e21: integral (Number.isInteger(1e21) === true) and non-negative, so it
	// is a contract-legal (absurd) count; Step 0 must fire -> STOP:identity.
	const rHuge = tryCall(() => decideFeasibility(tuple({ m4: 1e21 })));
	const rHuge2 = tryCall(() => decideFeasibility(tuple({ m4: 1e21 })));
	const hugeOk = Number.isInteger(1e21) && rHuge.threw === null &&
		rHuge.value.verdict === "STOP" && rHuge.value.reason === "identity" && deepEq(rHuge.value, rHuge2.value);
	reg.record({
		id: "DEC-m4-1e21", category: "decision", attack: "m4 = 1e21 (integral but absurd)",
		input: "m4 = 1e21",
		expected: "1e21 IS an integer-valued double and non-negative: contract-legal count -> STOP:identity (any positive count stops), deterministic; the integrality rule must not reject it for magnitude",
		observed: rHuge.threw ? rHuge.threw.message : describe(rHuge.value),
		verdict: hugeOk ? "PASS" : "WEAKNESS",
	});
	// MAX_SAFE_INTEGER + 1: exactly representable, integer, positive.
	const rMax = tryCall(() => decideFeasibility(tuple({ m4: Number.MAX_SAFE_INTEGER + 1 })));
	const maxOk = Number.isInteger(Number.MAX_SAFE_INTEGER + 1) && rMax.threw === null &&
		rMax.value.verdict === "STOP" && rMax.value.reason === "identity";
	reg.record({
		id: "DEC-m4-maxsafe-plus1", category: "decision", attack: "m4 = Number.MAX_SAFE_INTEGER + 1",
		input: "m4 = 9007199254740992",
		expected: "an integer double beyond the safe-integer range: the integrality check (Number.isInteger) is value-based, so it must accept and Step 0 must fire -> STOP:identity; no crash, no coercion",
		observed: rMax.threw ? rMax.threw.message : describe(rMax.value),
		verdict: maxOk ? "PASS" : "WEAKNESS",
	});
	// MAX_SAFE_INTEGER + 0.5: NOT representable — the literal rounds to
	// 9007199254740992 (an integer double) before the function ever sees it.
	// IEEE754 fact, recorded, not a violation: the value the rule observes IS
	// an integer.
	const rRound = tryCall(() => decideFeasibility(tuple({ m4: Number.MAX_SAFE_INTEGER + 0.5 })));
	const stored = Number.MAX_SAFE_INTEGER + 0.5;
	reg.record({
		id: "DEC-m4-ulp-rounds", category: "decision", attack: "m4 = MAX_SAFE_INTEGER + 0.5 (a fractional literal that rounds in IEEE754)",
		input: "m4 = Number.MAX_SAFE_INTEGER + 0.5",
		expected: "no contract obligation: the literal is not representable; the stored double is 9007199254740992 (integer), so Number.isInteger sees an integer and Step 0 fires -> STOP:identity, deterministically. Recorded so a future 'reject unsafe integers' rule has this fact pinned.",
		observed: `stored double = ${stored}; Number.isInteger(${stored}) = ${Number.isInteger(stored)}; ` +
			(rRound.threw ? `rejected: ${rRound.threw.message}` : describe(rRound.value)),
		verdict: "INFO",
	});
	// "0": a numeric STRING that would coerce to the passing count. The
	// dangerous direction — coercing "0" would read as 'no swaps' and clear
	// the Step-0 identity gate on unknown identity.
	const rStr0 = tryCall(() => decideFeasibility(tuple({ m4: "0" })));
	const str0Ok = rStr0.threw instanceof Error && /DECISION-INPUT/.test(rStr0.threw.message) && rStr0.threw.message.includes("m4");
	reg.record({
		id: "DEC-m4-string-zero", category: "decision", attack: "m4 = \"0\" (numeric string)",
		input: 'm4: "0"',
		expected: 'a string is not a number -> named DECISION-INPUT rejection naming m4; "0" must never coerce into the passing count',
		observed: rStr0.threw ? rStr0.threw.message : `no throw -> ${describe(rStr0.value)}`,
		verdict: str0Ok ? "PASS" : "WEAKNESS",
	});
	// 1 + 1 ulp: a fraction one ulp above an integer. Number.isInteger must
	// reject it even though it is 1e-16 away from a legal count.
	const rEps = tryCall(() => decideFeasibility(tuple({ m4: 1.0000000000000002 })));
	const epsOk = rEps.threw instanceof Error && /DECISION-INPUT/.test(rEps.threw.message) && rEps.threw.message.includes("m4") && /whole number/.test(rEps.threw.message);
	reg.record({
		id: "DEC-m4-epsilon-adjacent", category: "decision", attack: "m4 = 1 + 1 ulp (0.0000000000000002 above a legal count)",
		input: "m4 = 1.0000000000000002",
		expected: "a count cannot be 1+ε -> named DECISION-INPUT rejection naming m4 and 'whole number'; the epsilon must not read as 'just above zero swaps'",
		observed: rEps.threw ? rEps.threw.message : `no throw -> ${describe(rEps.value)}`,
		verdict: epsOk ? "PASS" : "WEAKNESS",
	});
}

// ---------------------------------------------------------------------------
// Property sweeps: totality + determinism + oracle agreement on well-formed
// Property sweeps: totality + determinism + oracle agreement on well-formed
// tuples; fail-closed named rejection on malformed tuples. The two halves are
// kept separate by a contract classifier (written from the §10.3 input
// contract text, NOT from the implementation) that decides each tuple's half.
// ---------------------------------------------------------------------------
{
	const rand = lcg(0xC0FFEE);
	const pick = (arr) => arr[Math.floor(rand() * arr.length)];

	// ---- well-formed sweep: every metric is present, finite and in range;
	// every mode entry is a plain object with finite in-range m3/m5/m6, so
	// every tuple must reach a branch (Step 4 is the unconditional else),
	// deterministically, matching the oracle.
	const wellFormed = [];
	for (let i = 0; i < 60000; i += 1) {
		const greens = [true, false];
		const mk = () => ({
			m3: pick([0, 0.01, 0.03, 0.04, 0.05, 0.08, 0.12, 0.2, 0.5]),
			m5: pick([0, 0.01, 0.05, 0.08, 0.12, 0.2, 0.5]),
			m6: pick([0, 0.01, 0.08, 0.12, 0.2, 0.5]),
			runnerGreen: pick(greens),
			measurementGreen: pick(greens),
		});
		wellFormed.push({
			m1: pick([0, 0.3, 0.59, 0.6, 0.8, 1]),
			m2: pick([0, 0.69, 0.84, 0.85, 0.9, 1]),
			m4: pick([-0, 0, 1, 2]),
			modes: { "contact-head": mk(), "lowest-foot": mk(), "manual-anchor": mk() },
		});
	}
	let totalOk = true;
	let detOk = true;
	let oracleOk = true;
	for (const input of wellFormed) {
		const r1 = tryCall(() => decideFeasibility(input));
		const r2 = tryCall(() => decideFeasibility(input));
		if (r1.threw) { totalOk = false; break; }
		const valid = (r1.value.verdict === "GO" || r1.value.verdict === "STOP") &&
			(r1.value.verdict === "STOP" ? r1.value.mode === null : MODES.includes(r1.value.mode));
		if (!valid) { totalOk = false; break; }
		if (!deepEq(r1.value, r2.value)) { detOk = false; break; }
		if (!deepEq(r1.value, oracle(input))) { oracleOk = false; break; }
	}
	ok("DEC-sweep-wellformed: 60k well-formed tuples total (reach a branch), deterministic, oracle-agree", totalOk && detOk && oracleOk,
		`total=${totalOk} det=${detOk} oracle=${oracleOk}`);
	reg.record({
		id: "DEC-sweep-wellformed", category: "decision", attack: "property sweep over 60k well-formed tuples",
		input: "random m1/m2 in [0,1] incl. thresholds, m4 in {-0..2}, per-mode m3/m5/m6 across all budgets, random green flags",
		expected: "every tuple reaches a branch; same input -> same output; result equals the §10.3 oracle (incl. green gate)",
		observed: `totality=${totalOk}, determinism=${detOk}, oracle-agreement=${oracleOk}`,
		verdict: totalOk && detOk && oracleOk ? "PASS" : "WEAKNESS",
	});

	// ---- malformed sweep: strings, NaN, ±Infinity, out-of-range numbers,
	// nulls, booleans, truthy greens, missing mode entries/fields, extra
	// keys. Each tuple is classified by the contract; malformed tuples must
	// reject with the named DECISION-INPUT error naming the first offending
	// metric, deterministically; a tuple the classifier finds well-formed
	// must still reach a branch.
	const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);
	const inRange = (v, min, max) => isFiniteNum(v) && v >= min && v <= max;
	const firstOffense = (m) => {
		if (m === null || typeof m !== "object" || Array.isArray(m)) return "metrics";
		if (!inRange(m.m1, 0, 1)) return "m1";
		if (!inRange(m.m2, 0, 1)) return "m2";
		if (!inRange(m.m4, 0, Number.POSITIVE_INFINITY)) return "m4";
		// pass-3: the m4 integrality rule is part of the contract now — a
		// fractional m4 (0.6, 2.5) is an offense of m4 itself, not of a later
		// mode metric; without this the classifier named "m3" for a tuple
		// with fractional m4 + NaN m3 while the implementation rejected
		// naming "m4", and the sweep read as WEAKNESS forever
		if (!Number.isInteger(m.m4)) return "m4";
		if (m.modes === null || typeof m.modes !== "object" || Array.isArray(m.modes)) return "modes";
		for (const key of MODES) {
			const mode = m.modes[key];
			if (mode === undefined) continue; // absent entry: that mode did not run
			if (mode === null || typeof mode !== "object" || Array.isArray(mode)) return `modes.${key}`;
			if (!inRange(mode.m3, 0, Number.POSITIVE_INFINITY)) return "m3";
			if (!inRange(mode.m5, 0, Number.POSITIVE_INFINITY)) return "m5";
			if (!inRange(mode.m6, 0, Number.POSITIVE_INFINITY)) return "m6";
		}
		return null; // well-formed
	};

	const typePool = [NaN, Infinity, -Infinity, -0, 0, 0.6, 0.85, 0.03, 0.05, 0.08, "", "0.01", "abc", null, true, false, -0.01, -1];
	const greenPool = [true, false, 1, 0, "true", undefined];
	const malformed = [];
	for (let i = 0; i < 20000; i += 1) {
		const mk = () => {
			const m = { runnerGreen: pick(greenPool), measurementGreen: pick(greenPool) };
			if (rand() < 0.3) m.m3 = pick(typePool);
			if (rand() < 0.3) m.m5 = pick(typePool);
			if (rand() < 0.3) m.m6 = pick(typePool);
			return m;
		};
		const modes = { "contact-head": mk(), "lowest-foot": mk(), "manual-anchor": mk() };
		if (rand() < 0.1) delete modes["lowest-foot"];
		if (rand() < 0.1) modes["extra-mode"] = mk();
		const input = { m1: pick(typePool), m2: pick(typePool), m4: pick(typePool), modes };
		if (rand() < 0.1) input.extra = 1;
		if (rand() < 0.1) delete input.m1;
		malformed.push(input);
	}
	let rejOk = true;   // malformed tuples reject, named, naming the offense
	let rejDet = true;  // rejection is deterministic (same input -> same message)
	let wfTotal = true; // accidentally well-formed tuples still reach a branch
	let wfDet = true;
	let wfOracle = true;
	let rejected = 0;
	let wellFormedHit = 0;
	for (const input of malformed) {
		const offense = firstOffense(input);
		const r1 = tryCall(() => decideFeasibility(input));
		const r2 = tryCall(() => decideFeasibility(input));
		if (offense === null) {
			wellFormedHit += 1;
			if (r1.threw || !(r1.value.verdict === "GO" || r1.value.verdict === "STOP")) { wfTotal = false; break; }
			if (!deepEq(r1.value, r2.value)) { wfDet = false; break; }
			if (!deepEq(r1.value, oracle(input))) { wfOracle = false; break; }
			continue;
		}
		rejected += 1;
		const named = r1.threw instanceof Error && /DECISION-INPUT/.test(r1.threw.message) && r1.threw.message.includes(offense);
		if (!named) { rejOk = false; break; }
		if (!(r2.threw instanceof Error) || r2.threw.message !== r1.threw.message) { rejDet = false; break; }
	}
	ok("DEC-sweep-malformed: 20k type-malformed tuples fail closed (named DECISION-INPUT naming the offense), reject deterministically; accidental well-formed tuples still total",
		rejOk && rejDet && wfTotal && wfDet && wfOracle,
		`reject=${rejOk} det=${rejDet} wf-total=${wfTotal} wf-det=${wfDet} wf-oracle=${wfOracle} (${rejected} rejected, ${wellFormedHit} well-formed)`);
	reg.record({
		id: "DEC-sweep-malformed", category: "decision", attack: "property sweep over 20k type-malformed tuples",
		input: "strings, NaN, ±Infinity, -1/-0.01, null, booleans, truthy greens, missing mode entries/fields, extra keys",
		expected: "malformed tuples reject with the named DECISION-INPUT error naming the first offending metric, deterministically; accidentally well-formed tuples still reach a branch",
		observed: `reject=${rejOk}, determinism=${rejDet}, well-formed-total=${wfTotal}, well-formed-det=${wfDet}, well-formed-oracle=${wfOracle} (${rejected} rejected / ${wellFormedHit} well-formed)`,
		verdict: rejOk && rejDet && wfTotal && wfDet && wfOracle ? "PASS" : "WEAKNESS",
	});
}

export const run = async () => {
	console.log("== rt-decision: decision function attacks ==");
	// the sweep ok() lines above already ran at import; nothing further needed
	return { cases: reg.cases, findings: reg.findings };
};

const isMain = process.argv[1] && process.argv[1].endsWith("rt-decision.mjs");
if (isMain) {
	await run();
	console.log(`\nrt-decision: ${reg.cases.length} cases, ${reg.findings.length} findings`);
}
