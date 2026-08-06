#!/usr/bin/env node
import { HIERARCHY_NODES } from "../src/hierarchy-model.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
function flatten(nodes, parent = null, depth = 0, out = []) {
	for (const node of nodes) {
		out.push({ ...node, parent, depth });
		if (node.children) flatten(node.children, node.id, depth + 1, out);
	}
	return out;
}

const nodes = flatten(HIERARCHY_NODES);
const byId = new Map(nodes.map((node) => [node.id, node]));
expect("hierarchy IDs are unique", byId.size === nodes.length, `${byId.size}/${nodes.length}`);
expect("Shot is the single hierarchy root", HIERARCHY_NODES.length === 1 && HIERARCHY_NODES[0].id === "shot");
expect("Camera belongs directly to Shot", byId.get("camera")?.parent === "shot");
expect("Characters group owns Character 1", byId.get("characterA")?.parent === "characters");
expect("Motion belongs to Character 1", byId.get("characterA.motion")?.parent === "characterA");
expect(
	"Motion exposes Base, Prompt Blocks, and IK correction layers",
	["characterA.baseMotion", "characterA.promptBlocks", "characterA.ik"].every(
		(id) => byId.get(id)?.parent === "characterA.motion",
	),
);
expect(
	"Rig exposes six human-readable body groups",
	["rig.hips", "rig.spine", "rig.leftArm", "rig.rightArm", "rig.leftLeg", "rig.rightLeg"].every(
		(id) => byId.get(id)?.parent === "characterA.rig",
	),
);
expect("Root Path stays at the Shot level", byId.get("rootPath")?.parent === "shot");
expect("Environment stays at the Shot level", byId.get("environment")?.parent === "shot");
expect("Props stay at the Shot level", byId.get("props")?.parent === "shot");
expect("tree depth stays scannable", Math.max(...nodes.map((node) => node.depth)) <= 4);

if (failures) process.exit(1);
console.log("all hierarchy checks PASS");
