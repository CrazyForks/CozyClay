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
