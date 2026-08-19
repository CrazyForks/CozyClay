// Project file envelope: create/parse round-trip, validation, and the
// boundaries that keep a project file from clobbering the session.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createProjectDocument, readProjectDocument, PROJECT_VERSION, PROJECT_EXTENSION } from "../src/project.js";
import { createSceneDocument, createSceneStage, SCENES_VERSION } from "../src/scenes.js";

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

// --- App wiring ------------------------------------------------------------
assert.match(appSource, /createProjectDocument/, "App builds the project envelope");
assert.match(appSource, /readProjectDocument/, "App parses project files");
assert.match(appSource, /pickProjectFileForSave/, "Save uses the FS Access picker");
assert.match(appSource, /downloadProjectFallback/, "non-FS-Access browsers get a download fallback");
assert.match(appSource, /storeProjectHandle/, "the last handle is remembered for auto-restore");
assert.match(appSource, /queryHandlePermission/, "auto-restore only with a granted handle");
assert.match(appSource, /projectDirty/, "unsaved changes surface as a dirty marker");
assert.ok(PROJECT_EXTENSION.length > 1, "project files carry an extension");

console.log("all project file checks PASS");
