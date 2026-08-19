/** Move one prompt clip on the fixed prompt-block grid without changing its
 * duration. Overlaps are rejected because segment generation needs one prompt
 * per frame range; gaps remain valid and inherit the main prompt.
 *
 * Clock-agnostic: `blockFrames` is the caller's grid, and App.jsx always
 * passes ARDY_PROMPT_HORIZON_FRAMES (2 s on the 24 fps timeline clock = 48).
 * The 40 default is only the bare-call fallback and means nothing on the
 * wire — nothing here ever reaches the bridge unconverted. */
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
