import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// The no-op compatibility hook is authorized only until the frozen App prop
// can be deleted. Keep the remaining call-site gate red, not skipped.
const root = new URL('../../src/', import.meta.url);
const matches = readdirSync(root, { recursive: true }).filter(path => /\.(js|jsx)$/.test(path)).flatMap(path => {
  const source = readFileSync(new URL(path, root), 'utf8');
  if (path === 'domains/shots.js') {
    assert.match(source, /function recordShotUndo\(\) \{\}/);
    const calls = [...source.matchAll(/recordShotUndo\s*\(/g)];
    assert.equal(calls.length, 1, 'only the inert declaration remains in the domain');
    return [];
  }
  return source.split('\n').flatMap((line, index) => line.includes('recordShotUndo') ? [`${path}:${index + 1}: ${line.trim()}`] : []);
});
assert.deepEqual(matches, [], 'acceptance 6: remove the frozen App crane prop after #483');
console.log('PASS no legacy shot-undo references');
