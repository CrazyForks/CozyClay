/**
 * C2: the §10.4 closed footage policy (plan §13 commit C2).
 *
 * Why this test exists: the footage policy is the gate that decides whether
 * any footage may enter the pipeline at all, and §10.4 enumerates its
 * verdicts: cuts, zoom, pan/handheld and uncorrected VFR are NO-GO (moving
 * cameras and cut-spanning footage are out of v1, plan §16), subject height
 * < 0.30 frame, person count != 2 and take < 2 s are no-go, interlace/
 * telecine and a clinch IoU peak > 0.5 are warn. The plan's canonical RED is
 * "zoom must be no-go: got warn" — a policy that warns on zoom lets the
 * state machine leave preflight with footage the pipeline cannot solve.
 *
 * The policy is CLOSED in two senses, and both are asserted: an unknown
 * signal key cannot fall through to "acceptable" (a new detector the policy
 * does not know must not be silently ignored), and a missing signal cannot
 * read as clean (a measurement that never ran must not look like "no
 * problem"). Every verdict class — no-go, warn, go — gets a negative
 * control: each no-go code has a witness input that must produce no-go, each
 * warn code one that must produce warn and never no-go, and the clean input
 * must produce go.
 *
 * What would be circular or wrong to assert: re-implementing the threshold
 * logic in the test (that asserts code against code); skipping the boundary
 * values (0.30/2s/0.5 are inclusive-side checks — a flipped < vs <= is
 * invisible at mid-range values); or asserting closedness by inspection
 * instead of by feeding unknown/missing/NaN signals and demanding a named
 * rejection. NaN is the insidious case: NaN > 0.5 is false, so a policy
 * that forgets to validate its numbers quietly ACCEPTS a corrupt signal.
 */
import {
	evaluateFootage,
	preflightGate,
	NO_GO_REASONS,
	WARN_REASONS,
	SUBJECT_MIN_FRACTION,
	TAKE_MIN_DURATION_S,
	CLINCH_IOU_WARN_PEAK,
} from "../../src/ingest/footage-policy.js";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

// Named rejection: the call must throw an Error whose message IS the code.
const throwsCode = (label, fn, code) => {
	let err = null;
	try {
		fn();
	} catch (e) {
		err = e;
	}
	ok(label, err !== null && err.message === code, err === null ? "no error thrown" : `got ${err.message}`);
	return err;
};

// Every signal measured and clean: the only input that may read "go".
const clean = {
	cutsDetected: false,
	zoomDetected: false,
	panHandheld: false,
	vfrUncorrected: false,
	interlaceTelecine: false,
	subjectHeightFraction: 0.5,
	personCount: 2,
	durationS: 10,
	clinchIoUPeak: 0.2,
};
const withSignals = (over) => ({ ...clean, ...over });

// ---------------------------------------------------------------------------
// 1. The plan's RED: zoom must be no-go
// ---------------------------------------------------------------------------
// "zoom must be no-go: got warn" — the naive defect is a policy that warns
// on zoom, which lets the state machine leave preflight with footage whose
// intrinsics change frame to frame. Zoom is a no-go, full stop.
let zoomReport;
try {
	zoomReport = evaluateFootage(withSignals({ zoomDetected: true }));
} catch (e) {
	zoomReport = { verdict: `threw ${e.message}` };
}
ok("zoom must be no-go", zoomReport.verdict === "no-go", `got ${zoomReport.verdict}`);

// ---------------------------------------------------------------------------
// 2. No-go class: one witness per code, each must be no-go
// ---------------------------------------------------------------------------
// §10.4 lists seven no-go signals. Each witness flips exactly one signal on
// the clean input; a policy that downgrades any of them to warn or go
// fails its witness here. Every code in the closed enum must be reachable —
// an enum member no input can produce is a dead contract.
const noGoWitnesses = [
	["cut-detected", { cutsDetected: true }],
	["zoom-detected", { zoomDetected: true }],
	["pan-handheld", { panHandheld: true }],
	["uncorrected-vfr", { vfrUncorrected: true }],
	["subject-too-small", { subjectHeightFraction: SUBJECT_MIN_FRACTION - 1e-9 }],
	["person-count-mismatch", { personCount: 3 }],
	["take-too-short", { durationS: TAKE_MIN_DURATION_S - 1e-9 }],
];
for (const [code, over] of noGoWitnesses) {
	const report = evaluateFootage(withSignals(over));
	ok(`no-go witness: ${code}`, report.verdict === "no-go" && report.reasons.includes(code), `verdict ${report.verdict}, reasons [${report.reasons}]`);
}
// A report carries ALL findings, not just the first: three simultaneous
// no-go signals must produce three codes.
const multi = evaluateFootage(withSignals({ cutsDetected: true, zoomDetected: true, personCount: 1 }));
ok(
	"multiple no-go signals all reported",
	multi.verdict === "no-go" && ["cut-detected", "zoom-detected", "person-count-mismatch"].every((c) => multi.reasons.includes(c)),
	`verdict ${multi.verdict}, reasons [${multi.reasons}]`
);

