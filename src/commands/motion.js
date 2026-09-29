// Motion and IK commands share one per-character authored-intent owner.
import { STUDIO_IK_CHAIN_TRACKS, studioActionDeclaration } from "../studio-actions.js";
import { fail, characterOf } from "./shared.js";
import { elementSetSchema, registerElementSet } from './elements.js';
import './elements/motion.js';
import { createMotionEdit, trimMotionEdit, splitMotionEdit, setMotionSegmentSpeed, removeMotionSegment } from '../ardy/motion-edit.js';
const id = { type: 'string', minLength: 1 }, frame = { type: 'integer', minimum: 0 };
const input = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const mutation = (id, label, properties, required) => ({ id, label, description: label, kind: 'mutation', undoDomain: 'motion', input: input(properties, required) });
const setInput = elementSetSchema('motion');
// A collection transaction has no single native character target. Normalize
// that scope explicitly so begin/update carry the same target sentinel.
for (const variant of setInput.oneOf) variant.properties.characterId = { type: 'null', default: null };
const edits = [
	{ ...mutation('motion.set', 'Set take fields', {}), input: setInput },
	mutation('motion.trim', 'Trim motion', { characterId: id, start: frame, end: frame }),
	mutation('motion.resetTrim', 'Restore full take', { characterId: id }),
	mutation('motion.cut', 'Cut motion segment', { characterId: id, frame }),
	mutation('motion.setSegmentSpeed', 'Set segment speed', { characterId: id, id, speed: { type: 'number', exclusiveMinimum: 0, maximum: 8 } }),
	mutation('motion.removeSegment', 'Remove motion segment', { characterId: id, id }),
	mutation('motion.fixCollisions', 'Fix body collisions', { characterId: id, scope: { type: 'string', enum: ['frame', 'clip'], default: 'frame' } }, ['characterId']),
];
const legacyIk = ['character.setIkKey', 'character.removeIkKey', 'character.clearIkKeys'].map(studioActionDeclaration);
const ik = legacyIk.map((entry, index) => ({ ...entry, id: ['ik.setKey', 'ik.removeKey', 'ik.clearKeys'][index] }));

const clear = { id: 'motion.clear', label: 'Clear motion', description: 'Clear the active take, its corrections and take-owned cast fields.',
	kind: 'mutation', undoDomain: 'motion', input: { type: 'object', properties: { characterId: { type: 'string' } }, required: ['characterId'], additionalProperties: false } };
export const declarations = Object.freeze([clear, ...edits, ...legacyIk, ...ik, ...["motion.generateAllBlocks", "motion.generateFromVideo"].map(studioActionDeclaration)]);

