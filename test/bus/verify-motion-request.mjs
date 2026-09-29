import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGenerationRequest } from '../../src/motion/generation.js';
import { judgeAuthoredPath } from '../../src/ardy/waypoints.js';

test('#444.1: an infeasible root leg is a coded refusal carrying the path judge result', () => {
  const character = { x: 0, z: 0, rot: 0 }, waypoints = [{ frame: 24, x: 0, z: 4 }];
  const judge = judgeAuthoredPath([{ frame: 0, x: 0, z: 0, heading: null }, ...waypoints], 24, 96);
  assert.throws(() => buildGenerationRequest({ character, waypoints, waypointMode: true, prompt: 'Walk', durationSeconds: 4, seed: 17 }), error => {
    assert.equal(error.code, 'INVALID_RANGE');
    // Compare shipped judge output, not a separately pinned prose sentence.
    assert.ok(error.message.includes(judge.errors[0]));
    assert.ok(error.uiMessage); return true;
  });
});
