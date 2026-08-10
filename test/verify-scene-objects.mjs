#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { buildHierarchyNodes } from "../src/hierarchy-model.js";
import {
	SCENE_QUARANTINE_KEY,
	SCENE_STORAGE_KEY,
	SCENE_VERSION,
	loadScene,
	serializeScene,
	DEFAULT_SCENE_OBJECTS,
	OBJECT_LIBRARY,
	createSceneObject,
	dropToSurfacePatch,
	placementInFront,
	objectSize,
	objectFootprintBounds,
	removeSceneObject,
	rotatePatch,
	scalePatch,
	screenRotatePatch,
	sceneObjectHierarchyId,
	sceneObjectIdFromHierarchy,
	translatePatch,
	updateSceneObject,
	wrapAngle,
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
expect("default registry excludes the car", !DEFAULT_SCENE_OBJECTS.some((object) => object.renderer === "car"));
expect("default registry excludes the chair", !DEFAULT_SCENE_OBJECTS.some((object) => object.renderer === "chair"));
expect("only the chair renderer applies the 90 percent scale", propsSource.includes("export function Chair") && propsSource.includes('rotation={[0, rotY, 0]} scale={0.9}') && !carSource.includes("scale={0.9}"));
expect("default player scene excludes the small plane", !DEFAULT_SCENE_OBJECTS.some((object) => object.renderer === "small-plane"));
expect("default player scene contains no props", DEFAULT_SCENE_OBJECTS.length === 0);
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

/* ------------------------------------------------------ creation ---- */

expect("catalogue offers the Unity primitive set", ["cube", "sphere", "capsule", "cylinder", "cone", "plane"].every((kind) => OBJECT_LIBRARY.some((entry) => entry.kind === kind)));
expect("catalogue keeps the hand-built set pieces", ["car", "small-plane", "chair"].every((kind) => OBJECT_LIBRARY.some((entry) => entry.kind === kind)));
expect("every catalogue entry carries a footprint and a height", OBJECT_LIBRARY.every((entry) => entry.footprint.width > 0 && entry.footprint.depth > 0 && entry.height >= 0));

const cube = createSceneObject("cube", []);
expect("created object starts neutral on the floor", cube.y === 0 && cube.rotX === 0 && cube.rotZ === 0 && cube.scaleX === 1 && cube.scaleY === 1 && cube.scaleZ === 1);
expect("primitives are grey-box grey, set pieces keep their clay", cube.color === "#c2c6c8" && createSceneObject("car", []).color === "#d98770");
expect("created object carries its own footprint copy", cube.footprint !== OBJECT_LIBRARY[0].footprint && cube.footprint.width === 1);
expect("unknown kinds create nothing", createSceneObject("teapot", []) === null);

const twoCubes = [cube, createSceneObject("cube", [cube])];
expect("repeat creation gets a unique id", twoCubes[0].id !== twoCubes[1].id);
expect("repeat creation gets a numbered name", twoCubes[1].name === "Cube 2", twoCubes[1].name);

const placed = createSceneObject("chair", [], { x: 99, z: -99, rot: 540 });
expect("creation clamps placement into the room", placed.x === 6.5 && placed.z === -6.5);
expect("an explicit placement angle is still wrapped", placed.rot === -180, String(placed.rot));

// camera at the origin looking down -Z (yaw 0): the drop point is 2.6 m ahead
const drop = placementInFront({ x: 0, z: 0 }, 0);
expect("new objects land down the lens, not on the lens", Math.abs(drop.z + 2.6) < 1e-9 && Math.abs(drop.x) < 1e-9, JSON.stringify(drop));
// Unity creates primitives axis-aligned. Anything else breaks the invariant
// the user reads off the inspector: equal rotation values face the same way.
expect("placement never rotates the new object", drop.rot === undefined);
const angled = placementInFront({ x: 0, z: 0 }, Math.PI / 3);
expect("a turned camera still creates an unrotated object", angled.rot === undefined, JSON.stringify(angled));
expect("an object created from any angle starts at zero rotation", (() => {
	const made = createSceneObject("cube", [], angled);
	return made.rot === 0 && made.rotX === 0 && made.rotZ === 0;
})());

/* --------------------------------------------------- gizmo maths ---- */

const start = { x: 1, y: 0.5, z: -2, rot: 10, rotX: 0, rotZ: 0 };
expect("axis drag is absolute from the drag start", translatePatch(start, "x", 0.5).x === 1.5);
expect("axis drag snaps to the 5 cm grid", translatePatch(start, "z", 0.32).z === -1.7, JSON.stringify(translatePatch(start, "z", 0.32)));
expect("height drags write the Y channel", translatePatch(start, "y", 0.25).y === 0.75);
expect("a non-axis drag writes nothing", translatePatch(start, "w", 1) === null && translatePatch(start, "x", Number.NaN) === null);
expect("the Y ring drives the yaw the plan board reads", rotatePatch(start, "y", 33).rot === 45, JSON.stringify(rotatePatch(start, "y", 33)));
expect("the X ring drives tilt and the Z ring roll", rotatePatch(start, "x", 20).rotX === 20 && rotatePatch(start, "z", -20).rotZ === -20);
expect("ring rotation wraps instead of running away", rotatePatch({ rot: 170 }, "y", 30).rot === -160, JSON.stringify(rotatePatch({ rot: 170 }, "y", 30)));
expect("angles fold into [-180, 180)", wrapAngle(360) === 0 && wrapAngle(-190) === 170 && wrapAngle(180) === -180);

expect("an axis scale knob scales only its own axis", JSON.stringify(scalePatch({ scaleX: 1, scaleY: 1, scaleZ: 1 }, "x", 2)) === JSON.stringify({ scaleX: 2 }));
expect("the centre knob scales all three axes", JSON.stringify(scalePatch({ scaleX: 1, scaleY: 2, scaleZ: 1 }, null, 1.5)) === JSON.stringify({ scaleX: 1.5, scaleY: 3, scaleZ: 1.5 }));
expect("scale snaps to 5 percent steps", scalePatch({ scaleX: 1 }, "x", 1.234).scaleX === 1.25, JSON.stringify(scalePatch({ scaleX: 1 }, "x", 1.234)));
expect("scale never collapses to nothing", scalePatch({ scaleX: 1 }, "x", 0.001).scaleX === 0.1);
expect("a degenerate scale drag writes nothing", scalePatch({ scaleX: 1 }, "x", 0) === null && scalePatch({ scaleX: 1 }, "w", 2) === null);
expect("world size folds scale into the footprint", JSON.stringify(objectSize({ footprint: { width: 2, depth: 3 }, height: 4, scaleX: 0.5, scaleY: 2, scaleZ: 1 })) === JSON.stringify({ width: 1, height: 8, depth: 3 }));

// The screen ring spins about an arbitrary world axis and has to write all
// three Euler channels back coherently.
const upright = { rotX: 0, rot: 0, rotZ: 0 };
const spun = screenRotatePatch(upright, { x: 0, y: 1, z: 0 }, 90);
expect("a view-axis spin about world Y lands on the Y channel", spun.rot === 90 && spun.rotX === 0 && spun.rotZ === 0, JSON.stringify(spun));
const rolled = screenRotatePatch(upright, { x: 0, y: 0, z: 1 }, 30);
expect("a view-axis spin about world Z lands on the Z channel", rolled.rotZ === 30 && rolled.rotX === 0 && rolled.rot === 0, JSON.stringify(rolled));
expect("the screen ring snaps to the 5 degree grid", screenRotatePatch(upright, { x: 0, y: 1, z: 0 }, 33).rot === 35, JSON.stringify(screenRotatePatch(upright, { x: 0, y: 1, z: 0 }, 33)));
expect("an unsnapped screen spin keeps the exact angle", screenRotatePatch(upright, { x: 0, y: 1, z: 0 }, 33, 0).rot === 33);
expect("a degenerate screen spin writes nothing", screenRotatePatch(upright, null, 10) === null && screenRotatePatch(upright, { x: 0, y: 1, z: 0 }, Number.NaN) === null);

/* ------------------------------------------------------- clamping --- */

const bounded = updateSceneObject([cube], cube.id, { x: 99, y: -3, z: -99, scaleX: 40, scaleY: 0 })[0];
expect("transforms stay inside the room and above the floor", bounded.x === 6.5 && bounded.z === -6.5 && bounded.y === 0);
expect("scale stays within a usable range", bounded.scaleX === 5 && bounded.scaleY === 0.1);
const renamed = updateSceneObject([cube], cube.id, { name: "Crate", color: "#123456" })[0];
expect("name and colour are editable", renamed.name === "Crate" && renamed.color === "#123456");
expect("empty names are rejected", updateSceneObject([cube], cube.id, { name: "" })[0] === cube);

/* ------------------------------------------------ persistence ---- */

const fullRecord = createSceneObject("cube", []);
const roundTrip = loadScene(serializeScene([fullRecord]));
expect(
	"a serialized scene round-trips",
	roundTrip.status === "valid" && JSON.stringify(roundTrip.objects) === JSON.stringify([fullRecord]),
	JSON.stringify(roundTrip),
);

expect(
	"an absent payload is tagged absent",
	loadScene(null).status === "absent" && loadScene("").status === "absent" && loadScene(undefined).status === "absent",
);

expect(
	"malformed JSON is tagged corrupt",
	loadScene("{").status === "corrupt" && loadScene("[1,2]").status === "corrupt" && loadScene('{"version":1}').status === "corrupt",
);

expect(
	"a non-integer or non-positive version is corrupt, not future",
	['{"version":"1","objects":[]}', '{"version":1.5,"objects":[]}', '{"version":0,"objects":[]}', '{"version":-1,"objects":[]}'].every(
		(raw) => loadScene(raw).status === "corrupt",
	),
);

expect(
	"only an integer newer than SCENE_VERSION is future",
	loadScene('{"version":2,"objects":[]}').status === "future" &&
		loadScene('{"version":99,"objects":[]}').status === "future" &&
		loadScene('{"version":2,"objects":[]}').objects.length === 0,
);

expect(
	"the supported version range is exactly 1..SCENE_VERSION",
	Array.from({ length: SCENE_VERSION }, (_, index) => index + 1).every((version) =>
		loadScene(JSON.stringify({ version, objects: [] })).status === "valid",
	),
);

expect(
	"an unknown renderer is dropped, not fatal",
	(() => {
		const result = loadScene(
			JSON.stringify({ version: 1, objects: [createSceneObject("cube", []), { id: "ghost", renderer: "ghost" }] }),
		);
		return result.objects.length === 1 && result.dropped === 1;
	})(),
);

expect(
	"footprint and height are rebuilt from the library",
	(() => {
		const result = loadScene(
			JSON.stringify({ version: 1, objects: [{ id: "cube", renderer: "cube", footprint: { width: 99, depth: 99 }, height: 42 }] }),
		);
		return result.objects[0].footprint.width === 1 && result.objects[0].footprint.depth === 1 && result.objects[0].height === 1;
	})(),
);

expect(
	"a single scale field fans out to three axes",
	(() => {
		const result = loadScene(JSON.stringify({ version: 1, objects: [{ id: "cube", renderer: "cube", scale: 2 }] }));
		const object = result.objects[0];
		return object.scaleX === 2 && object.scaleY === 2 && object.scaleZ === 2;
	})(),
);

expect(
	"out-of-room values are clamped on load",
	(() => {
		const result = loadScene(JSON.stringify({ version: 1, objects: [{ id: "cube", renderer: "cube", x: 99, y: -3, scaleX: 50 }] }));
		const object = result.objects[0];
		return object.x === 6.5 && object.y === 0 && object.scaleX === 5;
	})(),
);

expect(
	"duplicate ids are dropped and counted",
	(() => {
		const cube = createSceneObject("cube", []);
		const result = loadScene(JSON.stringify({ version: 1, objects: [cube, { ...cube, name: "Cube 2" }] }));
		return result.objects.length === 1 && result.dropped === 1;
	})(),
);

expect(
	"the storage keys are namespaced, versioned and distinct",
	SCENE_STORAGE_KEY === "cozyclay.scene.v1" &&
		SCENE_VERSION === 1 &&
		SCENE_QUARANTINE_KEY.startsWith(SCENE_STORAGE_KEY) &&
		SCENE_QUARANTINE_KEY !== SCENE_STORAGE_KEY,
);
/* ------------------------------------------------ drop-to-surface ---- */

// Strict drop-down (plan §9.2): a surface supports the falling object only
// when its top is at or below the object's current base, so an object that
// is already inside a box is NOT supported by it and falls through. The
// patch touches only Y; the caller's updateSceneObject clamp owns the limits.
const cubeAt = (id, x, z, y, height = 1) => ({
	id,
	x,
	y,
	z,
	rot: 0,
	rotX: 0,
	rotZ: 0,
	scaleX: 1,
	scaleY: 1,
	scaleZ: 1,
	footprint: { width: 0.5, depth: 0.5 },
	height,
});
const box = {
	id: "box",
	x: 0,
	y: 0,
	z: 0,
	rot: 0,
	rotX: 0,
	rotZ: 0,
	scaleX: 1,
	scaleY: 1,
	scaleZ: 1,
	footprint: { width: 1, depth: 1 },
	height: 1,
};

const floater = cubeAt("floater", 0, 0, 2);
const floaterBefore = JSON.stringify(floater);
const floorPatch = dropToSurfacePatch(floater, []);
expect("an object over empty floor drops to zero", floorPatch !== null && floorPatch.y === 0, JSON.stringify(floorPatch));
expect("a drop never mutates its inputs", JSON.stringify(floater) === floaterBefore);

const boxPatch = dropToSurfacePatch(cubeAt("faller", 0, 0, 1.5), [box]);
expect("an object over a box rests on its top", boxPatch !== null && boxPatch.y === 1, JSON.stringify(boxPatch));

const tallBox = { ...box, id: "tall", scaleY: 2 };
expect("scaleY raises the support surface", dropToSurfacePatch(cubeAt("faller2", 0, 0, 3), [tallBox]).y === 2);

expect("a non-overlapping neighbour is not a support", dropToSurfacePatch(cubeAt("far", 5, 5, 1), [box]).y === 0);
// The 0.5 m cube's edge touches the 1 m box's edge at x = 0.5 exactly: the
// EPS tolerance keeps the abutment from counting as overlap.
expect("an edge-touching neighbour is not a support", dropToSurfacePatch(cubeAt("edge", 0.75, 0, 1), [box]).y === 0);

const raisedBox = { ...box, id: "raised", y: 1 };
expect("a support above the object is ignored", dropToSurfacePatch(cubeAt("low", 0, 0, 0.5), [raisedBox]).y === 0);

// Base 0.4 is below the box top 1, so strict drop-down says the box is NOT
// support and the object lands on the floor — not on the box top.
expect("an object already inside a box falls through it", dropToSurfacePatch(cubeAt("buried", 0, 0, 0.4), [box]).y === 0);

// Composition: the patch carries only Y, so snapped X/Z survive byte-for-byte
// and the exact (un-snapped) contact height comes through updateSceneObject.
const offGrid = { ...box, id: "offgrid", x: 1.25, z: -0.4, height: 1.13 };
const snapStart = cubeAt("drop", 1.25, -0.4, 2);
const composed = dropToSurfacePatch(snapStart, [offGrid]);
expect("a drop preserves snapped X and Z byte-for-byte", composed !== null && composed.y === 1.13, JSON.stringify(composed));
const rested = updateSceneObject([snapStart, offGrid], snapStart.id, composed);
expect(
	"the applied drop lands exactly on the off-grid top, not on the 5 cm grid",
	rested[0].x === 1.25 && rested[0].z === -0.4 && rested[0].y === 1.13,
	JSON.stringify(rested[0]),
);
const noOp = dropToSurfacePatch(rested[0], [offGrid]);
expect("a drop is idempotent — the second drop changes nothing", noOp === null, JSON.stringify(noOp));
expect(
	"a redundant drop keeps the SAME array reference, so no history entry is possible",
	updateSceneObject(rested, rested[0].id, noOp ?? {}) === rested,
);

// The clamp lives in updateSceneObject alone: the pure patch reports the raw
// 6.00005 m contact (a support top a hair above the 6 m ceiling, admitted by
// the EPS tolerance because the object's base sits exactly at the ceiling)
// and the applied record is capped at 6.
const tallStack = { ...box, id: "stack", height: 6.00005 };
const overCeiling = dropToSurfacePatch(cubeAt("up", 0, 0, 6), [tallStack]);
expect("the drop patch itself is not clamped", overCeiling !== null && overCeiling.y === 6.00005, JSON.stringify(overCeiling));
const clamped = updateSceneObject([cubeAt("up", 0, 0, 6), tallStack], "up", overCeiling)[0];
expect("a composed drop still hits the ceiling clamp", clamped.y === 6, JSON.stringify(clamped));

// A 0.5 x 4 m plank at 45 degrees: the yawed AABB is a ~3.18 m square, so a
// cube at x = 0.5 (which the unrotated 0.5 m-wide footprint would miss) is
// supported, while one beyond the projected square is not.
const plank = {
	id: "plank",
	x: 0,
	y: 0,
	z: 0,
	rot: 45,
	rotX: 0,
	rotZ: 0,
	scaleX: 1,
	scaleY: 1,
	scaleZ: 1,
	footprint: { width: 0.5, depth: 4 },
	height: 0.1,
};
const plankBounds = objectFootprintBounds(plank);
expect(
	"the yawed AABB widens the plank beyond its unrotated footprint",
	plankBounds.maxX > 1.5 && plankBounds.maxZ > 1.5 && plankBounds.baseY === 0 && plankBounds.topY === 0.1,
	JSON.stringify(plankBounds),
);
expect(
	"a 45-degree long support widens the overlap window",
	dropToSurfacePatch(cubeAt("grazing", 0.5, 0, 1), [plank]).y === 0.1,
);
expect(
	"a 45-degree support does not create phantom overlap beyond its AABB",
	dropToSurfacePatch(cubeAt("clear", 2.5, 0, 1), [plank]).y === 0,
);

if (failures) process.exit(1);
console.log("all scene object checks PASS");
