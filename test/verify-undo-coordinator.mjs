#!/usr/bin/env node
/**
 * Cross-store undo interleaving (plan §7.3): the coordinator mints one
 * sequence id per real push and routes undo/redo to the store owning the
 * most recent entry, so scene edits and landed takes undo in landing
 * order, and a new edit invalidates every other store's redo. The
 * concrete sequence values 1/2/3 are asserted literally.
 *
 * What would be circular: reading the stores' private seq mirrors — the
 * mirror invariant is asserted behaviourally (topSeq/topRedoSeq after
 * every step, and the undo-present pairing at the HISTORY_LIMIT cap).
 */
import { createUndoCoordinator } from "../src/undo-coordinator.js";
import { createSceneHistoryStore } from "../src/scene-history.js";
import { createPerformanceTakeStore } from "../src/performance-take.js";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

// Fake App fields the take store writes, with counting spies so "applied
// exactly once per landing" and "restored on undo" are assertable.
function makeTakeWiring() {
	const fields = { take: null, clipA: null, clipB: null, dragging: true };
	const calls = { capture: 0, apply: 0, restore: 0 };
	const wiring = {
		capture() {
			calls.capture += 1;
			return { ...fields };
		},
		apply(value) {
			calls.apply += 1;
			fields.take = value;
		},
		restore(snapshot) {
			calls.restore += 1;
			Object.assign(fields, snapshot);
		},
	};
	return { fields, calls, wiring };
}

// A valid §5 TakePayload: both clips upright at 0°, 20 fps, equal frame
// counts, complete provenance.
function makePayload(requestId) {
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
			annotationPath: `/ingest/artifacts/0123456789abcdef0123456789abcdef/annotation-${track}.json`,
		},
	});
	return { requestId, a: clip("a"), b: clip("b") };
}

/* ------------------- branch invalidation (A3, plan §7.3) ------------ */

const coordinator = createUndoCoordinator();
const scene = createSceneHistoryStore(["base"], { coordinator, onObjects() {} });
const takeEnv = makeTakeWiring();
const take = createPerformanceTakeStore(takeEnv.wiring, { coordinator });
// The registration holds the store object, so counting what the
// coordinator calls is done by wrapping the public method.
const originalInvalidate = take.invalidateRedo;
let takeInvalidations = 0;
take.invalidateRedo = () => {
	takeInvalidations += 1;
	originalInvalidate();
};

scene.applyAtomic((objects) => ["base", "s1"]); // mints 1
ok("scene edit mints 1", coordinator.sequence() === 1, `sequence()=${coordinator.sequence()}`);
take.landTake(makePayload("branch-req")); // mints 2
ok("land take mints 2", coordinator.sequence() === 2, `sequence()=${coordinator.sequence()}`);
ok("undo picks the take store (2 > 1)", (() => {
	coordinator.undo();
	return take.value() === null && takeEnv.fields.take === null && takeEnv.calls.restore === 1;
})());
ok("the undone take can redo", take.canRedo() === true && take.topRedoSeq() === 2, `canRedo()=${take.canRedo()} topRedoSeq()=${take.topRedoSeq()}`);
coordinator.undo(); // scene undone (1)
const beforeMint3 = takeInvalidations;
scene.applyAtomic((objects) => ["base", "s1", "s3"]); // mints 3
ok("after branching, take.canRedo() expected false, got true (redo not invalidated cross-store)", take.canRedo() === false, `canRedo()=${take.canRedo()} topRedoSeq()=${take.topRedoSeq()}`);
ok("the take's redo stack is empty after the branch", take.topRedoSeq() === undefined && take.depths().future === 0, `topRedoSeq()=${take.topRedoSeq()}`);
ok("invalidateRedo() was invoked exactly once on the take store", takeInvalidations === beforeMint3 + 1, `invocations=${takeInvalidations - beforeMint3}`);
ok("invalidateRedo() runs on the non-pusher at every mint, empty future or not", takeInvalidations === 2, `invocations=${takeInvalidations}`);
ok("the pushing store's future is empty too", scene.canRedo() === false && scene.topRedoSeq() === undefined && scene.depths().future === 0, `canRedo()=${scene.canRedo()}`);
ok("coordinator.redo() returns null after the branch", coordinator.redo() === null);

