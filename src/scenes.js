// Pure multi-scene document model. No three.js, no React.
// A Scene is the set; shotDocument and stage are sealed department envelopes.
// This module stores and copies those envelopes but never opens or validates them.

export const SCENES_VERSION = 3;
export const SCENES_STORAGE_KEY = "cozyclay.scenes.v3";
export const SCENES_QUARANTINE_KEY = "cozyclay.scenes.v3.quarantine";
export const PREVIOUS_SCENES_STORAGE_KEY = "cozyclay.scenes.v2";
export const V1_SCENES_STORAGE_KEY = "cozyclay.scenes.v1";
export const LEGACY_SCENE_STORAGE_KEY = "cozyclay.scene.v1";

/** Rigged character models shipped in public/models. The id is both the FBX
 * file stem and the wire `source.rig` value sent to ARDY. */
export const CHARACTER_MODEL_IDS = Object.freeze(["y-bot-tpose", "x-bot-tpose"]);
export const DEFAULT_CHARACTER_MODEL = "y-bot-tpose";
export const DEFAULT_SUBJECT_ONE = "a young woman in a tan coat";
export const DEFAULT_SUBJECT_TWO = "a man in a dark coat";

export const DEFAULT_SCENE_STAGE = Object.freeze({
	characters: Object.freeze([
		Object.freeze({ id: "char-a", model: DEFAULT_CHARACTER_MODEL, x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: DEFAULT_SUBJECT_ONE }),
	]),
	hasCharSheet: false,
	shotAspect: "16:9",
});

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

const finiteOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);

/** One character entry in the stage envelope. `source` may be a v3 entry, a
 * partial (spawn dialog), or null — every field falls back to a sane default
 * and every object is freshly owned by the caller. */
export function createCharacterEntry(source = null, index = 0) {
	const s = plainObject(source) ? source : {};
	return {
		id: typeof s.id === "string" && s.id ? s.id : `char-${index + 1}`,
		model: CHARACTER_MODEL_IDS.includes(s.model) ? s.model : DEFAULT_CHARACTER_MODEL,
		x: finiteOr(s.x, 0),
		y: finiteOr(s.y, 0),
		z: finiteOr(s.z, 0),
		rot: finiteOr(s.rot, 0),
		hidden: s.hidden === true,
		// User-picked body tint; null means "model default" (y-bot clay, x-bot
		// whiter clay) so the entry survives future default tweaks.
		tint: typeof s.tint === "string" && /^#[0-9a-fA-F]{6}$/.test(s.tint) ? s.tint : null,
		pose: plainObject(s.pose) ? cloneValue(s.pose) : null,
		subject: typeof s.subject === "string" ? s.subject : index === 0 ? DEFAULT_SUBJECT_ONE : DEFAULT_SUBJECT_TWO,
		// The character's animation layer: its own root path and prompt-block
		// schedule. The generated clip itself is heavy, so only a lightweight
		// reference (bridge URL + generation params) is persisted — enough to
		// re-fetch and decode it on the next session.
		layer: normalizeLayer(s.layer),
		motionRef: normalizeMotionRef(s.motionRef),
	};
}

function normalizeMotionRef(ref) {
	if (!plainObject(ref) || typeof ref.url !== "string" || !ref.url) return null;
	return {
		url: ref.url,
		prompt: typeof ref.prompt === "string" ? ref.prompt : "",
		rotationDeg: Number.isFinite(ref.rotationDeg) ? ref.rotationDeg : 0,
		anchorX: Number.isFinite(ref.anchorX) ? ref.anchorX : 0,
		anchorZ: Number.isFinite(ref.anchorZ) ? ref.anchorZ : 0,
	};
}

function normalizeLayer(layer) {
	const source = plainObject(layer) ? layer : {};
	return {
		waypoints: Array.isArray(source.waypoints) ? cloneValue(source.waypoints) : [],
		promptClips: Array.isArray(source.promptClips) ? cloneValue(source.promptClips) : [],
	};
}

