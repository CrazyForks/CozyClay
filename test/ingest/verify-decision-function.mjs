/**
 * Behavioural proof of the Phase-0 decision function contract (plan §10.3).
 *
 * Why this test exists: the decision function is the total gate that decides
 * whether any feasibility-dependent code may ship. The plan claims five
 * properties for it — totality (no tuple falls through), ordering/exclusivity
 * (first satisfied branch wins), branch reachability, exact boundary
 * semantics (>= vs >, <= vs <), and the green gate (a mode whose runner or
 * measurement did not report green can never be selected). Each of those is a
 * behavioural claim about reachable inputs, so each is exercised here with
 * boundary and mid-gap values — including the gaps reviewers found: M3 in
 * (0.03, 0.08], M6 in (0.08, 0.20], M2 < 0.70.
 *
 * What would be circular or wrong to assert: asserting totality by inspecting
 * the implementation (an if/else chain ending in else is total by
 * construction — the sweep proves it against the *contract*); asserting the
 * function equals a re-implementation of its own literals (that asserts code
 * against code); asserting exact threshold semantics with mid-range values
 * only (0.04 < 0.05 proves nothing about 0.05 <= 0.05); or skipping the green
 * gate because the metric branches look right. The negative counterpart of
 * every GO here is a STOP asserted on the same tuple with one value flipped
 * across its threshold.
 */
import { decideFeasibility } from "../../tools/ingest/decision.mjs";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

const MODES = ["contact-head", "lowest-foot", "manual-anchor"];
const E = 1e-9; // epsilon: far above float ulp of every threshold, far below any metric scale

// a mode whose m3/m5/m6 pass every GO branch; green by default
const pass = (over = {}) => ({ m3: 0.01, m5: 0.01, m6: 0.01, runnerGreen: true, measurementGreen: true, ...over });
// a mode whose m3/m5/m6 fail every GO branch
const failHard = (over = {}) => ({ m3: 0.5, m5: 0.5, m6: 0.5, runnerGreen: true, measurementGreen: true, ...over });

const tuple = (over = {}) => ({
	m1: 0.8,
	m2: 0.9,
	m4: 0,
	modes: { "contact-head": pass(), "lowest-foot": failHard(), "manual-anchor": failHard() },
	...over,
});

const isGo = (r) => r.verdict === "GO" && MODES.includes(r.mode) && r.reason === r.mode && r.mode !== null;
const isStop = (r, reason) =>
	r.verdict === "STOP" && r.mode === null && r.reason === reason && r.degraded === false &&
	r.display.spacingMayReadSoft === false;

// ---------------------------------------------------------------------------
// 1. The plan's RED: M3 = 0.04 sits in the gap (0.03, 0.05] where contact-head
//    fails but lowest-foot can still pass. The function must reach a branch.
// ---------------------------------------------------------------------------
{
	const r = decideFeasibility(tuple({
		modes: {
			"contact-head": pass({ m3: 0.04 }),            // m3 in the gap -> step 1 fails
			"lowest-foot": pass(),                          // step 2 must fire
			"manual-anchor": failHard(),
		},
	}));
	ok("M3=0.04 reaches a branch", r !== undefined && r !== null && (r.verdict === "GO" || r.verdict === "STOP"), JSON.stringify(r));
}