/* ----------------- concrete interleaving (plan §7.3 values) --------- */

const coordinator2 = createUndoCoordinator();
const scene2 = createSceneHistoryStore(["base"], { coordinator: coordinator2, onObjects() {} });
const takeEnv2 = makeTakeWiring();
const take2 = createPerformanceTakeStore(takeEnv2.wiring, { coordinator: coordinator2 });

scene2.applyAtomic((objects) => ["base", "s1"]); // seq 1
take2.landTake(makePayload("interleave")); // seq 2
scene2.applyAtomic((objects) => ["base", "s1", "s3"]); // seq 3
ok("scene edit mints 1; land take mints 2; scene edit mints 3", coordinator2.sequence() === 3, `sequence()=${coordinator2.sequence()}`);
ok("scene.topSeq() === 3", scene2.topSeq() === 3, `topSeq()=${scene2.topSeq()}`);
ok("take.topSeq() === 2", take2.topSeq() === 2, `topSeq()=${take2.topSeq()}`);
ok("ids are never re-minted", coordinator2.sequence() === 3 && scene2.depths().past === 2 && take2.depths().past === 1, `sequence()=${coordinator2.sequence()}`);

// undo → scene (3 > 2)
const undoneScene = coordinator2.undo();
ok("undo picks the scene store (3 > 2)", undoneScene !== null && undoneScene[1] === "s1" && scene2.objects[1] === "s1");
ok("scene.topSeq() === 1", scene2.topSeq() === 1, `topSeq()=${scene2.topSeq()}`);
ok("scene.topRedoSeq() === 3", scene2.topRedoSeq() === 3, `topRedoSeq()=${scene2.topRedoSeq()}`);

// undo → take (2 > 1)
coordinator2.undo();
ok("undo picks the take store (2 > 1)", take2.value() === null && takeEnv2.fields.take === null && scene2.objects[1] === "s1");
ok("the take's seq moved to its redo stack", take2.topSeq() === undefined && take2.topRedoSeq() === 2 && take2.canUndo() === false, `topSeq()=${take2.topSeq()} topRedoSeq()=${take2.topRedoSeq()}`);

// undo → scene (1)
coordinator2.undo();
ok("undo picks the scene store (1)", scene2.objects.length === 1 && scene2.objects[0] === "base" && scene2.topSeq() === undefined, `topSeq()=${scene2.topSeq()}`);

// redo ×3 replays 1, 2, 3 in that order
coordinator2.redo();
ok("redo 1 replays the seq-1 scene edit", scene2.topSeq() === 1 && scene2.objects[1] === "s1", `topSeq()=${scene2.topSeq()}`);
coordinator2.redo();
ok("redo 2 replays the seq-2 landing", take2.topSeq() === 2 && take2.value() !== null && take2.value().requestId === "interleave", `topSeq()=${take2.topSeq()}`);
coordinator2.redo();
ok("redo 3 replays the seq-3 scene edit", scene2.topSeq() === 3 && scene2.objects[1] === "s1" && scene2.objects[2] === "s3", `topSeq()=${scene2.topSeq()}`);
ok("redo is exhausted", coordinator2.redo() === null && scene2.topRedoSeq() === undefined && take2.topRedoSeq() === undefined);

/* -------------------- coalescing mints nothing ---------------------- */

const beforeNoop = coordinator2.sequence();
scene2.applyAtomic((objects) => objects); // same reference: coalesced
ok("a coalesced no-op scene edit mints nothing", coordinator2.sequence() === beforeNoop, `sequence()=${coordinator2.sequence()}`);
ok("the no-op perturbs no ordering", scene2.topSeq() === 3 && take2.topSeq() === 2 && scene2.depths().past === 2 && scene2.depths().future === 0, `scene.topSeq()=${scene2.topSeq()} take.topSeq()=${take2.topSeq()}`);

