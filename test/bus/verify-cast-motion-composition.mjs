import assert from 'node:assert/strict';
import { test } from 'node:test';
import { castFixture } from './cast-fixture.mjs';
import { readStudioFunction } from './verify-domain-modules.mjs';

async function install(f) {
  const request = f.motionRequest();
  const prepared = await f.call('prepare_motion_install', request);
  assert.ok(prepared.candidateId, JSON.stringify(prepared));
  const next = { ...request, ...prepared, profile: 'studio-motion-v1' };
  const verified = await f.call('verify_motion_candidate', next);
  return f.call('commit_motion_candidate', { ...next, verificationId: verified.verificationId,
    expectedTargetToken: request.binding.targetToken, expectedPhysicsRevision: verified.physicsRevision,
    explicitUnverifiedAcceptance: true });
}
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
const snapshot = f => ({ cast: f.snapshot(), motion: f.actual.snapshotStudioDomain('motion', 'actor-a'),
  shots: structuredClone(f.scope.shotsDomain.state()) });
function bindClear(f) {
  // Evaluate the shipped native operation in the mounted cast's real App
  // environment; only React's render publication is represented by a setter.
  const scope = { ...f.scope, motion: f.buffer.current.motion, maxDst: 47,
    setMotion: value => { f.buffer.current.motion = value; }, setMotionError() {} };
  const names = ['clearMotion'];
  const clear = new Function(...Object.keys(scope), names.map(readStudioFunction).join('\n') + '\nreturn clearMotion;')(...Object.values(scope));
  f.scope.motionDomain = { ...f.scope.motionDomain, clearMotionNative: clear };
}

test('cast/native motion: candidate installation retains one composite receipt and restores both owners', async () => {
  const f = castFixture();
  try {
    f.scope.shotsDomain.load({ ...f.scope.shotsDomain.state(), camera: f.actual.readStudioCamera() });
    const before = snapshot(f);
    const receipt = ok(await install(f));
    assert.equal(receipt.status, 'installed'); assert.equal(receipt.undo.entries, 1);
    assert.ok(f.cast.read()[0].motionRef); assert.ok(f.buffer.current.motion);
    assert.equal(f.ports.isRetained(receipt), true);
    assert.equal(ok(f.run('edit.undo', { receiptId: receipt.receiptId })).status, 'undone');
    assert.deepEqual(snapshot(f), before);
  } finally { f.dispose(); }
});

test('cast/native motion: pose apply and reset clear the take in one undoable and cancellable gesture', async () => {
  const f = castFixture();
  try {
    f.scope.shotsDomain.load({ ...f.scope.shotsDomain.state(), camera: f.actual.readStudioCamera() });
    ok(await install(f)); bindClear(f);
    const before = snapshot(f);
    const applied = ok(f.run('character.setPose', { characterId: 'actor-a', pose: 'pose-wave', clearMotion: true }));
    assert.equal(f.cast.read()[0].pose.id, 'pose-wave'); assert.equal(f.buffer.current.motion, null);
    assert.equal(f.cast.read()[0].motionRef, null); assert.equal(applied.undo.entries, 1);
    assert.equal(ok(f.run('edit.undo', { receiptId: applied.receiptId })).status, 'undone');
    assert.deepEqual(snapshot(f), before);
    bindClear(f);
    const tx = ok(f.run('run.begin', { id: 'character.setPose', args: { characterId: 'actor-a', pose: null, clearMotion: true } }));
    ok(f.run('run.update', { txId: tx.txId, args: { characterId: 'actor-a', pose: null, clearMotion: true } }));
    assert.equal(f.buffer.current.motion, null);
    ok(f.run('run.cancel', { txId: tx.txId })); assert.deepEqual(snapshot(f), before);
  } finally { f.dispose(); }
});
