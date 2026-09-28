import assert from 'node:assert/strict';
import { appFixture } from './app-fixture.mjs';
import { deferred } from './fixture.mjs';
const f = appFixture();
try {
 const completion = deferred();
 let context;
 f.stand.promptBlockCount = 1;
 f.actionHandlers.current.runAllPromptBlocks = value => { context = value; return completion.promise; };
 const started = await f.actual.runStudioAction('motion.generateAllBlocks');
 assert.equal(started?.status, 'started', JSON.stringify(started));
 assert.ok(context.signal instanceof AbortSignal);
 const event = new Promise(resolve => f.binding.bus.subscribe(e => { if (e.jobId === started.jobId) resolve(e); }));
 completion.resolve();
 assert.equal((await event).receipt.status, 'completed');
 const inputs = { type: 'object', properties: {}, required: [], additionalProperties: false };
 f.registry.register({ id: 'shot.nested', kind: 'mutation', undoDomain: 'shot', input: inputs, available: () => true,
  run: (_args, ctx) => { ctx.run('shot.create'); ctx.run('shot.create'); return { affectedIds: f.live.current.shots.map(s => s.id), summary: 'Two nested edits.' }; } });
 const before = f.history.current.past.length;
 const receipt = await f.actual.runStudioAction('shot.nested');
 assert.equal(receipt?.ok, true, JSON.stringify(receipt));
 assert.equal(f.history.current.past.length, before + 1);
 const undo = await f.binding.bus.run('edit.undo', { receiptId: receipt.receiptId }, { origin: 'ui' });
 assert.equal(undo.status, 'undone', JSON.stringify(undo));
 assert.equal(f.live.current.shots.length, 0);
} finally { f.dispose(); }
console.log('PASS bus native adapters: deferred generation lifecycle and nested atomic undo');
