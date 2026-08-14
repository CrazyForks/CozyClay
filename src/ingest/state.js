// state.js - U1: the ingest surface state machine (plan §10.4, §13 U1).
//
// The flow is pick footage -> preflight -> select take -> calibrate ->
// extract -> review -> publish, and every arrow is a GUARDED transition:
// the machine consumes the §10.4 decision function (footage-policy.js) and
// the §9 calibration verdict and makes the bad transition IMPOSSIBLE
// instead of merely discouraged. A no-go footage report parks the machine
// in the terminal "no-go" state; a "block" calibration verdict parks it in
// "calibration-blocked" - neither has any outgoing transition, so extract
// and publish are unreachable from either by construction, and the
// verifier proves it exhaustively over the exported TRANSITIONS table
// rather than by example. A "warn" calibration verdict proceeds, with its
// reasons carried forward on the machine so the review UI can show what to
// look for (§9). §10.4: the machine cannot leave preflight unless the
// report's verdict is "go" - an acknowledged warn is still parked, because
// re-preflight (a NEW report) is the only path.
//
// dispatch is total: an unknown event, a known event from the wrong state,
// or a guard refusal returns {ok:false, reason} and never throws, so the
// surface can route refusals to the UI instead of crashing. Publish is the
// child-side §5 door: the stored take must pass validateTakePayload
// (contracts.js, the child mirror of the parent's door) or publish is
// refused by the door's own code.
//
// SURFACE_STAGE is the pre-U2 placeholder entry shim (main.jsx renders
// it); the machine's initial state is the honest value.

import { preflightGate } from "./footage-policy.js";
import { validateTakePayload } from "./contracts.js";

export const SURFACE_STAGE = "idle";

export const STATE = Object.freeze({
	IDLE: "idle",
	PREFLIGHT: "preflight",
	NO_GO: "no-go",
	SELECT_TAKE: "select-take",
	CALIBRATE: "calibrate",
	CALIBRATION_BLOCKED: "calibration-blocked",
	EXTRACT: "extract",
	REVIEW: "review",
	PUBLISHED: "published",
});

export const STATES = Object.freeze(Object.values(STATE));

export const EVENTS = Object.freeze([
	"pick-footage",
	"preflight-report",
	"take-selected",
	"calibration-verdict",
	"extraction-complete",
	"publish",
]);

// The transition table is the machine: the verifier computes reachability
// from it exhaustively instead of by example, so a new row that opens a
// path from a dead-end state fails the gate without a new test.
export const TRANSITIONS = Object.freeze([
	{ event: "pick-footage", from: STATE.IDLE, to: STATE.PREFLIGHT, guard: "footage-required" },
	{ event: "preflight-report", from: STATE.PREFLIGHT, to: STATE.SELECT_TAKE, guard: "preflight-gate" },
	{ event: "preflight-report", from: STATE.PREFLIGHT, to: STATE.NO_GO, guard: "verdict-no-go" },
	{ event: "take-selected", from: STATE.SELECT_TAKE, to: STATE.CALIBRATE, guard: "take-not-selected" },
	{ event: "calibration-verdict", from: STATE.CALIBRATE, to: STATE.EXTRACT, guard: "calibration-ok-or-warn" },
	{ event: "calibration-verdict", from: STATE.CALIBRATE, to: STATE.CALIBRATION_BLOCKED, guard: "calibration-blocked" },
	{ event: "extraction-complete", from: STATE.EXTRACT, to: STATE.REVIEW, guard: "take-not-extracted" },
	{ event: "publish", from: STATE.REVIEW, to: STATE.PUBLISHED, guard: "publish-door" },
]);

