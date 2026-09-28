// Issue #438: bus command discovery. A command registered only in the
// editor's registry is listed by, and callable through, the agent's
// run_action, MCP (studio_commands / studio_run) and the CLI (`cclay live
// commands` / `cclay live run`), with no agent, MCP or CLI code naming it.
//
// The editor is the actual App binding over its actual registry
// (app-fixture.mjs), connected to a real live hub over a real socket. The MCP
// handlers, the agent's tools and the CLI child process are the shipped ones.
// Run one case with --case <name>.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchLiveFrame } from '../../src/live-control.js';
import { validateReceipt } from '../../src/studio-agent-protocol.js';
import { appFixture } from './app-fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'cozyclay-discovery-'));
process.env.XDG_CONFIG_HOME = scratch;
process.env.COZYCLAY_AGENT_SESSIONS_DIR ??= join(scratch, 'sessions');
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
const { startLiveHub } = await import('../../mcp/live-hub.mjs');
const { publishLiveEndpoint } = await import('../../bin/live-endpoint.mjs');
const mcp = await import('../../mcp/tool-handlers.mjs');

const TOKEN = randomBytes(32).toString('hex');
const launcher = fileURLToPath(new URL('../../bin/cozyclay.mjs', import.meta.url));

const within = (promise, label, milliseconds = 20_000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), milliseconds); })])
    .finally(() => clearTimeout(timer));
};
const signal = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const identity = ({ workspaceId, documentEpoch, sceneId, sceneEpoch }) => ({ workspaceId, documentEpoch, sceneId, sceneEpoch });

/** The fixture command: registered in this editor's registry and nowhere else. */
const STAMP = Object.freeze({ id: 'fixture.stamp', label: 'Stamp the fixture', kind: 'job', timeoutMs: 120_000,
  description: 'A command registered only in this editor fixture; no agent, MCP or CLI code names it.',
  input: { type: 'object', properties: { note: { type: 'string', minLength: 1, maxLength: 40 } }, required: [], additionalProperties: false } });
const stamped = args => ({ affectedIds: [], summary: `Stamped ${args.note ?? 'nothing'}.`, output: { note: args.note ?? null } });

/** One editor on its own hub. `pending(name)` reads the deadline of every
 * frame of that command the hub is still waiting on. */
async function studio(commands = [{ ...STAMP, run: stamped }]) {
  const f = appFixture();
  for (const command of commands) f.registry.register({ available: () => true, ...command });
  const hub = await startLiveHub(0, { token: TOKEN, owner: 'mcp' });
  publishLiveEndpoint({ port: hub.port, token: TOKEN, owner: 'mcp' });
  const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/live`);
  const welcomed = signal();
  socket.addEventListener('message', async event => {
    const frame = JSON.parse(event.data);
    if (frame.type === 'workspace') return welcomed.resolve(frame.handle);
    const response = await dispatchLiveFrame(event.data, f.binding.handlers);
    if (response && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
  });
  await within(new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); }), 'the editor socket');
  socket.send(JSON.stringify({ type: 'hello', role: 'editor', version: 1, workspaceId: f.binding.context().host.workspaceId }));
  const handle = await within(welcomed.promise, 'the workspace handle');
  // The context names the handle the agent route resolves on this hub.
  f.scope.liveWorkspaceHandleRef.current = handle;
  mcp.setLiveHub(hub);
  return { f, hub, handle,
    pending: name => [...hub.pending.values()].filter(entry => entry.name === name).map(entry => entry.timeoutMs),
    async close() {
      mcp.setLiveHub(null); socket.close();
      for (const peer of hub.server.clients) peer.terminate();
      await new Promise(resolve => hub.server.close(resolve));
      f.dispose();
    } };
}

/** An MCP tool call as the server makes it: each declared field through its
 * own schema, run in the resolved workspace. */
const tools = mcp.createToolHandlers({});
async function callTool(name, args, handle) {
  const tool = tools.find(entry => entry.name === name);
  assert.ok(tool, `MCP registers ${name}`);
  const parsed = Object.fromEntries(Object.entries(tool.inputSchema).map(([key, schema]) => [key, schema.parse(args[key])]));
  const result = await mcp.liveWorkspace.run(handle, () => tool.handler(parsed));
  const text = result.content[0].text;
  assert.doesNotMatch(text, /^Live editor error/, text);
  return { isError: result.isError === true, value: JSON.parse(text) };
}

/** `cclay live …` as an operator runs it; stdout is one JSON object. */
function cli(args, port) {
  const env = { ...process.env, XDG_CONFIG_HOME: scratch };
  delete env.COZYCLAY_LIVE_TOKEN;
  const child = spawn(process.execPath, [launcher, 'live', ...args, '--live-port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return within(new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* the assertion below prints what came back */ }
      resolve({ code, stdout, stderr, json });
    });
  }), `cclay live ${args.join(' ')}`);
}

/** The agent's own tools for one turn, admitted at the editor's context. */
async function agentTools(s) {
  const { createStudioTools } = await import('../../bin/agent/studio-tools.mjs');
  const context = s.f.binding.context();
  const admission = { commandId: () => crypto.randomUUID(), host: identity(context.host), revision: context.revision.scene,
    async refresh() { admission.revision = s.f.binding.context().revision.scene; } };
  return createStudioTools({ liveHub: s.hub, workspaceHandle: s.handle,
    session: { admission, generation: { used: false, failures: 0 }, actionIndex: context.actionIndex } }).internal.invoke;
}

const cases = {};

cases['mcp-run'] = async () => {
  const s = await studio();
  try {
    const before = s.f.binding.context();
    const { isError, value: receipt } = await callTool('studio_run', { action: STAMP.id, args: { note: 'mcp' } }, s.handle);
    assert.equal(isError, false, JSON.stringify(receipt));
    validateReceipt(receipt);
    assert.deepEqual({ action: receipt.action, status: receipt.status, output: receipt.output }, { action: STAMP.id, status: 'completed', output: { note: 'mcp' } });
    assert.deepEqual(receipt.host, identity(before.host), 'admitted in the open document');
    // Admission is the editor's: a stale revision is refused before anything runs.
    const stale = await callTool('studio_run', { action: STAMP.id, args: {}, expectedRevision: before.revision.scene + 7 }, s.handle);
    assert.equal(stale.isError, true);
    assert.equal(stale.value.code, 'STALE_SCENE', JSON.stringify(stale.value));
    // A caller's commandId makes a retry answer the journalled receipt.
    const commandId = crypto.randomUUID();
    const first = await callTool('studio_run', { action: STAMP.id, args: { note: 'once' }, commandId }, s.handle);
    const retried = await callTool('studio_run', { action: STAMP.id, args: { note: 'once' }, commandId }, s.handle);
    assert.equal(first.value.commandId, commandId);
    assert.equal(retried.value.receiptId, first.value.receiptId, 'the retry is the same receipt');
  } finally { await s.close(); }
  console.log('PASS #438 acceptance 1: a command registered only in the editor runs through MCP studio_run and answers its bus receipt');
};

const index = process.argv.indexOf('--case');
const selected = index >= 0 ? process.argv[index + 1] : null;
if (selected && !cases[selected]) { console.error(`unknown --case ${selected}; known: ${Object.keys(cases).join(', ')}`); process.exit(2); }
for (const [name, run] of Object.entries(cases)) if (!selected || selected === name) await run();
