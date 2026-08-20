// Pure Camera Block model. A shot owns one complete camera instruction, like
// the camera card clipped to a single strip of film.

export const CAMERA_MODES = Object.freeze(["keys", "follow", "rail"]);

export const CAMERA_FOLLOW_DEFAULTS = Object.freeze({
	distance: 3,
	height: 1.6,
	response: 0.7,
	lead: 0.25,
	railStartMode: "head",
	maxDollySpeed: 4,
	pitchOffsetDeg: 0,
	orbitOffsetDeg: 0,
});

function cloneRail(points) {
	return Array.isArray(points) ? points.map((point) => ({ x: point.x, z: point.z })) : null;
}

function cloneRailFollow(value) {
	if (!value || typeof value !== "object") return null;
	if (value.mode === "off") return { mode: "off" };
	if (value.mode === "range") return {
		mode: "range",
		startFrame: value.startFrame,
		endFrame: value.endFrame,
	};
	return null;
}

/** Build a complete block from a partial or stored camera value. */
export function createCameraBlock(input = {}) {
	const value = input && typeof input === "object" ? input : {};
	return {
		mode: CAMERA_MODES.includes(value.mode) ? value.mode : "keys",
		followCam: { ...CAMERA_FOLLOW_DEFAULTS, ...(value.followCam ?? {}) },
		cameraRail: cloneRail(value.cameraRail),
		railFollow: cloneRailFollow(value.railFollow),
	};
}

/** Camera Blocks must never share nested settings across shots. */
export function cloneCameraBlock(camera) {
	return createCameraBlock(camera);
}

/** Immutable nested update used by both the sidebar and timeline inspector. */
export function updateCameraBlock(camera, patch = {}) {
	const current = createCameraBlock(camera);
	const change = patch && typeof patch === "object" ? patch : {};
	return createCameraBlock({
		...current,
		...change,
		followCam: change.followCam
			? { ...current.followCam, ...change.followCam }
			: current.followCam,
		cameraRail: Object.hasOwn(change, "cameraRail") ? change.cameraRail : current.cameraRail,
		railFollow: Object.hasOwn(change, "railFollow") ? change.railFollow : current.railFollow,
	});
}

/** Delete authored rail geometry and return rail mode to free Follow. */
export function removeCameraRail(camera) {
	const current = createCameraBlock(camera);
	return updateCameraBlock(current, {
		mode: current.mode === "rail" ? "follow" : current.mode,
		cameraRail: null,
		railFollow: null,
	});
}
