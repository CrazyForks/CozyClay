import assert from "node:assert/strict";
import { CSKEL27_JOINTS } from "../src/ardy/cskel27.js";
import {
	createMotionEdit,
	motionEditDuration,
	renderMotionEdit,
	setMotionSegmentSpeed,
	splitMotionEdit,
	timelineFrameToMotionFrame,
	trimMotionEdit,
} from "../src/ardy/motion-edit.js";

function pass(label) { console.log(`PASS ${label}`); }
function near(actual, expected, tolerance = 0.01) {
	assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}`);
}

function linearMotion(frames) {
	const joints = CSKEL27_JOINTS.length;
	const rotMats = new Float32Array(frames * joints * 9);
	const rootPos = new Float32Array(frames * 3);
	const posedJoints = new Float32Array(frames * joints * 3);
	for (let frame = 0; frame < frames; frame += 1) {
		for (let joint = 0; joint < joints; joint += 1) {
			const r = (frame * joints + joint) * 9;
			rotMats[r] = 1;
			rotMats[r + 4] = 1;
			rotMats[r + 8] = 1;
			const p = (frame * joints + joint) * 3;
			posedJoints[p] = frame;
		}
		rootPos[frame * 3] = frame;
	}
	return { frames, fps: 24, rotMats, rootPos, posedJoints };
}

{
	const edit = createMotionEdit(240);
	assert.deepEqual(edit, [{ id: "motion-0", sourceStart: 0, sourceEnd: 239, speed: 1 }]);
	assert.equal(motionEditDuration(edit), 240);
	assert.equal(timelineFrameToMotionFrame(edit, 0), 0);
	assert.equal(timelineFrameToMotionFrame(edit, 239), 239);
	pass("an untouched take is one 1x segment with identity sampling");
}

{
	const split = splitMotionEdit(createMotionEdit(240), 96);
	assert.deepEqual(split.map(({ sourceStart, sourceEnd, speed }) => ({ sourceStart, sourceEnd, speed })), [
		{ sourceStart: 0, sourceEnd: 95, speed: 1 },
		{ sourceStart: 96, sourceEnd: 239, speed: 1 },
	]);
	assert.equal(splitMotionEdit(split, 0), split);
	assert.equal(splitMotionEdit(split, 240), split);
	assert.equal(splitMotionEdit(split, 96), split);
	pass("cutting at the playhead creates a non-destructive source boundary once");
}

{
	const split = splitMotionEdit(createMotionEdit(240), 96);
	const slow = setMotionSegmentSpeed(split, split[1].id, 0.5);
	assert.equal(motionEditDuration(slow), 96 + 288);
	assert.equal(timelineFrameToMotionFrame(slow, 95), 95);
	assert.equal(timelineFrameToMotionFrame(slow, 96), 96);
	near(timelineFrameToMotionFrame(slow, 97), 96.5);
	assert.equal(timelineFrameToMotionFrame(slow, 383), 239);
	pass("a 0.5x segment doubles only its own timeline duration");
}

{
	const edit = [
		{ id: "a", sourceStart: 0, sourceEnd: 47, speed: 2 },
		{ id: "b", sourceStart: 48, sourceEnd: 95, speed: 0.25 },
	];
	assert.equal(motionEditDuration(edit), 24 + 192);
	assert.equal(timelineFrameToMotionFrame(edit, 23), 47);
	assert.equal(timelineFrameToMotionFrame(edit, 24), 48);
	assert.equal(timelineFrameToMotionFrame(edit, 215), 95);
	pass("fast and slow segments join without skipping their seam poses");
}

{
	const split = splitMotionEdit(createMotionEdit(240), 96);
	const slow = setMotionSegmentSpeed(split, split[1].id, 0.5);
	const trimmed = trimMotionEdit(slow, 48, 239);
	assert.deepEqual(trimmed.map(({ sourceStart, sourceEnd, speed }) => ({ sourceStart, sourceEnd, speed })), [
		{ sourceStart: 48, sourceEnd: 95, speed: 1 },
		{ sourceStart: 96, sourceEnd: 167, speed: 0.5 },
	]);
	assert.equal(motionEditDuration(trimmed), 48 + 144);
	pass("outer trim handles preserve cuts and speed inside the kept range");
}

{
	const edit = createMotionEdit(20);
	for (const speed of [0, -1, 8.1, Number.NaN]) {
		assert.throws(() => setMotionSegmentSpeed(edit, edit[0].id, speed), /setMotionSegmentSpeed:/);
	}
	const decimal = setMotionSegmentSpeed(edit, edit[0].id, 0.7);
	assert.equal(decimal[0].speed, 0.7);
	assert.equal(setMotionSegmentSpeed(edit, edit[0].id, 0.66)[0].speed, 0.7);
	assert.equal(setMotionSegmentSpeed(edit, edit[0].id, 1.01)[0].speed, 1);
	pass("speed accepts continuous 0.1x steps and rejects off-grid values");
}

{
	const split = splitMotionEdit(createMotionEdit(4), 2);
	const slowed = setMotionSegmentSpeed(split, split[1].id, 0.5);
	const rendered = renderMotionEdit(linearMotion(4), slowed);
	assert.equal(rendered.frames, 6);
	assert.equal(rendered.rootPos[0], 0);
	assert.equal(rendered.rootPos[3], 1);
	assert.equal(rendered.rootPos[6], 2);
	near(rendered.rootPos[9], 2.5);
	assert.equal(rendered.rootPos[12], 3);
	assert.equal(rendered.rootPos[15], 3);
	pass("rendering a slow segment creates a normal 24 fps clip for every consumer");
}

console.log("verify-motion-edit: all checks passed");
