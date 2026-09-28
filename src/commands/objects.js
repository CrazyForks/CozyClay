// Scene object commands: attachment, duplication and asset import.
import { studioActionDeclaration } from "../studio-actions.js";
import { changedIds, characterOf, fail } from "./shared.js";

export const declarations = Object.freeze(["object.attach", "object.detach", "object.duplicate", "asset.import"].map(studioActionDeclaration));

export function register(registry, ports) {
	const objectOf = objectId => ports.state().objects.find(object => object.id === objectId)
		?? fail("STALE_TARGET", `Object ${objectId} is not in this scene.`);
	registry.register({ ...studioActionDeclaration("object.attach"),
		available: state => state.objects.length === 0 ? "There are no scene objects to attach."
			: state.characters.length === 0 ? "There are no characters to attach an object to." : true,
		run: ({ objectId, characterId, bone }) => {
			const object = objectOf(objectId), character = characterOf(ports, characterId), before = ports.state().objects;
			ports.attachSceneObject(objectId, { characterId, bone: bone ?? null });
			const frameName = `${character.subject || character.id}'s ${bone ?? "root"}`;
			return { affectedIds: [objectId], summary: ports.state().objects === before
				? `${object.name || objectId} already rides ${frameName}; nothing changed.`
				: `Attached ${object.name || objectId} to ${frameName}, keeping its place on screen.` };
		} });
	registry.register({ ...studioActionDeclaration("object.detach"),
		available: state => state.objects.some(object => object.attach || object.parent) || "No scene object is attached to a character or grouped.",
		run: ({ objectId }) => {
			const object = objectOf(objectId);
			if (!object.attach && !object.parent) fail("TARGET_NOT_READY", `${object.name || objectId} is not attached to a character or in a group.`);
			ports.attachSceneObject(objectId, null);
			return { affectedIds: [objectId], summary: `Put ${object.name || objectId} back in the world where it is now.` };
		} });
	registry.register({ ...studioActionDeclaration("object.duplicate"),
		available: state => state.objects.length > 0 || "There are no scene objects to duplicate.",
		run: ({ objectId }) => {
			const state = ports.state(), id = objectId ?? state.selectedObjectId;
			if (!id) fail("TARGET_NOT_READY", "Name objectId or select an object first.");
			const source = state.objects.find(object => object.id === id) ?? fail("STALE_TARGET", `Object ${id} is not in this scene.`);
			ports.duplicateSelectedSceneObject(id);
			const after = ports.state().objects, affectedIds = changedIds(state.objects, after);
			const copy = after.find(object => affectedIds.includes(object.id));
			return { affectedIds, summary: copy ? `Duplicated ${source.name || source.id} as ${copy.name || copy.id}.` : "Duplicate object: nothing changed." };
		} });
	// The live import_asset path (validate, store the bytes, ONE atomic store
	// entry), fed a data URL; an http(s) source is fetched into one first.
	registry.register({ ...studioActionDeclaration("asset.import"), available: () => true,
		run: async ({ source, name, placeAs }, context) => {
			let dataUrl = source;
			if (!source.startsWith("data:")) {
				try { dataUrl = await ports.fetchImportSource(source); }
				catch (error) { fail("TARGET_NOT_READY", `Could not fetch the source (${error?.message || error}); its server must allow cross-origin reads.`); }
			}
			let imported;
			try { imported = await ports.importAsset({ name, placeAs, dataUrl }, context); }
			catch (error) { fail("INVALID_ARGUMENT", `Not imported: ${error?.message || error}`); }
			return { affectedIds: [imported.objectId], summary: `Imported ${name} as a ${placeAs} (object ${imported.objectId}, asset ${imported.assetId}).` };
		} });
}
