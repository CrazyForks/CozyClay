/**
 * U1: the ingest surface state machine (plan §13 commit U1).
 *
 * Why this test exists: the §10.4 footage policy and the §9 calibration
 * estimator are decision functions, but a decision nobody consumes is a
 * decoration. The state machine is the consumer: it cannot leave preflight
 * unless the policy's report is "go" (an acknowledged warn is still parked —
 * re-preflight is the only path), and a "block" calibration verdict cannot
 * reach extract while "warn" can, with the warning carried forward into
 * extract/review/publish. The plan's canonical RED is "extract allowed on a
 * no-go report": a machine that merely discourages the bad transition is
 * the defect, so every guard here has a negative control that must fail to
 * move the machine.
 *
 * The reachability claim is asserted EXHAUSTIVELY, not by example: the
 * verifier builds the graph from the exported TRANSITIONS table and proves
 * no path from the no-go/calibration-blocked dead ends to extract or
 * publish, and that no transition row originates in a dead end. A new row
 * that opens such a path fails this gate without a new test.
 *
 * What would be circular or wrong: re-implementing the guards in the test
 * (code against code); hand-building reports instead of consuming the real
 * evaluateFootage outputs; or asserting "no path" by walking one example
 * sequence instead of the whole table.
 */
import {
	createIngestMachine,
	STATE,
	STATES,
	EVENTS,
	TRANSITIONS,
} from "../../src/ingest/state.js";
import { evaluateFootage } from "../../src/ingest/footage-policy.js";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

// A machine that threw at construction (the RED run) must still fail the
// assertions with a visible reason instead of crashing the suite.
function makeMachine() {
	try {
		return { machine: createIngestMachine(), threw: null };
	} catch (err) {
		return { machine: null, threw: err.message };
	}
}
const dispatch = (env, event, payload) => {
	if (env.threw !== null) return { ok: false, reason: env.threw };
	try {
		return env.machine.dispatch(event, payload);
	} catch (err) {
		return { ok: false, reason: "threw " + err.message };
	}
};
const stateOf = (env) => (env.threw !== null ? `threw:${env.threw}` : env.machine.state());
const warningsOf = (env) => (env.threw !== null ? [] : env.machine.warnings());
const reportOf = (env) => (env.threw !== null ? { calibrationWarnings: [] } : env.machine.report());
const note = (env) => (env.threw !== null ? ` [${env.threw}]` : "");

// The §5 take payload (the same shape the parent door validates).
function makeTakePayload(requestId) {
	const clip = (track) => ({
		rotationDeg: 0,
		fps: 20,
		frames: 60,
		artifactPath: `/ingest/artifacts/0123456789abcdef0123456789abcdef/track-${track}`,
		provenance: {
			command: "cozyclay ingest",
			sourceUrl: "file:///raw/take.mov",
			licence: "operator-owned",
			sourceSha256: "a".repeat(64),
			trimStartS: 0,
			trimEndS: 3,
			gvhmrCommit: "b".repeat(40),
			weightsSha256: "c".repeat(64),
			annotationPath: `/ingest/artifacts/0123456789abcdef0123456789abcdef/annotation-${track}`,
		},
	});
	return { requestId, a: clip("a"), b: clip("b") };
}

// Real policy outputs: the machine consumes the §10.4 decision function,
// so the reports are produced by evaluateFootage, never hand-built.
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
const goReport = evaluateFootage(clean);
const noGoReport = evaluateFootage(withSignals({ zoomDetected: true }));
const warnReport = evaluateFootage(withSignals({ interlaceTelecine: true }));
const warnReasons = [{ code: "calibration-uncertainty-high", severity: "warn", value: 0.05, threshold: 0.03 }];
const blockReasons = [{ code: "calibration-heldout-error", severity: "block", value: 0.09, threshold: 0.05 }];

// Walk a fresh machine to calibrate along the happy path. Tolerates the
// RED run: the step dispatches simply refuse, and the assertions below
// then fail with a visible state.
function toSelectTake(env) {
	dispatch(env, "pick-footage", { sourceUrl: "file:///raw/take.mov" });
	dispatch(env, "preflight-report", { report: goReport, acknowledgedWarnings: [] });
	return env;
}

// Walk a fresh machine to calibrate along the happy path. Tolerates the
// RED run: the step dispatches simply refuse, and the assertions below
// then fail with a visible state.
function toCalibrate(env) {
	toSelectTake(env);
	dispatch(env, "take-selected", { takeId: "t-1" });
	return env;
}

