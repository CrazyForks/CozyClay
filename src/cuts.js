// Pure shot-segment model. No three.js, no React.
// A cut is a splice in film: each strip owns its camera keys, and the splice
// itself never invents an in-between frame.

import { cameraMoveAt } from "./camera-move.js";
import { cloneCameraBlock, createCameraBlock } from "./camera-block.js";

let nextShotId = 1;

function id() {
	return `shot-${Date.now().toString(36)}-${nextShotId++}`;
}

function frameNumber(value, fallback = 0) {
	return Number.isFinite(value) ? Math.round(value) : fallback;
}

function cloneFraming(framing) {
	if (!framing) return framing;
	return { ...framing, pos: framing.pos ? { ...framing.pos } : framing.pos };
}

function uniqueKeys(keys, min = -Infinity, max = Infinity) {
	const byFrame = new Map();
	for (const key of Array.isArray(keys) ? keys : []) {
		if (!key || !Number.isFinite(key.frame) || !key.framing) continue;
		const frame = Math.max(min, Math.min(max, Math.round(key.frame)));
		byFrame.set(frame, { frame, framing: cloneFraming(key.framing) });
	}
	return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

export function createShot(name = "Shot", startFrame = 0, cameraKeys = [], camera = null) {
	return {
		id: id(),
		name: typeof name === "string" && name.trim() ? name.trim() : "Shot",
		startFrame: Math.max(0, frameNumber(startFrame)),
		cameraKeys: uniqueKeys(cameraKeys),
		camera: createCameraBlock(camera),
	};
}

export function initialShots(frameCount, legacyCameraKeys = []) {
	const count = Math.max(1, frameNumber(frameCount, 1));
	const shot = createShot("Shot 1", 0, uniqueKeys(legacyCameraKeys, 0, count - 1));
	return [shot];
}

export function shotIndexAtFrame(shots, frame) {
	if (!Array.isArray(shots) || !shots.length) return -1;
	const target = Math.max(0, frameNumber(frame));
	let low = 0;
	let high = shots.length - 1;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		if (shots[middle].startFrame <= target) low = middle + 1;
		else high = middle - 1;
	}
	return Math.max(0, high);
}

export function shotAtFrame(shots, frame) {
	const index = shotIndexAtFrame(shots, frame);
	return index < 0 ? null : shots[index];
}

export function cutAtFrame(shots, frame, currentFraming) {
	if (!Array.isArray(shots) || !shots.length || !currentFraming) return shots;
	const cutFrame = frameNumber(frame);
	if (cutFrame <= 0 || shots.some((shot) => shot.startFrame === cutFrame)) return shots;
	const index = shotIndexAtFrame(shots, cutFrame);
	if (index < 0) return shots;

	const source = shots[index];
	const upstream = {
		...source,
		cameraKeys: source.cameraKeys.filter((key) => key.frame < cutFrame),
		camera: cloneCameraBlock(source.camera),
	};
	const downstreamKeys = source.cameraKeys.filter((key) => key.frame >= cutFrame);
	// The captured framing wins when the old strip already had a key here.
	const downstream = createShot(`Shot ${shots.length + 1}`, cutFrame, [
		...downstreamKeys,
		{ frame: cutFrame, framing: currentFraming },
	], source.camera);
	return [...shots.slice(0, index), upstream, downstream, ...shots.slice(index + 1)];
}

function clampShotKeys(shot, start, end) {
	return { ...shot, startFrame: start, cameraKeys: uniqueKeys(shot.cameraKeys, start, end) };
}

/**
 * Move the boundary that begins shots[index]. Each side keeps at least one
 * frame. Keys pushed over an edge are clamped onto that edge; if several land
 * together, the later key wins, matching normal re-key behaviour.
 */
