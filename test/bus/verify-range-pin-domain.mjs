import assert from 'node:assert/strict';
import { Quaternion } from 'three';
import { motionFixture, seedMotion } from './motion-fixture.mjs';

const f = motionFixture();
try {
	f.motion.load([{ id: 'actor-a', take: seedMotion() }]);
	const pin = { id: 'pin-qa', track: 'leftFoot', startFrame: 5, endFrame: 5, blend: 6, reach: 'limb', target: { space: 'world', position: [0, 0, 0] } };
	const keys = new Map([[5, new Map([['leftFoot', { q: [new Quaternion(), new Quaternion(), new Quaternion()], pin: pin.id, blend: 6 }]])]]);
	f.motion.setRangePinState('actor-a', { keys, pins: new Map([[pin.id, pin]]), pinResiduals: new Map([[pin.id, [{ frame: 5, errorM: 0 }]]]) });
	const app = f.scope.appContext;
	assert.equal(f.scope.ikStateRef.current.keys.get(5).get('leftFoot').pin, pin.id, 'projecting the document preserves key ownership');
	assert.deepEqual(f.scope.ikStateRef.current.pins.get(pin.id), pin);
	assert.equal(f.renderMotion().rangePins.length, 1, 'the panel reads pins from the motion owner');
	assert.ok(app.nextStoreHistory(false).stepHistory(false), 'pin edit is undoable');
	assert.equal(f.scope.ikStateRef.current.pins.size, 0);
	assert.equal(f.scope.ikStateRef.current.keys.size, 0);
	assert.ok(app.nextStoreHistory(true).stepHistory(true), 'pin metadata and keys redo together');
	assert.equal(f.scope.ikStateRef.current.keys.get(5).get('leftFoot').pin, pin.id);
	assert.equal(f.scope.ikStateRef.current.pinResiduals.get(pin.id)[0].errorM, 0);
	f.motion.setRangePinState('actor-a', { keys: new Map(), pins: new Map(), pinResiduals: new Map() });
	assert.equal(f.renderMotion().rangePins.length, 0, 'deletion clears the panel and projected keys');
	console.log('PASS range pin document projection, key ownership, undo, redo and deletion');
} finally { f.dispose(); }
