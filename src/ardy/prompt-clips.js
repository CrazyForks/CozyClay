/** Move one prompt clip on the fixed ARDY block grid without changing its
 * duration. Overlaps are rejected because segment generation needs one prompt
 * per frame range; gaps remain valid and inherit the main prompt. */
export function movePromptClipFrames(clips, id, rawStartFrame, blockFrames = 40) {
	const target = clips.find((clip) => clip.id === id);
	if (!target) return clips;
	const duration = target.endFrame - target.startFrame;
	const startFrame = Math.max(0, Math.round(rawStartFrame / blockFrames) * blockFrames);
	const endFrame = startFrame + duration;
	if (startFrame === target.startFrame) return clips;
	const overlaps = clips.some((clip) =>
		clip.id !== id && startFrame < clip.endFrame && endFrame > clip.startFrame
	);
	if (overlaps) return clips;
	return clips.map((clip) => clip.id === id ? { ...clip, startFrame, endFrame } : clip);
}
