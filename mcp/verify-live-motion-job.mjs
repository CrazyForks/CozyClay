#!/usr/bin/env node
// MCP stdio -> real live socket -> shipped editor binding, motion owner and bus.
// The retired server job registry/load acknowledgements are intentionally gone.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocket } from 'ws';
import { createLiveControl } from '../src/live-control.js';
import { generationFixture, motionBytes } from '../test/bus/generation-fixture.mjs';
const bounded = promise => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP motion event deadline')), 15000); })]).finally(() => clearTimeout(timer)); };
const port = Number(process.env.COZYCLAY_LIVE_PORT);
assert.ok(port > 0, 'COZYCLAY_LIVE_PORT must be explicit');
const f = generationFixture(), originalFetch = globalThis.fetch;
const client = new Client({ name: 'verify-bus-motion', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url)), '--live-port', String(port)], env: { ...process.env, COZYCLAY_LIVE_PORT: String(port) } });
let socket, control, handle, mode = 'ok', entered, release, generations = 0;
const wire = [], events = [];
const unsubscribe = f.binding.bus.subscribe(event => events.push(event));
globalThis.fetch = async (url, options) => {
  if (url === '/ardy/generate') {
    generations++; entered?.resolve();
    if (mode === 'held') await release.promise;
    if (mode === 'failure') return new Response(JSON.stringify({ event: 'error', message: 'fixture generation failed' }) + '\n');
    return new Response(JSON.stringify({ event: 'done', motionUrl: '/ardy/motions/123456-abcdef' }) + '\n');
  }
  if (url === '/ardy/motions/123456-abcdef') return new Response(motionBytes);
  return originalFetch(url, options);
};
async function connect() {
  const ready = Promise.withResolvers();
  control = createLiveControl({ url: `ws://127.0.0.1:${port}/live`, workspaceId: f.host().workspaceId,
    WebSocketImpl: class extends WebSocket { constructor(url) { super(url); socket = this; } },
    onWorkspace: ready.resolve, handlers: f.binding.handlers });
  socket.on('message', raw => { const frame = JSON.parse(raw); if (frame.type === 'cmd') wire.push(frame); });
  handle = await bounded(ready.promise);
}
async function call(name, args = {}) {
  const response = await bounded(client.callTool({ name, arguments: { ...args, workspace_handle: handle } }));
  return JSON.parse(response.content[0].text);
}
const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
const run = (action, args) => call('studio_run', { action, args });
try {
  await client.connect(transport); await connect();
  const before = f.snapshot();
  const generated = ok(await call('generate_motion', { phases: [{ text: 'A person walks.', seconds: 4 }], seed: 17 }));
  const installed = generated.status === 'started' ? ok(await run('job.await', { jobId: generated.jobId })) : generated;
  assert.equal(installed.action, 'motion.generate'); assert.equal(installed.undo.entries, 1);
  assert.equal(f.motion.motionFor('actor-a').frames, 96); assert.equal(generations, 1);
  assert.equal(wire.some(frame => frame.name === 'load_motion'), false);
  assert.equal(ok(await run('edit.undo', { receiptId: installed.receiptId })).status, 'undone');
  assert.deepEqual(f.snapshot(), before);

  const reused = ok(await call('generate_motion', { phases: [{ text: 'A person falls.', seconds: 4 }], motion_url: '/ardy/motions/123456-abcdef', drop: { from_s: 0.5, to_s: 2, meters: 2 } }));
  assert.equal(reused.action, 'motion.replace'); assert.equal(generations, 1, 'reuse never starts the generator');
  assert.equal(f.cast.read()[0].layer.promptClips.at(-1).endFrame, 96);
  const take = f.motion.motionFor('actor-a'); assert.ok(take.rootPos[72 * 3 + 1] < take.rootPos[1] - 1);
  ok(await run('edit.undo', { receiptId: reused.receiptId })); assert.deepEqual(f.snapshot(), before);

  // A disconnected transport does not create a second installation owner.
  mode = 'held'; entered = Promise.withResolvers(); release = Promise.withResolvers();
  const pending = call('generate_motion', { phases: ['A person walks.'], seconds: 4 });
  await bounded(entered.promise);
  const started = ok(await pending); assert.equal(started.status, 'started');
  const closed = once(socket, 'close'); control.close(); await bounded(closed); await connect();
  const completion = run('job.await', { jobId: started.jobId });
  release.resolve(); const recovered = ok(await completion);
  assert.equal(recovered.jobId, started.jobId); assert.equal(recovered.undo.entries, 1);
  assert.equal(events.filter(event => event.jobId === started.jobId && event.type === 'job.completed').length, 1);
  ok(await run('edit.undo', { receiptId: recovered.receiptId })); assert.deepEqual(f.snapshot(), before);

  entered = Promise.withResolvers(); release = Promise.withResolvers();
  const cancelledCall = call('generate_motion', { phases: ['A person walks.'], seconds: 4 });
  await bounded(entered.promise); const cancellable = ok(await cancelledCall);
  const cancelled = await run('job.cancel', { jobId: cancellable.jobId }); assert.equal(cancelled.code, 'CANCELLED');
  release.resolve(); assert.equal((await run('job.await', { jobId: cancellable.jobId })).code, 'CANCELLED');
  assert.equal(f.motion.motionFor('actor-a'), null);

  // Settle the actual producer, rather than racing cancellation cleanup.
  await bounded(new Promise(resolve => {
    const original = f.scope.generationPendingRef;
    if (!original.current) return resolve();
    let current = original.current;
    Object.defineProperty(original, 'current', { configurable: true, get: () => current, set(value) { current = value; if (!value) resolve(); } });
  }));
  mode = 'failure';
  const failed = await call('generate_motion', { phases: ['A person walks.'], seconds: 4 });
  const failure = failed.status === 'started' ? await run('job.await', { jobId: failed.jobId }) : failed;
  assert.equal(failure.ok, false); assert.equal(f.motion.motionFor('actor-a'), null);
  assert.equal(wire.filter(frame => frame.name === 'run_action').every(frame => frame.args.commandId && frame.args.host && Number.isInteger(frame.args.expectedRevision)), true);
  console.log('PASS MCP live motion: bus receipt, one undo, block/drop reuse, reconnect, cancellation, failure, and no legacy installer');
} finally { release?.resolve(); control?.close(); await client.close(); unsubscribe(); globalThis.fetch = originalFetch; f.dispose(); }
