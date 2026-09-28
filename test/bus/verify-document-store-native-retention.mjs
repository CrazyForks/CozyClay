import assert from 'node:assert/strict';
import { createSceneHistoryStore } from '../../src/scene-history.js';
import { sceneHistoryDomain } from '../../src/store/legacy-adapter.js';
import { HISTORY_LIMIT } from '../../src/history.js';

const scene = createSceneHistoryStore([], {}), port = sceneHistoryDomain(scene);
function edit(value) {
  const session = port.beginAction();
  session.run(() => port.write([{ id: 'cube', x: value }]));
  return session.commit().historyEntryId;
}
const abandoned = edit(1);
assert.equal(port.isRetained(abandoned), true);
port.undo();
assert.equal(port.isRetained(abandoned), true, 'the native redo path retains both images');
const first = edit(2);
assert.equal(port.isRetained(abandoned), false, 'a surviving pre-image does not retain a discarded redo transition');
for (let index = 2; index <= HISTORY_LIMIT; index++) edit(index + 1);
assert.equal(port.isRetained(first), true);
const last = edit(52);
assert.equal(port.isRetained(first), false, 'native cap also expires exactly at entry 51');
assert.equal(port.canUndo(last), true);
port.undo();
assert.equal(port.canRedo(last), true);
port.redo();
assert.equal(scene.objects[0].x, 52);
console.log('PASS document store native retention: discarded redo identities expire and both images bound retention');
