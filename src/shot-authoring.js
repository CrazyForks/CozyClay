/**
 * Shot-authoring persistence: the camera move keys, the root waypoints and
 * the clip length survive a reload the same way the scene objects do. The
 * rest of a shot (loaded motion, playhead, transport) is session state and
 * deliberately not stored — a refresh should reopen the authored shot, not
 * resume a half-played preview.
 */

export const SHOT_AUTHORING_KEY = "cozyclay.shot-authoring.v1";

/** clip length sanity bounds, frames @ 20 fps: 1 s .. 20 min */
const FRAME_COUNT_MIN = 20;
const FRAME_COUNT_MAX = 24000;

const finite = Number.isFinite;

/** framing = { pos: {x,y,z}, yaw, pitch, fovDeg }, all finite numbers */
function validFraming(framing) {
	return (
		!!framing &&
		typeof framing === "object" &&
		!!framing.pos &&
		finite(framing.pos.x) &&
		finite(framing.pos.y) &&
		finite(framing.pos.z) &&
		finite(framing.yaw) &&
		finite(framing.pitch) &&
		finite(framing.fovDeg)
	);
}

export function serializeShotAuthoring({ cameraKeys = [], waypoints = [], frameCount = null }) {
	return JSON.stringify({ version: 1, frameCount, cameraKeys, waypoints });
}

/**
 * Parse a stored payload back into authoring state. Malformed entries are
 * dropped one by one (a bad key must not take the whole shot down with it);
 * anything unusable at the top level returns null and the app starts fresh.
 */
export function loadShotAuthoring(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw || "null");
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;

	const frameCount = finite(parsed.frameCount)
		? Math.max(FRAME_COUNT_MIN, Math.min(FRAME_COUNT_MAX, Math.round(parsed.frameCount)))
		: null;

	const keysByFrame = new Map();
	for (const key of Array.isArray(parsed.cameraKeys) ? parsed.cameraKeys : []) {
		if (!key || !finite(key.frame) || key.frame < 0 || !validFraming(key.framing)) continue;
		const frame = Math.round(key.frame);
		// duplicate frames keep the later entry, matching re-key semantics
		keysByFrame.set(frame, {
			frame,
			framing: {
				pos: { x: key.framing.pos.x, y: key.framing.pos.y, z: key.framing.pos.z },
				yaw: key.framing.yaw,
				pitch: key.framing.pitch,
				fovDeg: key.framing.fovDeg,
			},
		});
	}
	const cameraKeys = [...keysByFrame.values()].sort((a, b) => a.frame - b.frame);

	const waypointsByFrame = new Map();
	for (const waypoint of Array.isArray(parsed.waypoints) ? parsed.waypoints : []) {
		if (!waypoint || !finite(waypoint.frame) || waypoint.frame < 0 || !finite(waypoint.x) || !finite(waypoint.z)) continue;
		const frame = Math.round(waypoint.frame);
		waypointsByFrame.set(frame, {
			frame,
			x: waypoint.x,
			z: waypoint.z,
			heading: finite(waypoint.heading) ? waypoint.heading : null,
		});
	}
	const waypoints = [...waypointsByFrame.values()].sort((a, b) => a.frame - b.frame);

	return { frameCount, cameraKeys, waypoints };
}
