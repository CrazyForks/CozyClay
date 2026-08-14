// The §10.4 closed footage policy (plan §13 commit C2).
//
// Why closed: the footage policy decides whether any footage enters the
// pipeline at all, so a gap in it is a gap in the gate. "Closed" here means
// two things, both enforced: the reason-code enum is the only vocabulary a
// report can speak, and the signal set is the only vocabulary a caller can
// speak. An unknown signal key is rejected BY NAME (a detector the policy
// does not know must not be silently ignored — ignoring it is how footage
// the policy never saw reaches "acceptable"), and a MISSING signal is
// rejected too: a measurement that never ran must not read as clean, the
// fail-closed direction. Every number is validated before any comparison,
// because NaN compares false against every threshold and an unvalidated NaN
// signal would fall through to "go".
//
// Verdicts (plan §10.4): cuts, zoom, pan/handheld, uncorrected VFR, subject
// height < 0.30 frame, person count != 2 and take < 2 s are no-go;
// interlace/telecine and clinch IoU peak > 0.5 warn (interlace/telecine
// additionally requires the research-13 §3 chain plus re-preflight — the
// operator's side of the acknowledgement). The state machine cannot leave
// preflight unless verdict === "go" AND every warn code is acknowledged;
// preflightGate returns the missing list so the wiring can answer 422 with
// a name instead of a bare refusal.

export const NO_GO_REASONS = Object.freeze([
	"cut-detected",
	"zoom-detected",
	"pan-handheld",
	"uncorrected-vfr",
	"subject-too-small",
	"person-count-mismatch",
	"take-too-short",
]);

export const WARN_REASONS = Object.freeze(["interlace-telecine", "clinch-iou-high"]);

// §10.4 thresholds: subject height < 0.30 frame and take < 2 s are no-go;
// clinch IoU peak > 0.5 warns.
export const SUBJECT_MIN_FRACTION = 0.3;
export const TAKE_MIN_DURATION_S = 2;
export const CLINCH_IOU_WARN_PEAK = 0.5;

// The signal vocabulary and its expected type. Iteration order IS the
// report's reason order, so a report is deterministic for a given input.
const SIGNAL_RULES = {
	cutsDetected: "boolean",
	zoomDetected: "boolean",
	panHandheld: "boolean",
	vfrUncorrected: "boolean",
	interlaceTelecine: "boolean",
	subjectHeightFraction: "number",
	personCount: "integer",
	durationS: "number",
	clinchIoUPeak: "number",
};

// [reason code, trigger] in enum order — no-go codes first, then warn codes,
// so the verdict derivation below is a pure function of the collected set.
const TRIGGERS = [
	["cut-detected", (s) => s.cutsDetected],
	["zoom-detected", (s) => s.zoomDetected],
	["pan-handheld", (s) => s.panHandheld],
	["uncorrected-vfr", (s) => s.vfrUncorrected],
	["subject-too-small", (s) => s.subjectHeightFraction < SUBJECT_MIN_FRACTION],
	["person-count-mismatch", (s) => s.personCount !== 2],
	["take-too-short", (s) => s.durationS < TAKE_MIN_DURATION_S],
	["interlace-telecine", (s) => s.interlaceTelecine],
	["clinch-iou-high", (s) => s.clinchIoUPeak > CLINCH_IOU_WARN_PEAK],
];

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

export function evaluateFootage(signals) {
	if (signals === null || typeof signals !== "object") throw new Error("policy-not-object");
	// Unknown keys first: a signal the policy does not know is the graver
	// error, because it means the policy was not consulted at all.
	for (const key of Object.keys(signals)) {
		if (SIGNAL_RULES[key] === undefined) throw new Error("policy-unknown-signal");
	}
	for (const key of Object.keys(SIGNAL_RULES)) {
		if (signals[key] === undefined) throw new Error("policy-missing-signal");
		const rule = SIGNAL_RULES[key];
		const v = signals[key];
		const okType =
			rule === "boolean"
				? typeof v === "boolean"
				: rule === "integer"
					? Number.isInteger(v) && v >= 0
					: isFiniteNumber(v) && v >= 0;
		if (!okType) throw new Error("policy-invalid-signal");
	}
	const reasons = TRIGGERS.filter(([, trigger]) => trigger(signals)).map(([code]) => code);
	const hasNoGo = reasons.some((code) => NO_GO_REASONS.includes(code));
	const hasWarn = reasons.some((code) => WARN_REASONS.includes(code));
	return { verdict: hasNoGo ? "no-go" : hasWarn ? "warn" : "go", reasons };
}

export function preflightGate(report, acknowledgedWarnings) {
	if (report === null || typeof report !== "object" || !Array.isArray(report.reasons)) throw new Error("policy-report");
	if (!Array.isArray(acknowledgedWarnings)) throw new Error("policy-acknowledgements");
	// The 422 rule (plan §10.4) is about MISSING warn codes: an extra
	// acknowledgement is harmless — it cannot make a no-go verdict leave
	// preflight, because the verdict gate runs first.
	const missingWarnings = WARN_REASONS.filter((code) => report.reasons.includes(code) && !acknowledgedWarnings.includes(code));
	return { allowed: report.verdict === "go" && missingWarnings.length === 0, missingWarnings };
}
