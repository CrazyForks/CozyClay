// Cast commands: a named character's root waypoints and IK key layer. They
// name their character explicitly, so they run the same way whichever
// character is active and whatever mode the editor is in.
import { STUDIO_IK_CHAIN_TRACKS, studioActionDeclaration } from "../studio-actions.js";
import { characterOf, fail, changedIds } from "./shared.js";
import { elementSetSchema, registerElementSet } from './elements.js';
import './elements/character.js';
import { createCharacterEntry } from '../scenes.js';
import { createStableItemId, updateStableItem, removeStableItem } from '../stable-items.js';
import { movePromptClipFrames } from '../ardy/prompt-clips.js';
import { STUDIO_TOOL_SCHEMAS, StudioSchemas } from '../studio-agent-protocol.js';

const id = StudioSchemas.TargetGuard.properties.targetId;
const input = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const record = { type: 'object', properties: {}, additionalProperties: true };
const mutation = (id, label, schema, exposure = 'open') => ({ id, label, description: label, kind: 'mutation', undoDomain: 'cast', input: schema, exposure });
const blocks = elementSetSchema('character').properties.set.properties.layer.properties.promptClips;
const semantic = [
	mutation('character.set', 'Set character fields', elementSetSchema('character')),
	mutation('character.add', 'Add character', input({ character: record })),
	mutation('character.remove', 'Remove character', input({ characterId: id })),
	mutation('character.update', 'Update character', input({ characterId: id, patch: record })),
	mutation('character.setPose', 'Set character pose', input({ characterId: id, pose: { oneOf: [id, record, { type: 'null' }] }, clearMotion: { type: 'boolean' } }, ['characterId', 'pose'])),
	mutation('character.setPromptBlocks', 'Set prompt blocks', input({ characterId: id, blocks })),
	mutation('characters.arrange', 'Arrange characters', STUDIO_TOOL_SCHEMAS.arrange_characters),
	mutation('cast.replace', 'Replace cast', input({ characters: { type: 'array', items: record, minItems: 1 } }), 'ui-only'),
	mutation('cast.setCustomPoses', 'Set pose library', input({ poses: { type: 'array', items: record } }), 'ui-only'),
	mutation('cast.showExtras', 'Show extra subjects', input({ show: { type: 'boolean' } }), 'ui-only'),
	mutation('cast.setLayer', 'Set character layer', input({ characterId: id, layer: record }), 'ui-only'),
	...['add', 'move', 'resize', 'change', 'remove'].map(verb => mutation(`character.${verb}PromptBlock`, `${verb} prompt block`,
		input({ characterId: id, id, frame: { type: 'number' }, edge: { type: 'string', enum: ['start', 'end'] }, text: { type: 'string', maxLength: 2000 } },
			verb === 'add' ? ['characterId', 'frame'] : verb === 'remove' ? ['characterId', 'id'] : verb === 'change' ? ['characterId', 'id', 'text'] : verb === 'resize' ? ['characterId', 'id', 'edge', 'frame'] : ['characterId', 'id', 'frame']), 'ui-only')),
];
export const declarations = Object.freeze([...semantic, ...["character.addWaypoint", "character.moveWaypoint", "character.removeWaypoint", "character.clearWaypoints", "character.setIkKey", "character.removeIkKey", "character.clearIkKeys"].map(studioActionDeclaration)]);

