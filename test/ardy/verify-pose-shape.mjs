#!/usr/bin/env node

/** Verify both generated mannequins accept local pose deltas and deform. */
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { readFileSync } from "node:fs";
import { applyPose, normalizeBoneName, primeBindPose } from "../../src/poses.js";

if (typeof globalThis.window === "undefined") {
	globalThis.window = { innerWidth: 1920, innerHeight: 1080, URL };
}

const failures = [];
const ok = (label, pass, detail = "") => {
	console.log(`${pass ? "PASS" : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!pass) failures.push(label);
};

function load(name) {
	const buffer = readFileSync(new URL(`../../public/models/${name}.fbx`, import.meta.url));
	const root = new FBXLoader().parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), "");
	root.updateMatrixWorld(true);
	primeBindPose(root);
	return root;
}

function bone(root, name) {
	const target = normalizeBoneName(name);
	let found = null;
	root.traverse((object) => {
		if (object.isBone && normalizeBoneName(object.name) === target) found = object;
	});
	return found;
}

for (const name of ["cozyclay-male-neutral", "cozyclay-female-neutral"]) {
	const root = load(name);
	const leftHand = bone(root, "mixamorigLeftHand");
	const rightHand = bone(root, "mixamorigRightHand");
	const beforeLeft = leftHand.getWorldPosition(new THREE.Vector3());
	const beforeRight = rightHand.getWorldPosition(new THREE.Vector3());
	const meshes = [];
	root.traverse((object) => {
		if (object.isSkinnedMesh) meshes.push(object);
	});
	ok(`${name}: contains one skinned mannequin mesh`, meshes.length === 1, `meshes=${meshes.length}`);

	const mesh = meshes[0];
	const leftArmIndex = mesh.skeleton.bones.findIndex((item) => item === bone(root, "mixamorigLeftArm"));
	const skinIndex = mesh.geometry.attributes.skinIndex;
	const skinWeight = mesh.geometry.attributes.skinWeight;
	let leftArmVertices = 0;
	for (let vertex = 0; vertex < skinIndex.count; vertex += 1) {
		for (let influence = 0; influence < 4; influence += 1) {
			if (skinIndex.getComponent(vertex, influence) === leftArmIndex && skinWeight.getComponent(vertex, influence) > 0.05) {
				leftArmVertices += 1;
				break;
			}
		}
	}

	const result = applyPose(root, { lArm: [0, 0, 0.7], lForeArm: [0, 0, -0.45] });
	const afterLeft = leftHand.getWorldPosition(new THREE.Vector3());
	const afterRight = rightHand.getWorldPosition(new THREE.Vector3());

	ok(`${name}: authored arm joints resolve`, result.applied === 2, `applied=${result.applied}`);
	ok(`${name}: posed hand moves`, afterLeft.distanceTo(beforeLeft) > 0.1, `move=${afterLeft.distanceTo(beforeLeft).toFixed(4)}`);
	ok(`${name}: opposite hand stays pinned`, afterRight.distanceTo(beforeRight) < 1e-6, `move=${afterRight.distanceTo(beforeRight).toExponential(2)}`);
	ok(`${name}: mesh is weighted to the posed arm`, leftArmVertices > 50, `vertices=${leftArmVertices}`);

	applyPose(root, { lArm: [0, 0, 0], lForeArm: [0, 0, 0] });
	ok(`${name}: zero delta restores the hand`, leftHand.getWorldPosition(new THREE.Vector3()).distanceTo(beforeLeft) < 1e-6);
}

console.log(`\nfailures: ${failures.length}`);
process.exit(failures.length ? 1 : 0);