// Every event with a plausible payload: the dead-end probes below try all
// of them and demand that none moves the machine.
const plausible = [
	["pick-footage", { sourceUrl: "file:///other.mov" }],
	["preflight-report", { report: goReport, acknowledgedWarnings: [] }],
	["take-selected", { takeId: "t-other" }],
	["calibration-verdict", { level: "ok", reasons: [] }],
	["extraction-complete", makeTakePayload("plausible-1")],
	["publish", undefined],
];

// ---------------------------------------------------------------------------
// 1. The plan's RED: extract must be unreachable from a no-go report
// ---------------------------------------------------------------------------
// "extract allowed on a no-go report" — the naive defect is a machine that
// notes the verdict and keeps going. Here the no-go report parks the
// machine in a terminal dead end: nothing the surface can dispatch moves
// it, so extract and publish are impossible, not merely discouraged.
const red = makeMachine();
dispatch(red, "pick-footage", { sourceUrl: "file:///raw/take.mov" });
const noGo = dispatch(red, "preflight-report", { report: noGoReport, acknowledgedWarnings: [] });
ok(
	"a no-go report parks the machine in no-go",
	noGo.ok === false && noGo.reason === "verdict-no-go" && stateOf(red) === STATE.NO_GO,
	`reason=${noGo.reason} state=${stateOf(red)}${note(red)}`
);
let redImmobile = true;
for (const [event, payload] of plausible) {
	const out = dispatch(red, event, payload);
	if (out.ok || stateOf(red) !== STATE.NO_GO) redImmobile = false;
}
ok(
	"no event can move a no-go machine (extract and publish unreachable)",
	redImmobile,
	`state=${stateOf(red)}${note(red)}`
);

// ---------------------------------------------------------------------------
// 2. The happy path: every named state, in order
// ---------------------------------------------------------------------------
const happy = makeMachine();
ok("a fresh machine starts idle", stateOf(happy) === STATE.IDLE, `state=${stateOf(happy)}${note(happy)}`);
let step = dispatch(happy, "pick-footage", { sourceUrl: "file:///raw/take.mov" });
ok("pick-footage moves idle -> preflight", step.ok === true && step.to === STATE.PREFLIGHT && stateOf(happy) === STATE.PREFLIGHT, JSON.stringify({ ...step, state: stateOf(happy) }));
step = dispatch(happy, "preflight-report", { report: goReport, acknowledgedWarnings: [] });
ok("a go report leaves preflight -> select-take", step.ok === true && step.to === STATE.SELECT_TAKE && stateOf(happy) === STATE.SELECT_TAKE, JSON.stringify({ ...step, state: stateOf(happy) }));
step = dispatch(happy, "take-selected", { takeId: "t-1" });
ok("take-selected moves select-take -> calibrate", step.ok === true && step.to === STATE.CALIBRATE && stateOf(happy) === STATE.CALIBRATE, JSON.stringify({ ...step, state: stateOf(happy) }));
step = dispatch(happy, "calibration-verdict", { level: "ok", reasons: [] });
ok("an ok calibration verdict reaches extract", step.ok === true && step.to === STATE.EXTRACT && stateOf(happy) === STATE.EXTRACT, JSON.stringify({ ...step, state: stateOf(happy) }));
step = dispatch(happy, "extraction-complete", makeTakePayload("happy-1"));
ok("extraction-complete moves extract -> review", step.ok === true && step.to === STATE.REVIEW && stateOf(happy) === STATE.REVIEW, JSON.stringify({ ...step, state: stateOf(happy) }));
step = dispatch(happy, "publish");
ok("publish moves review -> published", step.ok === true && step.to === STATE.PUBLISHED && stateOf(happy) === STATE.PUBLISHED, JSON.stringify({ ...step, state: stateOf(happy) }));
ok("published is terminal", dispatch(happy, "pick-footage", { sourceUrl: "file:///x.mov" }).ok === false && stateOf(happy) === STATE.PUBLISHED, `state=${stateOf(happy)}`);

// ---------------------------------------------------------------------------
// 3. Every guarded transition has a negative control
// ---------------------------------------------------------------------------

// 3a. pick-footage: a job needs footage.
const idle = makeMachine();
ok("pick-footage without a descriptor is refused", dispatch(idle, "pick-footage").reason === "footage-required" && stateOf(idle) === STATE.IDLE, `reason=${dispatch(idle, "pick-footage").reason} state=${stateOf(idle)}${note(idle)}`);
ok("pick-footage with a null descriptor is refused", dispatch(idle, "pick-footage", null).reason === "footage-required" && stateOf(idle) === STATE.IDLE, `state=${stateOf(idle)}`);

