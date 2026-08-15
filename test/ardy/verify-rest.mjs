#!/usr/bin/env node

/** Verify the generated CC0 mannequins share ARDY's 27-joint rest contract. */
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { readFileSync } from "node:fs";
import { CSKEL27_JOINTS, CSKEL27_PARENTS } from "../../src/ardy/cskel27.js";
import { CSKEL27_NEUTRAL } from "../../src/ardy/cskel27-neutral.js";
import { normalizeBoneName } from "../../src/poses.js";

if (typeof globalThis.window === "undefined") {
	globalThis.window = { innerWidth: 1920, innerHeight: 1080, URL };
}

const fail = [];
const ok = (label, pass, detail = "") => {
	console.log(`${pass ? "PASS" : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!pass) fail.push(label);
};

function load(name) {
	const buffer = readFileSync(new URL(`../../public/models/${name}.fbx`, import.meta.url));
	const root = new FBXLoader().parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), "");
	root.updateMatrixWorld(true);
	const bones = new Map();
	root.traverse((object) => {
		if (object.isBone) bones.set(normalizeBoneName(object.name), object);
	});
	return { root, bones };
}

const rigs = ["cozyclay-male-neutral", "cozyclay-female-neutral"].map((name) => ({ name, ...load(name) }));
const rest = JSON.parse(readFileSync(new URL("../../public/ardy/cskel27-rest.json", import.meta.url), "utf8"));
ok("rest file names the CC0 primary rig", rest.rig === "cozyclay-male-neutral", rest.rig);
ok("rest file resolves every cskel27 joint", rest.missing.length === 0 && rest.joints.length === 27);

const normalizedJoint = (name) => normalizeBoneName(`mixamorig${name}`);
for (const rig of rigs) {
	const mapped = CSKEL27_JOINTS.map((name) => rig.bones.get(normalizedJoint(name)));
	ok(`${rig.name}: all 27 bones exist`, mapped.every(Boolean));
	let hierarchyOk = true;
	for (let index = 1; index < mapped.length; index += 1) {
		hierarchyOk &&= mapped[index].parent === mapped[CSKEL27_PARENTS[index]];
	}
	ok(`${rig.name}: hierarchy matches cskel27`, hierarchyOk);

	const hips = mapped[0].getWorldPosition(new THREE.Vector3());
	let numerator = 0;
	let denominator = 0;
	const deltas = mapped.map((bone) => bone.getWorldPosition(new THREE.Vector3()).sub(hips));
	for (let index = 1; index < deltas.length; index += 1) {
		const neutral = new THREE.Vector3(...CSKEL27_NEUTRAL[index]);
		numerator += deltas[index].dot(neutral);
		denominator += neutral.lengthSq();
	}
	const scale = numerator / denominator;
	let maxError = 0;
	for (let index = 1; index < deltas.length; index += 1) {
		const expected = new THREE.Vector3(...CSKEL27_NEUTRAL[index]).multiplyScalar(scale);
		maxError = Math.max(maxError, deltas[index].distanceTo(expected));
	}
	ok(`${rig.name}: rest joints are a scaled ARDY neutral skeleton`, maxError < 1e-5, `scale=${scale.toFixed(5)} max=${maxError.toExponential(2)}`);
}

let maxRigDifference = 0;
for (const joint of CSKEL27_JOINTS) {
	const a = rigs[0].bones.get(normalizedJoint(joint)).getWorldQuaternion(new THREE.Quaternion());
	const b = rigs[1].bones.get(normalizedJoint(joint)).getWorldQuaternion(new THREE.Quaternion());
	maxRigDifference = Math.max(maxRigDifference, a.angleTo(b));
}
ok("male and female use identical rest axes", maxRigDifference < 0.002, `max=${THREE.MathUtils.radToDeg(maxRigDifference).toExponential(2)} deg`);

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
