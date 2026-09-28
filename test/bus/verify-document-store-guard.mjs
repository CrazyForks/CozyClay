import assert from 'node:assert/strict';
import { createDocumentStore } from '../../src/document-store.js';
import { createLegacyAdapter } from '../../src/store/legacy-adapter.js';
import { documentFixture } from './document-store-fixture.mjs';
import { deferred } from './fixture.mjs';

const { store, bus, run } = documentFixture();
try {
  assert.throws(() => store.write('stage', { intensity: 5 }), /bus run/);
  assert.equal(run('stage.set', { value: 5 }).ok, true);
  assert.throws(() => { store.read('stage').intensity = 6; }, TypeError);
  assert.throws(() => { store.getSnapshot().domainRevisions.stage = 0; }, TypeError);
  assert.throws(() => { store.history().past.length = 0; }, TypeError);
  const tx = store.beginAction('stage');
  assert.throws(() => store.write('stage', { intensity: 8 }), /bus run/);
  tx.update('stage', { intensity: 8 });
  tx.cancel();
  const finish = deferred();
  const pending = store.recordAction('stage', async () => {
    store.write('stage', { intensity: 9 });
    await finish.promise;
  });
  try { assert.throws(() => store.write('stage', { intensity: 10 }), /bus run/, 'an awaiting run must not authorize unrelated writes'); }
  finally { finish.resolve(); await pending; }
  assert.throws(() => createDocumentStore({ owned: { motion: { keys: new Map() } }, dev: true }), /plain authored/);
  const initial = { nested: { values: [1] } };
  const isolated = createDocumentStore({ owned: { stage: initial }, dev: true });
  initial.nested.values.push(2);
  assert.deepEqual(isolated.read('stage').nested.values, [1]);
  assert.throws(() => isolated.read('stage').nested.values.push(3), TypeError);
  const production = createDocumentStore({ owned: { stage: { intensity: 0 } }, dev: false });
  assert.doesNotThrow(() => production.write('stage', { intensity: 1 }));
  assert.equal(Object.isFrozen(production.read('stage')), false);
  let value = 0;
  const historyRef = { current: { past: [], future: [] } };
  const port = { read: () => value, write: next => { value = next; }, historyRef,
    recordUndo: () => historyRef.current.past.push({ snapshot: value }) };
  const legacy = createLegacyAdapter({ cast: port, stage: port });
  const mixed = createDocumentStore({ owned: { stage: {} }, legacy, dev: true });
  assert.doesNotThrow(() => mixed.write('cast', 1));
  assert.throws(() => legacy.write('stage', 2), /store-owned/);
  assert.equal(value, 1);
  mixed.dispose(); legacy.dispose();
} finally { bus.dispose(); }
console.log('PASS document store 5: per-domain bus guard, immutable dev snapshots and no async permission leak');