export function register(registry, ports) {
	const owner = () => ports.storeDomain('motion');
	const mounted = () => Boolean(ports.storeDomain?.('motion')) || 'The motion owner is not mounted.';
	const take = characterId => { characterOf(ports, characterId); return owner().motionFor(characterId) ?? fail('TARGET_NOT_READY', 'Load a take for this character first.'); };
	registerElementSet({ register(entry) { registry.register({ ...entry, available: mounted, run(args) {
		for (const op of args.ops ?? [args]) take(op.id);
		return entry.run(args);
	} }); } }, ports, edits[0]);
	for (const declaration of edits.slice(1)) registry.register({ ...declaration, available: mounted, run(args) {
		const { characterId } = args; characterOf(ports, characterId);
		if (declaration.id === 'motion.fixCollisions') owner().fix(characterId, args.scope);
		else {
			const current = take(characterId), full = owner().fullMotionFor(characterId);
			let segments = current.editSegments;
			if (declaration.id === 'motion.trim') {
				if (args.start > args.end || args.end >= current.frames) fail('INVALID_RANGE', 'Trim range is outside the take.');
				segments = trimMotionEdit(segments, args.start, args.end);
			} else if (declaration.id === 'motion.resetTrim') segments = createMotionEdit(full.frames);
			else if (declaration.id === 'motion.cut') segments = splitMotionEdit(segments, args.frame);
			else if (declaration.id === 'motion.setSegmentSpeed') segments = setMotionSegmentSpeed(segments, args.id, args.speed);
			else { if (segments.length <= 1) fail('INVALID_ARGUMENT', 'Use motion.clear to remove the final segment.'); segments = removeMotionSegment(segments, args.id); }
			if (segments !== current.editSegments) owner().editSegments(characterId, segments);
		}
		return { affectedIds: [characterId], summary: declaration.label };
	} });
	for (const [index, declaration] of [...legacyIk, ...ik].entries()) registry.register({ ...declaration,
		available: state => state.characters.length > 0 || 'There are no characters in this scene.', run(args) {
			const character = characterOf(ports, args.characterId), kind = index % 3;
			if (kind === 0) {
				const { frame, tracks } = args, names = Object.keys(tracks);
				if (frame >= ports.state().frameCount) fail('INVALID_RANGE', 'IK frame is outside the timeline.');
				if (!names.length) fail('INVALID_ARGUMENT', 'Name at least one track.');
				for (const track of names) {
					const key = tracks[track], chain = STUDIO_IK_CHAIN_TRACKS.includes(track), bones = chain ? 3 : 1;
					if (!key.q && !key.p) fail('INVALID_ARGUMENT', `tracks.${track} needs q or p.`);
					if (key.chainP && !chain) fail('INVALID_ARGUMENT', `tracks.${track}.chainP is for chain tracks only.`);
					for (const field of ['q', 'baseQ', 'chainP']) if (key[field] && key[field].length !== bones) fail('INVALID_ARGUMENT', `tracks.${track}.${field} needs ${bones} entries.`);
					if ([...(key.q ?? []), ...(key.baseQ ?? [])].some(q => Math.hypot(q.x, q.y, q.z, q.w) < 1e-6)) fail('INVALID_ARGUMENT', `tracks.${track} has a zero-length quaternion.`);
				}
				ports.setCharacterIkKey(args.characterId, frame, tracks);
			} else if (kind === 1) ports.removeCharacterIkKey(args.characterId, args.frame);
			else ports.clearCharacterIkKeys(args.characterId);
			return { affectedIds: [character.id], summary: declaration.label };
		} });
	registry.register({ ...clear, available: () => Boolean(ports.storeDomain?.('motion')) || typeof ports.clearMotionNative === 'function' || 'The motion owner is not mounted.',
		run({ characterId }) {
			if (ports.storeDomain?.('motion')) { characterOf(ports, characterId); owner().clear(characterId); }
			else {
				if (ports.state().activeCharacterId !== characterId) fail('TARGET_NOT_READY', 'Select this character before clearing its take.');
				ports.clearMotionNative();
			}
			return { affectedIds: [characterId], summary: 'Cleared motion.' };
		} });
	registry.register({ ...studioActionDeclaration("motion.generateAllBlocks"), target: () => ports.state().activeCharacterId,
		available: state => state.generating ? "A motion generation is already running."
			: !state.motionReady ? "The motion backend is not ready."
				: state.promptBlockCount === 0 ? "The active character has no prompt block with text; write them with patch_elements character.promptBlocks." : true,
		run: (_args, context) => {
			const { activeCharacterId, promptBlockCount } = ports.state();
			const shown = ports.runAllPromptBlocks(context) ?? [];
			if (shown?.then) return shown.then(() => ({ affectedIds: activeCharacterId ? [activeCharacterId] : [], summary: `Generated motion from ${promptBlockCount} prompt blocks.` }));
			// The generation queues synchronously or not at all; when it does not,
			// the editor's last toast names the refusal (rig not loaded, a root
			// waypoint outside the clip, an over-long block, a line-edit draft).
			if (!ports.state().generating) fail("TARGET_NOT_READY", shown.length ? `Generation not started: ${shown.at(-1)}` : "The editor did not start the generation; check the active character's rig and prompt blocks.");
			return { affectedIds: activeCharacterId ? [activeCharacterId] : [], summary: `Started generating the active character's motion from ${promptBlockCount} prompt block${promptBlockCount === 1 ? "" : "s"}.` };
		} });
	// AI-video motion: the agent panel's Generate motion (generateFalMotion
	// "act"), awaited to its clip. The Fal card shows every failure it meets, so
	// a refusal is silent in the UI and tells the model the reason in English.
	registry.register({ ...studioActionDeclaration("motion.generateFromVideo"), domain: "motion", target: () => ports.state().activeCharacterId,
		available: ({ falMotion }) => !falMotion.enabled ? "AI video motion (Fal) is not enabled for this account."
			: !["idle", "done", "error", "failed"].includes(falMotion.status) ? "An AI video motion generation is already running; wait for it to finish."
				: falMotion.dailyRemaining === 0 ? "The account's daily AI video generations are used up." : true,
		run: async ({ instruction }, context) => {
			const outcome = await ports.generateFalMotion("act", instruction, context);
			if (outcome.failed) fail("TARGET_NOT_READY", outcome.failed);
			const { job, footage, dailyRemaining } = outcome;
			if (!job.video?.url) fail("TARGET_NOT_READY", "The AI video model finished without returning a video.");
			return { affectedIds: [], output: { videoUrl: job.video.url, resolution: job.resolution ?? null, durationSeconds: job.resultDuration ?? job.duration ?? null,
				ingested: Boolean(footage), frames: footage?.frames ?? null, fps: footage?.fps ?? null, dailyRemaining },
			summary: footage
				? `The AI video (${job.resolution}, ${footage.frames} frames at ${footage.fps} fps) is ingested as Video capture footage and the timeline now spans it; its motion becomes a take once GVHMR extraction runs in the Video capture panel.`
				: `The AI video is ready at ${job.video.url}, but ingesting it as footage failed; the Video capture panel shows why.` };
		} });
}
