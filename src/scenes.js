// Pure multi-scene document model. No three.js, no React.
// A Scene is the set; shotDocument is a sealed camera-department envelope.
// This module stores and copies that envelope but never opens or validates it.

export const SCENES_VERSION = 1;
export const SCENES_STORAGE_KEY = "cozyclay.scenes.v1";
export const SCENES_QUARANTINE_KEY = "cozyclay.scenes.v1.quarantine";
export const LEGACY_SCENE_STORAGE_KEY = "cozyclay.scene.v1";

let sceneSequence = 1;

const plainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

// Persistence values are JSON-shaped. Recursing here keeps duplicateScene
// independent without borrowing the shot document's schema or runtime types.
function cloneValue(value, copies = new WeakMap()) {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "object") return null;
	if (copies.has(value)) return copies.get(value);
	if (Array.isArray(value)) {
		const copy = [];
		copies.set(value, copy);
		for (const entry of value) copy.push(cloneValue(entry, copies));
		return copy;
	}
	const copy = {};
	copies.set(value, copy);
	for (const [key, entry] of Object.entries(value)) {
		Object.defineProperty(copy, key, {
			value: cloneValue(entry, copies),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return copy;
}

function uniqueId(existing) {
	const ids = new Set(existing.map((scene) => scene?.id));
	let id;
	do id = `scene-${Date.now().toString(36)}-${sceneSequence++}`;
	while (ids.has(id));
	return id;
}

function uniqueName(requested, existing) {
	const nameKey = (name) => typeof name === "string" ? name.normalize("NFKC").toLowerCase() : "";
	const names = new Set(existing.map((scene) => nameKey(scene?.name)));
	const hasName = (name) => names.has(nameKey(name));
	const base = typeof requested === "string" && requested.trim() ? requested.trim() : "SCENE 01";
	if (!hasName(base)) return base;
	const numbered = base.match(/^(.*?)(\d+)$/);
	if (numbered) {
		const [, prefix, digits] = numbered;
		for (let number = Number(digits) + 1; ; number += 1) {
			const candidate = `${prefix}${String(number).padStart(digits.length, "0")}`;
			if (!hasName(candidate)) return candidate;
		}
	}
	for (let number = 2; ; number += 1) {
		const candidate = `${base} ${number}`;
		if (!hasName(candidate)) return candidate;
	}
}

export function createScene(name = "SCENE 01", existing = []) {
	return { id: uniqueId(existing), name: uniqueName(name, existing), objects: [], shotDocument: null };
}

export function addScene(scenes, name = "SCENE 01") {
	const list = Array.isArray(scenes) ? scenes : [];
	return [...list, createScene(name, list)];
}

export function duplicateScene(scenes, index) {
	if (!Array.isArray(scenes) || index < 0 || index >= scenes.length) return scenes;
	const source = scenes[index];
	const duplicate = createScene(source.name, scenes);
	duplicate.objects = cloneValue(source.objects);
	duplicate.shotDocument = cloneValue(source.shotDocument);
	return [...scenes.slice(0, index + 1), duplicate, ...scenes.slice(index + 1)];
}

export function renameScene(scenes, index, name) {
	if (!Array.isArray(scenes) || index < 0 || index >= scenes.length || typeof name !== "string" || !name.trim()) return scenes;
	const others = scenes.filter((_, sceneIndex) => sceneIndex !== index);
	const nextName = uniqueName(name, others);
	if (nextName === scenes[index].name) return scenes;
	return scenes.map((scene, sceneIndex) => sceneIndex === index ? { ...scene, name: nextName } : scene);
}

export function removeScene(scenes, index) {
	if (!Array.isArray(scenes) || scenes.length <= 1 || index < 0 || index >= scenes.length) return scenes;
	return scenes.filter((_, sceneIndex) => sceneIndex !== index);
}

export function activeSceneIndex(scenes, activeSceneId) {
	if (!Array.isArray(scenes) || !scenes.length) return -1;
	const index = scenes.findIndex((scene) => scene.id === activeSceneId);
	return index < 0 ? 0 : index;
}

export function activeScene(scenes, activeSceneId) {
	const index = activeSceneIndex(scenes, activeSceneId);
	return index < 0 ? null : scenes[index];
}

export function createSceneDocument() {
	const scene = createScene();
	return { version: SCENES_VERSION, activeSceneId: scene.id, scenes: [scene] };
}

function repairScene(record, existing, fallbackNumber) {
	if (!plainObject(record) || typeof record.id !== "string" || !record.id || !Array.isArray(record.objects)) return null;
	if (existing.some((scene) => scene.id === record.id)) return null;
	return {
		id: record.id,
		name: uniqueName(typeof record.name === "string" ? record.name : `SCENE ${String(fallbackNumber).padStart(2, "0")}`, existing),
		objects: record.objects.filter(plainObject).map((object) => cloneValue(object)),
		shotDocument: cloneValue(record.shotDocument ?? null),
	};
}

function repairDocument(payload) {
	const scenes = [];
	let dropped = 0;
	for (const record of payload.scenes) {
		const scene = repairScene(record, scenes, scenes.length + 1);
		if (scene) scenes.push(scene);
		else dropped += 1;
	}
	if (!scenes.length) scenes.push(createScene());
	const index = activeSceneIndex(scenes, payload.activeSceneId);
	return { document: { version: SCENES_VERSION, activeSceneId: scenes[index].id, scenes }, dropped };
}

function parse(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/** Tagged, side-effect-free reader. The caller decides when quarantine bytes
 * are written; future payloads are deliberately returned without a document. */
export function readSceneDocument(raw, legacyRaw = null) {
	if (raw === null || raw === undefined || raw === "") {
		if (legacyRaw !== null && legacyRaw !== undefined && legacyRaw !== "") {
			const legacy = parse(legacyRaw);
			if (!plainObject(legacy) || legacy.version !== 1 || !Array.isArray(legacy.objects)) {
				return { status: "corrupt", document: createSceneDocument(), dropped: 0, quarantineRaw: legacyRaw };
			}
			const document = createSceneDocument();
			document.scenes[0].objects = legacy.objects.filter(plainObject).map((object) => cloneValue(object));
			return { status: "migrated", document, dropped: legacy.objects.length - document.scenes[0].objects.length };
		}
		return { status: "absent", document: createSceneDocument(), dropped: 0 };
	}

	const payload = parse(raw);
	if (!plainObject(payload) || !Number.isInteger(payload.version) || payload.version < 1) {
		return { status: "corrupt", document: createSceneDocument(), dropped: 0, quarantineRaw: raw };
	}
	if (payload.version > SCENES_VERSION) return { status: "future", document: null, dropped: 0 };
	if (!Array.isArray(payload.scenes)) {
		return { status: "corrupt", document: createSceneDocument(), dropped: 0, quarantineRaw: raw };
	}
	const repaired = repairDocument(payload);
	return { status: "valid", ...repaired };
}

export function serializeSceneDocument(document) {
	return JSON.stringify({ version: SCENES_VERSION, activeSceneId: document.activeSceneId, scenes: document.scenes });
}

/** Storage adapter: quarantine corrupt bytes, persist successful migration,
 * and never write over a future document. The legacy key remains as a backup. */
export function loadSceneDocumentFromStorage(storage) {
	const raw = storage.getItem(SCENES_STORAGE_KEY);
	const legacyRaw = raw ? null : storage.getItem(LEGACY_SCENE_STORAGE_KEY);
	const result = readSceneDocument(raw, legacyRaw);
	if (result.status === "corrupt" && result.quarantineRaw !== undefined) {
		storage.setItem(SCENES_QUARANTINE_KEY, result.quarantineRaw);
	}
	if (result.status === "migrated") {
		storage.setItem(SCENES_STORAGE_KEY, serializeSceneDocument(result.document));
	}
	return result;
}
