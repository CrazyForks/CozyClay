import assert from "node:assert/strict";
import {
	cameraAtFrame,
	cutAtFrame,
	duplicateShot,
	initialShots,
	moveBoundary,
	removeShot,
	renameShot,
	shotAtFrame,
	shotIndexAtFrame,
} from "../src/cuts.js";

const framing = (x) => ({ pos: { x, y: 1.5, z: 4 }, yaw: 0, pitch: 0, fovDeg: 45 });
const key = (frame, x) => ({ frame, framing: framing(x) });

let shots = initialShots(100, [key(-2, -2), key(0, 0), key(99, 9), key(200, 20)]);
assert.equal(shots.length, 1);
assert.deepEqual(shots[0].cameraKeys.map((item) => item.frame), [0, 99]);
assert.equal(shotIndexAtFrame(shots, 50), 0);
assert.equal(shotAtFrame([], 0), null);

const unchangedAtZero = cutAtFrame(shots, 0, framing(3));
assert.equal(unchangedAtZero, shots, "cut at zero is a no-op");
shots = cutAtFrame(shots, 40, framing(4));
assert.deepEqual(shots.map((shot) => shot.startFrame), [0, 40]);
assert.equal(shots[1].cameraKeys[0].frame, 40);
assert.equal(shots[1].cameraKeys[0].framing.pos.x, 4);
assert.equal(cutAtFrame(shots, 40, framing(8)), shots, "existing boundary is a no-op");
assert.equal(shotIndexAtFrame(shots, 39), 0);
assert.equal(shotIndexAtFrame(shots, 40), 1);
assert.equal(cameraAtFrame(shots, { x: 0, z: 0 }, 40).pos.x, 4, "the cut frame belongs to the downstream shot");

shots = cutAtFrame(shots, 70, framing(7));
assert.deepEqual(shots.map((shot) => shot.startFrame), [0, 40, 70]);
let moved = moveBoundary(shots, 1, -100, 100);
assert.deepEqual(moved.map((shot) => shot.startFrame), [0, 1, 70], "cannot drag past previous shot");
moved = moveBoundary(shots, 1, 1000, 100);
assert.deepEqual(moved.map((shot) => shot.startFrame), [0, 69, 70], "cannot drag past next shot");
moved = moveBoundary(shots, 2, 1000, 100);
assert.equal(moved[2].startFrame, 99, "last shot retains one frame");
assert.ok(moved[1].cameraKeys.every((item) => item.frame >= moved[1].startFrame && item.frame < moved[2].startFrame));
assert.ok(moved[2].cameraKeys.every((item) => item.frame >= moved[2].startFrame && item.frame < 100));

const removedLast = removeShot(shots, 2);
assert.deepEqual(removedLast.map((shot) => shot.startFrame), [0, 40]);
assert.equal(removedLast[1].cameraKeys.some((item) => item.frame === 70), false, "removed keys are dropped");
const removedFirst = removeShot(shots, 0);
assert.deepEqual(removedFirst.map((shot) => shot.startFrame), [0, 70]);
assert.equal(removedFirst[0].id, shots[1].id);
assert.equal(removeShot([shots[0]], 0).length, 1);

const renamed = renameShot(shots, 1, "  Close-up  ");
assert.equal(renamed[1].name, "Close-up");
assert.notEqual(renamed, shots);

const duplicated = duplicateShot(shots, 0, 100);
assert.deepEqual(duplicated.map((shot) => shot.startFrame), [0, 20, 40, 70]);
assert.equal(new Set(duplicated.map((shot) => shot.id)).size, duplicated.length);
assert.equal(duplicated[1].name, `${shots[0].name} copy`);
assert.equal(duplicateShot([{ ...shots[0], startFrame: 0 }], 0, 1).length, 1);

const empty = [{ ...shots[0], cameraKeys: [] }];
assert.equal(cameraAtFrame(empty, { x: 0, z: 0 }, 10), null);

console.log("cuts model verified");