// 3b. preflight-report: the §10.4 gate, consumed from footage-policy.js.
const pre = makeMachine();
dispatch(pre, "pick-footage", { sourceUrl: "file:///raw/take.mov" });
const badVerdict = dispatch(pre, "preflight-report", { report: { verdict: "maybe", reasons: [] }, acknowledgedWarnings: [] });
ok("an unknown verdict is refused as report-invalid", badVerdict.reason === "report-invalid" && stateOf(pre) === STATE.PREFLIGHT, `reason=${badVerdict.reason} state=${stateOf(pre)}${note(pre)}`);
const badAcks = dispatch(pre, "preflight-report", { report: noGoReport, acknowledgedWarnings: "not-an-array" });
ok("non-array acknowledgements are refused as report-invalid", badAcks.reason === "report-invalid" && stateOf(pre) === STATE.PREFLIGHT, `reason=${badAcks.reason} state=${stateOf(pre)}`);
const noReport = dispatch(pre, "preflight-report", {});
ok("a missing report is refused as report-invalid", noReport.reason === "report-invalid" && stateOf(pre) === STATE.PREFLIGHT, `reason=${noReport.reason} state=${stateOf(pre)}`);
const unackedWarn = dispatch(pre, "preflight-report", { report: warnReport, acknowledgedWarnings: [] });
ok("a warn report cannot leave preflight, naming the verdict", unackedWarn.ok === false && unackedWarn.reason === "verdict-warn" && stateOf(pre) === STATE.PREFLIGHT, `reason=${unackedWarn.reason} state=${stateOf(pre)}`);
const ackedWarn = dispatch(pre, "preflight-report", { report: warnReport, acknowledgedWarnings: ["interlace-telecine"] });
ok("an acknowledged warn report still cannot leave preflight (re-preflight is the only path)", ackedWarn.ok === false && ackedWarn.reason === "verdict-warn" && stateOf(pre) === STATE.PREFLIGHT, `reason=${ackedWarn.reason} state=${stateOf(pre)}`);
const extraAcks = dispatch(pre, "preflight-report", { report: goReport, acknowledgedWarnings: ["clinch-iou-high"] });
ok("extra acknowledgements on a go report are harmless", extraAcks.ok === true && stateOf(pre) === STATE.SELECT_TAKE, `state=${stateOf(pre)}`);
const reWarn = makeMachine();
dispatch(reWarn, "pick-footage", { sourceUrl: "file:///raw/take.mov" });
dispatch(reWarn, "preflight-report", { report: warnReport, acknowledgedWarnings: ["interlace-telecine"] });
const newReport = dispatch(reWarn, "preflight-report", { report: goReport, acknowledgedWarnings: [] });
ok("a NEW go report after the warn is the only way out", newReport.ok === true && stateOf(reWarn) === STATE.SELECT_TAKE, `state=${stateOf(reWarn)}`);

// 3c. take-selected: calibrating needs a chosen take.
const sel = makeMachine();
toSelectTake(sel);
ok("take-selected with no payload is refused", dispatch(sel, "take-selected").reason === "take-not-selected" && stateOf(sel) === STATE.SELECT_TAKE, `state=${stateOf(sel)}${note(sel)}`);
ok("take-selected without a takeId is refused", dispatch(sel, "take-selected", {}).reason === "take-not-selected" && stateOf(sel) === STATE.SELECT_TAKE, `state=${stateOf(sel)}`);
ok("take-selected with an empty takeId is refused", dispatch(sel, "take-selected", { takeId: "" }).reason === "take-not-selected" && stateOf(sel) === STATE.SELECT_TAKE, `state=${stateOf(sel)}`);
ok("take-selected with a takeId proceeds", dispatch(sel, "take-selected", { takeId: "t-9" }).ok === true && stateOf(sel) === STATE.CALIBRATE, `state=${stateOf(sel)}`);