export function createIngestMachine() {
	let current = STATE.IDLE;
	let footage = null;
	let footageReport = null;
	let acknowledgedWarnings = [];
	let selection = null;
	let calibrationWarnings = [];
	let take = null;

	const dispatch = (event, payload) => {
		const from = current;
		const refuse = (reason) => ({ ok: false, from, to: current, reason });
		const advance = (next) => {
			current = next;
			return { ok: true, from, to: next };
		};
		if (typeof event !== "string" || !EVENTS.includes(event)) return refuse("unknown-event");
		switch (current) {
			case STATE.IDLE:
				if (event === "pick-footage") {
					if (payload === null || typeof payload !== "object") return refuse("footage-required");
					footage = payload;
					return advance(STATE.PREFLIGHT);
				}
				return refuse("invalid-transition");
			case STATE.PREFLIGHT:
				if (event === "preflight-report") {
					// The machine consumes the §10.4 decision function: the
					// report shape is validated here, then the verdict
					// classes are handled in order - no-go parks the
					// machine in a dead end, warn cannot leave preflight
					// (re-preflight is the only path, §10.4), and only a
					// "go" report the preflightGate allows leaves.
					const { report, acknowledgedWarnings: acks = [] } = payload ?? {};
					const wellFormed =
						report !== null &&
						typeof report === "object" &&
						["go", "warn", "no-go"].includes(report.verdict) &&
						Array.isArray(report.reasons) &&
						Array.isArray(acks);
					if (!wellFormed) return refuse("report-invalid");
					footageReport = report;
					acknowledgedWarnings = acks;
					if (report.verdict === "no-go") {
						current = STATE.NO_GO;
						return { ok: false, from, to: current, reason: "verdict-no-go" };
					}
					if (report.verdict === "warn") return refuse("verdict-warn");
					if (!preflightGate(report, acks).allowed) return refuse("warnings-unacknowledged");
					return advance(STATE.SELECT_TAKE);
				}
				return refuse("invalid-transition");
			case STATE.SELECT_TAKE:
				if (event === "take-selected") {
					if (payload === null || typeof payload !== "object" || typeof payload.takeId !== "string" || payload.takeId.length === 0) {
						return refuse("take-not-selected");
					}
					selection = payload;
					return advance(STATE.CALIBRATE);
				}
				return refuse("invalid-transition");
			case STATE.CALIBRATE:
				if (event === "calibration-verdict") {
					// The §9 verdict shape: {level: ok|warn|block, reasons}.
					// block parks the machine in a dead end; warn proceeds
					// with its reasons carried forward into extract/review/
					// publish so the review UI can show what to look for.
					const verdict = payload ?? null;
					if (verdict === null || typeof verdict !== "object" || !["ok", "warn", "block"].includes(verdict.level) || !Array.isArray(verdict.reasons)) {
						return refuse("calibration-verdict-invalid");
					}
					if (verdict.level === "block") {
						current = STATE.CALIBRATION_BLOCKED;
						return { ok: false, from, to: current, reason: "calibration-blocked" };
					}
					if (verdict.level === "warn") calibrationWarnings = verdict.reasons;
					return advance(STATE.EXTRACT);
				}
				return refuse("invalid-transition");
			case STATE.EXTRACT:
				if (event === "extraction-complete") {
					if (payload === null || typeof payload !== "object") return refuse("take-not-extracted");
					take = payload;
					return advance(STATE.REVIEW);
				}
				return refuse("invalid-transition");
			case STATE.REVIEW:
				if (event === "publish") {
					// The child-side §5 door: the stored take must pass
					// validateTakePayload (contracts.js mirrors the parent's
					// door; verify-contracts.mjs proves the two cannot
					// drift), or publish is refused by the door's own code.
					try {
						validateTakePayload(take);
					} catch (err) {
						return refuse(err.message);
					}
					return advance(STATE.PUBLISHED);
				}
				return refuse("invalid-transition");
			default:
				// no-go, calibration-blocked and published are terminal:
				// no event row exists for them, so nothing can move them.
				return refuse("invalid-transition");
		}
	};

	const report = () => ({
		state: current,
		footage,
		footageReport,
		acknowledgedWarnings: [...acknowledgedWarnings],
		selection,
		calibrationWarnings: [...calibrationWarnings],
		take,
	});

	return {
		state: () => current,
		dispatch,
		report,
		warnings: () => [...calibrationWarnings],
	};
}
