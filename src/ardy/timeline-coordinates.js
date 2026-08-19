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

/** Half a second at 24 fps: a shorter take is a pose, not a motion. */
export const TRIM_MIN_FRAMES = 12;

/** Clamp one trim-handle drag of the loaded take into a legal in/out range.
 * `preview` is the range the gesture currently shows, `frame` the frame under
 * the pointer and `max` the take's last displayed frame. The opposite edge
 * never moves, and the remaining take never drops below `minFrames`. */
export function motionTrimRange(edge, frame, preview, max, minFrames = TRIM_MIN_FRAMES) {
	return edge === "start"
		? { ...preview, start: Math.max(0, Math.min(frame, preview.end - minFrames)) }
		: { ...preview, end: Math.min(max, Math.max(frame, preview.start + minFrames)) };
}

/** Optional Shot blocks use their own explicit inclusive range. Gaps remain
 * visible free-camera time instead of being inferred from the next card. */
export function shotBlockGeometry(shots, index, frameCount, displayFrameCount = frameCount) {
	const shot = shots[index];
	if (!shot || frameCount < 1 || displayFrameCount < 1) return null;
	const denominator = Math.max(1, displayFrameCount - 1);
	const startFrame = Math.max(0, Math.min(frameCount - 1, shot.startFrame));
	const endFrame = Math.max(startFrame, Math.min(frameCount - 1, shot.endFrame ?? startFrame));
	return { startFrame, endFrame, startPct: startFrame / denominator, endPct: endFrame / denominator };
}
