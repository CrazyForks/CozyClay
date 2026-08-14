#!/usr/bin/env node
/**
 * The App seam (plan 7.1, 7.2, 7.3, 7.4; commits S3, S4, S5, S6, S7, S8):
 * one canonical effective transform per character feeds every consumer —
 * Character, ShotRig, PlanBoard, SubjectBox, follow yaw, deriveShot —
 * repairing the pre-existing A-side divergence where a loaded clip moved the
 * rendered character while the camera, plan pucks and inspector kept aiming
 * at the stale raw state. IK correction keys resolve chains from the
 * SELECTED subject's rig (the ikSubject switch) and each subject keeps its
 * OWN key state, and in/out trim clamps to clip bounds for both subjects.
 *
 * The take wiring is load-bearing too: ONE App-owned coordinator registers
 * BOTH real stores (scene + take), the landing door decodes both artifacts
 * and lands atomically (one entry), a clear is one entry, and Ctrl+Z
 * interleaves across the two stores with cross-store redo invalidation.
 * These are driven HERE through the same factory the app runs (the registry
 * is node-importable; App.jsx is not).
 *
 * HOW THE WIRING CLAIMS ARE PROVEN (pass-2 finding 2 — no source scan may
 * gate a capability claim):
 *
 * 1. BEHAVIOUR, HERE: the take factory (createUndoStores) and every registry
 *    function below are exercised through the real stores — the assertions
 *    labelled PASS/FAIL fail when the store misbehaves.
 *
 * 2. BEHAVIOUR, IN A REAL BROWSER (test/verify-app-render.mjs, run with
 *    `npm run test:app-render` against a live dev server): the App WIRING
 *    and capability claims — factory creation with ONE shared coordinator,
 *    keyboard undo/redo routing, the landing door's exposure and its
 *    two-artifact decode, both clip slots, the one-entry clear, per-subject
 *    keyed IK, and the single-key persistence round-trip — are observed in
 *    the RENDERED app through its QA hooks with real input. Text scans
 *    cannot prove any of these: a rendered App that never calls the factory
 *    still contains every string, which is exactly how the orphaned-store
 *    defect survived pass 1.
 *
 * 3. TRIPWIRES (NON-GATING), HERE: every remaining App.jsx/timeline.jsx/
 *    motion-sources.js source scan below is an explicitly-labelled,
 *    NON-GATING tripwire — a diagnostic that flags drift in the wiring text
 *    so a behavioural regression can be traced to the drifted line. A
 *    tripwire PASS is NOT capability proof; a tripwire MISS prints
 *    "TRIPWIRE MISS" and never fails the suite. Each tripwire carries its
 *    gate: the render test's behavioural gate, a behavioural gate in this
 *    file, or "unproven until U4".
 *
 * DECLARED GAP — unproven until U4 (the Phase-4 browser suite): ShotRig and
 * PlanBoard aiming at the canonical pair, follow-yaw and deriveShot reading
 * it, the take-loaded drag guard, the IK evaluate effect using the SELECTED
 * subject's rig and clip, ARDY regeneration pinning Subject 1's key set,
 * the timeline's Subject-2 lane rendering the trimmed ranges, and the
 * app-level trim wiring (playback sampling, edit clamping, load seeding).
 * Static contracts that are only checkable in source (the resolveIkRig call
 * count, effect dep arrays, "App.jsx never names the feature") are
 * tripwire-only by nature; they are labelled as such, never as verified.
 */
import { readFileSync } from "node:fs";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import {
	effectiveChars,
	anyLoaded,
	resolveSubjectIk,
	clampTrim,
	playbackFrame,
	createUndoStores,
	clearTakePayload,
	ikStateFor,
	serializeClipState,
	deserializeClipState,
} from "../src/motion-sources.js";
import { createIkState, ikTouch, ikBakeKeyframe } from "../src/ardy/ik.js";

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