// ---------------------------------------------------------------------------
// 2. Every branch reachable: one witness tuple per outcome.
// ---------------------------------------------------------------------------
{
	const r = decideFeasibility(tuple({ m4: 1 }));
	ok("STOP:identity witness", isStop(r, "identity") && r.verdict === "STOP", JSON.stringify(r));

	const r2 = decideFeasibility(tuple());
	ok("GO contact-head witness", isGo(r2) && r2.mode === "contact-head" && r2.degraded === false &&
		r2.display.spacingMayReadSoft === false, JSON.stringify(r2));

	const r3 = decideFeasibility(tuple({
		modes: {
			"contact-head": pass({ m3: 0.2 }),             // step 1 fails
			"lowest-foot": pass(),                          // step 2 fires
			"manual-anchor": failHard(),
		},
	}));
	ok("GO lowest-foot witness (degraded)", isGo(r3) && r3.mode === "lowest-foot" && r3.degraded === true &&
		r3.display.spacingMayReadSoft === true, JSON.stringify(r3));

	const r4 = decideFeasibility(tuple({
		modes: {
			"contact-head": failHard(),
			"lowest-foot": pass({ m3: 0.2 }),              // step 2 fails
			"manual-anchor": pass(),                        // step 3 fires
		},
	}));
	ok("GO manual-anchor witness (degraded)", isGo(r4) && r4.mode === "manual-anchor" && r4.degraded === true &&
		r4.display.spacingMayReadSoft === true, JSON.stringify(r4));

	const r5 = decideFeasibility(tuple({
		modes: { "contact-head": failHard(), "lowest-foot": failHard(), "manual-anchor": failHard() },
	}));
	ok("STOP:accuracy witness", isStop(r5, "accuracy"), JSON.stringify(r5));
}

// ---------------------------------------------------------------------------
// 3. Ordering / mutual exclusivity: tuples satisfying several branch
//    predicates simultaneously must resolve to the FIRST branch, and the
//    result must be deterministic across repeated calls.
// ---------------------------------------------------------------------------
{
	// steps 1, 2 and 3 all satisfied -> step 1 wins
	const r = decideFeasibility(tuple({
		modes: {
			"contact-head": pass(),
			"lowest-foot": pass(),
			"manual-anchor": pass(),
		},
	}));
	ok("all three GO branches satisfied -> contact-head first", isGo(r) && r.mode === "contact-head", JSON.stringify(r));
	ok("deterministic under repeat", JSON.stringify(r) === JSON.stringify(decideFeasibility(tuple({
		modes: { "contact-head": pass(), "lowest-foot": pass(), "manual-anchor": pass() },
	}))));

	// steps 2 and 3 satisfied, step 1 not -> lowest-foot wins
	const r2 = decideFeasibility(tuple({
		modes: {
			"contact-head": pass({ m3: 0.04 }),            // fails step 1 only
			"lowest-foot": pass(),
			"manual-anchor": pass(),
		},
	}));
	ok("steps 2+3 satisfied -> lowest-foot second", isGo(r2) && r2.mode === "lowest-foot", JSON.stringify(r2));

	// step 1 metrics satisfied but contact-head not green, steps 2+3 satisfied -> lowest-foot
	const r3 = decideFeasibility(tuple({
		modes: {
			"contact-head": pass({ runnerGreen: false }),
			"lowest-foot": pass(),
			"manual-anchor": pass(),
		},
	}));
	ok("step 1 blocked by green gate -> lowest-foot", isGo(r3) && r3.mode === "lowest-foot", JSON.stringify(r3));

	// step 1 metrics satisfied, contact-head and lowest-foot not green, step 3 satisfied -> manual-anchor
	const r4 = decideFeasibility(tuple({
		modes: {
			"contact-head": pass({ runnerGreen: false }),
			"lowest-foot": pass({ measurementGreen: false }),
			"manual-anchor": pass(),
		},
	}));
	ok("steps 1+2 blocked by green gate -> manual-anchor", isGo(r4) && r4.mode === "manual-anchor", JSON.stringify(r4));

	// step 0 dominates everything: M4 > 0 while every GO branch is satisfied
	const r5 = decideFeasibility(tuple({
		m4: 1,
		modes: { "contact-head": pass(), "lowest-foot": pass(), "manual-anchor": pass() },
	}));
	ok("M4 > 0 dominates all GO branches", isStop(r5, "identity"), JSON.stringify(r5));
}