export function register(registry, ports) {
	const owner = () => ports.storeDomain('cast');
	const mounted = () => Boolean(ports.storeDomain?.('cast')) || 'The cast document owner is not mounted.';
	const character = characterId => owner().read().find(row => row.id === characterId) ?? fail('STALE_TARGET', `Character ${characterId} is not in this scene.`);
	const pose = value => typeof value === 'string' ? owner().poses().find(row => row.id === value) ?? fail('STALE_TARGET', `Pose ${value} is not in the library.`) : value;
	const patch = (characterId, update) => { character(characterId); owner().write(rows => rows.map(row => row.id === characterId ? { ...row, ...update } : row)); };
	function promptEdit(command, args) {
		const before = character(args.characterId), clips = before.layer.promptClips;
		let next;
		if (command === 'character.addPromptBlock') {
			const snapped = Math.max(0, Math.round(args.frame / 48) * 48);
			const blocked = clips.some(clip => snapped < clip.endFrame && snapped + 48 > clip.startFrame);
			const startFrame = blocked ? Math.max(snapped, ...clips.map(clip => clip.endFrame)) : snapped;
			next = [...clips, { id: createStableItemId('prompt-clip'), startFrame, endFrame: startFrame + 48, text: '' }];
		} else if (command === 'character.removePromptBlock') next = removeStableItem(clips, args.id, 'promptClips');
		else if (command === 'character.changePromptBlock') next = updateStableItem(clips, args.id, clip => ({ ...clip, text: args.text }), 'promptClips');
		else if (command === 'character.movePromptBlock') next = movePromptClipFrames(clips, args.id, args.frame, 48);
		else {
			next = updateStableItem(clips, args.id, clip => {
				const snapped = Math.max(0, Math.round(args.frame / 48) * 48);
				return args.edge === 'start' ? { ...clip, startFrame: Math.min(Math.max(snapped, clip.endFrame - 120), clip.endFrame - 48) }
					: { ...clip, endFrame: Math.min(Math.max(clip.startFrame + 48, snapped), clip.startFrame + 120) };
			}, 'promptClips');
			const resized = next.find(clip => clip.id === args.id);
			if (next.some(clip => clip.id !== args.id && resized.startFrame < clip.endFrame && resized.endFrame > clip.startFrame)) return;
		}
		patch(args.characterId, { layer: { ...before.layer, promptClips: next } });
		owner().extendTimeline(next.reduce((end, clip) => Math.max(end, clip.endFrame), 24));
	}
	const methods = {
		'character.add': ({ character: value }) => {
			const row = createCharacterEntry({ ...value, id: value.id ?? createStableItemId('character') }, owner().read().length);
			if (owner().read().some(entry => entry.id === row.id)) fail('INVALID_ARGUMENT', 'Character id already exists.');
			owner().write(rows => [...rows, row]);
		},
		'character.remove': ({ characterId }) => { character(characterId); if (owner().read().length <= 1) fail('INVALID_ARGUMENT', 'Cannot remove the final character.'); owner().write(rows => rows.filter(row => row.id !== characterId)); },
		'character.update': ({ characterId, patch: value }) => patch(characterId, value),
		'character.setPose': ({ characterId, pose: value, clearMotion }) => { character(characterId); owner().applyPose(characterId, pose(value), clearMotion); },
		'character.setPromptBlocks': ({ characterId, blocks }) => {
			const entry = character(characterId); patch(characterId, { layer: { ...entry.layer, promptClips: blocks } });
		},
		'cast.replace': ({ characters }) => owner().write(characters),
		'cast.setCustomPoses': ({ poses }) => owner().writeState(before => ({ ...before, customPoses: poses })),
		'cast.showExtras': ({ show }) => owner().showExtras(show),
		'cast.setLayer': ({ characterId, layer }) => patch(characterId, { layer: { ...character(characterId).layer, ...layer } }),
	};
	registerElementSet({ register(entry) {
		registry.register({ ...entry, available: mounted, run(args) {
			const expand = op => Object.hasOwn(op.set, 'pose') ? { ...op, set: { ...op.set, pose: pose(op.set.pose) } } : op;
			return entry.run(args.ops ? { ops: args.ops.map(expand) } : expand(args));
		} });
	} }, ports, semantic[0]);
	for (const declaration of semantic.slice(1)) registry.register({ ...declaration, available: mounted, run(args) {
		if (declaration.id === 'characters.arrange') { const plan = owner().arrange(args); return { affectedIds: plan.affectedIds, summary: 'Arranged characters.' }; }
		const before = owner().read();
		if (declaration.id.endsWith('PromptBlock')) promptEdit(declaration.id, args); else methods[declaration.id](args);
		const changed = changedIds(before, owner().read());
		return { affectedIds: changed.length ? changed : [args.characterId ?? ports.state().activeSceneId], summary: declaration.label };
	} });
	if (ports.storeDomain?.('cast')) registry.registerToolAlias('arrange_characters', 'characters.arrange');
	const castAction = (id, run) => registry.register({ ...studioActionDeclaration(id),
		available: state => state.characters.length > 0 || "There are no characters in this scene; add one with arrange_characters.",
		run: args => {
			const character = characterOf(ports, args.characterId);
			return { affectedIds: [character.id], summary: run(args, character.subject || character.id) };
		} });
	const pin = waypoint => `frame ${waypoint.frame} (x ${waypoint.x}, z ${waypoint.z})`;
	const warned = warnings => warnings.length ? `; warning: ${warnings[0]}` : "";
	castAction("character.addWaypoint", ({ characterId, position, frame }, name) => {
		const { waypoint, index, warnings } = ports.addCharacterWaypoint(characterId, position, frame ?? null);
		ports.setWaypointMode(true);
		return `Added ${name}'s root waypoint ${index + 1} at ${pin(waypoint)}${warned(warnings)}.`;
	});
	castAction("character.moveWaypoint", ({ characterId, frame, position }, name) => {
		const { waypoint, warnings } = ports.moveCharacterWaypoint(characterId, frame, position);
		ports.setWaypointMode(true);
		return `Moved ${name}'s root waypoint to ${pin(waypoint)}${warned(warnings)}.`;
	});
	castAction("character.removeWaypoint", ({ characterId, frame }, name) => {
		ports.removeCharacterWaypoint(characterId, frame);
		return `Removed ${name}'s root waypoint at frame ${frame}.`;
	});
	castAction("character.clearWaypoints", ({ characterId }, name) => {
		const count = ports.clearCharacterWaypoints(characterId);
		return count ? `Cleared ${name}'s root path (${count} waypoint${count === 1 ? "" : "s"}).` : `${name} has no root waypoints; nothing changed.`;
	});
	// The declared schema carries the key's shape; the per-track counts and the
	// timeline bound are checked here, before anything is recorded.
	castAction("character.setIkKey", ({ characterId, frame, tracks }, name) => {
		const { frameCount } = ports.state(), named = Object.keys(tracks);
		if (frame >= frameCount) fail("INVALID_RANGE", `Frame ${frame} is outside the timeline (0-${frameCount - 1}).`);
		if (!named.length) fail("INVALID_ARGUMENT", "Name at least one track in tracks.");
		for (const track of named) {
			const key = tracks[track], chain = STUDIO_IK_CHAIN_TRACKS.includes(track), bones = chain ? 3 : 1;
			if (!key.q && !key.p) fail("INVALID_ARGUMENT", `tracks.${track} needs q (bone rotations) or p (a local position).`);
			if (key.chainP && !chain) fail("INVALID_ARGUMENT", `tracks.${track}.chainP is for chain tracks only.`);
			for (const field of ["q", "baseQ", "chainP"]) {
				if (key[field] && key[field].length !== bones) fail("INVALID_ARGUMENT", `tracks.${track}.${field} needs ${bones} entr${bones === 1 ? "y" : "ies"}, one per bone.`);
			}
			if ([...(key.q ?? []), ...(key.baseQ ?? [])].some(q => Math.hypot(q.x, q.y, q.z, q.w) < 1e-6)) fail("INVALID_ARGUMENT", `tracks.${track} has a zero-length quaternion.`);
		}
		ports.setCharacterIkKey(characterId, frame, tracks);
		return `Keyed ${name}'s IK layer at frame ${frame}: ${named.join(", ")}.`;
	});
	castAction("character.removeIkKey", ({ characterId, frame }, name) => {
		ports.removeCharacterIkKey(characterId, frame);
		return `Deleted ${name}'s IK key at frame ${frame}.`;
	});
	castAction("character.clearIkKeys", ({ characterId }, name) => {
		const count = ports.clearCharacterIkKeys(characterId);
		return count ? `Cleared ${name}'s IK layer (${count} key${count === 1 ? "" : "s"}).` : `${name} has no IK keys; nothing changed.`;
	});
}
