import assert from "node:assert/strict";
import * as THREE from "three";
import { resolveIkRig, ikEvaluate, solveIk } from "../../src/ardy/ik.js";
import { physicsKeyStamp } from "../../src/ardy/physics-review.js";
import { fitPlatforms, PLATFORM_FIT_LIMITS } from "../../src/ardy/platform-fit.js";

// Synthetic mixamo rig (cm bones under a 0.01 group), legs 45 + 45 cm, a
// level foot whose toe sits 5 cm below / 12 cm ahead of the ankle. With no
// skinned mesh the support sampler's sole is ankle.y - 0.05.
function makeRig() {
	const rig = new THREE.Group(); rig.scale.setScalar(.01);
	const bone = (name, parent, x, y, z = 0) => { const b = new THREE.Bone(); b.name = `mixamorig${name}`; b.position.set(x, y, z); parent.add(b); return b; };
	const hips = bone("Hips", rig, 0, 93), spine = bone("Spine", hips, 0, 15), chest = bone("Spine1", spine, 0, 15);
	bone("Spine2", chest, 0, 15); const neck = bone("Neck", chest, 0, 30), head = bone("Head", neck, 0, 15); bone("HeadTop_End", head, 0, 20);
	for (const [side, dir] of [["Left", 1], ["Right", -1]]) {
		const shoulder = bone(`${side}Shoulder`, chest, dir * 10, 25), arm = bone(`${side}Arm`, shoulder, dir * 10, -10), fore = bone(`${side}ForeArm`, arm, dir * 30, 0);
		bone(`${side}Hand`, fore, dir * 30, 0);
		const up = bone(`${side}UpLeg`, hips, dir * 10, 0), shin = bone(`${side}Leg`, up, 0, -45), foot = bone(`${side}Foot`, shin, 0, -45);
		bone(`${side}ToeBase`, foot, 0, -5, 12);
	}
	rig.updateMatrixWorld(true); return rig;
}

// A 3 s walk along +Z at 0.6 m/s: 1 s gait cycle, 60 % stance, feet level.
const FPS = 30, FRAMES = 90, CYCLE = 30, STANCE = 18, STRIDE = .6;
const plants = { leftFoot: { x: .1, offset: 0, z0: .17 }, rightFoot: { x: -.1, offset: 15, z0: .47 } };
function ankleAt(id, f) {
	const { x, offset, z0 } = plants[id], g = f - offset, k = Math.floor(g / CYCLE), p = g - k * CYCLE;
	const plant = (i) => z0 + STRIDE * i;
	if (p < STANCE) return new THREE.Vector3(x, .05, plant(k));
	const s = (p - STANCE + 1) / (CYCLE - STANCE + 1), e = s * s * (3 - 2 * s);
	return new THREE.Vector3(x, .05 + .08 * Math.sin(Math.PI * s), plant(k) + (plant(k + 1) - plant(k)) * e);
}

const rig = makeRig(), { chains, fkJoints } = resolveIkRig(rig), hips = fkJoints.get("hips").bone;
const rest = []; rig.traverse((b) => { if (b.isBone) rest.push([b, b.position.clone(), b.quaternion.clone()]); });
const applyRaw = (f) => {
	for (const [b, p, q] of rest) { b.position.copy(p); b.quaternion.copy(q); }
	hips.position.set(0, 88 + Math.cos(2 * Math.PI * f / 15), 100 * STRIDE * f / CYCLE);
	rig.updateMatrixWorld(true);
	for (const id of Object.keys(plants)) {
		const chain = chains.get(id);
		solveIk(chain, ankleAt(id, f), { exactHinge: true }); rig.updateMatrixWorld(true);
		const foot = chain.bones[2]; foot.quaternion.copy(foot.parent.getWorldQuaternion(new THREE.Quaternion()).invert()); rig.updateMatrixWorld(true);
	}
};
const motion = { frames: FRAMES, fps: FPS };
const params = { rig, motion, chains, fkJoints, applyRaw };
const box = (height, z = 1.75, depth = 1.6) => ({ id: "box", kind: "box", x: 0, y: 0, z, height, footprint: { width: 1, depth } });

