// The single mutation owner for scene objects. All four producer classes —
// gizmo, plan board, inspector number scrubs, one-shot hierarchy/inspector
// atomics — mutate through this store so a drag becomes exactly ONE undo
// entry and can be cancelled. No React, node-importable (the test seam).
import {
	createHistory,
	pushHistory,
	undoHistory,
	redoHistory,
	canUndo as historyCanUndo,
	canRedo as historyCanRedo,
	createTransactions,
	beginTransaction,
	isCurrentTransaction,
	endTransaction,
	settleTransaction,
} from "./history.js";
import { createSeqMirror } from "./undo-coordinator.js";

// Invariant, stated once: whenever no transaction is open,
// `store.present()` is reference-equal to `store.objects`. `history` is
// assigned in exactly four places — applyAtomic, end(commit:true), settle,
// and undo/redo — and every one pushes or steps to the POST-change present.
export function createSceneHistoryStore(initialObjects, { onObjects, coordinator }) {
	let objects = initialObjects;
	let history = createHistory(initialObjects);
	const tx = createTransactions();
	let before = null;
	// Seq mirrors; without a coordinator nothing is minted or moved.
	const seq = createSeqMirror();
	let registered = null;

	function emit(next) {
		objects = next;
		onObjects?.(next);
	}
	// pushHistory coalesces by reference; only a real entry mints.
	function pushStamped(next) {
		const pushed = pushHistory(history, next);
		if (pushed === history) return;
		history = pushed;
		registered?.stamp();
	}
	// A settle is triggered by the user starting something else; the
	// travel already applied is real and becomes its own entry, so the
	// very next Ctrl+Z discards it deliberately.
	function settle() {
		if (settleTransaction(tx) === null) return;
		pushStamped(objects);
		before = null;
	}
	const store = {
		get objects() {
			return objects;
		},

		// Public so the present === objects invariant is assertable from
		// Node and from QA without touching private state.
		present() {
			return history.present;
		},

		// Settle any open drag first, then apply one atomic mutation. A fn
		// that returns the same array creates no entry (coalescing).
		applyAtomic(fn) {
			settle();
			const next = fn(objects);
			if (next === objects) return;
			emit(next);
			pushStamped(next);
		},

		// Settle first so a nested begin commits the previous drag as ONE
		// entry; history is not touched at begin.
		begin(owner, cancel) {
			settle();
			before = objects;
			return beginTransaction(tx, { owner, cancel });
		},

		// Stream applies land on the live array only while the token is the
		// current transaction; history is not touched here.
		applyIn(token, fn) {
			if (!isCurrentTransaction(tx, token)) return;
			const next = fn(objects);
			if (next === objects) return;
			emit(next);
		},

		end(token, { commit }) {
			if (!endTransaction(tx, token)) return false;
			if (commit) {
				// pushHistory coalesces: nothing applied pushes nothing.
				pushStamped(objects);
			} else {
				// Rollback restores the whole pre-drag array by reference —
				// strictly more correct than replaying one record.
				emit(before);
			}
			before = null;
			return true;
		},

		settle,

		undo() {
			settle();
			const stepped = undoHistory(history);
			if (stepped === null) return null;
			history = stepped;
			seq.undo();
			emit(stepped.present);
			return stepped.present;
		},

		redo() {
			settle();
			const stepped = redoHistory(history);
			if (stepped === null) return null;
			history = stepped;
			seq.redo();
			emit(stepped.present);
			return stepped.present;
		},

		// The coordinator's prepare phase (Finding 4): settle any open
		// transaction so eligibility is judged AFTER the travel is a real
		// entry. Idempotent — undo()/redo() settle again as a no-op.
		prepare() {
			settle();
		},

		canUndo() {
			return historyCanUndo(history);
		},

		canRedo() {
			return historyCanRedo(history);
		},

		depths() {
			return { past: history.past.length, future: history.future.length };
		},
		stamp(id) { seq.push(id); },
		invalidateRedo() { history = { past: history.past, present: history.present, future: [] }; seq.invalidate(); },
		topSeq() { return seq.topSeq(); },
		topRedoSeq() { return seq.topRedoSeq(); },
	};
	if (coordinator) registered = coordinator.register({ id: "scene", store });
	return store;
}
