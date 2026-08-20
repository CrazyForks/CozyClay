// Project file envelope: create/parse round-trip, validation, and the
// boundaries that keep a project file from clobbering the session.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createProjectDocument, readProjectDocument, PROJECT_VERSION, PROJECT_EXTENSION } from "../src/project.js";
import { createSceneDocument, createSceneStage, SCENES_VERSION } from "../src/scenes.js";
import { ASSET_MAX_SOURCE_BYTES, referencedAssetIds } from "../src/scene-assets.js";

const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

// --- envelope round trip --------------------------------------------------
const scenesDocument = createSceneDocument("SCENE 01");
scenesDocument.scenes[0].stage = createSceneStage({
	characters: [{ id: "char-a", model: "x-bot-tpose", x: 1, z: -2, rot: 30, tint: "#a1b2c3", subject: "a robot" }],
});
const doc = createProjectDocument({
	scenesDocument,
	workspaceLayout: { hierarchyWidth: 320, sidebarWidth: 400 },
	customPoses: [{ id: "custom_1", label: "My Pose", bones: { hips: [0.1, 0, 0] } }],
	name: "Demo Reel",
});
const parsed = readProjectDocument(JSON.stringify(doc));
assert.equal(parsed.ok, true);
assert.equal(parsed.project.name, "Demo Reel");
assert.equal(parsed.project.scenesDocument.scenes[0].stage.characters[0].model, "x-bot-tpose");
assert.equal(parsed.project.scenesDocument.scenes[0].stage.characters[0].tint, "#a1b2c3");
assert.equal(parsed.project.workspaceLayout.hierarchyWidth, 320);
assert.equal(parsed.project.customPoses.length, 1);

// --- embedded scene assets -------------------------------------------------
const renderedAssetId = `img-${"a".repeat(32)}`;
const sourceAssetId = `img-${"b".repeat(32)}`;
const matteAssetId = `img-${"c".repeat(32)}`;
const orphanAssetId = `img-${"d".repeat(32)}`;
const assetScenesDocument = createSceneDocument("CUTOUTS");
assetScenesDocument.scenes[0].objects = [{
	id: "matted-cutout",
	renderer: "cutout",
	assetId: renderedAssetId,
	sourceAssetId,
	matteAssetId,
}];
const fakeAssets = [
	{ id: renderedAssetId, type: "image/png", width: 80, height: 60, name: "rendered.png", bytes: new Uint8Array([1, 2, 3]) },
	{ id: sourceAssetId, type: "image/jpeg", width: 80, height: 60, name: "source.jpg", bytes: new Uint8Array([4, 5, 6]) },
	{ id: matteAssetId, type: "image/png", width: 80, height: 60, name: "matte.png", bytes: new Uint8Array([7, 8, 9]) },
	{ id: orphanAssetId, type: "image/png", width: 80, height: 60, name: "orphan.png", bytes: new Uint8Array([10]) },
];
const assetDocument = createProjectDocument({ scenesDocument: assetScenesDocument, assets: fakeAssets });
const embeddedAssetIds = assetDocument.assets.map((asset) => asset.id).sort();
assert.deepEqual(embeddedAssetIds, [...referencedAssetIds(assetScenesDocument.scenes)].sort(), "only the matted cutout asset closure is embedded");
assert.equal(assetDocument.version, 2, "asset-bearing documents use envelope v2");
assert.ok(assetDocument.assets.every((asset) => typeof asset.bytes === "string" && !asset.bytes.startsWith("data:")), "asset bytes are bare base64");
const parsedAssets = readProjectDocument(JSON.stringify(assetDocument));
assert.equal(parsedAssets.ok, true);
assert.deepEqual(
	parsedAssets.project.assets.map(({ id: assetId, type, width, height, name, bytes }) => ({ assetId, type, width, height, name, bytes: [...new Uint8Array(bytes)] })),
	assetDocument.assets.map(({ id: assetId, type, width, height, name, bytes }) => ({
		assetId,
		type,
		width,
		height,
		name,
		bytes: [...Buffer.from(bytes, "base64")],
	})),
	"embedded asset records round-trip byte-for-byte",
);

// --- validation boundaries ------------------------------------------------
assert.equal(readProjectDocument("{broken").ok, false, "corrupt JSON rejected");
assert.equal(readProjectDocument("{broken").reason, "corrupt");
assert.equal(readProjectDocument(JSON.stringify({ app: "cozyclay", kind: "project", version: PROJECT_VERSION + 1 })).reason, "future", "a newer file version never loads");
assert.equal(readProjectDocument(JSON.stringify({ app: "other", kind: "project", version: 1 })).reason, "not-a-project");
assert.equal(
	readProjectDocument(JSON.stringify({ app: "cozyclay", kind: "project", version: 1, scenes: { version: SCENES_VERSION + 1, scenes: [] } })).reason,
	"scenes-invalid",
	"a project holding future scenes stays sealed",
);

// name fallback + pose filtering
const unnamed = readProjectDocument(JSON.stringify(createProjectDocument({ scenesDocument, name: "  " })));
assert.equal(unnamed.project.name, "Untitled");
const dirtyPoses = readProjectDocument(JSON.stringify({ ...doc, poseLibrary: [{ id: "ok", bones: {} }, { nope: true }, null, { id: 3, bones: {} }] }));
assert.equal(dirtyPoses.project.customPoses.length, 1, "pose library entries without id+bones are dropped");

const { assets: _v2Assets, ...v1Document } = { ...doc, version: 1 };
const parsedV1 = readProjectDocument(JSON.stringify(v1Document));
assert.equal(parsedV1.ok, true, "v1 documents without assets remain readable");
assert.deepEqual(parsedV1.project.assets, [], "v1 documents produce no assets to hydrate");
const malformedAssets = readProjectDocument(JSON.stringify({
	...assetDocument,
	assets: [
		{ ...assetDocument.assets[0], id: "junk" },
		{ ...assetDocument.assets[1], bytes: "not base64!" },
		{ ...assetDocument.assets[2], bytes: "A".repeat(Math.ceil((ASSET_MAX_SOURCE_BYTES + 1) / 3) * 4) },
	],
}));
assert.equal(malformedAssets.ok, true, "malformed embedded assets never reject a project");
assert.deepEqual(malformedAssets.project.assets, [], "malformed embedded assets are skipped");
assert.equal(malformedAssets.warnings.length, 3, "each skipped embedded asset is warned about");

// --- App wiring ------------------------------------------------------------
assert.match(appSource, /createProjectDocument/, "App builds the project envelope");
assert.match(appSource, /readProjectDocument/, "App parses project files");
assert.match(appSource, /pickProjectFileForSave/, "Save uses the FS Access picker");
assert.match(appSource, /downloadProjectFallback/, "non-FS-Access browsers get a download fallback");
assert.match(appSource, /storeProjectHandle/, "the last handle is remembered for auto-restore");
assert.match(appSource, /queryHandlePermission/, "auto-restore only with a granted handle");
assert.match(appSource, /referencedAssetIds/, "export finds the complete referenced asset closure");
assert.match(appSource, /getAsset/, "export reads referenced asset records from IndexedDB");
assert.match(appSource, /putAsset/, "open restores embedded asset records to IndexedDB");
assert.match(appSource, /projectDirty/, "unsaved changes surface as a dirty marker");
assert.ok(PROJECT_EXTENSION.length > 1, "project files carry an extension");

console.log("embedded asset round-trip and compatibility checks PASS");
console.log("all project file checks PASS");
