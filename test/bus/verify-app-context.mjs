import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSync } from 'rolldown/experimental';

const { createAppContext } = await import('../../src/app-context.js');
const ref = current => ({ current });
function test(name, run) {
  run();
  console.log(`PASS AppContext ${name}`);
}

test('acceptance 1: exposes the App-owned clock, cast history, live projections and ports', () => {
  const clock = ref(0), history = ref({ past: [], future: [] });
  const characters = ref([{ id: 'actor' }]), scenes = ref([{ id: 'scene' }]), motion = ref({ frames: 48 });
  const state = ref({ shots: [], timeline: { frameCount: 48 } });
  const context = createAppContext({ clock, history, characters, scenes, motion, state });
  assert.equal(context.nextTick(), 1);
  assert.equal(clock.current, 1);
  assert.equal(context.undoClock, 1);
  assert.equal(context.castHistory, history.current);
  context.recordCharacterUndo({ characters: characters.current });
  context.recordShotUndo({ shots: state.current.shots });
  assert.deepEqual(history.current.past.map(entry => entry.tick), [2, 3]);
  assert.equal(context.live.characters, characters.current);
  assert.equal(context.live.scenes, scenes.current);
  assert.equal(context.live.motion, motion.current);
  assert.equal(context.live.state, state.current);
  assert.throws(() => { context.live.characters = []; }, TypeError);
  assert.throws(() => { context.live.state = {}; }, TypeError);
  context.updatePorts({ read: () => 'first' });
  const read = context.ports.read;
  context.updatePorts({ read: () => 'latest' });
  assert.equal(read(), 'latest', 'retained delegates reach the latest render');
  context.updateActionPorts({ state: () => 'first action' });
  const ports = context.actionPorts;
  context.updateActionPorts({ state: () => 'latest action' });
  assert.equal(ports, context.actionPorts);
  assert.equal(ports.state(), 'latest action');
});

const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
const parsed = parseSync('App.jsx', app);
assert.deepEqual(parsed.errors, []);
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(child)) child.forEach(value => walk(value, visit));
    else walk(child, visit);
  }
}
test('acceptance 2: App has no direct undo-clock or cast-history refs', () => {
  const leaks = [];
  walk(parsed.program, node => {
    if (node.type === 'Identifier' && ['opClockRef', 'charHistoryRef'].includes(node.name)) leaks.push(node.name);
  });
  assert.deepEqual(leaks, []);
});

function memberPath(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type !== 'MemberExpression') return '';
  return `${memberPath(node.object)}.${node.computed ? node.property.value : node.property.name}`;
}
test('acceptance 3: live model publications stay behind the facade, including aliases', () => {
  const aliases = new Set(['charactersRef.current', 'liveStateRef.current', 'scenesRef.current', 'appContext.live']);
  walk(parsed.program, node => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier'
      && [...aliases].some(path => memberPath(node.init).startsWith(path))) aliases.add(node.id.name);
  });
  const leaks = [];
  const check = node => {
    const path = memberPath(node);
    if ([...aliases].some(alias => path === alias || path.startsWith(`${alias}.`))) leaks.push(path);
  };
  walk(parsed.program, node => {
    if (node.type === 'AssignmentExpression') check(node.left);
    if (node.type === 'UpdateExpression') check(node.argument);
    if (node.type === 'CallExpression' && memberPath(node.callee) === 'Object.assign') check(node.arguments[0]);
  });
  assert.deepEqual(leaks, []);
});
test('acceptance 3: synchronous publications and later renders reach retained readers', () => {
  const context = createAppContext();
  const read = () => context.live;
  const first = { characters: [], shots: [], timeline: { frameCount: 48 } };
  context.publishLive(first);
  const cast = [{ id: 'new actor' }];
  context.publishCharacters(cast);
  context.patchLive({ characters: cast, shots: [{ id: 'shot' }] });
  context.patchTimeline({ frameCount: 96 });
  assert.equal(read().characters, cast);
  assert.equal(first.characters, cast);
  assert.equal(read().state.timeline.frameCount, 96);
  const next = { characters: cast, shots: [], timeline: { frameCount: 120 } };
  context.publishLive(next);
  context.publishScenes([{ id: 'new scene' }]);
  context.publishMotion({ frames: 120 });
  assert.equal(read().state, next);
  assert.equal(read().scenes[0].id, 'new scene');
  assert.equal(read().motion.frames, 120);
});
