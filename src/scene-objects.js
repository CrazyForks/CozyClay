/**
 * Scene objects: everything the user drops into the set themselves.
 *
 * A shot needs things in it. The set used to ship a fixed handful of props and
 * no way to add anything, so this module owns the whole lifecycle instead:
 * the catalogue you can create from, the record every object carries, and the
 * transform maths the gizmo and the inspector sliders both go through. One
 * clamp/snap path means a drag in the viewport and a slider nudge can never
 * disagree about what a legal transform is.
 *
 * Record shape:
 *   { id, name, renderer, x, y, z, rot, rotX, rotZ, scale, color,
 *     footprint: { width, depth }, height }
 * Position is metres on the floor plane (`y` is height above the deck, 0 =
 * standing on it). `rot` stays the Y (yaw) angle in degrees — the bird's-eye
 * board and its handles are built on it — with `rotX`/`rotZ` the pitch/roll
 * the 3D gizmo's other two rings drive.
 */

import { Euler, Quaternion } from "three";

export const DEFAULT_SCENE_OBJECTS = [];

/** Euler convention shared with the renderer in props.jsx. */
const EULER_ORDER = "XYZ";
const DEG = Math.PI / 180;

/** Room half-extent; matches the plan board's ROOM_LIMIT. */
const ROOM_LIMIT = 6.5;
const CEILING = 6;
const SCALE_MIN = 0.1;
const SCALE_MAX = 5;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
/** degrees folded into [-180, 180), the range both rotation sliders span */
export const wrapAngle = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;
/** Snap to a detent AND to that detent's own precision: plain multiplication
 * leaves 0.05 grids reading -1.7000000000000002 in the inspector. A step of 0
 * means "no detent" — a free drag still rounds, or the inspector would show a
 * position of 1.2999999999999998. */
const snapTo = (value, step) => Number((step > 0 ? Math.round(value / step) * step : value).toFixed(4));

/**
 * What you can create. `group` is the catalogue heading, `footprint` is the
 * plan-board rectangle in metres, `height` is how tall the untransformed
 * object stands (used for the selection box and the gizmo's height).
 *
 * Primitives are grey-box grey on purpose: a blockout stands in for something
 * else, and a tinted maquette reads as a finished prop. The hand-built set
 * pieces keep their clay colours because they ARE the thing they depict.
 */
const GREY_BOX = "#c2c6c8";
export const OBJECT_LIBRARY = [
	{ kind: "cube", label: "Cube", group: "Primitives", footprint: { width: 1, depth: 1 }, height: 1, color: GREY_BOX },
	{ kind: "sphere", label: "Sphere", group: "Primitives", footprint: { width: 1, depth: 1 }, height: 1, color: GREY_BOX },
	{ kind: "capsule", label: "Capsule", group: "Primitives", footprint: { width: 0.7, depth: 0.7 }, height: 1.4, color: GREY_BOX },
	{ kind: "cylinder", label: "Cylinder", group: "Primitives", footprint: { width: 1, depth: 1 }, height: 1, color: GREY_BOX },
	{ kind: "cone", label: "Cone", group: "Primitives", footprint: { width: 1, depth: 1 }, height: 1, color: GREY_BOX },
	{ kind: "plane", label: "Plane", group: "Primitives", footprint: { width: 2, depth: 2 }, height: 0, color: GREY_BOX },
	{ kind: "chair", label: "Chair", group: "Set pieces", footprint: { width: 0.6, depth: 0.6 }, height: 1.15, color: "#b9855d" },
	{ kind: "car", label: "Car", group: "Set pieces", footprint: { width: 1.8, depth: 4.5 }, height: 1.4, color: "#d98770" },
	{ kind: "small-plane", label: "Plane (aircraft)", group: "Set pieces", footprint: { width: 3.4, depth: 3.6 }, height: 1.4, color: "#7896a4" },
];

/** Blockout greys first, then the clay accents, for re-tinting from the
 * inspector. */
export const OBJECT_COLORS = ["#e2e5e6", GREY_BOX, "#9aa1a5", "#767d81", "#d9b18c", "#8fae9b"];

