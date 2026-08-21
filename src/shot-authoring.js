/**
 * Shot-authoring persistence. Like the scene store, the version lives in the
 * key and body. Bad bytes are identified for quarantine by the caller, while
 * future bytes are left in place for the newer app that understands them.
 */

import { createShot } from "./cuts.js";

export const SHOT_AUTHORING_VERSION = 4;
export const SHOT_AUTHORING_KEY = "cozyclay.shot-authoring.v4";
// The single-key alias points at the newest legacy body for older callers.
// New readers should walk the list so a user can still arrive directly from v1.
export const SHOT_AUTHORING_LEGACY_KEY = "cozyclay.shot-authoring.v3";
export const SHOT_AUTHORING_LEGACY_KEYS = Object.freeze([
	SHOT_AUTHORING_LEGACY_KEY,
	"cozyclay.shot-authoring.v2",
	"cozyclay.shot-authoring.v1",
]);
export const SHOT_AUTHORING_QUARANTINE_KEY = "cozyclay.shot-authoring.v4.quarantine";

/** clip length sanity bounds, frames @ 24 fps: 1 s .. 20 min */
const FRAME_COUNT_MIN = 24;
const FRAME_COUNT_MAX = 28800;
const DEFAULT_FRAME_COUNT = 144;
const RAIL_MAX_POINTS = 512;
const finite = Number.isFinite;

/** v3 and older bodies counted frames on ARDY's 20 fps clock; v4 counts them
 * on the 24 fps production clock. Every frame-bearing number is multiplied so
 * a saved roll keeps its DURATION: a 300-frame clip was 15 s and stays 15 s as
 * 360 frames. Reinterpreting instead would silently shorten it to 12.5 s. */
const LEGACY_FRAME_FPS = 20;
const TIMELINE_FRAME_FPS = 24;
const toTimelineFrame = (frame) => Math.round((frame * TIMELINE_FRAME_FPS) / LEGACY_FRAME_FPS);
const rescaleFrame = (value) => (finite(value) ? toTimelineFrame(value) : value);
const rescaleKeys = (entries) => (Array.isArray(entries)
	? entries.map((key) => (key && typeof key === "object" ? { ...key, frame: rescaleFrame(key.frame) } : key))
	: entries);
const rescaleRailFollow = (value) => (value && typeof value === "object" && !Array.isArray(value)
	? { ...value, startFrame: rescaleFrame(value.startFrame), endFrame: rescaleFrame(value.endFrame) }
	: value);

/** Retime a whole parsed body before the ordinary repair runs, so the version
 * migrations below only ever see production-clock numbers. Rail geometry,
 * follow gains and framings carry no frames and are passed through. */
function rescaleShotAuthoringFrames(parsed) {
	const next = { ...parsed, frameCount: rescaleFrame(parsed.frameCount) };
	if (Array.isArray(parsed.cameraKeys)) next.cameraKeys = rescaleKeys(parsed.cameraKeys);
	if (Array.isArray(parsed.waypoints)) next.waypoints = rescaleKeys(parsed.waypoints);
	if (parsed.railFollow !== undefined) next.railFollow = rescaleRailFollow(parsed.railFollow);
	if (Array.isArray(parsed.shots)) {
		next.shots = parsed.shots.map((shot) => {
			if (!shot || typeof shot !== "object") return shot;
			const moved = { ...shot, startFrame: rescaleFrame(shot.startFrame), endFrame: rescaleFrame(shot.endFrame) };
			if (Array.isArray(shot.cameraKeys)) moved.cameraKeys = rescaleKeys(shot.cameraKeys);
			if (shot.camera && typeof shot.camera === "object" && !Array.isArray(shot.camera)) {
				moved.camera = { ...shot.camera, railFollow: rescaleRailFollow(shot.camera.railFollow) };
			}
			return moved;
		});
	}
	return next;
}