export function createCharacterLayer() {
	return { waypoints: [], promptClips: [] };
}

/** Stage envelopes before v3 stored a fixed cast (charA/charB/showB/poseA/
 * poseB/subject/subject2). Fold that cast into the characters list so the
 * rest of the app only ever sees one shape. */
function migrateLegacyCast(source) {
	const cast = [createCharacterEntry({ ...plainObject(source.charA) ? source.charA : {}, id: "char-a", pose: source.poseA ?? null, subject: source.subject ?? DEFAULT_SUBJECT_ONE }, 0)];
	if (source.showB === true) {
		cast.push(createCharacterEntry({ ...plainObject(source.charB) ? source.charB : {}, id: "char-b", pose: source.poseB ?? null, subject: source.subject2 ?? DEFAULT_SUBJECT_TWO }, 1));
	}
	return cast;
}

const STAGE_ENVELOPE_KEYS = new Set([
	"characters", "hasCharSheet", "shotAspect",
	"charA", "charB", "showB", "poseA", "poseB", "subject", "subject2",
]);

export function createSceneStage(stage = null) {
	const source = plainObject(stage) ? stage : {};
	const characters = Array.isArray(source.characters) && source.characters.length
		? source.characters.map((entry, index) => createCharacterEntry(entry, index))
		: migrateLegacyCast(source);
	// Unknown extra keys (shotAspect was one, once) ride along so the envelope
	// stays sealed-but-lossless; legacy cast keys are deliberately dropped.
	const extras = {};
	for (const [key, value] of Object.entries(source)) {
		if (!STAGE_ENVELOPE_KEYS.has(key)) extras[key] = cloneValue(value);
	}
	return {
		...extras,
		characters,
		hasCharSheet: source.hasCharSheet === true,
		shotAspect: ["16:9", "9:16", "1:1", "4:3"].includes(source.shotAspect)
			? source.shotAspect
			: DEFAULT_SCENE_STAGE.shotAspect,
	};
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
	return { id: uniqueId(existing), name: uniqueName(name, existing), objects: [], shotDocument: null, stage: createSceneStage() };
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
	duplicate.stage = createSceneStage(source.stage);
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

function repairScene(record, existing, fallbackNumber, fallbackStage) {
	if (!plainObject(record) || typeof record.id !== "string" || !record.id || !Array.isArray(record.objects)) return null;
	if (existing.some((scene) => scene.id === record.id)) return null;
	return {
		id: record.id,
		name: uniqueName(typeof record.name === "string" ? record.name : `SCENE ${String(fallbackNumber).padStart(2, "0")}`, existing),
		objects: record.objects.filter(plainObject).map((object) => cloneValue(object)),
		shotDocument: cloneValue(record.shotDocument ?? null),
		stage: cloneValue(plainObject(record.stage) ? record.stage : fallbackStage),
	};
}

function repairDocument(payload, fallbackStage = DEFAULT_SCENE_STAGE) {
	const scenes = [];
	let dropped = 0;
	for (const record of payload.scenes) {
		const scene = repairScene(record, scenes, scenes.length + 1, fallbackStage);
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
	const migrating = payload.version < SCENES_VERSION;
	const repaired = repairDocument(payload, createSceneStage(payload.stage));
	return { status: migrating ? "migrated" : "valid", ...repaired };
}

export function serializeSceneDocument(document) {
	return JSON.stringify({ version: SCENES_VERSION, activeSceneId: document.activeSceneId, scenes: document.scenes });
}

/** Storage adapter: quarantine corrupt bytes, persist successful migration,
 * and never write over a future document. The legacy key remains as a backup. */
export function loadSceneDocumentFromStorage(storage) {
	const currentRaw = storage.getItem(SCENES_STORAGE_KEY);
	const previousRaw = currentRaw ? null : storage.getItem(PREVIOUS_SCENES_STORAGE_KEY);
	const v1Raw = currentRaw || previousRaw ? null : storage.getItem(V1_SCENES_STORAGE_KEY);
	const raw = currentRaw || previousRaw || v1Raw;
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