// A tripwire is a source scan that deliberately does NOT gate (finding 2):
// it reports whether the wiring text still matches so a behavioural
// regression can be traced to the drifted line. The claim each tripwire
// watches is gated behaviourally either in test/verify-app-render.mjs (the
// real-browser suite), by a behavioural section in THIS file, or — where no
// observation exists yet — is declared unproven until U4 (see the header).
// A tripwire PASS is a diagnostic, never capability proof; a tripwire MISS
// is a WARN in the summary, never a suite failure.
const tripMissed = [];
const trip = (label, cond, gate) => {
	const status = cond ? "TRIPWIRE PASS" : "TRIPWIRE MISS";
	console.log(`${status}  ${label}  [non-gating; ${gate}]`);
	if (!cond) tripMissed.push(label);
};

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const timeline = readFileSync(new URL("../src/ardy/timeline.jsx", import.meta.url), "utf8");
const registry = readFileSync(new URL("../src/motion-sources.js", import.meta.url), "utf8");

/* ------------------------- the real take wiring --------------------------- */
// The App fields a take owns (plan 7.2): both clips, both trims, B's
// visibility and the shared timeline. The wiring factory reads/writes them;
// the App supplies the same accessors over its live state.
function makeClipFields(overrides = {}) {
	return {
		motion: null,
		motionB: null,
		trimA: null,
		trimB: null,
		charA: { x: 0, z: 0, rot: 0 },
		charB: { x: 1.15, z: 0.1, rot: -14 },
		showB: false,
		tlFrameCount: 300,
		tlFps: 20,
		tlFrame: 0,
		tlPlaying: false,
		...overrides,
	};
}
function makeTakeEnv(start = makeClipFields()) {
	let fields = start;
	const writes = [];
	return {
		read: () => ({ ...fields }),
		write(patch) {
			writes.push(patch);
			fields = { ...fields, ...patch };
		},
		fields: () => fields,
		writes,
	};
}

// A valid §5 TakePayload; the artifact path carries the requestId so the
// tests can tell one landing's clips from another's.
function makePayload(requestId) {
	const clip = (track) => ({
		rotationDeg: 0,
		fps: 20,
		frames: 60,
		artifactPath: `/ingest/artifacts/0123456789abcdef0123456789abcdef/track-${track}-${requestId}`,
		provenance: {
			command: "cozyclay ingest",
			sourceUrl: "file:///raw/take.mov",
			licence: "operator-owned",
			sourceSha256: "a".repeat(64),
			trimStartS: 0,
			trimEndS: 3,
			gvhmrCommit: "b".repeat(40),
			weightsSha256: "c".repeat(64),
			annotationPath: `/ingest/artifacts/0123456789abcdef0123456789abcdef/annotation-${track}-${requestId}`,
		},
	});
	return { requestId, a: clip("a"), b: clip("b") };
}

// The door's enrichment (plan 7.2): both artifacts decoded before the atomic
// landing, so apply() never touches the network.
function enrich(payload) {
	const decoded = () => ({
		frames: 60,
		fps: 20,
		rotMats: new Float32Array(60 * 27 * 9),
		rootPos: new Float32Array(60 * 3),
		posedJoints: new Float32Array(60 * 27 * 3),
	});
	return {
		...payload,
		a: { ...payload.a, decoded: decoded() },
		b: { ...payload.b, decoded: decoded() },
	};
}

/* --------------- the ONE coordinator owns both real stores ---------------- */