function objectLibraryEntry(kind) {
	return OBJECT_LIBRARY.find((entry) => entry.kind === kind) ?? null;
}

export function sceneObjectHierarchyId(id) {
	return `object:${id}`;
}

export function sceneObjectIdFromHierarchy(hierarchyId) {
	return hierarchyId.startsWith("object:") ? hierarchyId.slice("object:".length) : null;
}

/**
 * A fresh object of `kind`, named and identified uniquely against `existing`.
 * `placement` seeds the floor position (the caller drops it in front of the
 * camera); everything else starts neutral so the first drag is predictable.
 */
export function createSceneObject(kind, existing = [], placement = {}) {
	const entry = objectLibraryEntry(kind);
	if (!entry) return null;
	const names = new Set(existing.map((object) => object.name));
	let name = entry.label;
	for (let n = 2; names.has(name); n += 1) name = `${entry.label} ${n}`;
	const ids = new Set(existing.map((object) => object.id));
	let id = kind;
	for (let n = 2; ids.has(id); n += 1) id = `${kind}-${n}`;
	return {
		id,
		name,
		renderer: kind,
		x: clamp(Number(placement.x) || 0, -ROOM_LIMIT, ROOM_LIMIT),
		y: 0,
		z: clamp(Number(placement.z) || 0, -ROOM_LIMIT, ROOM_LIMIT),
		rot: wrapAngle(Number(placement.rot) || 0),
		rotX: 0,
		rotZ: 0,
		scaleX: 1,
		scaleY: 1,
		scaleZ: 1,
		color: entry.color,
		footprint: { ...entry.footprint },
		height: entry.height,
	};
}

/** Every writable transform channel and the rule that keeps it in the room. */
const TRANSFORM_LIMITS = {
	x: (value) => clamp(value, -ROOM_LIMIT, ROOM_LIMIT),
	y: (value) => clamp(value, 0, CEILING),
	z: (value) => clamp(value, -ROOM_LIMIT, ROOM_LIMIT),
	rot: wrapAngle,
	rotX: wrapAngle,
	rotZ: wrapAngle,
	scaleX: (value) => clamp(value, SCALE_MIN, SCALE_MAX),
	scaleY: (value) => clamp(value, SCALE_MIN, SCALE_MAX),
	scaleZ: (value) => clamp(value, SCALE_MIN, SCALE_MAX),
};

export function updateSceneObject(objects, id, patch) {
	let changed = false;
	const next = objects.map((object) => {
		if (object.id !== id) return object;
		const update = {};
		for (const [key, limit] of Object.entries(TRANSFORM_LIMITS)) {
			if (patch[key] === undefined) continue;
			const value = Number(patch[key]);
			if (!Number.isFinite(value)) continue;
			const bounded = limit(value);
			if (bounded === object[key]) continue;
			update[key] = bounded;
		}
		for (const key of ["name", "color"]) {
			if (typeof patch[key] !== "string" || !patch[key] || patch[key] === object[key]) continue;
			update[key] = patch[key];
		}
		if (!Object.keys(update).length) return object;
		changed = true;
		return { ...object, ...update };
	});
	return changed ? next : objects;
}

export function removeSceneObject(objects, id) {
	const next = objects.filter((object) => object.id !== id);
	return next.length === objects.length ? objects : next;
}

/* ------------------------------------------------------------- gizmo ---- */

/** The three world axes the gizmo drags along, and the record field each one
 * rotates / scales. */
const WORLD_AXES = ["x", "y", "z"];
const ROTATION_KEYS = { x: "rotX", y: "rot", z: "rotZ" };
const SCALE_KEYS = { x: "scaleX", y: "scaleY", z: "scaleZ" };
/** 5 cm translate detents, 5° rotate detents and 5% scale steps: the same grid
 * the plan board blocks on, so an object dragged in 3D lands where the top-down
 * view expects. */
const TRANSLATE_SNAP = 0.05;
const ROTATE_SNAP = 5;
const SCALE_SNAP = 0.05;

/**
 * Axis-drag result. `start` is the object as it was when the drag began and
 * `distance` the travel along that world axis, so a move is absolute and can
 * never compound across pointer ticks.
 */
