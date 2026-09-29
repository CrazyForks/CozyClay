// Motion commands: generating the active character's take.
import { studioActionDeclaration } from "../studio-actions.js";
import { fail } from "./shared.js";

const clear = { id: 'motion.clear', label: 'Clear motion', description: 'Clear the active take, its corrections and take-owned cast fields.',
	kind: 'mutation', undoDomain: 'motion', input: { type: 'object', properties: { characterId: { type: 'string' } }, required: ['characterId'], additionalProperties: false } };
export const declarations = Object.freeze([clear, ...["motion.generateAllBlocks", "motion.generateFromVideo"].map(studioActionDeclaration)]);

export function register(registry, ports) {
	registry.register({ ...clear, available: () => typeof ports.clearMotionNative === 'function' || 'The motion owner is not mounted.',
		run({ characterId }) {
			if (ports.state().activeCharacterId !== characterId) fail('TARGET_NOT_READY', 'Select this character before clearing its take.');
			ports.clearMotionNative();
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
