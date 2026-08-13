// Pure optional Shot-overlay model. Shots are camera ownership cards placed
// on a timeline: gaps are valid free-camera time, overlaps are rejected.

import { cameraMoveAt } from "./camera-move.js";
import { cloneCameraBlock, createCameraBlock } from "./camera-block.js";

export const DEFAULT_SHOT_FRAMES = 40;

let nextShotId = 1;
const id = () => `shot-${Date.now().toString(36)}-${nextShotId++}`;
const frameNumber = (value, fallback = 0) => Number.isFinite(value) ? Math.round(value) : fallback;

function cloneFraming(framing) {
	return framing ? { ...framing, pos: framing.pos ? { ...framing.pos } : framing.pos } : framing;
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

export function createShot(name = "Shot", startFrame = 0, endFrame = startFrame + DEFAULT_SHOT_FRAMES - 1, cameraKeys = [], camera = null) {
	const start = Math.max(0, frameNumber(startFrame));
	const end = Math.max(start, frameNumber(endFrame, start));
	return {
		id: id(),
		name: typeof name === "string" && name.trim() ? name.trim() : "Shot",
		startFrame: start,
		endFrame: end,
		cameraKeys: uniqueKeys(cameraKeys, start, end),
		camera: createCameraBlock(camera),
	};
}

/** New documents begin without an implicit camera owner. */
export function initialShots() {
	return [];
}

export function shotIndexAtFrame(shots, frame) {
	if (!Array.isArray(shots) || !shots.length) return -1;
	const target = Math.max(0, frameNumber(frame));
	let low = 0;
	let high = shots.length - 1;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const shot = shots[middle];
		if (target < shot.startFrame) high = middle - 1;
		else if (target > shot.endFrame) low = middle + 1;
		else return middle;
	}
	return -1;
}

export function shotAtFrame(shots, frame) {
	const index = shotIndexAtFrame(shots, frame);
	return index < 0 ? null : shots[index];
}

function overlaps(shots, startFrame, endFrame, ignoredIndex = -1) {
	return shots.some((shot, index) => index !== ignoredIndex && startFrame <= shot.endFrame && endFrame >= shot.startFrame);
}

/** Split only the Shot that actually covers the cut frame. Gap frames remain gaps. */
export function cutAtFrame(shots, frame, currentFraming) {
	if (!Array.isArray(shots) || !currentFraming) return shots;
	const cutFrame = frameNumber(frame);
	const index = shotIndexAtFrame(shots, cutFrame);
	if (index < 0) return shots;
	const source = shots[index];
	if (cutFrame <= source.startFrame || cutFrame > source.endFrame) return shots;
	const upstream = {
		...source,
		endFrame: cutFrame - 1,
		cameraKeys: uniqueKeys(source.cameraKeys, source.startFrame, cutFrame - 1),
		camera: cloneCameraBlock(source.camera),
	};
	const downstream = createShot(`Shot ${shots.length + 1}`, cutFrame, source.endFrame, [
		...source.cameraKeys.filter((key) => key.frame >= cutFrame),
		{ frame: cutFrame, framing: currentFraming },
	], source.camera);
	return [...shots.slice(0, index), upstream, downstream, ...shots.slice(index + 1)];
}

/** Add a 2-second Shot in a gap; an occupied playhead splits its Shot. */
export function addShotAtFrame(shots, frame, frameCount, currentFraming, duration = DEFAULT_SHOT_FRAMES) {
	const list = Array.isArray(shots) ? shots : [];
	const count = Math.max(1, frameNumber(frameCount, 1));
	const target = Math.max(0, Math.min(count - 1, frameNumber(frame)));
	const inside = shotIndexAtFrame(list, target);
	if (inside >= 0) {
		const source = list[inside];
		const cutFrame = target > source.startFrame ? target : source.startFrame + Math.floor((source.endFrame - source.startFrame + 1) / 2);
		return cutFrame > source.startFrame && cutFrame <= source.endFrame ? cutAtFrame(list, cutFrame, currentFraming) : list;
	}
	const nextStart = list.find((shot) => shot.startFrame > target)?.startFrame ?? count;
	const endFrame = Math.min(count - 1, nextStart - 1, target + Math.max(1, frameNumber(duration, DEFAULT_SHOT_FRAMES)) - 1);
	if (endFrame < target || overlaps(list, target, endFrame)) return list;
	const keys = currentFraming ? [{ frame: target, framing: currentFraming }] : [];
	return [...list, createShot(`Shot ${list.length + 1}`, target, endFrame, keys)].sort((a, b) => a.startFrame - b.startFrame);
}

