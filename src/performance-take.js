// The atomic take store: one landed take plus the `before` snapshot of
// every App field it writes. landTake validates the §5 TakePayload
// contract, applies in one batch, and pushes exactly one history entry.
// No React, node-importable (the test seam).
import {
	createHistory,
	pushHistory,
	undoHistory,
	redoHistory,
	canUndo as historyCanUndo,
	canRedo as historyCanRedo,
} from "./history.js";
import { createSeqMirror } from "./undo-coordinator.js";

// The provenance block a complete take must carry (plan §5, §10.2).
const PROVENANCE_KEYS = ["command", "sourceUrl", "licence", "sourceSha256", "trimStartS", "trimEndS", "gvhmrCommit", "weightsSha256", "annotationPath"];

// Named-code rejection: a failed check reads nothing further, so
// landTake can never half-apply.
function validateTakePayload(payload) {
	if (payload === null || typeof payload !== "object") throw new Error("payload-not-object");
	if (typeof payload.requestId !== "string" || payload.requestId.length === 0) throw new Error("request-id-missing");
	const a = payload.a;
	const b = payload.b;
	if (a === null || typeof a !== "object" || b === null || typeof b !== "object") throw new Error("clips-missing");
	if (a.rotationDeg !== 0 || b.rotationDeg !== 0) throw new Error("rotation-deg-mismatch");
	if (a.fps !== 20 || b.fps !== 20) throw new Error("fps-not-20");
	if (!Number.isInteger(a.frames) || a.frames <= 0 || a.frames !== b.frames) throw new Error("frame-count-mismatch");
	for (const clip of [a, b]) {
		if (clip.provenance === null || typeof clip.provenance !== "object") throw new Error("provenance-incomplete");
		for (const key of PROVENANCE_KEYS) {
			if (clip.provenance[key] === undefined) throw new Error("provenance-incomplete");
		}
	}
	return payload;
}

export function createPerformanceTakeStore({ capture, apply, restore }, { coordinator }) {
	let history = createHistory(null);
	const seq = createSeqMirror();
	let registered = null;
	// The last accepted landing; a replayed requestId returns it verbatim
	// so a retry can never mint a second entry.
	let lastAck = null;

	function pushStamped(next) {
		const pushed = pushHistory(history, next);
		if (pushed === history) return;
		history = pushed;
		registered?.stamp();
	}
	const store = {
		// validate → replay-check → snapshot → apply → exactly one push.
		landTake(payload) {
			const value = validateTakePayload(payload);
			if (lastAck !== null && lastAck.requestId === value.requestId) return lastAck;
			const entry = { value, before: capture() };
			apply(value);
			lastAck = { requestId: value.requestId, value };
			pushStamped(entry);
			return lastAck;
		},

		value() {
			return history.present === null ? null : history.present.value;
		},

		undo() {
			const entry = history.present;
			const stepped = undoHistory(history);
			if (stepped === null) return null;
			history = stepped;
			seq.undo();
			restore(entry.before);
			return entry;
		},

		redo() {
			const stepped = redoHistory(history);
			if (stepped === null) return null;
			history = stepped;
			seq.redo();
			apply(stepped.present.value);
			return stepped.present;
		},

		canUndo() { return historyCanUndo(history); },
		canRedo() { return historyCanRedo(history); },
		depths() { return { past: history.past.length, future: history.future.length }; },
		stamp(id) { seq.push(id); },
		invalidateRedo() { history = { past: history.past, present: history.present, future: [] }; seq.invalidate(); },
		topSeq() { return seq.topSeq(); },
		topRedoSeq() { return seq.topRedoSeq(); },
	};
	if (coordinator) registered = coordinator.register({ id: "take", store });
	return store;
}
