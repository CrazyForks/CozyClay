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
 const event = deferred();
 f.binding.bus.subscribe(e => { if (e.jobId === started.jobId) event.resolve(e); });
 const timeout = setTimeout(() => event.reject(new Error('job completion event deadline')), 5000);
 completion.resolve();
 try { assert.equal((await event.promise).receipt.status, 'completed'); }
 finally { clearTimeout(timeout); }
 const inputs = { type: 'object', properties: {}, required: [], additionalProperties: false };
 f.registry.register({ id: 'shot.nested', kind: 'mutation', undoDomain: 'shot', input: inputs, available: () => true,
  run: (_args, ctx) => { const created = ctx.run('shot.create'); ctx.run('shot.setCameraRail', { shotId: created.affectedIds[0], points: [{ x: -2, z: 4 }, { x: 2, z: 4 }] }); return { affectedIds: f.live.current.shots.map(s => s.id), summary: 'Two nested edits.' }; } });
 const before = f.scope.shotsDomain.documentStore.depths().past;
 const receipt = await f.actual.runStudioAction('shot.nested');
 assert.equal(receipt?.ok, true, JSON.stringify(receipt));
 assert.equal(f.scope.shotsDomain.documentStore.depths().past, before + 1);
 assert.equal(f.history.current.past.length, 0, 'nested shots do not add native cast entries');
 const undo = await f.binding.bus.run('edit.undo', { receiptId: receipt.receiptId }, { origin: 'ui' });
 assert.equal(undo.status, 'undone', JSON.stringify(undo));
 assert.equal(f.live.current.shots.length, 0);
} finally { f.dispose(); }
console.log('PASS bus native adapters: deferred generation lifecycle and nested atomic undo');