// ---------------------------------------------------------------------------
// 3. Warn class: warn is warn, never no-go, never go
// ---------------------------------------------------------------------------
// Interlace/telecine warns and requires the research-13 §3 chain plus
// re-preflight; a clinch IoU peak above 0.5 warns. Both are recoverable —
// the operator can act — so they must NOT read as no-go either.
const interlace = evaluateFootage(withSignals({ interlaceTelecine: true }));
ok(
	"interlace/telecine is warn, not no-go",
	interlace.verdict === "warn" && interlace.reasons.includes("interlace-telecine"),
	`verdict ${interlace.verdict}, reasons [${interlace.reasons}]`
);
const clinch = evaluateFootage(withSignals({ clinchIoUPeak: CLINCH_IOU_WARN_PEAK + 1e-9 }));
ok(
	"clinch IoU peak > 0.5 is warn, not no-go",
	clinch.verdict === "warn" && clinch.reasons.includes("clinch-iou-high"),
	`verdict ${clinch.verdict}, reasons [${clinch.reasons}]`
);
const bothWarn = evaluateFootage(withSignals({ interlaceTelecine: true, clinchIoUPeak: 0.9 }));
ok(
	"both warn codes reported together",
	bothWarn.verdict === "warn" && bothWarn.reasons.length === 2 && WARN_REASONS.every((c) => bothWarn.reasons.includes(c)),
	`verdict ${bothWarn.verdict}, reasons [${bothWarn.reasons}]`
);
for (const code of WARN_REASONS) {
	ok(`warn enum member ${code} is reachable`, [interlace, clinch, bothWarn].some((r) => r.reasons.includes(code)), "");
}

// ---------------------------------------------------------------------------
// 4. Go class: only the fully clean input reads "go"
// ---------------------------------------------------------------------------
const goReport = evaluateFootage(clean);
ok("clean signals are go", goReport.verdict === "go" && goReport.reasons.length === 0, `verdict ${goReport.verdict}, reasons [${goReport.reasons}]`);

// ---------------------------------------------------------------------------
// 5. Closedness: unknown, missing, or corrupt signals cannot fall through
// ---------------------------------------------------------------------------
// The closedness contract has two directions, both asserted. An unknown
// signal key is rejected by name — a detector the policy does not know must
// not be silently ignored, because ignoring it is how footage the policy
// never saw reaches "acceptable". A MISSING signal is rejected too: a
// measurement that never ran must not read as clean (the fail-closed
// direction — absence is not evidence).
throwsCode("an unknown signal key is rejected", () => evaluateFootage(withSignals({ slowMoDetected: true })), "policy-unknown-signal");
throwsCode("a missing signal is rejected", () => evaluateFootage({ ...withSignals({}), cutsDetected: undefined }), "policy-missing-signal");
throwsCode("a non-object signal set is rejected", () => evaluateFootage(null), "policy-not-object");
// NaN is the insidious corruption: every comparison against it is false, so
// an unvalidated NaN signal would read as "no problem" and the footage would
// fall through to acceptable. Each numeric signal must be validated.
throwsCode("NaN subjectHeightFraction is rejected", () => evaluateFootage(withSignals({ subjectHeightFraction: NaN })), "policy-invalid-signal");
throwsCode("NaN clinchIoUPeak is rejected", () => evaluateFootage(withSignals({ clinchIoUPeak: NaN })), "policy-invalid-signal");
throwsCode("a negative subjectHeightFraction is rejected", () => evaluateFootage(withSignals({ subjectHeightFraction: -0.1 })), "policy-invalid-signal");
throwsCode("a string-typed personCount is rejected", () => evaluateFootage(withSignals({ personCount: "2" })), "policy-invalid-signal");
throwsCode("a fractional personCount is rejected", () => evaluateFootage(withSignals({ personCount: 2.5 })), "policy-invalid-signal");
throwsCode("a non-boolean cut flag is rejected", () => evaluateFootage(withSignals({ cutsDetected: 1 })), "policy-invalid-signal");

