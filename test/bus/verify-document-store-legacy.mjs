import assert from 'node:assert/strict';
import { createDocumentStore } from '../../src/document-store.js';
import { createLegacyAdapter } from '../../src/store/legacy-adapter.js';
import { HISTORY_LIMIT } from '../../src/history.js';

// These are the React/live-ref and charHistoryRef ports, not a second store.
let reactState = { name: 'Actor' };
const historyRef = { current: { past: [], future: [] } };
let records = 0;
const legacy = createLegacyAdapter({ cast: {
  read: () => reactState, write: value => { reactState = value; }, historyRef,
  recordUndo() {
    records++;
    historyRef.current.past.push({ tick: records, snapshot: reactState });
    historyRef.current.past = historyRef.current.past.slice(-HISTORY_LIMIT);
    historyRef.current.future = [];
  },
  undo() { const entry = historyRef.current.past.pop(); historyRef.current.future.push({ ...entry, snapshot: reactState }); reactState = entry.snapshot; },
  redo() { const entry = historyRef.current.future.pop(); historyRef.current.past.push({ ...entry, snapshot: reactState }); reactState = entry.snapshot; },
} });
const store = createDocumentStore({ legacy, dev: true });
const before = reactState;
store.write('cast', current => ({ ...current, name: 'Edited' }));
assert.equal(reactState.name, 'Edited');
assert.equal(records, 1);
assert.equal(historyRef.current.past[0].snapshot, before);
assert.equal(store.read('cast'), reactState);
assert.equal(store.owns('cast'), false);
assert.deepEqual(store.getSnapshot().slices, {});
assert.ok([...store.history().past, store.history().present].every(entry => !Object.hasOwn(entry.snapshot, 'cast')));
reactState = { name: 'External React update' };
assert.equal(store.read('cast'), reactState, 'reads never use a cached legacy copy');
const tx = store.beginAction('cast');
tx.run(() => store.write('cast', { name: 'Preview A' }));
tx.run(() => store.write('cast', { name: 'Preview B' }));
assert.equal(records, 2, 'a legacy session records native undo only once');
tx.cancel();
assert.equal(reactState.name, 'External React update');
assert.equal(historyRef.current.past.length, 1);
assert.deepEqual(store.getSnapshot().slices, {});
store.dispose();
console.log('PASS document store 4: legacy writes reach React and native history without a stored domain copy');
