#!/usr/bin/env node
import assert from "node:assert/strict";
import {
	LEGACY_SCENE_STORAGE_KEY,
	SCENES_QUARANTINE_KEY,
	SCENES_STORAGE_KEY,
	activeScene,
	activeSceneIndex,
	addScene,
	createScene,
	createSceneDocument,
	duplicateScene,
	loadSceneDocumentFromStorage,
	readSceneDocument,
	removeScene,
	renameScene,
	serializeSceneDocument,
} from "../src/scenes.js";

let scenes = [];
scenes = addScene(scenes);
scenes = addScene(scenes);
scenes = addScene(scenes, "Kitchen");
scenes = addScene(scenes, "Kitchen");
assert.deepEqual(scenes.map((scene) => scene.name), ["SCENE 01", "SCENE 02", "Kitchen", "Kitchen 2"]);
assert.equal(new Set(scenes.map((scene) => scene.id)).size, scenes.length);

scenes[0].objects = [{ id: "chair", transform: { x: 1 } }];
scenes[0].shotDocument = { version: 99, cameraBlocks: [{ id: "sealed", keys: [1, 2] }] };
const duplicated = duplicateScene(scenes, 0);
assert.equal(duplicated[1].name, "SCENE 03");
assert.notEqual(duplicated[1].objects, scenes[0].objects);
assert.notEqual(duplicated[1].objects[0].transform, scenes[0].objects[0].transform);
assert.notEqual(duplicated[1].shotDocument.cameraBlocks, scenes[0].shotDocument.cameraBlocks);
duplicated[1].objects[0].transform.x = 8;
duplicated[1].shotDocument.cameraBlocks[0].keys.push(3);
assert.equal(scenes[0].objects[0].transform.x, 1);
assert.deepEqual(scenes[0].shotDocument.cameraBlocks[0].keys, [1, 2]);

const renamed = renameScene(scenes, 2, "SCENE 01");
assert.equal(renamed[2].name, "SCENE 03");
assert.equal(renameScene(scenes, 2, "  "), scenes);
assert.equal(removeScene([scenes[0]], 0).length, 1, "the final scene is protected");
assert.equal(removeScene(scenes, 1).length, scenes.length - 1);

assert.equal(activeSceneIndex(scenes, scenes[2].id), 2);
assert.equal(activeSceneIndex(scenes, "missing"), 0);
assert.equal(activeSceneIndex([], "missing"), -1);
assert.equal(activeScene(scenes, scenes[1].id), scenes[1]);
assert.equal(activeScene([], null), null);

const document = createSceneDocument();
document.scenes = scenes;
document.activeSceneId = scenes[2].id;
const restored = readSceneDocument(serializeSceneDocument(document));
assert.equal(restored.status, "valid");
assert.equal(restored.document.activeSceneId, scenes[2].id);
assert.deepEqual(restored.document.scenes[0].shotDocument, scenes[0].shotDocument);

const repaired = readSceneDocument(JSON.stringify({
	version: 1,
	activeSceneId: "missing",
	scenes: [
		{ id: "good", name: "Set", objects: [{ id: "box" }, null], shotDocument: { futureShape: [1] } },
		{ id: "good", name: "duplicate id", objects: [] },
		null,
		{ id: "bad-objects", name: "Bad", objects: "nope" },
	],
}));
assert.equal(repaired.status, "valid");
assert.equal(repaired.dropped, 3);
assert.equal(repaired.document.scenes.length, 1);
assert.equal(repaired.document.scenes[0].objects.length, 1);
assert.equal(repaired.document.activeSceneId, "good");

const legacyObjects = [{ id: "hero-chair", renderer: "chair", x: 3 }, { id: "car", renderer: "car", nested: { untouched: true } }];
const migrated = readSceneDocument(null, JSON.stringify({ version: 1, objects: legacyObjects }));
assert.equal(migrated.status, "migrated");
assert.equal(migrated.document.scenes.length, 1);
assert.deepEqual(migrated.document.scenes[0].objects, legacyObjects, "legacy user work survives byte-shaped migration");
assert.equal(migrated.document.scenes[0].name, "SCENE 01");

assert.equal(readSceneDocument("{broken").status, "corrupt");
assert.equal(readSceneDocument(JSON.stringify({ version: 2, scenes: [] })).status, "future");
assert.equal(readSceneDocument(JSON.stringify({ version: 2, newerShape: true })).status, "future");
assert.equal(readSceneDocument(null, "{broken").status, "corrupt");

class FakeStorage {
	constructor(entries = {}) { this.values = new Map(Object.entries(entries)); this.writes = []; }
	getItem(key) { return this.values.get(key) ?? null; }
	setItem(key, value) { this.values.set(key, value); this.writes.push([key, value]); }
}

const legacyRaw = JSON.stringify({ version: 1, objects: legacyObjects });
const migrationStorage = new FakeStorage({ [LEGACY_SCENE_STORAGE_KEY]: legacyRaw });
const storageMigration = loadSceneDocumentFromStorage(migrationStorage);
assert.equal(storageMigration.status, "migrated");
assert.ok(migrationStorage.getItem(SCENES_STORAGE_KEY));
assert.equal(migrationStorage.getItem(LEGACY_SCENE_STORAGE_KEY), legacyRaw, "legacy backup is not deleted");

const corruptRaw = "{broken scenes";
const corruptStorage = new FakeStorage({ [SCENES_STORAGE_KEY]: corruptRaw });
assert.equal(loadSceneDocumentFromStorage(corruptStorage).status, "corrupt");
assert.equal(corruptStorage.getItem(SCENES_QUARANTINE_KEY), corruptRaw);

const futureRaw = JSON.stringify({ version: 9, scenes: [{ id: "future" }] });
const futureStorage = new FakeStorage({ [SCENES_STORAGE_KEY]: futureRaw });
assert.equal(loadSceneDocumentFromStorage(futureStorage).status, "future");
assert.deepEqual(futureStorage.writes, [], "future data is left untouched");
assert.equal(futureStorage.getItem(SCENES_STORAGE_KEY), futureRaw);

assert.match(SCENES_STORAGE_KEY, /\.v1$/);
assert.notEqual(SCENES_STORAGE_KEY, SCENES_QUARANTINE_KEY);
assert.notEqual(SCENES_STORAGE_KEY, LEGACY_SCENE_STORAGE_KEY);
assert.ok(createScene("SCENE 01", scenes).id);

console.log("all scene document checks PASS");
