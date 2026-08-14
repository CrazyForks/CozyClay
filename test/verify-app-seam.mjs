#!/usr/bin/env node
/**
 * The App seam (plan 7.1, 7.4; commits S3, S7, S8): one canonical effective
 * transform per character feeds every consumer — Character, ShotRig,
 * PlanBoard, SubjectBox, follow yaw, deriveShot — repairing the pre-existing
 * A-side divergence where a loaded clip moved the rendered character while
 * the camera, plan pucks and inspector kept aiming at the stale raw state.
 * IK correction keys resolve chains from the SELECTED subject's rig (the
 * ikSubject switch), and in/out trim clamps to clip bounds for both
 * subjects. App.jsx must never name the feature: it reaches the seam only
 * through the neutral registry. The registry's behaviour is load-bearing
 * (real rigs, real clip math); the App.jsx source checks are the wiring
 * tripwire that proves every consumer reads the canonical values.
 */
import { readFileSync } from "node:fs";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import {
	effectiveChars,
	anyLoaded,
	resolveSubjectIk,
	clampTrim,
	playbackFrame,
} from "../src/motion-sources.js";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!cond) fail.push(label);
};

// A throwing export must surface as the named behavioural assertion below,
// never as a resolution error.
const safe = (fn) => {
	try {
		return fn();
	} catch {
		return null;
	}
};

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const timeline = readFileSync(new URL("../src/ardy/timeline.jsx", import.meta.url), "utf8");

// --- S3: canonical transforms -----------------------------------------------
// With a clip loaded the subject stands at the clip anchor; without one the
// authored state stands. The loaded-clip values below are the plan's S3 RED
// contract: effectiveCharB must read the clip anchor, not the raw charB.
const base = { A: { x: 0, z: 0, rot: 0 }, B: { x: 1.15, z: 0.1, rot: -14 } };
const clip = { anchorX: 1.42, anchorZ: -0.31, rotationDeg: 0, frames: 124 };

const eff = safe(() => effectiveChars(base, { A: null, B: clip }));
const gotB = eff ? { x: eff.B.x, z: eff.B.z } : base.B;
ok(
	"effectiveCharB with a loaded clip",
	eff !== null && Math.abs(eff.B.x - 1.42) < 1e-9 && Math.abs(eff.B.z - -0.31) < 1e-9,
	`expected {1.42,-0.31}, got {${gotB.x},${gotB.z}}`,
);
ok(
	"effectiveCharA without a clip stays at the authored state",
	eff !== null && eff.A.x === 0 && eff.A.z === 0 && eff.A.rot === 0,
	JSON.stringify(eff ? eff.A : null),
);
ok(
	"a clip anchors both subjects alike",
	safe(() => {
		const e = effectiveChars(base, { A: clip, B: clip });
		return e.A.x === 1.42 && e.B.x === 1.42 && e.B.rot === 0;
	}) === true,
	"clip anchoring is per-subject, not A-only",
);
ok(
	"empty slots leave both subjects at the authored state",
	safe(() => {
		const e = effectiveChars(base, { A: null, B: null });
		return e.B.rot === -14 && e.A.rot === 0;
	}) === true,
	"empty slot falls back to the raw char state",
);
ok(
	"anyLoaded sees a clip in either slot",
	anyLoaded({ A: null, B: clip }) === true && anyLoaded({ A: null, B: null }) === false,
	`B-only=${anyLoaded({ A: null, B: clip })}, empty=${anyLoaded({ A: null, B: null })}`,
);

