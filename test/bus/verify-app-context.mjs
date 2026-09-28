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
    // Rebinding a local (including scalar projections) is not a model write.
    if ([...aliases].some(alias => (alias.includes('.') && path === alias) || path.startsWith(`${alias}.`))) leaks.push(path);
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

const { createSceneHistoryStore } = await import('../../src/scene-history.js');
const { appFixture } = await import('./app-fixture.mjs');
test('acceptance 4: both App object-store callbacks join the facade clock', () => {
  const callbacks = [];
  walk(parsed.program, node => {
    if (node.type === 'Property' && node.key.name === 'onObjects') callbacks.push(node.value);
  });
  assert.equal(callbacks.length, 2, 'initial store and scene-replacement store');
  for (const callback of callbacks) {
    const context = createAppContext();
    const onObjects = new Function('appContext', 'setSceneObjects', `return (${app.slice(callback.start, callback.end)});`)(context, () => {});
    const store = createSceneHistoryStore([], { onObjects });
    store.applyAtomic(() => [{ id: 'object' }]);
    assert.equal(context.undoClock, 1);
    assert.equal(context.objectClock, 1);
    context.recordCharacterUndo({ characters: [] });
    store.applyAtomic(rows => [...rows, { id: 'second' }]);
    assert.equal(context.undoClock, 3);
    assert.equal(context.objectClock, 3);
    context.suppressObjectClock = true;
    store.undo();
    assert.equal(context.undoClock, 3, 'history traversal does not double-count');
  }
});
test('acceptance 4: real App undo and redo traverse interleaved object and cast edits in reverse order', () => {
  const f = appFixture();
  try {
    const state = () => ({ objects: f.store.current.objects, characters: f.characterRef.current });
    const snapshots = [state()];
    for (let index = 1; index <= 3; index++) {
      f.actual.commitStudioDraft({ domain: 'objects', draft: [{ id: `object-${index}`, x: index }] });
      snapshots.push(state());
      f.actual.commitStudioDraft({ domain: 'cast', draft: f.characterRef.current.map(c => ({ ...c, x: index })) });
      snapshots.push(state());
    }
    assert.equal(f.scope.appContext.undoClock, 6);
    assert.equal(f.scope.appContext.objectClock, 5, 'the last object edit shares the cast clock');
    for (let index = snapshots.length - 2; index >= 0; index--) {
      f.actual.undoScene();
      assert.deepEqual(state(), snapshots[index], `undo ${index}`);
    }
    for (let index = 1; index < snapshots.length; index++) {
      f.actual.redoScene();
      assert.deepEqual(state(), snapshots[index], `redo ${index}`);
    }
    const history = f.scope.appContext.castHistory;
    f.scope.appContext.resetCastHistory();
    assert.notEqual(f.scope.appContext.castHistory, history);
    assert.deepEqual(f.scope.appContext.castHistory, { past: [], future: [] });
  } finally { f.dispose(); }
});