export function resizeShot(shots, index, edge, rawFrame, frameCount) {
	if (!Array.isArray(shots) || index < 0 || index >= shots.length || (edge !== "start" && edge !== "end")) return shots;
	const count = Math.max(1, frameNumber(frameCount, 1));
	const shot = shots[index];
	const frame = Math.max(0, Math.min(count - 1, frameNumber(rawFrame, edge === "start" ? shot.startFrame : shot.endFrame)));
	const startFrame = edge === "start" ? Math.min(frame, shot.endFrame) : shot.startFrame;
	const endFrame = edge === "end" ? Math.max(frame, shot.startFrame) : shot.endFrame;
	if ((startFrame === shot.startFrame && endFrame === shot.endFrame) || overlaps(shots, startFrame, endFrame, index)) return shots;
	const next = shots.slice();
	next[index] = { ...shot, startFrame, endFrame, cameraKeys: uniqueKeys(shot.cameraKeys, startFrame, endFrame) };
	return next.sort((a, b) => a.startFrame - b.startFrame);
}

/** Compatibility name for callers that move the left edge. */
export function moveBoundary(shots, index, newStartFrame, frameCount) {
	return resizeShot(shots, index, "start", newStartFrame, frameCount);
}

export function removeShot(shots, index) {
	if (!Array.isArray(shots) || index < 0 || index >= shots.length) return shots;
	return shots.filter((_, shotIndex) => shotIndex !== index);
}

export function renameShot(shots, index, name) {
	if (!Array.isArray(shots) || index < 0 || index >= shots.length || typeof name !== "string" || !name.trim()) return shots;
	return shots.map((shot, shotIndex) => shotIndex === index ? { ...shot, name: name.trim() } : shot);
}

/** Move a card in absolute time. Duration and local camera instruction travel together. */
export function reorderShot(shots, fromIndex, rawStartFrame, frameCount) {
	if (!Array.isArray(shots) || fromIndex < 0 || fromIndex >= shots.length) return shots;
	const shot = shots[fromIndex];
	const count = Math.max(1, frameNumber(frameCount, 1));
	const duration = shot.endFrame - shot.startFrame + 1;
	const startFrame = Math.max(0, Math.min(count - duration, frameNumber(rawStartFrame, shot.startFrame)));
	const endFrame = startFrame + duration - 1;
	if (startFrame === shot.startFrame || overlaps(shots, startFrame, endFrame, fromIndex)) return shots;
	const delta = startFrame - shot.startFrame;
	const moved = {
		...shot,
		startFrame,
		endFrame,
		cameraKeys: uniqueKeys(shot.cameraKeys.map((key) => ({ ...key, frame: key.frame + delta })), startFrame, endFrame),
	};
	return shots.map((entry, index) => index === fromIndex ? moved : entry).sort((a, b) => a.startFrame - b.startFrame);
}

function freeStart(shots, duration, frameCount, preferred) {
	const candidates = [preferred, 0, ...shots.map((shot) => shot.endFrame + 1)];
	return candidates.find((start) => start >= 0 && start + duration <= frameCount && !overlaps(shots, start, start + duration - 1));
}

export function duplicateShot(shots, index, frameCount) {
	if (!Array.isArray(shots) || index < 0 || index >= shots.length) return shots;
	const source = shots[index];
	const duration = source.endFrame - source.startFrame + 1;
	const startFrame = freeStart(shots, duration, Math.max(1, frameNumber(frameCount, 1)), source.endFrame + 1);
	if (startFrame === undefined) return shots;
	const delta = startFrame - source.startFrame;
	const duplicate = createShot(`${source.name} copy`, startFrame, startFrame + duration - 1,
		source.cameraKeys.map((key) => ({ ...key, frame: key.frame + delta })), source.camera);
	return [...shots, duplicate].sort((a, b) => a.startFrame - b.startFrame);
}

/** Gaps deliberately return null; the caller interprets null as free camera. */
export function cameraAtFrame(shots, anchor, frame) {
	const shot = shotAtFrame(shots, frame);
	return shot ? cameraMoveAt(shot.cameraKeys, anchor, frame) : null;
}
