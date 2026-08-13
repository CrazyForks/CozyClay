/**
 * Shot-authoring persistence. Like the scene store, the version lives in the
 * key and body. Bad bytes are identified for quarantine by the caller, while
 * future bytes are left in place for the newer app that understands them.
 */

import { createShot, initialShots } from "./cuts.js";

export const SHOT_AUTHORING_VERSION = 2;
export const SHOT_AUTHORING_KEY = "cozyclay.shot-authoring.v2";
export const SHOT_AUTHORING_LEGACY_KEY = "cozyclay.shot-authoring.v1";
export const SHOT_AUTHORING_QUARANTINE_KEY = "cozyclay.shot-authoring.v2.quarantine";

/** clip length sanity bounds, frames @ 20 fps: 1 s .. 20 min */
const FRAME_COUNT_MIN = 20;
const FRAME_COUNT_MAX = 24000;
const DEFAULT_FRAME_COUNT = 120;
const RAIL_MAX_POINTS = 512;
const finite = Number.isFinite;

const FOLLOW_BOUNDS = {
	distance: [0.5, 15],
	height: [0.2, 6],
	response: [0.1, 3],
	lead: [0, 1],
	maxDollySpeed: [0.2, 8],
	pitchOffsetDeg: [-30, 30],
};
const FOLLOW_FIELD_DEFAULTS = {
	railStartMode: "head",
	maxDollySpeed: 4,
	pitchOffsetDeg: 0,
};

function validFraming(framing) {
	return (
		!!framing && typeof framing === "object" && !!framing.pos &&
		finite(framing.pos.x) && finite(framing.pos.y) && finite(framing.pos.z) &&
		finite(framing.yaw) && finite(framing.pitch) && finite(framing.fovDeg)
	);
}

function repairFrameCount(value) {
	return finite(value) ? Math.max(FRAME_COUNT_MIN, Math.min(FRAME_COUNT_MAX, Math.round(value))) : null;
}

function repairKeys(entries, minFrame, maxFrame) {
	const byFrame = new Map();
	for (const key of Array.isArray(entries) ? entries : []) {
		if (!key || !finite(key.frame) || !validFraming(key.framing)) continue;
		const frame = Math.max(minFrame, Math.min(maxFrame, Math.round(key.frame)));
		byFrame.set(frame, {
			frame,
			framing: {
				pos: { x: key.framing.pos.x, y: key.framing.pos.y, z: key.framing.pos.z },
				yaw: key.framing.yaw,
				pitch: key.framing.pitch,
				fovDeg: key.framing.fovDeg,
			},
		});
	}
	return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

function repairShots(entries, frameCount) {
	const candidates = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!entry || typeof entry !== "object" || !finite(entry.startFrame)) continue;
		const startFrame = Math.max(0, Math.min(frameCount - 1, Math.round(entry.startFrame)));
		candidates.push({ entry, startFrame });
	}
	candidates.sort((a, b) => a.startFrame - b.startFrame);
	if (!candidates.length) return initialShots(frameCount);

	// One boundary per frame. The later stored entry wins, just like re-keying.
	const byStart = new Map(candidates.map((candidate) => [candidate.startFrame, candidate.entry]));
	if (!byStart.has(0)) {
		byStart.delete(candidates[0].startFrame);
		byStart.set(0, candidates[0].entry);
	}
	const ordered = [...byStart.entries()].sort((a, b) => a[0] - b[0]);
	const seenIds = new Set();
	return ordered.map(([startFrame, entry], index) => {
		const endFrame = (ordered[index + 1]?.[0] ?? frameCount) - 1;
		const fallback = createShot(`Shot ${index + 1}`, startFrame);
		const storedId = typeof entry.id === "string" && entry.id.trim() && !seenIds.has(entry.id) ? entry.id : fallback.id;
		seenIds.add(storedId);
		return {
			id: storedId,
			name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : `Shot ${index + 1}`,
			startFrame,
			cameraKeys: repairKeys(entry.cameraKeys, startFrame, endFrame),
		};
	});
}

function repairWaypoints(entries) {
	const byFrame = new Map();
	for (const waypoint of Array.isArray(entries) ? entries : []) {
		if (!waypoint || !finite(waypoint.frame) || waypoint.frame < 0 || !finite(waypoint.x) || !finite(waypoint.z)) continue;
		const frame = Math.round(waypoint.frame);
		byFrame.set(frame, { frame, x: waypoint.x, z: waypoint.z, heading: finite(waypoint.heading) ? waypoint.heading : null });
	}
	return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

function repairFollowCam(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const followCam = {
		enabled: value.enabled === true,
		railStartMode: value.railStartMode === "nearest" ? "nearest" : FOLLOW_FIELD_DEFAULTS.railStartMode,
		maxDollySpeed: FOLLOW_FIELD_DEFAULTS.maxDollySpeed,
		pitchOffsetDeg: FOLLOW_FIELD_DEFAULTS.pitchOffsetDeg,
	};
	for (const [key, [min, max]] of Object.entries(FOLLOW_BOUNDS)) {
		if (finite(value[key])) followCam[key] = Math.max(min, Math.min(max, value[key]));
	}
	return followCam;
}

function repairRail(value) {
	if (!Array.isArray(value)) return null;
	const points = value.filter((point) => point && finite(point.x) && finite(point.z))
		.slice(0, RAIL_MAX_POINTS).map((point) => ({ x: point.x, z: point.z }));
	return points.length >= 2 ? points : null;
}

function repairShared(parsed, frameCount) {
	return {
		frameCount,
		waypoints: repairWaypoints(parsed.waypoints),
		followCam: repairFollowCam(parsed.followCam),
		cameraRail: repairRail(parsed.cameraRail),
	};
}

export function serializeShotAuthoring({ shots = [], waypoints = [], frameCount = null, followCam = null, cameraRail = null }) {
	return JSON.stringify({ version: SHOT_AUTHORING_VERSION, frameCount, shots, waypoints, followCam, cameraRail });
}

/** Tagged reader used by App so corrupt and future payloads take different paths. */
export function readShotAuthoring(raw) {
	if (raw === null || raw === undefined || raw === "") return { status: "absent", state: null };
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { status: "corrupt", state: null };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "corrupt", state: null };
	const version = parsed.version === undefined ? 1 : parsed.version;
	if (!Number.isInteger(version) || version < 1) return { status: "corrupt", state: null };
	if (version > SHOT_AUTHORING_VERSION) return { status: "future", state: null };

	const frameCount = repairFrameCount(parsed.frameCount);
	const effectiveFrameCount = frameCount ?? DEFAULT_FRAME_COUNT;
	if (version === 1) {
		const keys = repairKeys(parsed.cameraKeys, 0, effectiveFrameCount - 1);
		return {
			status: "migrated",
			state: { ...repairShared(parsed, frameCount), shots: initialShots(effectiveFrameCount, keys) },
		};
	}
	if (!Array.isArray(parsed.shots)) return { status: "corrupt", state: null };
	return {
		status: "valid",
		state: { ...repairShared(parsed, frameCount), shots: repairShots(parsed.shots, effectiveFrameCount) },
	};
}

/** Compatibility-shaped convenience for model callers and tests. */
export function loadShotAuthoring(raw) {
	return readShotAuthoring(raw).state;
}