// 3d. calibration-verdict: ok and warn reach extract, block never does.
const cal = makeMachine();
toCalibrate(cal);
ok("a verdict without a level is refused", dispatch(cal, "calibration-verdict", { reasons: [] }).reason === "calibration-verdict-invalid" && stateOf(cal) === STATE.CALIBRATE, `state=${stateOf(cal)}${note(cal)}`);
ok("an unknown level is refused", dispatch(cal, "calibration-verdict", { level: "maybe", reasons: [] }).reason === "calibration-verdict-invalid" && stateOf(cal) === STATE.CALIBRATE, `state=${stateOf(cal)}`);
ok("a verdict without a reasons array is refused", dispatch(cal, "calibration-verdict", { level: "ok" }).reason === "calibration-verdict-invalid" && stateOf(cal) === STATE.CALIBRATE, `state=${stateOf(cal)}`);
const blocked = makeMachine();
toCalibrate(blocked);
const blockStep = dispatch(blocked, "calibration-verdict", { level: "block", reasons: blockReasons });
ok("a block calibration verdict parks the machine in calibration-blocked", blockStep.ok === false && blockStep.reason === "calibration-blocked" && stateOf(blocked) === STATE.CALIBRATION_BLOCKED, `reason=${blockStep.reason} state=${stateOf(blocked)}${note(blocked)}`);
let blockedImmobile = true;
for (const [event, payload] of plausible) {
	const out = dispatch(blocked, event, payload);
	if (out.ok || stateOf(blocked) !== STATE.CALIBRATION_BLOCKED) blockedImmobile = false;
}
ok("no event can move a calibration-blocked machine (extract and publish unreachable)", blockedImmobile, `state=${stateOf(blocked)}`);

// 3e. extraction-complete: review needs the extracted take.
const ext = makeMachine();
toCalibrate(ext);
dispatch(ext, "calibration-verdict", { level: "ok", reasons: [] });
ok("extraction-complete without a take is refused", dispatch(ext, "extraction-complete").reason === "take-not-extracted" && stateOf(ext) === STATE.EXTRACT, `reason=${dispatch(ext, "extraction-complete").reason} state=${stateOf(ext)}${note(ext)}`);
ok("extraction-complete with a non-object is refused", dispatch(ext, "extraction-complete", "take").reason === "take-not-extracted" && stateOf(ext) === STATE.EXTRACT, `state=${stateOf(ext)}`);

// 3f. publish: the child-side §5 door, one named clause per control.
const pubEarly = makeMachine();
toCalibrate(pubEarly);
dispatch(pubEarly, "calibration-verdict", { level: "ok", reasons: [] });
ok("publish from extract is an invalid transition", dispatch(pubEarly, "publish").reason === "invalid-transition" && stateOf(pubEarly) === STATE.EXTRACT, `state=${stateOf(pubEarly)}${note(pubEarly)}`);
const doorCases = [
	["request-id-missing", (t) => ({ ...t, requestId: "" })],
	["rotation-deg-mismatch", (t) => ({ ...t, b: { ...t.b, rotationDeg: 5 } })],
	["fps-not-20", (t) => ({ ...t, a: { ...t.a, fps: 24 } })],
	["frame-count-mismatch", (t) => ({ ...t, b: { ...t.b, frames: 59 } })],
	["artifact-path-invalid", (t) => ({ ...t, a: { ...t.a, artifactPath: "https://evil.example/x" } })],
	["provenance-incomplete", (t) => {
		const p = { ...t.b.provenance };
		delete p.weightsSha256;
		return { ...t, b: { ...t.b, provenance: p } };
	}],
];
for (const [code, mutate] of doorCases) {
	const env = makeMachine();
	toCalibrate(env);
	dispatch(env, "calibration-verdict", { level: "ok", reasons: [] });
	dispatch(env, "extraction-complete", mutate(makeTakePayload("door-" + code)));
	const out = dispatch(env, "publish");
	ok(`publish refuses a take with ${code}, staying in review`, out.ok === false && out.reason === code && stateOf(env) === STATE.REVIEW, `reason=${out.reason} state=${stateOf(env)}${note(env)}`);
}

// ---------------------------------------------------------------------------
// 4. Refusals never throw: unknown events and invalid transitions
// ---------------------------------------------------------------------------
const quiet = makeMachine();
const unknown = dispatch(quiet, "frobnicate", {});
ok("an unknown event is refused, never thrown", unknown.ok === false && unknown.reason === "unknown-event" && stateOf(quiet) === STATE.IDLE, `reason=${unknown.reason} state=${stateOf(quiet)}${note(quiet)}`);
ok("a non-string event is refused the same way", dispatch(quiet, undefined, {}).reason === "unknown-event", `reason=${dispatch(quiet, undefined, {}).reason}`);
const wrongState = dispatch(quiet, "take-selected", { takeId: "t-1" });
ok("a known event from the wrong state is an invalid transition", wrongState.ok === false && wrongState.reason === "invalid-transition" && stateOf(quiet) === STATE.IDLE, `reason=${wrongState.reason} state=${stateOf(quiet)}`);