// ---------------------------------------------------------------------------
// 4. Totality: systematic sweep over boundary and mid-gap probe values for
//    every metric. For each mode in turn the other two modes are pinned at
//    failing values (the fewest branches can fire, the hardest case for
//    totality); every combination must still land on a branch. The same sweep
//    with every mode not green must land on STOP everywhere — nothing may GO
//    when no runner/measurement pair is green.
// ---------------------------------------------------------------------------
const probes = {
	m1: [0, 0.3, 0.6 - E, 0.6, 0.8, 1.0],
	m2: [0, 0.5, 0.69, 0.75, 0.85 - E, 0.85, 1.0], // includes the M2 < 0.70 gap
	m4: [0, 1],
	m3: [0, 0.03, 0.04, 0.05, 0.08, 0.2], // includes 0.04 and the M3 gap (0.03, 0.08]
	m5: [0, 0.05, 0.08, 0.12, 0.2],
	m6: [0, 0.08, 0.12, 0.2, 0.25], // includes the M6 gap (0.08, 0.20]
};

let swept = 0;
// The summaries below are bound to the sweep's OBSERVED state — n tuples
// swept, reached tuples that landed on a branch, stops tuples that landed on
// STOP — so a sweep that falls through or bails out early FAILS its summary
// instead of passing a literal true (the A5 tautology).
const sweep = (green) => {
	let n = 0;
	let reached = 0;
	let stops = 0;
	const abort = (label, detail) => {
		ok(label, false, detail);
		return { n, reached, stops };
	};
	for (const sweptMode of MODES) {
		const others = Object.fromEntries(MODES.filter((m) => m !== sweptMode).map((m) => [m, failHard()]));
		for (const m1 of probes.m1)
			for (const m2 of probes.m2)
				for (const m4 of probes.m4)
					for (const m3 of probes.m3)
						for (const m5 of probes.m5)
							for (const m6 of probes.m6) {
								const r = decideFeasibility({
									m1, m2, m4,
									modes: {
										...others,
										[sweptMode]: green ? pass({ m3, m5, m6 }) : pass({ m3, m5, m6, runnerGreen: false, measurementGreen: false }),
									},
								});
								n += 1;
								swept += 1;
								if (r === undefined || r === null || (r.verdict !== "GO" && r.verdict !== "STOP") ||
									typeof r.reason !== "string" || typeof r.degraded !== "boolean") {
									return abort(`totality: ${JSON.stringify({ m1, m2, m4, [sweptMode]: { m3, m5, m6 } })} fell through`, JSON.stringify(r));
								}
								if (r.verdict === "GO" && (r.mode === null || !MODES.includes(r.mode))) {
									return abort("GO carries a real mode", JSON.stringify(r));
								}
								if (r.verdict === "STOP" && r.mode !== null) {
									return abort("STOP carries no mode", JSON.stringify(r));
								}
								// M4 > 0 is step 0: identity beats every branch in either sweep
								if (m4 > 0 && (r.verdict !== "STOP" || r.reason !== "identity")) {
									return abort("M4 > 0 always yields STOP:identity", JSON.stringify({ m4, r }));
								}
								// green=false sweep: no GO may fire anywhere, ever
								if (!green && r.verdict === "GO") {
									return abort("no GO with no green mode", JSON.stringify({ m1, m2, m4, m3, m5, m6, r }));
								}
								if (!green && (r.reason === "identity") !== (m4 > 0)) {
									return abort("green=false STOP reason follows M4", JSON.stringify({ m4, r }));
								}
								reached += 1;
								if (r.verdict === "STOP") stops += 1;
							}
	}
	return { n, reached, stops };
};
const greenSweep = sweep(true);
ok("totality sweep (all green): every tuple lands on a branch", greenSweep.reached === greenSweep.n, `${greenSweep.reached}/${greenSweep.n} tuples reached a branch`);
const noGreenSweep = sweep(false);
ok("totality sweep (no green): every tuple lands on STOP, none GO", noGreenSweep.stops === noGreenSweep.n, `${noGreenSweep.stops}/${noGreenSweep.n} tuples landed on STOP`);
{
	const r = decideFeasibility(tuple({ m4: 1, modes: { "contact-head": pass(), "lowest-foot": pass(), "manual-anchor": pass() } }));
	ok("sweep count is exhaustive of the probe lattice", swept === 75600, `swept=${swept}`);
	ok("sweep determinism spot check", JSON.stringify(r) === JSON.stringify(decideFeasibility(tuple({ m4: 1, modes: { "contact-head": pass(), "lowest-foot": pass(), "manual-anchor": pass() } }))));
}

