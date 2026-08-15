#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const required = [
	"public/models/cozyclay-male-neutral.fbx",
	"public/models/cozyclay-female-neutral.fbx",
	"public/models/README.md",
	"THIRD_PARTY_NOTICES.md",
	"licenses/draco-LICENSE.txt",
	"licenses/basis-universal-LICENSE.txt",
];
for (const relative of required) {
	assert.ok(existsSync(resolve(root, relative)), `missing required distribution file: ${relative}`);
}

for (const prohibited of ["public/models/x-bot-tpose.fbx", "public/models/y-bot-tpose.fbx"]) {
	assert.equal(existsSync(resolve(root, prohibited)), false, `prohibited Mixamo asset remains: ${prohibited}`);
}

const app = readFileSync(resolve(root, "src/App.jsx"), "utf8");
const worker = readFileSync(resolve(root, "public/sw.js"), "utf8");
for (const file of [app, worker]) {
	assert.doesNotMatch(file, /(?:x|y)-bot-tpose\.fbx/i);
}
assert.match(app, /cozyclay-male-neutral\.fbx/);
assert.match(app, /cozyclay-female-neutral\.fbx/);

console.log("distribution licensing guard: PASS");
