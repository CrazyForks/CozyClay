export const DEFAULT_SCENE_OBJECTS = [
	{
		id: "object-car-1",
		name: "Car",
		renderer: "car",
		x: -3.2,
		z: -2.4,
		rot: (Math.PI / 7) * (180 / Math.PI),
		footprint: { width: 1.78, depth: 4.45 },
	},
	{
		id: "object-chair-1",
		name: "Chair",
		renderer: "chair",
		x: 0,
		z: -0.36,
		rot: 0,
		footprint: { width: 0.54, depth: 0.522 },
	},
];

export function sceneObjectHierarchyId(id) {
	return `object:${id}`;
}

export function sceneObjectIdFromHierarchy(hierarchyId) {
	return hierarchyId.startsWith("object:") ? hierarchyId.slice("object:".length) : null;
}

export function updateSceneObject(objects, id, patch) {
	let changed = false;
	const next = objects.map((object) => {
		if (object.id !== id) return object;
		const update = {};
		for (const key of ["x", "z", "rot"]) {
			if (patch[key] === undefined) continue;
			const value = Number(patch[key]);
			if (!Number.isFinite(value) || value === object[key]) continue;
			update[key] = value;
		}
		if (!Object.keys(update).length) return object;
		changed = true;
		return { ...object, ...update };
	});
	return changed ? next : objects;
}