// ---------------------------------------------------------------------------
// 5. Boundary semantics: at every threshold, the inclusive side passes and the
//    exclusive side fails, with the same tuple otherwise. The non-swept modes
//    are pinned failing so a flipped value cannot be rescued by a lower branch.
// ---------------------------------------------------------------------------
{
	// M4 > 0: identity at the first count above zero, never at zero. The epsilon
	// used for the continuous metrics is wrong here -- m4 is a count of label
	// transitions, so its domain is the non-negative integers and the smallest
	// value above the threshold is 1, not 1e-9.
	const r0 = decideFeasibility(tuple({ m4: 0 }));
	ok("M4 boundary: 0 is not identity", isGo(r0) && r0.mode === "contact-head", JSON.stringify(r0));
	const r1 = decideFeasibility(tuple({ m4: 1 }));
	ok("M4 boundary: > 0 is identity", isStop(r1, "identity"), JSON.stringify(r1));

	// A fractional count is not a near-miss, it is a metric the caller never
	// computed; STOP:identity would record an impossible swap count as a real
	// finding.
	for (const bad of [E, 0.5, 2.5]) {
		let rejected = false;
		try {
			decideFeasibility(tuple({ m4: bad }));
		} catch (e) {
			rejected = /DECISION-INPUT/.test(e.message) && /m4/.test(e.message);
		}
		ok(`M4 domain: fractional count ${bad} is rejected, not silently STOPped`, rejected);
	}

	const base = () => tuple({ modes: { "contact-head": pass(), "lowest-foot": failHard(), "manual-anchor": failHard() } });

	// M1 and M2 live at the top level of the tuple, not on a mode: flipping
	// them on the mode would silently leave the tuple unchanged and prove
	// nothing (the first version of this loop did exactly that — the fail
	// side still went).
	for (const [name, field, t] of [["M1", "m1", 0.6], ["M2", "m2", 0.85]]) {
		const tup = base();
		tup[field] = t;
		const passSide = decideFeasibility(tup);
		ok(`${name} boundary: >= ${t} passes step 1`,
			isGo(passSide) && passSide.mode === "contact-head", JSON.stringify(passSide));
		const tup2 = base();
		tup2[field] = t - E;
		const failSide = decideFeasibility(tup2);
		ok(`${name} boundary: < ${t} fails step 1 and is not rescued`,
			isStop(failSide, "accuracy"), JSON.stringify(failSide));
	}

	// M3/M5/M6 live on the mode; the fail side flips above the threshold.
	for (const [name, field, t] of [["M3_ch", "m3", 0.03], ["M5_ch", "m5", 0.05], ["M6_ch", "m6", 0.08]]) {
		const tup = base();
		tup.modes["contact-head"] = pass({ ...tup.modes["contact-head"], [field]: t });
		const passSide = decideFeasibility(tup);
		ok(`${name} boundary: <= ${t} passes step 1`,
			isGo(passSide) && passSide.mode === "contact-head", JSON.stringify(passSide));
		const tup2 = base();
		tup2.modes["contact-head"] = pass({ ...tup2.modes["contact-head"], [field]: t + E });
		const failSide = decideFeasibility(tup2);
		ok(`${name} boundary: > ${t} fails step 1 and is not rescued`,
			isStop(failSide, "accuracy"), JSON.stringify(failSide));
	}

	const lfBase = () => tuple({ modes: { "contact-head": pass({ m3: 0.2 }), "lowest-foot": pass(), "manual-anchor": failHard() } });
	for (const [name, field, t] of [["M3_lf", "m3", 0.05], ["M5_lf", "m5", 0.08], ["M6_lf", "m6", 0.12]]) {
		const tup = lfBase();
		tup.modes["lowest-foot"] = pass({ ...tup.modes["lowest-foot"], [field]: t });
		const passSide = decideFeasibility(tup);
		ok(`${name} boundary: <= ${t} passes step 2`,
			isGo(passSide) && passSide.mode === "lowest-foot" && passSide.degraded === true, JSON.stringify(passSide));
		const tup2 = lfBase();
		tup2.modes["lowest-foot"] = pass({ ...tup2.modes["lowest-foot"], [field]: t + E });
		const failSide = decideFeasibility(tup2);
		ok(`${name} boundary: > ${t} fails step 2 and is not rescued`,
			isStop(failSide, "accuracy"), JSON.stringify(failSide));
	}

	const maBase = () => tuple({ modes: { "contact-head": failHard(), "lowest-foot": pass({ m3: 0.2 }), "manual-anchor": pass() } });
	for (const [name, field, t] of [["M3_ma", "m3", 0.05], ["M5_ma", "m5", 0.08], ["M6_ma", "m6", 0.12]]) {
		const tup = maBase();
		tup.modes["manual-anchor"] = pass({ ...tup.modes["manual-anchor"], [field]: t });
		const passSide = decideFeasibility(tup);
		ok(`${name} boundary: <= ${t} passes step 3`,
			isGo(passSide) && passSide.mode === "manual-anchor" && passSide.degraded === true, JSON.stringify(passSide));
		const tup2 = maBase();
		tup2.modes["manual-anchor"] = pass({ ...tup2.modes["manual-anchor"], [field]: t + E });
		const failSide = decideFeasibility(tup2);
		ok(`${name} boundary: > ${t} fails step 3 and is not rescued`,
			isStop(failSide, "accuracy"), JSON.stringify(failSide));
	}
}

