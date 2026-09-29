import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSync } from 'rolldown/experimental';
import { createKeyLight } from '../../src/scenes.js';
import { stageFixture } from './stage-fixture.mjs';
import { readStudioFunction } from './verify-domain-modules.mjs';
const source = readFileSync(new URL('../../src/domains/cast.js', import.meta.url), 'utf8');
let expression;
function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'VariableDeclarator' && node.id.name === 'snapshotCast') expression = source.slice(node.init.start, node.init.end);
  for (const [key, value] of Object.entries(node)) if (key !== 'parent') Array.isArray(value) ? value.forEach(walk) : walk(value);
}
walk(parseSync('cast.js', source).program);
const f = stageFixture();
try {
  Object.assign(f.scope, f.live.current.stage, { snapshotIkKeys: f.actual.snapshotIkKeys });
  const snapshotCast = new Function('appContext', 'activeChar', `return (${expression});`)(f.scope.appContext, f.characterRef.current[0]);
  const scope = { ...f.scope, createKeyLight };
  const restoreCast = new Function(...Object.keys(scope), `${readStudioFunction('restoreCast')}\nreturn restoreCast;`)(...Object.values(scope));
  const before = snapshotCast();
  f.scope.appContext.recordCharacterUndo(before);
  f.actual.publishStudioCharacters(f.characterRef.current.map(c => ({ ...c, x: c.x + 1 })), true);
  assert.equal(f.run('stage.set', { keyLight: { intensity: 3 }, environment: 'After cast edit' }).ok, true);
  const stage = structuredClone(f.stage.read());
  restoreCast(before); // Native cast undo, not the newer document-stage undo.
  assert.deepEqual(f.stage.read(), stage, 'cast edit -> stage edit -> cast undo preserves stage');
  assert.equal(f.stage.documentStore.depths().past, 1);
  for (const key of ['keyLight', 'environmentImage', 'environment', 'style', 'hasEnvSheet']) assert.equal(Object.hasOwn(before, key), false, `${key} is not cast history`);
  console.log('PASS cast history excludes stage and interleaved cast undo preserves the stage edit');
} finally { f.dispose(); }
