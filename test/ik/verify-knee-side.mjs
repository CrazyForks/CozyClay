import assert from "node:assert/strict";
import * as THREE from "three";
import { resolveIkRig, solveIk } from "../../src/ardy/ik.js";

// Synthetic mixamo leg (45 + 45 cm, cm bones under a 0.01 group), facing +Z.
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
const rig = makeRig(), { chains } = resolveIkRig(rig), chain = chains.get("leftFoot");
const [hip, knee, ankle] = chain.bones;
const world = (b) => b.getWorldPosition(new THREE.Vector3());
// Signed knee flexion in degrees: + = knee forward of the hip-ankle line (normal), - = reverse.
const flex = () => {
	const p0 = world(hip), p1 = world(knee), p2 = world(ankle);
	const thigh = p1.clone().sub(p0), shin = p2.clone().sub(p1);
	return Math.sign(thigh.clone().cross(shin).x) * THREE.MathUtils.radToDeg(thigh.angleTo(shin));
};

// A heel-strike swing pose: thigh forward by `hipFlex`, knee bent by `bendDeg`
// (both about +X), then the ankle target raised by `lift` with the hip held,
// exactly what platform-fit asks of a swing foot near a raised box. The
// exactHinge path must keep the knee on its current side; the legacy path
// (fix-collisions) is out of scope here.
let worst = null, worstReach = 0, cases = 0;
for (let hipFlex = 5; hipFlex <= 35; hipFlex += 5) for (let bendDeg = 4; bendDeg <= 30; bendDeg += 2) for (let lift = .05; lift <= .4 + 1e-9; lift += .05) {
	hip.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -THREE.MathUtils.degToRad(hipFlex));
	knee.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(bendDeg));
	rig.updateMatrixWorld(true);
	const before = flex();
	assert(before > 0, `source pose bends forward (${before})`);
	const target = world(ankle).add(new THREE.Vector3(0, lift, 0));
	solveIk(chain, target, { exactHinge: true }); rig.updateMatrixWorld(true);
	const after = flex();
	worstReach = Math.max(worstReach, world(ankle).distanceTo(target));
	if (!worst || after < worst.after) worst = { hipFlex, bendDeg, lift: +lift.toFixed(2), before: +before.toFixed(1), after: +after.toFixed(1) };
	cases += 1;
}
console.log(`worst ${JSON.stringify(worst)} over ${cases} cases`);
assert(worst.after > 0, `exactHinge knee flipped to the reverse side: ${JSON.stringify(worst)}`);
console.log(`PASS exactHinge knee keeps its bend side under raised targets (worst flex ${worst.after.toFixed(1)} deg)`);
assert(worstReach < 1e-4, `exactHinge effector misses the reachable target by ${worstReach} m`);
console.log(`PASS exactHinge effector reaches every raised target (worst miss ${worstReach.toExponential(2)} m)`);