// ---------------------------------------------------------------------------
// 6. The green gate: a tuple that would GO contact-head must NOT select it
//    when either the runner or the measurement path is not green. Missing
//    green flags fail closed.
// ---------------------------------------------------------------------------
{
	const wouldGo = () => tuple({ modes: { "contact-head": pass(), "lowest-foot": failHard(), "manual-anchor": failHard() } });

	// runner not green, measurement green
	const t1 = wouldGo();
	t1.modes["contact-head"] = pass({ runnerGreen: false });
	const r1b = decideFeasibility(t1);
	ok("green gate: runner not green blocks contact-head", r1b.verdict === "STOP" && r1b.reason === "accuracy" && r1b.mode === null, JSON.stringify(r1b));
	// measurement not green, runner green
	const t2 = wouldGo();
	t2.modes["contact-head"] = pass({ measurementGreen: false });
	const r2 = decideFeasibility(t2);
	ok("green gate: measurement not green blocks contact-head", r2.verdict === "STOP" && r2.reason === "accuracy" && r2.mode === null, JSON.stringify(r2));
	// green flags absent entirely -> fail closed
	const t3 = wouldGo();
	t3.modes["contact-head"] = { m3: 0.01, m5: 0.01, m6: 0.01 };
	const r3 = decideFeasibility(t3);
	ok("green gate: missing green flags fail closed", r3.verdict === "STOP" && r3.reason === "accuracy", JSON.stringify(r3));
	// blocked contact-head must not shadow a green lowest-foot
	const t4 = wouldGo();
	t4.modes["contact-head"] = pass({ runnerGreen: false });
	t4.modes["lowest-foot"] = pass();
	const r4 = decideFeasibility(t4);
	ok("green gate: blocked mode falls through to next green branch", isGo(r4) && r4.mode === "lowest-foot" && r4.degraded === true, JSON.stringify(r4));
	// the unblocked control actually goes
	const control = decideFeasibility(wouldGo());
	ok("green gate control: fully green tuple goes contact-head", isGo(control) && control.mode === "contact-head", JSON.stringify(control));
}

