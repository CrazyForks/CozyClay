// Scene commands: the scene pill's and the Hierarchy scene menu's own
// handlers. When the open scene moves, the action answers once React has
// rendered the new room, so the next command reads that scene's state.
import { studioActionDeclaration } from "../studio-actions.js";
import { fail } from "./shared.js";

export const declarations = Object.freeze(["scene.create", "scene.duplicate", "scene.rename", "scene.delete", "scene.switch"].map(studioActionDeclaration));

export function register(registry, ports) {
	const sceneOf = sceneId => ports.state().scenes.find(scene => scene.id === sceneId) ?? fail("STALE_TARGET", `Scene ${sceneId} is not in this project.`);
	const sceneName = scene => `${scene.name} (${scene.id})`;
	const sceneAction = (id, available, run) => registry.register({ ...studioActionDeclaration(id), available,
		run: async args => {
			const before = ports.state(), describe = run(args, before), after = ports.state();
			const moved = after.activeSceneId !== before.activeSceneId, opened = after.scenes.find(scene => scene.id === after.activeSceneId);
			const affectedIds = [...new Set([
				...after.scenes.filter(scene => !before.scenes.some(row => row.id === scene.id && row.name === scene.name)).map(scene => scene.id),
				...before.scenes.filter(scene => !after.scenes.some(row => row.id === scene.id)).map(scene => scene.id),
				...(moved ? [after.activeSceneId] : []),
			])];
			if (moved) await ports.afterRender();
			return { affectedIds, summary: describe(after, opened, moved) };
		} });
	const manyScenes = state => state.scenes.length > 1;
	sceneAction("scene.create", () => true, () => {
		ports.addSceneDocument();
		return (after, opened) => `Created and opened scene ${sceneName(opened)}.`;
	});
	sceneAction("scene.duplicate", () => true, ({ sceneId }) => {
		const source = sceneOf(sceneId);
		ports.duplicateSceneDocument(sceneId);
		return (after, opened) => `Duplicated ${sceneName(source)} as ${sceneName(opened)} and opened the copy.`;
	});
	sceneAction("scene.rename", () => true, ({ sceneId, name }) => {
		const source = sceneOf(sceneId);
		ports.renameSceneDocument(sceneId, name);
		return after => {
			const renamed = after.scenes.find(scene => scene.id === sceneId);
			return renamed.name === source.name ? `${sceneName(source)} already has that name; nothing changed.` : `Renamed scene ${sceneId} from ${source.name} to ${renamed.name}.`;
		};
	});
	sceneAction("scene.delete", state => manyScenes(state) || "The project's last scene cannot be deleted.", ({ sceneId }) => {
		const source = sceneOf(sceneId);
		ports.deleteSceneDocument(sceneId);
		return (after, opened, moved) => `Deleted scene ${sceneName(source)}${moved ? `; opened ${sceneName(opened)}` : ""}.`;
	});
	sceneAction("scene.switch", state => manyScenes(state) || "This project has one scene; add one with scene.create.", ({ sceneId }, before) => {
		const target = sceneOf(sceneId);
		if (sceneId === before.activeSceneId) return () => `${sceneName(target)} is already open; nothing changed.`;
		ports.switchSceneDocument(sceneId);
		return () => `Opened scene ${sceneName(target)}.`;
	});
}
