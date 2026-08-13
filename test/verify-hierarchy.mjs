#!/usr/bin/env node
import { readFile } from "node:fs/promises";
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
expect("Scene is the single hierarchy root", HIERARCHY_NODES.length === 1 && HIERARCHY_NODES[0].id === "shot" && HIERARCHY_NODES[0].label === "SCENE 01" && HIERARCHY_NODES[0].kind === "scene");
expect("Camera belongs directly to Scene", byId.get("camera")?.parent === "shot");
expect("Characters group owns Character 1", byId.get("characterA")?.parent === "characters");
// The tree lists scene entities only — workflow nodes (motion, prompt
// blocks, IK, root path) moved to the sidebar's Shot/Motion tabs.
expect(
	"workflow nodes stay out of the scene tree",
	["characterA.motion", "characterA.baseMotion", "characterA.promptBlocks", "characterA.ik", "rootPath", "characterA.character", "characterB.character"].every(
		(id) => !byId.has(id),
	),
);
expect("Rig belongs to Character 1", byId.get("characterA.rig")?.parent === "characterA");
expect(
	"Rig exposes six human-readable body groups",
	["rig.hips", "rig.spine", "rig.leftArm", "rig.rightArm", "rig.leftLeg", "rig.rightLeg"].every(
		(id) => byId.get(id)?.parent === "characterA.rig",
	),
);
expect("Environment stays at the Scene level", byId.get("environment")?.parent === "shot");
expect("Props stay at the Scene level", byId.get("props")?.parent === "shot");
expect("tree depth stays scannable", Math.max(...nodes.map((node) => node.depth)) <= 4);

const panelSource = await readFile(new URL("../src/hierarchy-panel.jsx", import.meta.url), "utf8");
for (const callback of ["onSceneSelect", "onSceneCreate", "onSceneDuplicate", "onSceneRename", "onSceneDelete"]) {
	expect(`panel exposes ${callback}`, panelSource.includes(callback));
}
expect("scene selector is separate from entity tree", panelSource.includes('className="scene-switcher"') && panelSource.includes('className="hierarchy-tree"'));
expect("scene rename supports double-click", panelSource.includes("onDoubleClick={() => setEditingId(scene.id)}"));
expect("scene deletion asks for confirmation", panelSource.includes("window.confirm(message)"));
expect("last scene deletion is protected", panelSource.includes("disabled={availableScenes.length <= 1}"));

if (failures) process.exit(1);
console.log("all hierarchy checks PASS");
