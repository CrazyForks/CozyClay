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
 *   { id, name, renderer, x, y, z, rot, rotX, rotZ, scaleX, scaleY, scaleZ,
 *     color, footprint: { width, depth }, height }
 * Position is metres on the floor plane (`y` is height above the deck, 0 =
 * standing on it). `rot` stays the Y (yaw) angle in degrees — the bird's-eye
 * board and its handles are built on it — with `rotX`/`rotZ` the pitch/roll
 * the 3D gizmo's other two rings drive.
 */

import { Euler, Quaternion } from "three";

export const DEFAULT_SCENE_OBJECTS = [];
/** The persistence contract (plan §8.1): the version lives in the key AND in
 * the body, so a future v2 can read a v1 body. The quarantine key holds a
 * corrupt payload byte-for-byte until an older build can be upgraded. */
export const SCENE_STORAGE_KEY = "cozyclay.scene.v1";
export const SCENE_QUARANTINE_KEY = "cozyclay.scene.v1.quarantine";
export const SCENE_VERSION = 1;

/** Euler convention shared with the renderer in props.jsx. */
const EULER_ORDER = "XYZ";
const DEG = Math.PI / 180;

/** Room half-extent; matches the plan board's ROOM_LIMIT. */
const ROOM_LIMIT = 11;
const CEILING = 6;
const SCALE_MIN = 0.1;
const SCALE_MAX = 100;

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
/* -------------------------------------------------- persistence ---- */

/**
 * Repair one stored record into a live record, or return null to drop it.
 * Storage is never trusted: `footprint`/`height` are rebuilt from the
 * library, every transform channel goes through the same clamps the editor
 * uses, and missing channels take `createSceneObject` defaults. An unknown
 * `renderer` (or a record without an id) has nothing to render or address,
 * so it is dropped rather than half-restored (plan §8.2).
 */
export function normalizeSceneObject(record) {
	if (!record || typeof record !== "object" || Array.isArray(record)) return null;
	const entry = objectLibraryEntry(record.renderer);
	if (!entry) return null;
	if (typeof record.id !== "string" || !record.id) return null;
	// Defensive import fallback, not a migration: hand-authored or external
	// payloads may carry one `scale` (the pre-split record shape). It fans
	// out to all three axes only when no axis is present — an explicit
	// scaleX wins over the fallback.
	const hasSingleScale = record.scaleX === undefined && record.scaleY === undefined && record.scaleZ === undefined;
	const singleScale = hasSingleScale ? Number(record.scale) : NaN;
	const scaleFallback = Number.isFinite(singleScale) ? singleScale : 1;
	const pick = (value, fallback) => {
		const n = value === undefined ? fallback : Number(value);
		return Number.isFinite(n) ? n : fallback;
	};
	return {
		id: record.id,
		name: typeof record.name === "string" && record.name ? record.name : entry.label,
		renderer: entry.kind,
		x: TRANSFORM_LIMITS.x(pick(record.x, 0)),
		y: TRANSFORM_LIMITS.y(pick(record.y, 0)),
		z: TRANSFORM_LIMITS.z(pick(record.z, 0)),
		rot: TRANSFORM_LIMITS.rot(pick(record.rot, 0)),
		rotX: TRANSFORM_LIMITS.rotX(pick(record.rotX, 0)),
		rotZ: TRANSFORM_LIMITS.rotZ(pick(record.rotZ, 0)),
		scaleX: TRANSFORM_LIMITS.scaleX(pick(record.scaleX, scaleFallback)),
		scaleY: TRANSFORM_LIMITS.scaleY(pick(record.scaleY, scaleFallback)),
		scaleZ: TRANSFORM_LIMITS.scaleZ(pick(record.scaleZ, scaleFallback)),
		color: typeof record.color === "string" && record.color ? record.color : entry.color,
		footprint: { ...entry.footprint },
		height: entry.height,
	};
}

/** The only writer. The body carries the version alongside the key so a
 * future build can read today's payload after a key rename. */
export function serializeScene(objects) {
	return JSON.stringify({ version: SCENE_VERSION, objects });
}

/**
 * Total, consistent tag predicate (plan §8.2): every input falls into exactly
 * one row and this never throws. `absent` and `corrupt` fall back to the
 * defaults; `future` is quarantined in App — never overwritten.
 */
