import assert from 'node:assert/strict';
import { collectionFixture } from './collection-fixture.mjs';
import { register } from './tool-alias-fixture.mjs';
import * as planners from '../../src/studio-agent-commands.js';
const f = collectionFixture();
try {
  assert.equal(typeof f.registry.registerToolAlias, 'function', 'modules need an alias registration port');
  register(f.registry);
  assert.equal(f.registry.toolAlias('frame_shot').action, 'shot.frame', 'the shipped shot alias remains registered');
  const request = f.request('arrange_characters', { item: 'item-b', amount: 8 });
  const receipt = f.binding.handlers.arrange_characters(request);
  assert.equal(receipt.status, 'applied', JSON.stringify(receipt));
  assert.equal(receipt.action, 'fixtureItem.set');
  assert.equal(f.domain.read()[1].amount, 8);
  assert.deepEqual(f.binding.handlers.arrange_characters(request), receipt, 'aliases keep bus idempotency');
  assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }).status, 'undone');
  assert.equal(f.domain.read()[1].amount, 2);
  assert.equal(f.binding.handlers.arrange_characters({ ...request, commandId: crypto.randomUUID(), expectedRevision: -1 }).code, 'STALE_SCENE');
  assert.equal(typeof planners.arrangement, 'function');
  assert.equal(typeof planners.frameDraft, 'function');
  assert.throws(() => register(f.registry), /already registered/);
  console.log('PASS #480.3 module-owned tool alias, bus fencing/replay/undo and reusable planners');
} finally { f.dispose(); }
