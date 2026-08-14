// The global undo authority: mints one sequence id per real push and
// routes undo/redo to the store owning the most recent entry. No scene
// knowledge, no React — node-importable so cross-store interleaving is
// unit-testable.
import { HISTORY_LIMIT } from "./history.js";

// Per-store mirror of history.past / history.future. Ids move between
// the stacks on undo/redo; they are never re-minted.
export function createSeqMirror() {
	const past = [];
	const future = [];
	return {
		push(id) {
			past.push(id);
			future.length = 0;
			// pushHistory trims past at HISTORY_LIMIT; shift in lockstep
			// so seqPast[i] keeps pairing with history.past[i].
			if (past.length > HISTORY_LIMIT) past.shift();
		},
		undo() {
			const id = past.pop();
			if (id !== undefined) future.unshift(id);
		},
		redo() {
			const id = future.shift();
			if (id !== undefined) past.push(id);
		},
		invalidate() {
			future.length = 0;
		},
		topSeq() {
			return past[past.length - 1];
		},
		topRedoSeq() {
			return future[0];
		},
	};
}

export function createUndoCoordinator() {
	let nextSeq = 0;
	const stores = [];
	return {
		// The store brings id plus the seven-handler contract (prepare,
		// canUndo, canRedo, undo, redo, invalidateRedo) and the seq
		// accessors; the returned stamp() is the ONLY minting path.
		register({ id, store }) {
			const entry = { id, store };
			stores.push(entry);
			return {
				stamp() {
					nextSeq += 1;
					// A new branch invalidates every OTHER store's redo
					// before the new id is recorded, atomically (A3).
					for (const other of stores) {
						if (other !== entry) other.store.invalidateRedo();
					}
					entry.store.stamp(nextSeq);
					return nextSeq;
				},
			};
		},

		// The most recent entry wins: greatest topSeq among undoable.
		// The prepare phase runs BEFORE eligibility: a store with an open
		// transaction settles it here and becomes eligible. The settle
		// mints the open travel as a real entry, so the very FIRST
		// mid-drag undo works — checking canUndo() first would see an
		// empty history, return null, and leave the travel applied with
		// nothing to undo. redo() deliberately does NOT prepare: settling
		// mid-drag would commit the travel and kill the live drag token
		// while the user only asked for a redo.
		undo() {
			for (const s of stores) s.store.prepare();
			let pick = null;
			for (const s of stores) {
				if (!s.store.canUndo()) continue;
				if (pick === null || s.store.topSeq() > pick.store.topSeq()) pick = s;
			}
			return pick === null ? null : pick.store.undo();
		},

		// The oldest branch first: least topRedoSeq among redoable.
		redo() {
			let pick = null;
			for (const s of stores) {
				if (!s.store.canRedo()) continue;
				if (pick === null || s.store.topRedoSeq() < pick.store.topRedoSeq()) pick = s;
			}
			return pick === null ? null : pick.store.redo();
		},

		// Read-only counter: a coalesced no-op must leave it unchanged.
		sequence() {
			return nextSeq;
		},
	};
}