const FOLLOW_BOUNDS = {
	distance: [0.5, 15],
	height: [0.2, 6],
	response: [0.1, 3],
	lead: [0, 1],
	maxDollySpeed: [0.2, 8],
	pitchOffsetDeg: [-30, 30],
	orbitOffsetDeg: [-180, 180],
};
const FOLLOW_DEFAULTS = {
	distance: 3,
	height: 1.6,
	response: 0.7,
	lead: 0.25,
	railStartMode: "head",
	maxDollySpeed: 4,
	pitchOffsetDeg: 0,
	orbitOffsetDeg: 0,
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
	if (!candidates.length) return [];

	// One boundary per frame. The later stored entry wins, just like re-keying.
	const byStart = new Map(candidates.map((candidate) => [candidate.startFrame, candidate.entry]));
	const ordered = [...byStart.entries()].sort((a, b) => a[0] - b[0]);
	const seenIds = new Set();
	return ordered.map(([startFrame, entry], index) => {
		const nextStart = ordered[index + 1]?.[0] ?? frameCount;
		// Pre-overlay v3 bodies had no endFrame and were gapless by definition.
		// Infer their old boundary exactly; new bodies persist an explicit end.
		const storedEnd = finite(entry.endFrame) ? Math.round(entry.endFrame) : nextStart - 1;
		const endFrame = Math.max(startFrame, Math.min(frameCount - 1, nextStart - 1, storedEnd));
		const fallback = createShot(`Shot ${index + 1}`, startFrame, endFrame);
		const storedId = typeof entry.id === "string" && entry.id.trim() && !seenIds.has(entry.id) ? entry.id : fallback.id;
		seenIds.add(storedId);
		return {
			id: storedId,
			name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : `Shot ${index + 1}`,
			startFrame,
			endFrame,
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

function repairRailFollow(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	if (value.mode === "off") return { mode: "off" };
	if (value.mode !== "range" || !finite(value.startFrame) || !finite(value.endFrame)) return null;
	const startFrame = Math.max(0, Math.round(value.startFrame));
	const endFrame = Math.max(0, Math.round(value.endFrame));
	return startFrame <= endFrame ? { mode: "range", startFrame, endFrame } : null;
}

function repairCamera(value) {
	const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
	const cameraRail = repairRail(source.cameraRail);
	let mode = CAMERA_MODES.has(source.mode) ? source.mode : "keys";
	// A rail block without a usable two-point rail behaves like ordinary
	// follow, never like a mysteriously enabled but motionless dolly.
	if (mode === "rail" && !cameraRail) mode = "follow";
	return { mode, followCam: repairFollowCam(source.followCam), cameraRail, railFollow: repairRailFollow(source.railFollow) };
}

function migratedCamera(followCam, cameraRail, railFollow = null) {
	const rail = repairRail(cameraRail);
	const enabled = followCam?.enabled === true;
	return repairCamera({
		mode: enabled ? (rail ? "rail" : "follow") : "keys",
		followCam,
		cameraRail: rail,
		railFollow,
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
export function readShotAuthoringDocument(raw) {
	if (raw === undefined) return { status: "absent", state: null };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { status: "corrupt", state: null };
	const version = raw.version === undefined ? 1 : raw.version;
	if (!Number.isInteger(version) || version < 1) return { status: "corrupt", state: null };
	if (version > SHOT_AUTHORING_VERSION) return { status: "future", state: null };

	// One conversion at the door: everything below reads one clock.
	const parsed = version < 4 ? rescaleShotAuthoringFrames(raw) : raw;
	const frameCount = repairFrameCount(parsed.frameCount);
	const effectiveFrameCount = frameCount ?? DEFAULT_FRAME_COUNT;
	if (version === 1) {
		const keys = repairKeys(parsed.cameraKeys, 0, effectiveFrameCount - 1);
		const camera = migratedCamera(parsed.followCam, parsed.cameraRail, parsed.railFollow);
		// v1 was one whole-timeline camera roll even when it had no keys.
		const shots = [createShot("Shot 1", 0, effectiveFrameCount - 1, keys, repairCamera(camera))];
		return {
			status: "migrated",
			state: { ...repairShared(parsed, frameCount), shots },
		};
	}
	if (!Array.isArray(parsed.shots)) return { status: "corrupt", state: null };
	if (version === 2) {
		const camera = migratedCamera(parsed.followCam, parsed.cameraRail, parsed.railFollow);
		return {
			status: "migrated",
			state: { ...repairShared(parsed, frameCount), shots: repairShots(parsed.shots, effectiveFrameCount, camera) },
		};
	}
	return {
		// A v3 body is structurally current but was authored on the old clock;
		// it is rewritten, so it reports as migrated, not valid.
		status: version < SHOT_AUTHORING_VERSION ? "migrated" : "valid",
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
