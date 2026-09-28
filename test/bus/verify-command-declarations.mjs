// #437 acceptance 2: every command module's declarations load in plain Node
// (no React, renderer or browser globals) and are data only. Together the
// modules declare each Studio action exactly once.
import assert from 'node:assert/strict';
import { STUDIO_ACTIONS, STUDIO_ACTION_IDS } from '../../src/studio-actions.js';
import { declarations as shot } from '../../src/commands/shot.js';
import { declarations as cast } from '../../src/commands/cast.js';
import { declarations as motion } from '../../src/commands/motion.js';
import { declarations as objects } from '../../src/commands/objects.js';
import { declarations as view } from '../../src/commands/view.js';
import { declarations as scene } from '../../src/commands/scene.js';
import { declarations as project } from '../../src/commands/project.js';
import { declarations as exporting } from '../../src/commands/export.js';
import { declarations as ai } from '../../src/commands/ai.js';

assert.deepEqual(shot.map(entry => entry.id), [
 'shot.create', 'shot.split', 'shot.duplicate', 'shot.remove', 'shot.setRange', 'shot.setCameraRail', 'shot.clearCameraRail', 'shot.reorder',
], 'shot.js declares the 8 shot actions');

const modules = { shot, cast, motion, objects, view, scene, project, export: exporting, ai };
const all = Object.values(modules).flat();
for (const [name, list] of Object.entries(modules)) {
 assert.ok(Array.isArray(list) && list.length > 0, `${name}.js declares its actions`);
 // Data only: a structured JSON round trip keeps every field.
 assert.deepEqual(JSON.parse(JSON.stringify(list)), list, `${name}.js declarations are plain data`);
 for (const entry of list) assert.deepEqual(entry, STUDIO_ACTIONS.find(action => action.id === entry.id), `${entry.id} is the shared declaration`);
}
assert.equal(new Set(all.map(entry => entry.id)).size, all.length, 'no action is declared twice');
assert.deepEqual(all.map(entry => entry.id).sort(), [...STUDIO_ACTION_IDS].sort(), 'the modules declare every Studio action');
console.log(`PASS #437 acceptance 2: ${all.length} actions declared across ${Object.keys(modules).length} command modules, 8 in shot.js`);