// ---------------------------------------------------------------------------
// 6. Boundary semantics: the inclusive side passes, the exclusive side fails
// ---------------------------------------------------------------------------
// §10.4's thresholds: subject height < 0.30 is no-go (0.30 exactly is not),
// take < 2 s is no-go (2 s exactly is not), clinch IoU peak > 0.5 warns
// (0.5 exactly does not). A flipped < vs <= is invisible at mid-range
// values, so each boundary is probed from both sides.
ok(
	"subjectHeightFraction 0.30 exactly is not no-go",
	evaluateFootage(withSignals({ subjectHeightFraction: SUBJECT_MIN_FRACTION })).verdict === "go",
	`verdict ${evaluateFootage(withSignals({ subjectHeightFraction: SUBJECT_MIN_FRACTION })).verdict}`
);
ok(
	"subjectHeightFraction just below 0.30 is no-go",
	evaluateFootage(withSignals({ subjectHeightFraction: SUBJECT_MIN_FRACTION - 1e-9 })).verdict === "no-go",
	`verdict ${evaluateFootage(withSignals({ subjectHeightFraction: SUBJECT_MIN_FRACTION - 1e-9 })).verdict}`
);
ok(
	"durationS 2 exactly is not no-go",
	evaluateFootage(withSignals({ durationS: TAKE_MIN_DURATION_S })).verdict === "go",
	`verdict ${evaluateFootage(withSignals({ durationS: TAKE_MIN_DURATION_S })).verdict}`
);
ok(
	"durationS just below 2 is no-go",
	evaluateFootage(withSignals({ durationS: TAKE_MIN_DURATION_S - 1e-9 })).verdict === "no-go",
	`verdict ${evaluateFootage(withSignals({ durationS: TAKE_MIN_DURATION_S - 1e-9 })).verdict}`
);
ok(
	"clinchIoUPeak 0.5 exactly is not warn",
	evaluateFootage(withSignals({ clinchIoUPeak: CLINCH_IOU_WARN_PEAK })).verdict === "go",
	`verdict ${evaluateFootage(withSignals({ clinchIoUPeak: CLINCH_IOU_WARN_PEAK })).verdict}`
);
ok(
	"clinchIoUPeak just above 0.5 is warn",
	evaluateFootage(withSignals({ clinchIoUPeak: CLINCH_IOU_WARN_PEAK + 1e-9 })).verdict === "warn",
	`verdict ${evaluateFootage(withSignals({ clinchIoUPeak: CLINCH_IOU_WARN_PEAK + 1e-9 })).verdict}`
);

// ---------------------------------------------------------------------------
// 7. The preflight gate: cannot leave preflight unless verdict === "go"
// ---------------------------------------------------------------------------
// §10.4: the state machine cannot leave preflight unless verdict === "go",
// and every warn code must appear in acknowledgedWarnings[] or the job is
// 422. So a no-go report is never allowed — even with every conceivable
// acknowledgement, because an ack cannot repair a fatal flaw — and a warn
// report is allowed only with ALL its warn codes acknowledged. The gate
// reports which warnings are missing so the wiring can answer 422 with a
// named list instead of a bare refusal.
const goGate = preflightGate(goReport, []);
ok("go report leaves preflight without acknowledgements", goGate.allowed === true && goGate.missingWarnings.length === 0, JSON.stringify(goGate));
const noGoGate = preflightGate(zoomReport, [...WARN_REASONS]);
ok(
	"no-go report never leaves preflight, acks or not",
	noGoGate.allowed === false,
	`allowed ${noGoGate.allowed}`
);
const unackedGate = preflightGate(interlace, []);
ok(
	"warn report without acknowledgements is refused, naming the missing code",
	unackedGate.allowed === false && unackedGate.missingWarnings.length === 1 && unackedGate.missingWarnings[0] === "interlace-telecine",
	JSON.stringify(unackedGate)
);
const partialGate = preflightGate(bothWarn, ["interlace-telecine"]);
ok(
	"warn report with a partial acknowledgement is refused, naming the rest",
	partialGate.allowed === false && partialGate.missingWarnings.length === 1 && partialGate.missingWarnings[0] === "clinch-iou-high",
	JSON.stringify(partialGate)
);
const ackedGate = preflightGate(bothWarn, [...WARN_REASONS]);
// An ack satisfies the 422 clause but is NOT a re-preflight: §10.4's state
// machine still cannot leave preflight while verdict is warn — the
// research-13 §3 chain plus re-preflight is the only path, and it produces
// a NEW report.
ok("an acknowledged warn report still cannot leave preflight (re-preflight is the only path)", ackedGate.allowed === false && ackedGate.missingWarnings.length === 0, JSON.stringify(ackedGate));
// An acknowledgement of a code the report never raised is harmless: the 422
// rule is about MISSING warn codes, and an extra ack cannot make a no-go
// verdict leave preflight.
const extraAckGate = preflightGate(goReport, ["not-a-warn-code"]);
ok("extra acknowledgements are harmless", extraAckGate.allowed === true, JSON.stringify(extraAckGate));
throwsCode("non-array acknowledgements are rejected", () => preflightGate(goReport, "interlace-telecine"), "policy-acknowledgements");
throwsCode("a non-report is rejected", () => preflightGate(null, []), "policy-report");

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
