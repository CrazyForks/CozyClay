#!/usr/bin/env node
/** #446: shipped MCP handlers -> real live socket -> App bus and owned domains.
 * React/renderer hardware use the existing domain fixture; receipts and history
 * are never mocked. Run one acceptance case with COZYCLAY_446_CASE=<name>.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { z } from "zod";
import { projectFixture } from "../test/bus/project-fixture.mjs";
import { dispatchLiveFrame } from "../src/live-control.js";
import { SCENES_VERSION } from "../src/scenes.js";
import { validateReceipt } from "../src/studio-agent-protocol.js";
import { startLiveHub } from "./live-hub.mjs";
import { createToolHandlers, liveWorkspace, setLiveHub } from "./tool-handlers.mjs";

const bounded = (promise, label) => {
	let timer;
	return Promise.race([promise, new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 15_000);
	})]).finally(() => clearTimeout(timer));
};
export async function studio() {
	const f = projectFixture();
	const hub = await startLiveHub(0);
	const wire = [], events = [];
	const sendEvent = hub.sendEvent.bind(hub);
	hub.sendEvent = (workspaceId, name, payload) => {
		if (name === "telemetry") events.push(payload);
		return sendEvent(workspaceId, name, payload);
	};
	const describe = () => {
		const live = f.actual.readStudioState();
		return structuredClone({
			sceneName: live.sceneName,
			camera: { ...live.camera.position, focalMm: live.camera.focalMm, sensorId: live.filmback.sensorId, aspectRatio: live.filmback.aspectRatio },
			characters: live.characters, objects: live.objects, stage: live.stage,
			activeCharacterId: live.activeCharacterId,
			timeline: { currentFrame: live.view.frame, frameCount: live.frameCount, fps: 24 },
			document: { version: SCENES_VERSION, activeSceneId: f.scope.activeSceneIdRef.current, scenes: f.scope.scenesRef.current },
		});
	};
	const legacy = f.objects.createLegacyObjectHandlers((args, keys) => Object.fromEntries(keys.filter(key => args[key] !== undefined).map(key => [key, args[key]])));
	const handlers = { ...f.binding.handlers, ...legacy, describe,
		set_camera: args => f.scope.shotsDomain.setLiveCamera(args),
		load_scenes: args => f.project.loadLiveScenes(args),
	};
	const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/live`);
	const welcomed = Promise.withResolvers();
	socket.on("message", async raw => {
		const frame = JSON.parse(raw);
		if (frame.type === "workspace") { welcomed.resolve(frame.handle); return; }
		if (frame.type !== "cmd") return;
		wire.push(frame);
		const response = await dispatchLiveFrame(raw.toString(), handlers);
		if (response) socket.send(JSON.stringify(response));
	});
	await bounded(once(socket, "open"), "editor socket");
	socket.send(JSON.stringify({ type: "hello", role: "editor", version: 1, workspaceId: f.host().workspaceId }));
	const handle = await bounded(welcomed.promise, "workspace hello");
	f.scope.liveWorkspaceHandleRef.current = handle;
	setLiveHub(hub);
	const tools = createToolHandlers();
	const call = async (name, args = {}) => {
		const tool = tools.find(row => row.name === name);
		assert.ok(tool, name);
		const parsed = z.object(tool.inputSchema).parse(args);
		return hub.runExclusive(name, handle, resolved => liveWorkspace.run(resolved, () => hub.observeExecution(name, resolved, () => tool.handler(parsed))));
	};
	return { f, hub, wire, events, handle, tools, describe, call,
		async close() {
			setLiveHub(null);
			const closed = bounded(Promise.all([once(socket, "close"), once(hub.editors.get(handle), "close")]), "disconnect");
			socket.close(); await closed;
			await new Promise(resolve => hub.server.close(resolve));
			f.dispose();
		},
	};
}
export function receipt(result, action) {
	let value;
	try { value = JSON.parse(result.content[0].text); }
	catch { assert.fail(`Expected a bus receipt from ${action}, received: ${result.content[0].text.slice(0, 180)}`); }
	validateReceipt(value);
	assert.equal(value.ok, true, JSON.stringify(value));
	assert.equal(result.isError, undefined, JSON.stringify(result));
	assert.equal(value.action, action);
	assert.ok(Number.isSafeInteger(value.revision.before));
	assert.ok(Number.isSafeInteger(value.revision.after));
	return value;
}
const cases = {};
cases.receipts = async () => {
	const s = await studio();
	try {
		const added = receipt(await s.call("place_object", { kind: "cube", x: 2, z: -1, name: "Crate" }), "object.add");
		const id = added.affectedIds[0];
		assert.equal(s.f.objects.read().find(row => row.id === id).name, "Crate");
		assert.equal(added.undo.entries, 1);
		receipt(await s.call("update_object", { id, x: 3, facing: 30, tilt: 10, roll: 5, scale: 2, scale_y: 3, hidden: true,
			path: { points: [{ x: 0, z: 0 }, { x: 2, z: 2 }], face_travel: false } }), "object.update");
		const updated = s.f.objects.read().find(row => row.id === id);
		assert.deepEqual([updated.x, updated.rot, updated.rotX, updated.rotZ, updated.scaleX, updated.scaleY, updated.hidden, updated.path.faceTravel], [3, 30, 10, 5, 2, 3, true, false]);
		const parent = receipt(await s.call("place_object", { kind: "chair" }), "object.add").affectedIds[0];
		receipt(await s.call("group_objects", { parent, children: [id] }), "object.group");
		assert.equal(s.f.objects.read().find(row => row.id === id).parent, parent);
		receipt(await s.call("group_objects", { parent: null, children: [id] }), "object.ungroup");
		assert.equal(s.f.objects.read().find(row => row.id === id).parent, null);
		receipt(await s.call("remove_object", { id }), "object.remove");
		assert.equal(s.f.objects.read().some(row => row.id === id), false);
		const imported = receipt(await s.call("import_mesh", { path: fileURLToPath(new URL("../test/fixtures/unit-cube.glb", import.meta.url)), x: 2, height: 0.8, clay: true }), "asset.import");
		assert.ok(s.f.objects.read().some(row => row.id === imported.output.objectId));
		assert.equal(imported.undo.entries, 1);
		const camera = receipt(await s.call("set_camera", { x: 3, y: 2, z: 6, focal_mm: 50, look_at_x: 0, look_at_y: 1.3, look_at_z: 0 }), "shot.frame");
		assert.equal(camera.undo.entries, 1);
		assert.deepEqual(s.f.binding.context().camera.position, { x: 3, y: 2, z: 6 });
		const before = s.f.binding.context().camera;
		receipt(await s.call("set_camera", { x: 4 }), "shot.frame");
		const after = s.f.binding.context().camera;
		for (const axis of ["x", "y", "z"]) assert.ok(Math.abs((after.lookAt[axis] - after.position[axis]) - (before.lookAt[axis] - before.position[axis])) < 1e-10);
		for (const view of ["front", "front three-quarter", "profile", "rear three-quarter", "back"]) {
			receipt(await s.call("frame_shot", { size: "medium shot", view }), "shot.frame");
			assert.deepEqual(s.f.binding.context().camera.lookAt, { x: 0, y: 1.3, z: 0 });
		}
		const oldScene = s.f.scope.scenesRef.current[0].name;
		const created = await s.call("add_scene", { name: "New room" });
		receipt(created, "scene.create");
		assert.equal(s.f.scope.scenesRef.current.find(row => row.id === s.f.scope.activeSceneIdRef.current).name, "New room");
		receipt(await s.call("switch_scene", { name: oldScene }), "scene.switch");
		assert.equal(s.f.scope.activeSceneIdRef.current, "scene");
		assert.ok(s.wire.some(frame => frame.name === "run_action"));
		assert.ok(s.wire.every(frame => ["inspect_studio", "run_action", "describe"].includes(frame.name)), "migrated aliases must not send legacy mutator frames");
	} finally { await s.close(); }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const selected = process.env.COZYCLAY_446_CASE;
	if (selected) assert.ok(cases[selected], `Unknown case ${selected}`);
	for (const [name, run] of Object.entries(cases)) if (!selected || selected === name) {
		await run(); console.log(`PASS #446 ${name}`);
	}
}
