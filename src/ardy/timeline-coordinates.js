/** Convert a pointer X into the frame represented by the rendered lane.
 * `laneLeft` already includes horizontal scroll through getBoundingClientRect,
 * while `displayFrameCount` carries zoom-out's expanded virtual range. */
export function frameFromClientX(clientX, laneLeft, laneWidth, displayFrameCount, frameCount) {
	const width = Math.max(1, laneWidth);
	const t = Math.max(0, Math.min(1, (clientX - laneLeft) / width));
	const displayedFrame = Math.round(t * Math.max(0, displayFrameCount - 1));
	return Math.max(0, Math.min(frameCount - 1, displayedFrame));
}

/** Convert drag delta into a raw prompt-block start frame. Geometry and frame
 * count are captured at pointer-down so extending the timeline cannot feed
 * back into the next pointermove. Scroll cancels out because this uses delta X. */
export function promptMoveStartFrame(startFrame, startClientX, clientX, laneWidth, displayFrameCount) {
	const framesPerPixel = Math.max(0, displayFrameCount - 1) / Math.max(1, laneWidth);
	return startFrame + (clientX - startClientX) * framesPerPixel;
}

/** Shot blocks meet on the exact frame used by the ruler and playhead. The
 * last block ends at the clip's last visible frame; zoom-out leaves the rest
 * of the virtual ruler empty rather than pretending the shot grew longer. */
export function shotBlockGeometry(shots, index, frameCount, displayFrameCount = frameCount) {
	const shot = shots[index];
	if (!shot || frameCount < 1 || displayFrameCount < 1) return null;
	const denominator = Math.max(1, displayFrameCount - 1);
	const startFrame = Math.max(0, Math.min(frameCount - 1, shot.startFrame));
	const endFrame = Math.max(startFrame, Math.min(frameCount - 1, shots[index + 1]?.startFrame ?? frameCount - 1));
	return { startFrame, endFrame, startPct: startFrame / denominator, endPct: endFrame / denominator };
}