// ---------------------------------------------------------------------------
// 5. Exhaustive reachability over the exported transition table
// ---------------------------------------------------------------------------
// Not by example: build the graph from TRANSITIONS, then demand the dead
// ends reach nothing, the table is closed (no row originates in a dead
// end), every named state is reachable from idle, and the canonical flow
// is a chain in the table.
const adjacency = new Map();
for (const t of TRANSITIONS) {
	if (!adjacency.has(t.from)) adjacency.set(t.from, []);
	adjacency.get(t.from).push(t.to);
}
function reachable(from) {
	const seen = new Set([from]);
	const queue = [from];
	while (queue.length > 0) {
		const cur = queue.shift();
		for (const next of adjacency.get(cur) ?? []) {
			if (!seen.has(next)) {
				seen.add(next);
				queue.push(next);
			}
		}
	}
	return seen;
}
ok("the transition table names only machine states", TRANSITIONS.every((t) => STATES.includes(t.from) && STATES.includes(t.to)), "");
ok("no transition row originates in the no-go dead end", TRANSITIONS.every((t) => t.from !== STATE.NO_GO), "");
ok("no transition row originates in the calibration-blocked dead end", TRANSITIONS.every((t) => t.from !== STATE.CALIBRATION_BLOCKED), "");
for (const dead of [STATE.NO_GO, STATE.CALIBRATION_BLOCKED]) {
	const seen = reachable(dead);
	ok(
		`no path from ${dead} to extract or publish`,
		!seen.has(STATE.EXTRACT) && !seen.has(STATE.PUBLISHED),
		`reachable=[${[...seen].join(", ")}]`
	);
}
const fromIdle = reachable(STATE.IDLE);
ok("every named state is reachable from idle", STATES.every((s) => fromIdle.has(s)), `missing=[${STATES.filter((s) => !fromIdle.has(s)).join(", ")}]`);
const chain = [STATE.IDLE, STATE.PREFLIGHT, STATE.SELECT_TAKE, STATE.CALIBRATE, STATE.EXTRACT, STATE.REVIEW, STATE.PUBLISHED];
let chainOk = true;
for (let i = 0; i + 1 < chain.length; i += 1) {
	if (!TRANSITIONS.some((t) => t.from === chain[i] && t.to === chain[i + 1])) chainOk = false;
}
ok("the canonical flow idle -> ... -> published is a chain in the table", chainOk, "");

// ---------------------------------------------------------------------------
// 6. Calibration warn proceeds, with the warning carried forward
// ---------------------------------------------------------------------------
const warned = makeMachine();
toCalibrate(warned);
const warnVerdict = { level: "warn", reasons: warnReasons };
const warnStep = dispatch(warned, "calibration-verdict", warnVerdict);
ok("a warn calibration verdict reaches extract", warnStep.ok === true && warnStep.to === STATE.EXTRACT && stateOf(warned) === STATE.EXTRACT, JSON.stringify({ ...warnStep, state: stateOf(warned) }) + note(warned));
ok(
	"the warning is carried forward on the machine",
	JSON.stringify(warningsOf(warned)) === JSON.stringify(warnReasons) && JSON.stringify(reportOf(warned).calibrationWarnings) === JSON.stringify(warnReasons),
	`warnings=${JSON.stringify(warningsOf(warned))}${note(warned)}`
);
dispatch(warned, "extraction-complete", makeTakePayload("warn-1"));
ok("the warning survives into review", JSON.stringify(warningsOf(warned)) === JSON.stringify(warnReasons), `warnings=${JSON.stringify(warningsOf(warned))}`);
const warnPublish = dispatch(warned, "publish");
ok("a warn verdict does not block publish", warnPublish.ok === true && stateOf(warned) === STATE.PUBLISHED, JSON.stringify(warnPublish));
const okVerdict = makeMachine();
toCalibrate(okVerdict);
dispatch(okVerdict, "calibration-verdict", { level: "ok", reasons: [] });
ok("an ok verdict carries no warnings", warningsOf(okVerdict).length === 0, `warnings=${JSON.stringify(warningsOf(okVerdict))}`);

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