// The wiring tripwire: every §7.1 consumer reads the ONE derived pair.
ok(
	"App derives the canonical transforms once",
	(app.match(/effectiveChars\(/g) ?? []).length === 1,
	`sites: ${(app.match(/effectiveChars\(/g) ?? []).length}`,
);
ok(
	"Character renders at the canonical transform",
	app.includes("position={[effectiveCharA.x, 0, effectiveCharA.z]}") &&
		app.includes("rot={effectiveCharA.rot}") &&
		app.includes("position={[effectiveCharB.x, 0, effectiveCharB.z]}") &&
		app.includes("rot={effectiveCharB.rot}"),
	"both Character mounts read effectiveCharA/effectiveCharB",
);
ok(
	"ShotRig and PlanBoard both aim at the canonical transform",
	(app.match(/charA=\{effectiveCharA\}/g) ?? []).length >= 2 &&
		(app.match(/charB=\{effectiveCharB\}/g) ?? []).length >= 2,
	`charA sites: ${(app.match(/charA=\{effectiveCharA\}/g) ?? []).length}, charB sites: ${(app.match(/charB=\{effectiveCharB\}/g) ?? []).length}`,
);
ok(
	"the inspector shows the canonical transform",
	app.includes("value={effectiveCharA}") && app.includes("value={effectiveCharB}"),
	"SubjectBox values read the derived pair",
);
ok(
	"follow yaw reads the canonical transform",
	app.includes("const yaw = (effectiveCharA.rot * Math.PI) / 180;"),
	"followTrack initialDir derives from effectiveCharA.rot",
);
ok(
	"deriveShot reads the canonical transform",
	app.includes("deriveShot(cameraPos, effectiveCharA,"),
	"the shot framing derives from effectiveCharA",
);
ok(
	"subject dragging is disabled while a take is loaded",
	app.includes("takeLoaded ? noop : setCharA") && app.includes("takeLoaded ? noop : setCharB"),
	"PlanBoard setters are guarded while any slot holds a clip",
);
ok("App.jsx never names the feature", !app.includes("ingest"), "the seam is the neutral registry");

// --- S7: per-subject IK -----------------------------------------------------
// Correction keys must resolve chains from the SELECTED subject's rig: B
// with the real model resolves a full chain set, an empty B slot resolves
// null (the A-only resolveIkRig(rigA) seam is gone).
function loadRig(name) {
	const buf = readFileSync(new URL(`../public/models/${name}`, import.meta.url));
	const rig = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");
	rig.scale.setScalar(0.01);
	rig.updateMatrixWorld(true);
	return rig;
}
const rigA = loadRig("x-bot-tpose.fbx");
const rigB = loadRig("y-bot-tpose.fbx");

const resolvedB = safe(() => resolveSubjectIk("B", { A: rigA, B: rigB }));
ok(
	"ikSubject=B resolves chains from rigB",
	resolvedB !== null && resolvedB.chains !== null,
	"chains null",
);
ok(
	"an empty B slot resolves null",
	safe(() => resolveSubjectIk("B", { A: rigA, B: null })) === null,
	"no rig, no chains",
);
ok(
	"the A slot still resolves from rigA",
	safe(() => resolveSubjectIk("A", { A: rigA, B: rigB })) !== null,
	"A keeps its rig resolution",
);
ok(
	"the ikSubject switch selects the rig",
	app.includes('const ikSubject = selectedHierarchyId === "characterB" ? "B" : "A";') &&
		app.includes('const ikRig = ikSubject === "B" ? rigB : rigA;'),
	"selectedHierarchyId drives the subject switch",
);
ok(
	"the A-only resolveIkRig(rigA) seam is gone",
	!app.includes("resolveIkRig(rigA)") && app.includes("resolveIkRig(ikRig)"),
	"chains resolve from the selected subject's rig",
);
ok(
	"the IK resolve effect follows the selected rig",
	app.includes("}, [ikRig]);"),
	"rig load or subject change re-resolves the chains",
);

// --- S8: lane trim ----------------------------------------------------------
// In/out trim for BOTH subjects (plan 7.4): the range clamps to the clip's
// frame bounds no matter what the UI asks for, playback samples inside the
// trimmed range, and the timeline shows each subject's trimmed range on its
// own lane.
const trimClip = { frames: 124 }; // 0..123
const gotTrim = safe(() => clampTrim({ start: 12, end: 118 }, trimClip));
const trimFallback = gotTrim ?? { start: 0, end: trimClip.frames - 1 };
ok(
	"trim clamps to clip bounds",
	gotTrim !== null && gotTrim.start === 12 && gotTrim.end === 118,
	`expected 12..118, got ${trimFallback.start}..${trimFallback.end}`,
);
ok(
	"trim clamps out-of-bounds requests into the clip",
	safe(() => {
		const t = clampTrim({ start: -5, end: 200 }, trimClip);
		return t.start === 0 && t.end === 123;
	}) === true,
	JSON.stringify(safe(() => clampTrim({ start: -5, end: 200 }, trimClip))),
);
ok(
	"an inverted trim collapses to its start",
	safe(() => clampTrim({ start: 60, end: 20 }, trimClip))?.start === 60,
	"end never precedes start",
);
ok(
	"playback clamps into the trimmed range",
	safe(() => playbackFrame(0, { start: 12, end: 118 })) === 12 &&
		safe(() => playbackFrame(200, { start: 12, end: 118 })) === 118 &&
		safe(() => playbackFrame(50, { start: 12, end: 118 })) === 50,
	"frames outside the trim hold the edge pose",
);
ok(
	"untrimmed playback passes the frame through",
	safe(() => playbackFrame(30, null)) === 30 && safe(() => playbackFrame(30, undefined)) === 30,
	"no trim, no clamp",
);
ok(
	"Subject 2 owns a timeline lane",
	timeline.includes('"Subject 2"') && timeline.includes('const SUBJECT_2_LANE = "Subject 2";'),
	"the lane list gains Subject 2 (plan 7.4)",
);
ok(
	"both clips render their trimmed range on the timeline",
	timeline.includes("clipA") &&
		timeline.includes("clipB") &&
		timeline.includes("clipPct(clipA.start)") &&
		timeline.includes("clipPct(clipB.start)"),
	"Subject 1 on the Full-Body lane, Subject 2 on its own lane",
);
ok(
	"both playback effects honor the trim",
	app.includes("playbackFrame(tlFrame, trimA)") && app.includes("playbackFrame(tlFrame, trimB)"),
	"A and B sample inside their trimmed ranges",
);
ok(
	"trim edits clamp through the registry",
	app.includes("clampTrim("),
	"no raw trim values ever enter state",
);
ok(
	"trim state resets with its clip",
	app.includes("setTrimA(null)") && app.includes("setTrimB(null)") && app.includes("setTrimA({ start: 0, end: decoded.frames - 1 })"),
	"load sets the full range, clear empties it",
);

if (fail.length) {
	console.log(`\nfailures: ${fail.length}`);
	process.exit(1);
}
console.log("all app seam checks PASS");