/* ------------- a store that cannot undo is never chosen -------------- */

const coordinator3 = createUndoCoordinator();
const scene3 = createSceneHistoryStore(["base"], { coordinator: coordinator3, onObjects() {} });
const ghost = {
	stamp() {},
	invalidateRedo() {},
	canUndo() {
		return false;
	},
	canRedo() {
		return false;
	},
	undo() {
		throw new Error("ghost store was chosen for undo");
	},
	redo() {
		throw new Error("ghost store was chosen for redo");
	},
	topSeq() {
		return 999;
	},
	topRedoSeq() {
		return 0;
	},
};
coordinator3.register({ id: "ghost", store: ghost });
scene3.applyAtomic((objects) => ["base", "s1"]);
ok("a store reporting canUndo() === false is never chosen", coordinator3.undo() !== null && scene3.objects[0] === "base" && scene3.topRedoSeq() === 1);
ok("a store reporting canRedo() === false is never chosen", coordinator3.redo() !== null && scene3.objects[1] === "s1");
/* --------- the other two push sites mint exactly once (§7.3) --------- */

const coordinator5 = createUndoCoordinator();
const scene5 = createSceneHistoryStore(["base"], { coordinator: coordinator5, onObjects() {} });
const token5 = scene5.begin("drag", () => {});
scene5.applyIn(token5, () => ["base", "mid"]);
scene5.end(token5, { commit: true });
ok("a committed drag mints exactly one sequence", coordinator5.sequence() === 1 && scene5.depths().past === 1 && scene5.topSeq() === 1, `sequence()=${coordinator5.sequence()}`);
const token5b = scene5.begin("drag2", () => {});
scene5.applyIn(token5b, () => ["base", "mid", "travel"]);
scene5.settle();
ok("a settle mints exactly one sequence", coordinator5.sequence() === 2 && scene5.depths().past === 2 && scene5.topSeq() === 2, `sequence()=${coordinator5.sequence()}`);
const token5c = scene5.begin("noop", () => {});
scene5.end(token5c, { commit: true });
ok("a committed no-op drag mints nothing", coordinator5.sequence() === 2 && scene5.depths().past === 2 && scene5.topSeq() === 2, `sequence()=${coordinator5.sequence()}`);
const token5d = scene5.begin("drag3", () => {});
scene5.applyIn(token5d, () => ["base", "mid", "travel", "more"]);
coordinator5.undo();
ok("undo mid-drag settles the drag then undoes it", coordinator5.sequence() === 3 && scene5.topSeq() === 2 && scene5.topRedoSeq() === 3 && scene5.objects[2] === "travel", `sequence()=${coordinator5.sequence()} topSeq()=${scene5.topSeq()}`);

/* --------------- HISTORY_LIMIT keeps seqPast aligned ---------------- */

const coordinator4 = createUndoCoordinator();
const scene4 = createSceneHistoryStore(["v0"], { coordinator: coordinator4, onObjects() {} });
for (let i = 1; i <= 51; i += 1) scene4.applyAtomic(() => [`v${i}`]);
ok("the 51st push trims history.past to HISTORY_LIMIT", scene4.depths().past === 50, `past=${scene4.depths().past}`);
ok("topSeq() is the 51st mint", scene4.topSeq() === 51, `topSeq()=${scene4.topSeq()}`);
// Each undo must return the present whose sequence was on top: the
// pairing v(k-1) ↔ seq k is the index alignment of seqPast and past.
let undos = 0;
let aligned = true;
while (scene4.canUndo()) {
	const top = scene4.topSeq();
	const present = scene4.undo();
	undos += 1;
	if (present === null || present[0] !== `v${top - 1}`) aligned = false;
}
ok("every undo pops the seq-paired present (seqPast ↔ history.past)", aligned, `undos=${undos}`);
ok("50 undos exhaust the trimmed stacks", undos === 50 && scene4.topSeq() === undefined && scene4.canUndo() === false && scene4.undo() === null && scene4.depths().past === 0, `undos=${undos}`);

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