// Pose at frame f under a key map (empty map = raw clip).
const pose = (keys, f) => {
	applyRaw(f); ikEvaluate(chains, { keys, tracked: new Set([...keys.values()].flatMap((e) => [...e.keys()])) }, f, fkJoints, 6); rig.updateMatrixWorld(true);
	return { hips: hips.getWorldPosition(new THREE.Vector3()), ...Object.fromEntries(Object.keys(plants).map((id) => [id, chains.get(id).bones[2].getWorldPosition(new THREE.Vector3())])) };
};
const sole = (p, id) => p[id].y - .05;
const raw = Array.from({ length: FRAMES }, (_, f) => pose(new Map(), f));
assert(raw.every((p, f) => Object.keys(plants).every((id) => p[id].distanceTo(ankleAt(id, f)) < 1e-6)), "synthetic walk places every ankle exactly");
const feetMoved = (keys, frames, reference = raw) => Math.max(0, ...frames.flatMap((f) => { const p = pose(keys, f); return Object.keys(plants).map((id) => p[id].distanceTo(reference[f][id])); }));

// (c) no objects: nothing changes.
{
	const empty = new Map(), stamp = physicsKeyStamp(empty);
	const result = await fitPlatforms({ ...params, sourceKeys: empty });
	assert.deepEqual(result.changedFrames, []);
	assert.equal(result.summary.lifted, 0);
	assert.equal(result.sourceStamp, stamp);
	assert(Math.abs(result.legLength - .9) < 1e-6, `leg length is measured from the rig (${result.legLength})`);
	assert(result.steps.length >= 5 && result.steps.every((s) => s.status === "ok" && s.objectId === null), "flat-floor contacts are detected and ok");
	console.log("PASS no scene objects: contacts detected, no frame changed");
}

// (a) a 0.2 m box under the later footsteps.
const top = .2, sourceKeys = new Map(), stamp = physicsKeyStamp(sourceKeys);
const fit = await fitPlatforms({ ...params, sourceKeys, sceneObjects: [box(top)] });
assert.equal(physicsKeyStamp(sourceKeys), stamp, "source keys are not mutated");
const onBox = fit.steps.filter((s) => s.objectId === "box");
assert(onBox.length >= 3 && onBox.every((s) => s.status === "ok" && Math.abs(s.surfaceY - top) < 1e-9 && Math.abs(s.rise - top) < .01), `box steps are ok: ${JSON.stringify(onBox)}`);
assert.equal(fit.summary.lifted, onBox.length);
{
	for (const step of onBox) {
		let rise = -Infinity;
		for (let f = step.start; f <= step.end; f += 1) {
			const p = pose(fit.candidate.keys, f), s = sole(p, step.foot);
			assert(Math.abs(s - top) < .015, `sole on box top at ${step.foot} frame ${f}: ${s}`);
			assert(s >= top - .01, `no sole below the top at frame ${f}`);
			rise = Math.max(rise, p.hips.y - raw[f].hips.y);
		}
		assert(rise >= .1 && rise <= .25, `pelvis rises ${rise.toFixed(3)} m on ${step.id}`);
	}
	console.log("PASS feet on the 0.2 m box rest on its top and the pelvis rises with them");
	const floorSteps = fit.steps.filter((s) => s.objectId === null);
	assert(floorSteps.length >= 3, JSON.stringify(fit.steps.map((s) => [s.id, s.end, s.status, s.objectId, +s.rise.toFixed(3), +s.lift.toFixed(3)])));
	for (const step of floorSteps) {
		const frames = Array.from({ length: step.end - step.start + 1 }, (_, i) => step.start + i);
		const moved = Math.max(...frames.map((f) => pose(fit.candidate.keys, f)[step.foot].distanceTo(raw[f][step.foot])));
		assert(moved < 1e-4, `floor step ${step.id} unchanged (${moved})`);
	}
	const firstChanged = Math.min(...fit.changedFrames);
	assert(feetMoved(fit.candidate.keys, Array.from({ length: firstChanged }, (_, f) => f)) < 1e-4, "frames before the fit are untouched");
	const keyFrame = fit.changedFrames[Math.floor(fit.changedFrames.length / 2)], entry = fit.candidate.keys.get(keyFrame);
	assert(entry.get("hips").p && entry.get("hips").basePos && entry.get("hips").baseQ?.length === 1 && entry.get("hips").q?.length === 1);
	assert(entry.get("leftFoot").keepTranslations === true && entry.get("leftFoot").chainP && entry.get("leftFoot").baseQ.length === 3 && entry.get("leftFoot").p === null);
	console.log("PASS steps before the box are unchanged and keys use the physics-review format");
	// Swing toes clear the box edge.
	let dip = Infinity;
	for (let f = 0; f < FRAMES; f += 1) {
		const p = pose(fit.candidate.keys, f);
		for (const id of Object.keys(plants)) {
			const toe = p[id].clone().add(new THREE.Vector3(0, -.05, .12));
			if (toe.z >= .95 && toe.z <= 2.55) dip = Math.min(dip, toe.y - top);
		}
	}
	assert(dip > -.01, `toes never sink into the box (${dip})`);
	console.log("PASS swing toes clear the box");
}

