/**
 * Object travel paths — the same authoring grammar the camera rail uses.
 *
 * A path is a stroke drawn on the Top-View floor, refined in the scene by
 * dragging its points (including their height, the way a crane point lifts a
 * camera). This module is the pure half: it owns the schema, the arc-length
 * table and the frame → transform answer, so playback, the offscreen export
 * and the MCP surface all read one truth and stay importable without three.js.
 *
 * Timing follows the character root path's rule: a path spans the whole
 * timeline. `speed` is metres per second when set; otherwise the path's own
 * length divided by the take's duration fills the timeline exactly.
 */

const MAX_PATH_POINTS = 64;
const ROOM_LIMIT = 240;
const MAX_HEIGHT = 60;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** One authored path point: a floor position plus the height it travels at. */
function createPathPoint(value) {
	const source = value && typeof value === "object" ? value : {};
	return {
		x: clamp(finite(source.x), -ROOM_LIMIT, ROOM_LIMIT),
		y: clamp(finite(source.y), 0, MAX_HEIGHT),
		z: clamp(finite(source.z), -ROOM_LIMIT, ROOM_LIMIT),
	};
}

/**
 * Normalize a stored or drawn path. Returns null for anything that cannot
 * describe travel — fewer than two points, or a stroke that never moves.
 */
export function createObjectPath(value) {
	if (!value || typeof value !== "object") return null;
	const rawPoints = Array.isArray(value.points) ? value.points : [];
	const points = [];
	for (const raw of rawPoints) {
		const point = createPathPoint(raw);
		// Drop the duplicate samples a drag emits while the pointer rests: they
		// add length-zero segments that would divide by zero downstream.
		const previous = points[points.length - 1];
		if (previous && Math.hypot(point.x - previous.x, point.z - previous.z, point.y - previous.y) < 1e-4) continue;
		points.push(point);
		if (points.length >= MAX_PATH_POINTS) break;
	}
	if (points.length < 2) return null;
	const speed = finite(value.speed, 0);
	return {
		points,
		// 0 means "fill the timeline": the length/duration answer is computed at
		// sample time, where the take's duration is known.
		speed: speed > 0 ? clamp(speed, 0.01, 50) : 0,
		faceTravel: value.faceTravel !== false,
		loop: value.loop === true,
		// Keep going in the final direction after the last point — the "just
		// keep moving that way" case, expressed as an option on a real path.
		extend: value.extend === true,
	};
}

/** Cumulative arc length per point, plus the total. */
export function pathMetrics(path) {
	const points = path?.points ?? [];
	const cumulative = [0];
	for (let i = 1; i < points.length; i += 1) {
		const a = points[i - 1];
		const b = points[i];
		cumulative.push(cumulative[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
	}
	return { cumulative, length: cumulative[cumulative.length - 1] ?? 0 };
}

/** The point at `distance` along the path, extrapolating past the end. */
function pointAtDistance(path, metrics, distance) {
	const { points } = path;
	const { cumulative, length } = metrics;
	if (distance <= 0) {
		const heading = headingBetween(points[0], points[1]);
		return { ...points[0], heading };
	}
	if (distance >= length) {
		const last = points[points.length - 1];
		const heading = headingBetween(points[points.length - 2], last);
		if (!path.extend) return { ...last, heading };
		// Past the end the object keeps its final direction and speed.
		const overshoot = distance - length;
		const previous = points[points.length - 2];
		const span = Math.hypot(last.x - previous.x, last.y - previous.y, last.z - previous.z) || 1;
		return {
			x: last.x + ((last.x - previous.x) / span) * overshoot,
			y: Math.max(0, last.y + ((last.y - previous.y) / span) * overshoot),
			z: last.z + ((last.z - previous.z) / span) * overshoot,
			heading,
		};
	}
	let index = 1;
	while (index < cumulative.length - 1 && cumulative[index] < distance) index += 1;
	const a = points[index - 1];
	const b = points[index];
	const segment = cumulative[index] - cumulative[index - 1];
	const weight = segment > 1e-9 ? (distance - cumulative[index - 1]) / segment : 0;
	return {
		x: a.x + (b.x - a.x) * weight,
		y: a.y + (b.y - a.y) * weight,
		z: a.z + (b.z - a.z) * weight,
		heading: headingBetween(a, b),
	};
}

/** Yaw in degrees for travel from `a` to `b`, in the object's rotation frame. */
function headingBetween(a, b) {
	if (!a || !b) return null;
	const dx = b.x - a.x;
	const dz = b.z - a.z;
	if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return null;
	return (Math.atan2(dx, dz) * 180) / Math.PI;
}

/**
 * Where an object stands at `frame`. Returns null when the object has no
 * usable path, so callers fall back to its authored transform untouched.
 *
 * @param {object} object a scene object record
 * @param {number} frame absolute timeline frame
 * @param {{ frameCount: number, fps: number }} take timeline geometry
 */
export function objectTransformAt(object, frame, take = {}) {
	const path = createObjectPath(object?.path);
	if (!path) return null;
	const metrics = pathMetrics(path);
	if (metrics.length <= 1e-9) return null;
	const frameCount = Math.max(1, Math.round(finite(take.frameCount, 1)));
	const fps = Math.max(1, finite(take.fps, 24));
	const sampled = clamp(finite(frame), 0, Math.max(0, frameCount - 1));
	const seconds = sampled / fps;
	// speed 0 = fill the timeline: cover the whole path across the take.
	const duration = Math.max(1e-6, (frameCount - 1) / fps);
	const speed = path.speed > 0 ? path.speed : metrics.length / duration;
	let distance = speed * seconds;
	if (path.loop && metrics.length > 1e-9) distance %= metrics.length;
	const at = pointAtDistance(path, metrics, distance);
	return {
		x: at.x,
		y: at.y,
		z: at.z,
		rot: path.faceTravel && at.heading !== null ? at.heading : null,
	};
}

export { MAX_PATH_POINTS, MAX_HEIGHT as MAX_PATH_HEIGHT };