const env = makeTakeEnv();
const { coordinator, scene, take } = createUndoStores({
	sceneObjects: ["base"],
	onObjects() {},
	read: env.read,
	write: env.write,
});
scene.applyAtomic((objects) => [...objects, "s1"]); // seq 1
ok("the scene store and the take store share ONE coordinator", coordinator.sequence() === 1 && scene.topSeq() === 1 && take.topSeq() === undefined, `sequence()=${coordinator.sequence()}`);
const ack = take.landTake(enrich(makePayload("land-1"))); // seq 2
ok("a landing mints exactly one sequence through the coordinator", coordinator.sequence() === 2 && take.depths().past === 1, `sequence()=${coordinator.sequence()}`);
ok("a landing writes both clip slots, both trims, B and the timeline", env.fields().motion !== null && env.fields().motionB !== null && env.fields().motion.url.endsWith("track-a-land-1") && env.fields().motionB.url.endsWith("track-b-land-1") && env.fields().trimA.start === 0 && env.fields().trimA.end === 59 && env.fields().trimB.end === 59 && env.fields().showB === true && env.fields().tlFrameCount === 60 && env.fields().tlFrame === 0 && env.fields().tlPlaying === false, `url=${env.fields().motion?.url}`);
ok("landed clips anchor at the subjects' authored positions", env.fields().motion.anchorX === 0 && env.fields().motionB.anchorX === 1.15 && env.fields().motionB.anchorZ === 0.1, `A=${env.fields().motion?.anchorX} B=${env.fields().motionB?.anchorX}`);
ok("a landed clip stores the artifact as its source url", env.fields().motion.url.endsWith("track-a-land-1") && env.fields().motion.rotationDeg === 0, "url/rotation carried from the payload");
coordinator.undo();
ok("one Ctrl+Z reverts the landing", env.fields().motion === null && env.fields().motionB === null && env.fields().trimA === null && env.fields().showB === false && env.fields().tlFrameCount === 300 && take.value() === null && take.canRedo() === true, `motion=${env.fields().motion !== null}`);
coordinator.redo();
ok("one Ctrl+Shift+Z re-applies the landing", env.fields().motion !== null && env.fields().motionB !== null && take.value()?.requestId === "land-1", `value=${take.value()?.requestId}`);
ok("a replayed requestId mints nothing and returns the cached ack", (() => {
	const seqBefore = coordinator.sequence();
	const replay = take.landTake(enrich(makePayload("land-1")));
	return coordinator.sequence() === seqBefore && take.depths().past === 1 && replay.requestId === "land-1";
})());

/* -------- load / replace / clear are each exactly ONE undo entry ---------- */

