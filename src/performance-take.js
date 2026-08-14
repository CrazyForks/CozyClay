// The atomic take store: one landed take plus the `before` snapshot of
// every App field it writes. landTake validates the §5 TakePayload
// contract, applies in one batch, and pushes exactly one history entry;
// every accepted requestId is retained for the store's lifetime in a
// bounded table that refuses at its ceiling rather than evicting —
// eviction is exactly what lets a delayed retry land twice. No React,
// node-importable (the test seam).
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

// Idempotency ceiling (§12.2's pattern, at the store's own layer): a
// NEW requestId at the ceiling is refused by name, never evicted. The
// adapter's session table (src/surface-host.js) is the session
// authority; this table is the store-level guard, and being stricter —
// it also refuses a replay of an already-landed id after a surface
// reload — only ever swallows a protocol violation, never a legitimate
// first landing. Each record holds the accepted payload, so the bound
// matters: 10 000 × ~1-2 KB is a bounded worst case, and refusing
// keeps it that way.
const REQUEST_TABLE_BUDGET = 10000;

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
	// requestId -> { requestId, value }: every accepted landing, never
	// evicted. A replay returns the cached ack verbatim so it can never
	// mint a second entry; at the ceiling a NEW id is refused by name
	// (request-table-exhausted) instead of evicting an old one.
	const accepted = new Map();

	function pushStamped(next) {
		const pushed = pushHistory(history, next);
		if (pushed === history) return;
		history = pushed;
		registered?.stamp();
	}
	const store = {
		// validate → replay-check → budget-check → snapshot → apply →
		// exactly one push.
		landTake(payload) {
			const value = validateTakePayload(payload);
			const cached = accepted.get(value.requestId);
			if (cached !== undefined) return cached;
			if (accepted.size >= REQUEST_TABLE_BUDGET) throw new Error("request-table-exhausted");
			const entry = { value, before: capture() };
			apply(value);
			const ack = { requestId: value.requestId, value };
			accepted.set(value.requestId, ack);
			pushStamped(entry);
			return ack;
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
