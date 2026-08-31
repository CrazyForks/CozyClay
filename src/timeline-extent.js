/**
 * Return the current content-driven length of the shared production clock.
 *
 * The active character is represented by the editing-buffer motion; inactive
 * characters keep their committed sessionMotion. Prompt block endFrame values
 * are already expressed as an exclusive timeline count, matching motion.frames.
 *
 * A zero result is intentional: an empty scene keeps its existing authored
 * duration instead of collapsing the pre-generation clock to one frame.
 */
export function timelineContentExtent(
	characters = [],
	activeCharacterId = null,
	activeMotion = null,
	promptClips = [],
	extraFrames = 0,
) {
	const longestMotion = characters.reduce((max, entry) => {
		const clip = entry.id === activeCharacterId ? activeMotion : entry.sessionMotion;
		const layerPromptEnd = entry.id === activeCharacterId
			? 0
			: (entry.layer?.promptClips ?? []).reduce(
				(layerMax, clip) => Math.max(layerMax, Number.isFinite(clip?.endFrame) ? clip.endFrame : 0),
				0,
			);
		return Math.max(max, Number.isFinite(clip?.frames) ? clip.frames : 0, layerPromptEnd);
	}, 0);
	const promptEnd = promptClips.reduce(
		(max, clip) => Math.max(max, Number.isFinite(clip?.endFrame) ? clip.endFrame : 0),
		0,
	);
	const authoredExtent = Math.max(longestMotion, promptEnd);
	// Ingested footage owns the clock only before a cast take or prompt
	// schedule exists. Once a 136-frame take is installed, an older 192-frame
	// source video must not recreate the frozen tail this helper prevents.
	return authoredExtent > 0
		? authoredExtent
		: Number.isFinite(extraFrames) ? extraFrames : 0;
}