const env2 = makeTakeEnv();
const undo2 = createUndoStores({ sceneObjects: ["base"], onObjects() {}, read: env2.read, write: env2.write });
undo2.take.landTake(enrich(makePayload("t1"))); // seq 1
undo2.take.landTake(enrich(makePayload("t2"))); // seq 2 — replace
ok("a replacement lands exactly one entry", undo2.coordinator.sequence() === 2 && undo2.take.depths().past === 2, `sequence()=${undo2.coordinator.sequence()}`);
undo2.coordinator.undo();
ok("one undo reverts the replacement to the first take", env2.fields().motion?.url.endsWith("track-a-t1") && env2.fields().motionB?.url.endsWith("track-b-t1"), `url=${env2.fields().motion?.url}`);
undo2.coordinator.redo();
ok("redo re-applies the replacement", env2.fields().motion?.url.endsWith("track-a-t2"), `url=${env2.fields().motion?.url}`);
undo2.take.clear(clearTakePayload("clear-1", { tlFrameCount: 300, tlFps: 20, tlFrame: 0 })); // seq 3
ok("a clear lands exactly one entry through the coordinator", undo2.coordinator.sequence() === 3 && undo2.take.depths().past === 3, `sequence()=${undo2.coordinator.sequence()}`);
ok("the clear empties both lanes and resets the timeline", env2.fields().motion === null && env2.fields().motionB === null && env2.fields().trimA === null && env2.fields().trimB === null && env2.fields().tlFrameCount === 300, `motion=${env2.fields().motion !== null} tlFrameCount=${env2.fields().tlFrameCount}`);
undo2.coordinator.undo();
ok("one Ctrl+Z restores the cleared take", env2.fields().motion !== null && env2.fields().motionB !== null && env2.fields().trimB?.end === 59, `motion=${env2.fields().motion !== null}`);
undo2.coordinator.redo();
ok("redo re-clears both lanes", env2.fields().motion === null && env2.fields().motionB === null, "both slots empty again");
// a second clear mints a second entry — the distinct clear op pushes every
// time, so two clears can never collapse into one
undo2.take.clear(clearTakePayload("clear-2", {}));
ok("a second clear is its own entry", undo2.coordinator.sequence() === 4 && undo2.take.depths().past === 4, `sequence()=${undo2.coordinator.sequence()}`);
/* ------ a colliding external id must not swallow a clear (Finding 5) ------- */
// The old clear path minted internal ids (clear-1, clear-2) inside the take
// store's EXTERNAL request-id namespace: a landing that happened to carry
// id "clear-1" made the first clear return the cached landing ack and mint
// zero entries — the lanes stayed loaded and Ctrl+Z had nothing to restore.
// The clear is now a DISTINCT store operation outside the replay table, so
// a colliding external id can neither swallow it nor be shadowed by it.
const envCollide = makeTakeEnv();
const undoCollide = createUndoStores({ sceneObjects: ["base"], onObjects() {}, read: envCollide.read, write: envCollide.write });
undoCollide.take.landTake(enrich(makePayload("clear-1"))); // the colliding external id
const seqAfterLanding = undoCollide.coordinator.sequence();
undoCollide.take.clear(clearTakePayload("clear-1", {})); // the clear, same id
ok("a clear after a colliding landing still pushes exactly one entry", undoCollide.coordinator.sequence() === seqAfterLanding + 1 && undoCollide.take.depths().past === 2, `sequence()=${undoCollide.coordinator.sequence()} past=${undoCollide.take.depths().past}`);
ok("the colliding clear empties both lanes", envCollide.fields().motion === null && envCollide.fields().motionB === null && envCollide.fields().trimA === null && envCollide.fields().trimB === null, `motion=${envCollide.fields().motion !== null}`);
// the reverse direction: the clear never entered the replay table, so the
// landing's cache is intact — a replay of "clear-1" still returns the cached
// LANDING ack, applies nothing, and mints nothing
const writesAfterClear = envCollide.writes.length;
const seqAfterClear = undoCollide.coordinator.sequence();
const landingReplay = undoCollide.take.landTake(enrich(makePayload("clear-1")));
ok("the clear did not shadow the landing's replay cache", landingReplay.requestId === "clear-1" && landingReplay.value.requestId === "clear-1" && undoCollide.coordinator.sequence() === seqAfterClear && undoCollide.take.depths().past === 2 && envCollide.writes.length === writesAfterClear, `sequence()=${undoCollide.coordinator.sequence()} writes=${envCollide.writes.length}`);
// and Ctrl+Z restores the landing the colliding clear emptied
undoCollide.coordinator.undo();
ok("one Ctrl+Z after the colliding clear restores the landing", envCollide.fields().motion !== null && envCollide.fields().motion.url.endsWith("track-a-clear-1") && envCollide.fields().motionB !== null && undoCollide.take.value()?.requestId === "clear-1", `url=${envCollide.fields().motion?.url}`);

/* -------- Ctrl+Z interleaving across the two stores (plan 7.3) ------------ */

const env3 = makeTakeEnv();
const undo3 = createUndoStores({ sceneObjects: ["base"], onObjects() {}, read: env3.read, write: env3.write });
undo3.scene.applyAtomic((objects) => [...objects, "s1"]); // seq 1
undo3.take.landTake(enrich(makePayload("seq-2"))); // seq 2
undo3.scene.applyAtomic(() => ["base", "s1", "s3"]); // seq 3
ok("interleaving: scene 1, take 2, scene 3", undo3.coordinator.sequence() === 3 && undo3.scene.topSeq() === 3 && undo3.take.topSeq() === 2, `scene.topSeq()=${undo3.scene.topSeq()} take.topSeq()=${undo3.take.topSeq()}`);
const undoneScene = undo3.coordinator.undo();
ok("undo picks the scene store (3 > 2)", Array.isArray(undoneScene) && undoneScene[1] === "s1" && undo3.scene.topSeq() === 1 && undo3.scene.topRedoSeq() === 3, `scene.topSeq()=${undo3.scene.topSeq()}`);
undo3.coordinator.undo();
ok("undo picks the take store (2 > 1)", env3.fields().motion === null && undo3.take.value() === null && undo3.take.topRedoSeq() === 2, `take.topRedoSeq()=${undo3.take.topRedoSeq()}`);
undo3.coordinator.undo();
ok("undo picks the scene store (1)", undo3.scene.objects.length === 1 && undo3.scene.objects[0] === "base", `objects=${undo3.scene.objects.length}`);
undo3.coordinator.redo();
ok("redo 1 replays the seq-1 scene edit", undo3.scene.topSeq() === 1 && undo3.scene.objects[1] === "s1", `scene.topSeq()=${undo3.scene.topSeq()}`);
undo3.coordinator.redo();
ok("redo 2 replays the seq-2 landing", undo3.take.topSeq() === 2 && env3.fields().motion !== null, `take.topSeq()=${undo3.take.topSeq()}`);
undo3.coordinator.redo();
ok("redo 3 replays the seq-3 scene edit", undo3.scene.topSeq() === 3 && undo3.scene.objects[2] === "s3", `scene.topSeq()=${undo3.scene.topSeq()}`);
ok("redo is exhausted", undo3.coordinator.redo() === null);

