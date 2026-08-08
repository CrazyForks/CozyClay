#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { buildHierarchyNodes } from "../src/hierarchy-model.js";
import {
	DEFAULT_SCENE_OBJECTS,
	removeSceneObject,
	sceneObjectHierarchyId,
	sceneObjectIdFromHierarchy,
	updateSceneObject,
} from "../src/scene-objects.js";

let failures = 0;
const propsSource = readFileSync(new URL("../src/props.jsx", import.meta.url), "utf8");
const carSource = propsSource.slice(
	propsSource.indexOf("export function Car"),
	propsSource.indexOf("export function SmallPlane"),
);
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
function findNode(nodes, id) {
	for (const node of nodes) {
		if (node.id === id) return node;
		const child = node.children && findNode(node.children, id);
		if (child) return child;
	}
	return null;
}

const objects = [
	{ id: "asset-17", name: "Desk Lamp", renderer: "lamp", x: 1, z: 2, rot: 15, footprint: { width: 0.4, depth: 0.4 } },
	{ id: "generated-bike", name: "Bike", renderer: "bike", x: -2, z: 0, rot: -30, footprint: { width: 0.7, depth: 1.8 } },
];
const defaultIds = new Set(DEFAULT_SCENE_OBJECTS.map((object) => object.id));
expect("default objects have unique IDs", defaultIds.size === DEFAULT_SCENE_OBJECTS.length);
expect("default registry includes the current car", DEFAULT_SCENE_OBJECTS.some((object) => object.renderer === "car"));
expect("default registry excludes the chair", !DEFAULT_SCENE_OBJECTS.some((object) => object.renderer === "chair"));
expect("only the chair renderer applies the 90 percent scale", propsSource.includes("export function Chair") && propsSource.includes('rotation={[0, rotY, 0]} scale={0.9}') && !carSource.includes("scale={0.9}"));
expect("default player scene excludes the small plane", !DEFAULT_SCENE_OBJECTS.some((object) => object.renderer === "small-plane"));
expect("default player scene contains only the car", DEFAULT_SCENE_OBJECTS.length === 1);
const hierarchy = buildHierarchyNodes(objects);
const props = findNode(hierarchy, "props");
expect("Props children come from live scene objects", props.children.length === 2, JSON.stringify(props.children));
expect("arbitrary object name appears in hierarchy", props.children[0].label === "Desk Lamp");
expect("arbitrary object ID is namespaced", props.children[0].id === "object:asset-17");
expect("hierarchy ID round-trips to object ID", sceneObjectIdFromHierarchy(sceneObjectHierarchyId("asset-17")) === "asset-17");
expect("non-object hierarchy ID is rejected", sceneObjectIdFromHierarchy("camera") === null);

const moved = updateSceneObject(objects, "asset-17", { x: 3.25, z: -1.5, rot: 90 });
expect("transform update returns a new collection", moved !== objects);
expect("transform update preserves untouched object identity", moved[1] === objects[1]);
expect("transform update changes only requested object", moved[0].x === 3.25 && moved[0].z === -1.5 && moved[0].rot === 90);
expect("transform update preserves renderer metadata", moved[0].renderer === "lamp" && moved[0].footprint === objects[0].footprint);
expect("invalid numeric update is ignored", updateSceneObject(objects, "asset-17", { x: Number.NaN }) === objects);
expect("unknown object update is ignored", updateSceneObject(objects, "missing", { x: 4 }) === objects);

const removed = removeSceneObject(objects, "asset-17");
expect("object removal returns a new collection", removed !== objects);
expect("object removal removes only the requested object", removed.length === 1 && removed[0] === objects[1]);
expect("unknown object removal is ignored", removeSceneObject(objects, "missing") === objects);

if (failures) process.exit(1);
console.log("all scene object checks PASS");
