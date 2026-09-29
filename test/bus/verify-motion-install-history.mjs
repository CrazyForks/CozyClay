import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appFixture } from './app-fixture.mjs';

async function install(f) {
  const request = f.motionRequest();
  const prepared = await f.call('prepare_motion_install', request);
  assert.ok(prepared.candidateId, JSON.stringify(prepared));
  const next = { ...request, ...prepared, profile: 'studio-motion-v1' };
  const verified = await f.call('verify_motion_candidate', next);
  assert.ok(verified.verificationId, JSON.stringify(verified));
  return f.call('commit_motion_candidate', { ...next, verificationId: verified.verificationId,
    expectedTargetToken: request.binding.targetToken, expectedPhysicsRevision: verified.physicsRevision,
    explicitUnverifiedAcceptance: true });
}

for (const composed of [false, true]) test(`motion installation receipt retains ${composed ? 'the returned owned/native composite' : 'the native fallback'} history ID`, async () => {
  const f = appFixture();
  let returnedHistoryId;
  try {
    const beforeShots = structuredClone(f.scope.shotsDomain.state());
    const beforeMotion = f.actual.snapshotStudioDomain('motion', 'actor-a');
    if (composed) f.ports.commitMotion = payload => {
      // Real owners, facade, rig installation and binding. Wrapping only this
      // publication port reproduces the ownership transition without replacing
      // candidate verification, receipt creation or native history.
      const recorded = f.actual.recordStudioAction('shot', () => {
        f.scope.shotsDomain.writeState(before => ({ ...before, frameCount: 96 }));
        f.actual.recordStudioAction('motion', () => f.actual.commitStudioMotion(payload), payload.binding.characterId, true);
      });
      returnedHistoryId = recorded.historyEntryId;
      return recorded;
    };
    const receipt = await install(f);
    assert.equal(receipt.status, 'installed', JSON.stringify(receipt));
    if (composed) assert.equal(receipt.undo.historyEntryId, returnedHistoryId);
    assert.equal(f.ports.isRetained(receipt), true);
    assert.equal(f.ports.canUndo(receipt), true);
    const undo = f.binding.bus.run('edit.undo', { receiptId: receipt.receiptId });
    assert.equal(undo.status, 'undone', JSON.stringify(undo));
    assert.deepEqual(f.scope.shotsDomain.state(), beforeShots);
    assert.deepEqual(f.actual.snapshotStudioDomain('motion', 'actor-a'), beforeMotion);
  } finally { f.dispose(); }
});