// cross-store branch invalidation (A3): a new scene edit after the take was
// undone kills the take's redo branch
const env4 = makeTakeEnv();
const undo4 = createUndoStores({ sceneObjects: ["base"], onObjects() {}, read: env4.read, write: env4.write });
undo4.take.landTake(enrich(makePayload("branch"))); // seq 1
undo4.coordinator.undo(); // take undone, canRedo true
undo4.scene.applyAtomic((objects) => [...objects, "s1"]); // mints 2
ok("a new scene edit invalidates the take's redo branch", undo4.take.canRedo() === false && undo4.take.topRedoSeq() === undefined && undo4.take.depths().future === 0 && undo4.coordinator.redo() === null, `canRedo()=${undo4.take.canRedo()}`);

// a store reporting canUndo() === false is never chosen (the scene store
// cannot undo a take, and vice versa)
ok("a take landing is never undone by the scene store", (() => {
	const envX = makeTakeEnv();
	const undoX = createUndoStores({ sceneObjects: ["base"], onObjects() {}, read: envX.read, write: envX.write });
	undoX.take.landTake(enrich(makePayload("only-take"))); // seq 1
	const restored = undoX.coordinator.undo();
	return restored !== null && envX.fields().motion === null && undoX.scene.objects.length === 1;
})());

/* --------------------------- S3: canonical transforms --------------------- */
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
	"each subject's canonical transform reads its OWN clip (no cross-contamination)",
	safe(() => {
		const e = effectiveChars(base, {
			A: { anchorX: 1, anchorZ: 2, rotationDeg: 3, frames: 10 },
			B: { anchorX: 7, anchorZ: 8, rotationDeg: 9, frames: 10 },
		});
		return e.A.x === 1 && e.A.rot === 3 && e.B.x === 7 && e.B.rot === 9;
	}) === true,
	"A's clip never moves B, B's clip never moves A",
);
ok(
	"anyLoaded sees a clip in either slot",
	anyLoaded({ A: null, B: clip }) === true && anyLoaded({ A: null, B: null }) === false,
	`B-only=${anyLoaded({ A: null, B: clip })}, empty=${anyLoaded({ A: null, B: null })}`,
);