export function translatePatch(start, axis, distance, snap = TRANSLATE_SNAP) {
	if (!WORLD_AXES.includes(axis) || !Number.isFinite(distance)) return null;
	const value = snapTo((start[axis] ?? 0) + distance, snap);
	return { [axis]: value };
}

/** Ring-drag result: `deltaDeg` degrees added to the drag-start angle. */
export function rotatePatch(start, axis, deltaDeg, snap = ROTATE_SNAP) {
	const key = ROTATION_KEYS[axis];
	if (!key || !Number.isFinite(deltaDeg)) return null;
	return { [key]: wrapAngle(snapTo((start[key] ?? 0) + deltaDeg, snap)) };
}

/**
 * Scale-drag result. `factor` is how much bigger the handle's axis got over the
 * drag (1 = untouched); `axis` null scales all three at once, which is what the
 * gizmo's centre box does.
 */
export function scalePatch(start, axis, factor, snap = SCALE_SNAP) {
	if (!Number.isFinite(factor) || factor <= 0) return null;
	const axes = axis === null ? WORLD_AXES : WORLD_AXES.includes(axis) ? [axis] : [];
	if (!axes.length) return null;
	const patch = {};
	for (const each of axes) {
		const key = SCALE_KEYS[each];
		patch[key] = Math.max(SCALE_MIN, snapTo((start[key] ?? 1) * factor, snap));
	}
	return patch;
}

/**
 * Screen-ring result: `deltaDeg` about an arbitrary world axis (the camera's
 * view direction), composed onto the drag-start orientation. The record stores
 * Euler degrees per world axis, so the spin is done in quaternion space and all
 * three channels are written back together — anything less would drift.
 */
export function screenRotatePatch(start, viewAxis, deltaDeg, snap = ROTATE_SNAP) {
	if (!Number.isFinite(deltaDeg) || !viewAxis) return null;
	const turned = snapTo(deltaDeg, snap);
	const orientation = new Quaternion().setFromEuler(
		new Euler((start.rotX ?? 0) * DEG, (start.rot ?? 0) * DEG, (start.rotZ ?? 0) * DEG, EULER_ORDER),
	);
	// world-space delta: new = delta · old, so the object spins about the view
	// axis no matter how it is already turned
	orientation.premultiply(new Quaternion().setFromAxisAngle(viewAxis, turned * DEG));
	const back = new Euler().setFromQuaternion(orientation, EULER_ORDER);
	return {
		rotX: wrapAngle(snapTo(back.x / DEG, 0)),
		rot: wrapAngle(snapTo(back.y / DEG, 0)),
		rotZ: wrapAngle(snapTo(back.z / DEG, 0)),
	};
}

/** The object's world size along each axis, for the gizmo and the plan board. */
export function objectSize(object) {
	return {
		width: (object.footprint?.width ?? 1) * (object.scaleX ?? 1),
		height: (object.height ?? 1) * (object.scaleY ?? 1),
		depth: (object.footprint?.depth ?? 1) * (object.scaleZ ?? 1),
	};
}

/**
 * Where a fresh object should land: on the floor a few metres down the lens, so
 * it appears where you were looking.
 *
 * Position only — the object is created UNROTATED. Unity's primitives arrive
 * axis-aligned at identity rotation, and that is also the only convention that
 * keeps the invariant a blocking tool needs: equal rotation values face the
 * same way. Turning new objects to face the camera (what this used to do) left
 * every box sitting at a skewed angle to the room and to the character, whose
 * own rotation starts at 0. (docs/unity-reference.md §7)
 */
export function placementInFront(cameraPos, yaw, distance = 2.6) {
	const x = cameraPos.x - Math.sin(yaw) * distance;
	const z = cameraPos.z - Math.cos(yaw) * distance;
	return {
		x: snapTo(clamp(x, -ROOM_LIMIT, ROOM_LIMIT), TRANSLATE_SNAP),
		z: snapTo(clamp(z, -ROOM_LIMIT, ROOM_LIMIT), TRANSLATE_SNAP),
	};
}