// ---------------------------------------------------------------------------
// 7. The input contract: totality is a property of WELL-FORMED tuples, and
//    malformed input must REJECT with the named DECISION-INPUT error before
//    any branch is reached — never a silent branch (a malformed tuple must
//    not be able to read as a verdict) and never a TypeError from a null
//    dereference. The defects this guards (red-team): modes:null crashed the
//    total gate; a missing m4 read as "no identity swaps" — the unsafe
//    direction, since Step 0 is the gate that stops the whole pipeline;
//    string-typed "0.8" coerced into passing thresholds. Rejecting, rather
//    than forcing STOP:identity for a bad m4, keeps a broken producer visible
//    instead of recording a legitimate Phase-0 outcome for it.
// ---------------------------------------------------------------------------
{
	const rejects = (label, input, why) => {
		let err = null;
		try {
			decideFeasibility(input);
		} catch (e) {
			err = e;
		}
		ok(label, err !== null && err instanceof Error && /DECISION-INPUT/.test(err.message),
			err === null ? `accepted: ${why}` : `threw ${err.name}: ${err.message}`);
	};
	const goodModes = () => ({ "contact-head": pass(), "lowest-foot": failHard(), "manual-anchor": failHard() });
	const chOnly = (ch) => ({ m1: 0.8, m2: 0.9, m4: 0, modes: { "contact-head": ch, "lowest-foot": failHard(), "manual-anchor": failHard() } });

	// Q1: the modes container itself must be a plain object.
	rejects("modes: null rejects with DECISION-INPUT", tuple({ modes: null }), "modes: null must not crash the total gate with a TypeError");
	rejects("absent modes container rejects", { m1: 0.8, m2: 0.9, m4: 0 }, "a tuple without modes must not be decided");
	rejects("modes as an array rejects", tuple({ modes: [] }), "modes must be a plain object, not an array");
	rejects("metrics itself null rejects", null, "decideFeasibility(null) must reject, not throw a TypeError");

	// Q2: the identity metric must be present and finite; unknown identity must
	// never read as clean.
	rejects("missing m4 rejects", { m1: 0.8, m2: 0.9, m4: undefined, modes: goodModes() }, "missing m4 must not default to 0 swaps");
	rejects("NaN m4 rejects", tuple({ m4: NaN }), "NaN m4 must not read as clean identity");
	rejects("Infinity m4 rejects", tuple({ m4: Infinity }), "a non-finite swap count is a contract violation");
	rejects("negative m4 rejects", tuple({ m4: -1 }), "a negative swap count is impossible input");

	// Q3: every metric that gates a GO branch must be a finite number, and
	// string-typed numbers must not coerce.
	rejects("string m1 rejects", tuple({ m1: "0.8" }), '"0.8" must not coerce into a passing coverage');
	rejects("string m2 rejects", tuple({ m2: "0.9" }), '"0.9" must not coerce into a passing precision');
	rejects("string m4 rejects", tuple({ m4: "0" }), '"0" must not read as zero swaps');
	rejects("string mode metric rejects", chOnly(pass({ m3: "0.01" })), '"0.01" must not coerce into the 0.03 budget');
	rejects("null mode metric rejects", chOnly(pass({ m5: null })), "null coerces to 0 and must not pass the 0.05 budget");
	rejects("boolean mode metric rejects", chOnly(pass({ m6: true })), "a boolean must not be accepted where a number is required");
	rejects("out-of-range m1 rejects", tuple({ m1: 1.5 }), "a coverage fraction above 1 is impossible input");
	rejects("negative jitter rejects", chOnly(pass({ m3: -0.01 })), "a std cannot be negative");

	// a PRESENT mode entry claims the mode was measured, so its m3/m5/m6 must
	// be present and finite; an ABSENT entry claims the opposite (the mode did
	// not run) and simply cannot be green — the fail-closed direction.
	rejects("incomplete mode entry rejects", chOnly({ runnerGreen: true, measurementGreen: true }), "an incomplete mode entry must not fall through as if unmeasured");
	rejects("null mode entry rejects", chOnly(null), "a null mode entry must not read as within budget");
	const absentMode = decideFeasibility(tuple({ modes: { "lowest-foot": failHard(), "manual-anchor": failHard() } }));
	ok("absent mode entry falls through, not rejected", absentMode.verdict === "STOP" && absentMode.reason === "accuracy", JSON.stringify(absentMode));
	const noGreenFlags = decideFeasibility(chOnly({ m3: 0.01, m5: 0.01, m6: 0.01 }));
	ok("missing green flags fail closed, not rejected", noGreenFlags.verdict === "STOP" && noGreenFlags.reason === "accuracy", JSON.stringify(noGreenFlags));
}

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