export function moveBoundary(shots, index, newStartFrame, frameCount) {
	if (!Array.isArray(shots) || index <= 0 || index >= shots.length) return shots;
	const count = Math.max(shots.length, frameNumber(frameCount, shots.at(-1).startFrame + 1));
	const min = shots[index - 1].startFrame + 1;
	const max = (shots[index + 1]?.startFrame ?? count) - 1;
	const boundary = Math.max(min, Math.min(max, frameNumber(newStartFrame, shots[index].startFrame)));
	if (boundary === shots[index].startFrame) return shots;
	const next = shots.slice();
	next[index - 1] = clampShotKeys(shots[index - 1], shots[index - 1].startFrame, boundary - 1);
	next[index] = clampShotKeys(shots[index], boundary, (shots[index + 1]?.startFrame ?? count) - 1);
	return next;
}

export function removeShot(shots, index) {
	if (!Array.isArray(shots) || shots.length <= 1 || index < 0 || index >= shots.length) return shots;
	if (index === 0) {
		return [{ ...shots[1], startFrame: 0 }, ...shots.slice(2)];
	}
	return [...shots.slice(0, index), ...shots.slice(index + 1)];
}

export function renameShot(shots, index, name) {
	if (!Array.isArray(shots) || index < 0 || index >= shots.length || typeof name !== "string" || !name.trim()) return shots;
	return shots.map((shot, shotIndex) => (shotIndex === index ? { ...shot, name: name.trim() } : shot));
}

/**
 * Move a whole strip to another slot while preserving every strip's duration.
 * Camera keys travel with their strip by the same frame delta, like lifting a
 * physical clip from the edit bench and dropping it between two neighbours.
 */
export function reorderShot(shots, fromIndex, toIndex, frameCount) {
	if (!Array.isArray(shots) || fromIndex < 0 || fromIndex >= shots.length || toIndex < 0 || toIndex >= shots.length || fromIndex === toIndex) return shots;
	const count = Math.max(shots.length, frameNumber(frameCount, shots.at(-1).startFrame + 1));
	const durations = new Map(shots.map((shot, index) => [shot.id, (shots[index + 1]?.startFrame ?? count) - shot.startFrame]));
	const reordered = shots.slice();
	const [moved] = reordered.splice(fromIndex, 1);
	reordered.splice(toIndex, 0, moved);
	let startFrame = 0;
	return reordered.map((shot) => {
		const duration = Math.max(1, durations.get(shot.id) ?? 1);
		const delta = startFrame - shot.startFrame;
		const shifted = {
			...shot,
			startFrame,
			cameraKeys: uniqueKeys(shot.cameraKeys.map((key) => ({ ...key, frame: key.frame + delta })), startFrame, startFrame + duration - 1),
		};
		startFrame += duration;
		return shifted;
	});
}

/**
 * Duplicate a shot inside the existing timeline: its range is divided in two,
 * and its keys are time-scaled into both halves. This keeps frameCount stable,
 * like copying a clip into the available piece of tape. A one-frame shot has
 * no room to divide and is left unchanged.
 */
export function duplicateShot(shots, index, frameCount) {
	if (!Array.isArray(shots) || index < 0 || index >= shots.length) return shots;
	const source = shots[index];
	const end = (shots[index + 1]?.startFrame ?? Math.max(1, frameNumber(frameCount))) - 1;
	const duration = end - source.startFrame + 1;
	if (duration < 2) return shots;
	const firstDuration = Math.ceil(duration / 2);
	const duplicateStart = source.startFrame + firstDuration;
	const scaleKeys = (start, length) => uniqueKeys(source.cameraKeys.map((key) => ({
		frame: start + Math.round(((key.frame - source.startFrame) / Math.max(1, duration - 1)) * Math.max(0, length - 1)),
		framing: key.framing,
	})), start, start + length - 1);
	const original = {
		...source,
		cameraKeys: scaleKeys(source.startFrame, firstDuration),
		camera: cloneCameraBlock(source.camera),
	};
	const duplicate = createShot(
		`${source.name} copy`,
		duplicateStart,
		scaleKeys(duplicateStart, duration - firstDuration),
		source.camera,
	);
	return [...shots.slice(0, index), original, duplicate, ...shots.slice(index + 1)];
}

export function cameraAtFrame(shots, anchor, frame) {
	const shot = shotAtFrame(shots, frame);
	return shot ? cameraMoveAt(shot.cameraKeys, anchor, frame) : null;
}
