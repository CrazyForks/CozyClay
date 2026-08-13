/**
 * Shot-authoring persistence. Like the scene store, the version lives in the
 * key and body. Bad bytes are identified for quarantine by the caller, while
 * future bytes are left in place for the newer app that understands them.
 */

import { createShot, initialShots } from "./cuts.js";

export const SHOT_AUTHORING_VERSION = 3;
export const SHOT_AUTHORING_KEY = "cozyclay.shot-authoring.v3";
// The single-key alias points at the newest legacy body for older callers.
// New readers should walk the list so a user can still arrive directly from v1.
export const SHOT_AUTHORING_LEGACY_KEY = "cozyclay.shot-authoring.v2";
export const SHOT_AUTHORING_LEGACY_KEYS = Object.freeze([
	SHOT_AUTHORING_LEGACY_KEY,
	"cozyclay.shot-authoring.v1",
]);
export const SHOT_AUTHORING_QUARANTINE_KEY = "cozyclay.shot-authoring.v3.quarantine";

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
const FOLLOW_DEFAULTS = {
	distance: 3,
	height: 1.6,
	response: 0.7,
	lead: 0.25,
	railStartMode: "head",
	maxDollySpeed: 4,
	pitchOffsetDeg: 0,
};
const CAMERA_MODES = new Set(["keys", "follow", "rail"]);

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

function repairShots(entries, frameCount, inheritedCamera = null) {
	const candidates = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!entry || typeof entry !== "object" || !finite(entry.startFrame)) continue;
		const startFrame = Math.max(0, Math.min(frameCount - 1, Math.round(entry.startFrame)));
		candidates.push({ entry, startFrame });
	}
	candidates.sort((a, b) => a.startFrame - b.startFrame);
	if (!candidates.length) {
		return initialShots(frameCount).map((shot) => ({ ...shot, camera: repairCamera(inheritedCamera) }));
	}

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
			camera: repairCamera(inheritedCamera ?? entry.camera),
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
	const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
	const followCam = { ...FOLLOW_DEFAULTS };
	followCam.railStartMode = source.railStartMode === "nearest" ? "nearest" : FOLLOW_DEFAULTS.railStartMode;
	for (const [key, [min, max]] of Object.entries(FOLLOW_BOUNDS)) {
		if (finite(source[key])) followCam[key] = Math.max(min, Math.min(max, source[key]));
	}
	return followCam;
}

function repairRail(value) {
	if (!Array.isArray(value)) return null;
	const points = value.filter((point) => point && finite(point.x) && finite(point.z))
		.slice(0, RAIL_MAX_POINTS).map((point) => ({ x: point.x, z: point.z }));
	return points.length >= 2 ? points : null;
}

function repairCamera(value) {
	const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
	const cameraRail = repairRail(source.cameraRail);
	let mode = CAMERA_MODES.has(source.mode) ? source.mode : "keys";
	// A rail block without a usable two-point rail behaves like ordinary
	// follow, never like a mysteriously enabled but motionless dolly.
	if (mode === "rail" && !cameraRail) mode = "follow";
	return { mode, followCam: repairFollowCam(source.followCam), cameraRail };
}

function migratedCamera(followCam, cameraRail) {
	const rail = repairRail(cameraRail);
	const enabled = followCam?.enabled === true;
	return repairCamera({
		mode: enabled ? (rail ? "rail" : "follow") : "keys",
		followCam,
		cameraRail: rail,
	});
}

function repairShared(parsed, frameCount) {
	return {
		frameCount,
		waypoints: repairWaypoints(parsed.waypoints),
	};
}

/**
 * Build a transport-neutral shot document. It can live at the root today or
 * be nested under a future Scene document without changing its schema.
 */
export function createShotAuthoringDocument({ shots = [], waypoints = [], frameCount = null } = {}) {
	const repairedFrameCount = repairFrameCount(frameCount);
	const effectiveFrameCount = repairedFrameCount ?? DEFAULT_FRAME_COUNT;
	return {
		version: SHOT_AUTHORING_VERSION,
		frameCount: repairedFrameCount,
		shots: repairShots(shots, effectiveFrameCount),
		waypoints: repairWaypoints(waypoints),
	};
}

/** Pure object reader; storage adapters decide how bytes become this object. */
export function readShotAuthoringDocument(parsed) {
	if (parsed === undefined) return { status: "absent", state: null };
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "corrupt", state: null };
	const version = parsed.version === undefined ? 1 : parsed.version;
	if (!Number.isInteger(version) || version < 1) return { status: "corrupt", state: null };
	if (version > SHOT_AUTHORING_VERSION) return { status: "future", state: null };

	const frameCount = repairFrameCount(parsed.frameCount);
	const effectiveFrameCount = frameCount ?? DEFAULT_FRAME_COUNT;
	if (version === 1) {
		const keys = repairKeys(parsed.cameraKeys, 0, effectiveFrameCount - 1);
		const camera = migratedCamera(parsed.followCam, parsed.cameraRail);
		const shots = initialShots(effectiveFrameCount, keys).map((shot) => ({ ...shot, camera: repairCamera(camera) }));
		return {
			status: "migrated",
			state: { ...repairShared(parsed, frameCount), shots },
		};
	}
	if (!Array.isArray(parsed.shots)) return { status: "corrupt", state: null };
	if (version === 2) {
		const camera = migratedCamera(parsed.followCam, parsed.cameraRail);
		return {
			status: "migrated",
			state: { ...repairShared(parsed, frameCount), shots: repairShots(parsed.shots, effectiveFrameCount, camera) },
		};
	}
	return {
		status: "valid",
		state: { ...repairShared(parsed, frameCount), shots: repairShots(parsed.shots, effectiveFrameCount) },
	};
}

/** JSON compatibility adapters used by App and older model callers. */
export function serializeShotAuthoring(state) {
	return JSON.stringify(createShotAuthoringDocument(state));
}

export function readShotAuthoring(raw) {
	if (raw === null || raw === undefined || raw === "") return { status: "absent", state: null };
	try {
		return readShotAuthoringDocument(JSON.parse(raw));
	} catch {
		return { status: "corrupt", state: null };
	}
}

/** Compatibility-shaped convenience for model callers and tests. */
export function loadShotAuthoring(raw) {
	return readShotAuthoring(raw).state;
}