// Every §7.1 consumer reads the ONE derived pair. These scans are NON-GATING
// tripwires (finding 2): the rendered-rig/inspector claims are gated
// behaviourally in test/verify-app-render.mjs, the rest are unproven until U4.
trip(
	"App derives the canonical transforms once",
	(app.match(/effectiveChars\(/g) ?? []).length === 1,
	`behavioural gate: verify-app-render.mjs (rendered rig + inspector follow the canonical pair)  sites: ${(app.match(/effectiveChars\(/g) ?? []).length}`,
);
trip(
	"Character renders at the canonical transform",
	app.includes("position={[effectiveCharA.x, 0, effectiveCharA.z]}") &&
		app.includes("rot={effectiveCharA.rot}") &&
		app.includes("position={[effectiveCharB.x, 0, effectiveCharB.z]}") &&
		app.includes("rot={effectiveCharB.rot}"),
	"behavioural gate: verify-app-render.mjs (rig world rotation ignores raw char edits while a clip is loaded)",
);
trip(
	"ShotRig and PlanBoard both aim at the canonical transform",
	(app.match(/charA=\{effectiveCharA\}/g) ?? []).length >= 2 &&
		(app.match(/charB=\{effectiveCharB\}/g) ?? []).length >= 2,
	`unproven until U4  charA sites: ${(app.match(/charA=\{effectiveCharA\}/g) ?? []).length}, charB sites: ${(app.match(/charB=\{effectiveCharB\}/g) ?? []).length}`,
);
trip(
	"the inspector shows the canonical transform",
	app.includes("value={effectiveCharA}") && app.includes("value={effectiveCharB}"),
	"behavioural gate: verify-app-render.mjs (SubjectBox shows the canonical rot, not the raw edit)",
);
trip(
	"follow yaw reads the canonical transform",
	app.includes("const yaw = (effectiveCharA.rot * Math.PI) / 180;"),
	"unproven until U4",
);
trip(
	"deriveShot reads the canonical transform",
	app.includes("deriveShot(cameraPos, effectiveCharA,"),
	"unproven until U4",
);
trip(
	"subject dragging is disabled while a take is loaded",
	app.includes("takeLoaded ? noop : setCharA") && app.includes("takeLoaded ? noop : setCharB"),
	"unproven until U4",
);
trip("App.jsx never names the feature", !app.includes("ingest"), "static seam contract — tripwire only by nature");

/* ---- the wiring tripwires (NON-GATING): coordinator, take store, door, IK */
// The claims below are gated behaviourally in test/verify-app-render.mjs —
// a real browser drives the RENDERED app through its QA hooks. These scans
// only trace a behavioural regression to the drifted line; a PASS here is
// not capability proof, and a MISS never fails the suite.
trip(
	"the app creates the coordinator and BOTH stores through the factory",
	app.includes("createUndoStores(") && app.includes("const coordinator = storeRef.current.coordinator;") && app.includes("const takeStore = storeRef.current.take;"),
	"behavioural gate: verify-app-render.mjs (one Ctrl+Z interleaves across both live stores)",
);
trip(
	"keyboard undo/redo routes through the coordinator",
	app.includes("const restored = coordinator.undo();") && app.includes("const restored = coordinator.redo();"),
	"behavioural gate: verify-app-render.mjs (real Ctrl+Z / Ctrl+Shift+Z keys)",
);
trip(
	"the landing door decodes BOTH artifacts before landing",
	app.includes("const [a, b] = await Promise.all([decode(payload.a), decode(payload.b)]);") &&
		app.includes("takeStore.landTake("),
	"behavioural gate: verify-app-render.mjs (a landing writes both clip slots)",
);
trip(
	"the landing door is exposed on the QA hook for the surface host",
	app.includes("landTake,") && app.includes("motionB, tlFrame, ikMode"),
	"behavioural gate: verify-app-render.mjs (typeof window.__cozyclay.landTake and a real call)",
);
trip(
	"the take wiring writes both clip slots",
	app.includes('if ("motionB" in patch) setMotionB(patch.motionB);') &&
		app.includes('if ("trimB" in patch) setTrimB(patch.trimB);'),
	"behavioural gate: verify-app-render.mjs (motionB non-null after landing)",
);
trip(
	"the clear is one take-store entry through the DISTINCT clear op",
	app.includes("clearTakePayload(") &&
		app.includes("takeStore.clear(clearTakePayload(") &&
		!app.includes("takeStore.landTake(clearTakePayload("),
	"behavioural gate: verify-app-render.mjs (Clear clip button: one entry, one Ctrl+Z) and this file's clear-store sections",
);
trip(
	"clip state and IK state are keyed per subject",
	app.includes("ikStatesRef") && app.includes("ikStateFor(") && app.includes('const ikState = ikStateFor(ikSubject, ikStatesRef.current);'),
	"behavioural gate: verify-app-render.mjs (ik identity follows the selection) and this file's ikStateFor sections",
);
trip(
	"the IK evaluate effect uses the SELECTED subject's rig and clip",
	app.includes("if (!ikChains || !ikRig || posing) return;") &&
		app.includes("ikEvaluate(ikChains, ikState, tlFrame, ikFkJoints, ikClip ? IK_CORRECTION_BLEND_FRAMES : 0);"),
	"unproven until U4",
);
trip(
	"ARDY regeneration pins Subject 1's own key set",
	app.includes("const ikStateA = ikStateFor(\"A\", ikStatesRef.current);") && app.includes("ikEvaluate(ikChains, ikStateA, constraintFrame,"),
	"unproven until U4",
);
trip(
	"both clips persist under one storage key",
	app.includes('const CLIPS_STORAGE_KEY = "cozyclay.clips.v1";') &&
		app.includes("serializeClipState({ A: motion, B: motionB }") &&
		app.includes("deserializeClipState(localStorage.getItem(CLIPS_STORAGE_KEY))"),
	"behavioural gate: verify-app-render.mjs (the observed localStorage key survives a reload)",
);


/* ---------------------------- S7: per-subject IK --------------------------- */
// Correction keys must resolve chains from the SELECTED subject's rig: B
// with the real model resolves a full chain set, an empty B slot resolves
// null (the A-only resolveIkRig(rigA) seam is gone). Each subject's key
// state is separate, so baking a key for A never touches B's set.
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
// Behavioural isolation with the REAL rigs and the REAL ik functions: bake a
// key into A's state, assert B's state is untouched and vice versa.
const ikStates = { A: createIkState(), B: createIkState() };
ok("ikStateFor keys per subject", ikStateFor("A", ikStates) === ikStates.A && ikStateFor("B", ikStates) === ikStates.B && ikStateFor("C", ikStates) === null, "A/B/C");
const chainsA = safe(() => resolveSubjectIk("A", { A: rigA, B: rigB }));
safe(() => {
	ikTouch(ikStates.A, "leftHand");
	ikBakeKeyframe(chainsA.chains, ikStates.A, 30, chainsA.fkJoints);
});
ok(
	"A's key lands in A's state only",
	ikStates.A.keys.has(30) && ikStates.B.keys.size === 0,
	`A=${[...ikStates.A.keys.keys()]} B=${[...ikStates.B.keys.keys()]}`,
);
safe(() => {
	ikTouch(ikStates.B, "rightFoot");
	ikBakeKeyframe(chainsA.chains, ikStates.B, 45, chainsA.fkJoints);
});
ok(
	"B's key lands in B's state only",
	ikStates.B.keys.has(45) && !ikStates.A.keys.has(45) && ikStates.A.keys.size === 1,
	`A=${[...ikStates.A.keys.keys()]} B=${[...ikStates.B.keys.keys()]}`,
);
trip(
	"the ikSubject switch selects the rig",
	app.includes('const ikSubject = selectedHierarchyId === "characterB" ? "B" : "A";') &&
		app.includes('const ikRig = ikSubject === "B" ? rigB : rigA;'),
	"behavioural gate: verify-app-render.mjs (the keyed IK state identity follows the selection) + this file's resolveSubjectIk sections",
);
trip(
	"the A-only resolveIkRig(rigA) call seam is gone",
	(app.match(/resolveIkRig\(/g) ?? []).length === 1 && app.includes("resolveIkRig(ikRig)"),
	`static contract — tripwire only by nature  calls: ${(app.match(/resolveIkRig\(/g) ?? []).length}`,
);
trip(
	"the IK resolve effect follows the selected rig",
	app.includes("}, [ikRig]);"),
	"unproven until U4",
);

/* ----------------------------- S8: lane trim ------------------------------- */
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
	"trim clamps for BOTH subjects alike",
	safe(() => {
		const t = clampTrim({ start: -3, end: 999 }, { frames: 60 });
		return t.start === 0 && t.end === 59;
	}) === true,
	"Subject 2's clip bounds bind the same way",
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
trip(
	"Subject 2 owns a timeline lane",
	timeline.includes('"Subject 2"') && timeline.includes('const SUBJECT_2_LANE = "Subject 2";'),
	"unproven until U4",
);
trip(
	"both clips render their trimmed range on the timeline",
	timeline.includes("clipA") &&
		timeline.includes("clipB") &&
		timeline.includes("clipPct(clipA.start)") &&
		timeline.includes("clipPct(clipB.start)"),
	"unproven until U4",
);
trip(
	"both playback effects honor the trim",
	app.includes("playbackFrame(tlFrame, trimA)") && app.includes("playbackFrame(tlFrame, trimB)"),
	"unproven until U4",
);
trip(
	"trim edits clamp through the registry",
	app.includes("clampTrim("),
	"unproven until U4 (clampTrim itself: this file's S8 sections)",
);
trip(
	"loading a clip sets the full trim range",
	app.includes("setTrimA({ start: 0, end: decoded.frames - 1 })"),
	"unproven until U4",
);
trip(
	"the take wiring seeds both trims on landing and empties them on clear",
	registry.includes("trimA: { start: 0, end: motion.frames - 1 }") &&
		registry.includes("trimB: { start: 0, end: motionB.frames - 1 }") &&
		registry.includes("write({ motion: null, motionB: null, trimA: null, trimB: null"),
	"behavioural gate: this file's take-store sections (landing writes both trims; clear writes nulls)",
);

/* -------------------- persistence: state survives a reload ----------------- */
const persistedClip = {
	frames: 60,
	fps: 20,
	anchorX: 1.42,
	anchorZ: -0.31,
	anchorFrame: 0,
	rotationDeg: 0,
	url: "/ingest/artifacts/0123456789abcdef0123456789abcdef/track-a-req",
	rotMats: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
	rootPos: new Float32Array([0, 0.95, 0]),
	posedJoints: new Float32Array(27 * 3),
};
const persistedText = safe(() => serializeClipState({ A: persistedClip, B: null }, { A: { start: 2, end: 55 }, B: null }));
const restoredState = safe(() => deserializeClipState(persistedText));
ok(
	"both clips + trims survive a reload round-trip",
	restoredState !== null &&
		restoredState.A.clip.frames === 60 &&
		restoredState.A.clip.rotMats instanceof Float32Array &&
		restoredState.A.clip.rotMats[0] === 1 &&
		restoredState.A.clip.anchorX === 1.42 &&
		restoredState.A.clip.url.endsWith("track-a-req") &&
		restoredState.A.trim.start === 2 &&
		restoredState.A.trim.end === 55 &&
		restoredState.B.clip === null &&
		restoredState.B.trim === null,
	`A=${restoredState?.A.clip?.frames} trim=${restoredState?.A.trim?.start}..${restoredState?.A.trim?.end} B=${restoredState?.B.clip}`,
);
ok(
	"a Subject-2-only session restores Subject 2",
	safe(() => {
		const text = serializeClipState({ A: null, B: persistedClip }, { A: null, B: { start: 4, end: 40 } });
		const state = deserializeClipState(text);
		return state.A.clip === null && state.B.clip.frames === 60 && state.B.trim.end === 40;
	}) === true,
	"per-subject keys persist independently",
);
ok(
	"corrupt persisted state degrades to null, never crashes",
	deserializeClipState("not-json{") === null,
	"parse failure yields null",
);
ok(
	"an absent persisted state starts empty",
	deserializeClipState(null).A.clip === null && deserializeClipState(null).B.clip === null,
	"no key, no clips",
);

if (tripMissed.length) {
	// A missed tripwire is a WARN, never a failure (finding 2): the claim is
	// either still gated behaviourally (verify-app-render.mjs or the store
	// sections above) or declared unproven until U4 — see the header.
	console.log(`\nTRIPWIRE MISSES (non-gating, source drifted — trace the behavioural gate or report to U4): ${tripMissed.length}`);
	for (const label of tripMissed) console.log(`  - ${label}`);
}
if (fail.length) {
	console.log(`\nfailures: ${fail.length}`);
	process.exit(1);
}
console.log("all app seam checks PASS");