export function loadScene(raw) {
	if (raw === null || raw === undefined || raw === "") {
		return { status: "absent", objects: [], dropped: 0 };
	}
	let payload;
	try {
		payload = JSON.parse(raw);
	} catch {
		return { status: "corrupt", objects: [], dropped: 0 };
	}
	// A scene body is a non-array plain object holding an array of records.
	if (payload === null || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.objects)) {
		return { status: "corrupt", objects: [], dropped: 0 };
	}
	const { version } = payload;
	// The supported range is exactly the integers 1..SCENE_VERSION; a
	// malformed version ("1", 1.5, 0, -1, NaN) is corrupt, never future.
	if (!Number.isInteger(version) || version < 1) {
		return { status: "corrupt", objects: [], dropped: 0 };
	}
	if (version > SCENE_VERSION) {
		return { status: "future", objects: [], dropped: 0 };
	}
	const seen = new Set();
	const objects = [];
	let dropped = 0;
	for (const record of payload.objects) {
		const normalized = normalizeSceneObject(record);
		// Unknown renderers and duplicate ids are dropped and counted, so the
		// caller can report what was lost instead of silently degrading.
		if (!normalized || seen.has(normalized.id)) {
			dropped += 1;
			continue;
		}
		seen.add(normalized.id);
		objects.push(normalized);
	}
	return { status: "valid", objects, dropped };
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
/* -------------------------------------------------- drop-to-surface ---- */

/** The tolerance that keeps an edge-abutting footprint from counting as
 * overlap: a strict `<` against `max - EPS` makes a 0.5 - 0.5 touch false. */
const OVERLAP_EPS = 1e-4;

/**
 * The object's world-space axis-aligned bounds. The footprint rectangle is
 * rotated by `rot` (the yaw the plan board reads) and projected to its AABB:
 * at 45 degrees a long plank widens on both axes. Pitch/roll are a documented
 * approximation — the vertical extent still uses the unrotated height, so a
 * tilted object's support level is approximate while yaw is exact.
 */
export function objectFootprintBounds(object) {
	const size = objectSize(object);
	const rot = (object.rot ?? 0) * DEG;
	const c = Math.abs(Math.cos(rot));
	const s = Math.abs(Math.sin(rot));
	const halfW = (size.width * c + size.depth * s) / 2;
	const halfD = (size.width * s + size.depth * c) / 2;
	const x = object.x ?? 0;
	const z = object.z ?? 0;
	const baseY = object.y ?? 0;
	return {
		minX: x - halfW,
		maxX: x + halfW,
		minZ: z - halfD,
		maxZ: z + halfD,
		baseY,
		topY: baseY + size.height,
	};
}

/**
 * Where the object would land if it fell straight down, as a `{ y }` patch —
 * PURE: it reads `object` and `others` and mutates nothing. Returns null when
 * the object is already resting exactly on the surface, so a redundant drop
 * can never create a history entry.
 *
 * Strict drop-down (plan §9.2): among the `others` whose projected footprints
 * strictly overlap this object's (EPS keeps edge abutments out), only
 * surfaces whose top is at or below the object's current base are support;
 * the object lands with its base exactly on the highest such top, or on the
 * floor when there is none. An object already penetrating a surface is
 * therefore NOT supported by it and falls through — the recovery is to raise
 * Y above the box and press End again. The deferred alternative (a bounded
 * penetration threshold) is cut because the user cannot see the threshold
 * and a second End press would differ from the first.
 *
 * The contact height is exact, never snapped to the 5 cm grid, and never
 * clamped here: the y clamp stays in updateSceneObject, the single owner.
 */
export function dropToSurfacePatch(object, others) {
	const self = objectFootprintBounds(object);
	let highestTop = 0;
	for (const other of others) {
		const bounds = objectFootprintBounds(other);
		if (self.minX >= bounds.maxX - OVERLAP_EPS || bounds.minX >= self.maxX - OVERLAP_EPS) continue;
		if (self.minZ >= bounds.maxZ - OVERLAP_EPS || bounds.minZ >= self.maxZ - OVERLAP_EPS) continue;
		if (bounds.topY > self.baseY + OVERLAP_EPS) continue;
		if (bounds.topY > highestTop) highestTop = bounds.topY;
	}
	return highestTop === self.baseY ? null : { y: highestTop };
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