// (d) idempotent: re-running on the fitted keys adds nothing.
{
	const again = await fitPlatforms({ ...params, sourceKeys: fit.candidate.keys, sceneObjects: [box(top)] });
	const most = Math.max(...Object.values(again.lifts).flatMap((track) => track.map(Math.abs)));
	assert(most < .005, `re-run lift ${most}`);
	assert.equal(again.summary.lifted, 0);
	console.log(`PASS re-running on its own output is idempotent (max lift ${most.toExponential(2)} m, ${again.changedFrames.length} changed frames)`);
}

// (e) removing or moving the box brings the feet back down.
{
	const removed = await fitPlatforms({ ...params, sourceKeys: fit.candidate.keys, sceneObjects: [] });
	for (const step of onBox) for (let f = step.start; f <= step.end; f += 1) {
		const s = sole(pose(removed.candidate.keys, f), step.foot);
		assert(Math.abs(s) < .015, `removed box: ${step.foot} back on the floor at frame ${f} (${s})`);
	}
	console.log("PASS removing the box brings the feet back to the floor");
	const moved = await fitPlatforms({ ...params, sourceKeys: fit.candidate.keys, sceneObjects: [box(top, 1.95, 1.2)] });
	const stillOn = new Set(moved.steps.filter((s) => s.objectId === "box").map((s) => `${s.foot}:${s.start}`));
	assert(stillOn.size >= 1 && stillOn.size < onBox.length, "moved box covers fewer steps");
	for (const step of onBox) {
		const expected = stillOn.has(`${step.foot}:${step.start}`) ? top : 0;
		for (let f = step.start; f <= step.end; f += 1) {
			const s = sole(pose(moved.candidate.keys, f), step.foot);
			assert(Math.abs(s - expected) < .015, `moved box: ${step.foot} frame ${f} at ${s}, expected ${expected}`);
		}
	}
	console.log("PASS moving the box re-seats every step on what is now under it");
}

// (b) too tall to climb: reported, nothing lifted, feet unchanged.
{
	const tall = 1.2 * PLATFORM_FIT_LIMITS.climb * .9;
	const result = await fitPlatforms({ ...params, sourceKeys: new Map(), sceneObjects: [box(tall)] });
	const blocked = result.steps.filter((s) => s.objectId === "box");
	assert(blocked.length >= 1 && blocked.every((s) => s.status === "wall" || s.status === "tooHigh"), JSON.stringify(blocked));
	assert(blocked.some((s) => s.status === "wall"));
	assert.equal(result.summary.lifted, 0);
	assert(feetMoved(result.candidate.keys, Array.from({ length: FRAMES }, (_, f) => f)) < 1e-4, "feet unchanged");
	const high = await fitPlatforms({ ...params, sourceKeys: new Map(), sceneObjects: [box(.7 * .9)] });
	assert(high.steps.filter((s) => s.objectId === "box").every((s) => s.status === "tooHigh") && high.summary.tooHigh >= 1 && high.summary.lifted === 0);
	console.log("PASS walls and too-high steps are reported and never lifted");
}
console.log("all pass");
