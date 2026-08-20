/**
 * Scene assets: the bytes an object points at.
 *
 * A cutout carries an `assetId`, never its picture. The scene document is one
 * JSON string in localStorage (`cozyclay.scenes.v2`), and a single base64 PNG
 * is bigger than the whole budget that string gets — so images live in
 * IndexedDB, keyed by an id the scene can hold on to.
 *
 * The id is derived from the bytes themselves (SHA-256), which buys three
 * things for free: the same picture imported twice is stored once, a
 * duplicated scene shares its originals instead of copying them, and an id is
 * meaningful across a reload, an export and another machine.
 *
 * Everything above the storage adapter is pure and testable in node; the
 * adapter is the only part that needs a browser.
 */

/** Content-addressed, so the same bytes always land on the same id. */
export const ASSET_ID_PREFIX = "img-";
/** 128 bits of a SHA-256 digest: collision-proof for a project's worth of
 * pictures, and short enough to read in a scene file. */
const ASSET_ID_HEX = 32;

export const ASSET_DB_NAME = "cozyclay.assets";
export const ASSET_DB_VERSION = 1;
export const ASSET_STORE_NAME = "images";

/** What an import will accept. SVG is excluded on purpose: it is a document
 * that can carry script, and a set piece is not worth that. */
export const ASSET_IMAGE_TYPES = Object.freeze(["image/png", "image/webp", "image/jpeg", "image/gif"]);
/** Source-file ceiling. A 40 MP phone photo is fine as an INPUT — it gets
 * decoded and downscaled before anything is stored — but the file itself has
 * to be readable in one bite first. */
export const ASSET_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
/** Longest edge kept. A card is a staging surface, not a texture for a hero
 * render, and 2048 is the size every WebGL implementation can hold. */
export const ASSET_MAX_DIMENSION = 2048;

export function isSupportedImageType(type) {
	return typeof type === "string" && ASSET_IMAGE_TYPES.includes(type.toLowerCase());
}

/** An id from a hex digest, tolerant of the caller's case and length. */
export function assetIdFromDigest(hex) {
	if (typeof hex !== "string") return null;
	const clean = hex.trim().toLowerCase();
	if (!/^[0-9a-f]+$/.test(clean) || clean.length < ASSET_ID_HEX) return null;
	return `${ASSET_ID_PREFIX}${clean.slice(0, ASSET_ID_HEX)}`;
}

export function isAssetId(value) {
	return typeof value === "string" && new RegExp(`^${ASSET_ID_PREFIX}[0-9a-f]{${ASSET_ID_HEX}}$`).test(value);
}

/**
 * The id these bytes will be stored under. `subtle` is injectable so the node
 * tests can hand in `crypto.webcrypto.subtle`; in the browser it is the page's
 * own SubtleCrypto, which needs a secure context (localhost counts).
 */
export async function assetIdForBytes(bytes, subtle = globalThis.crypto?.subtle) {
	if (!subtle?.digest) throw new Error("SubtleCrypto is unavailable — a secure context is required to import images");
	const buffer = bytes instanceof ArrayBuffer ? bytes : bytes?.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : null;
	if (!buffer) throw new TypeError("assetIdForBytes needs an ArrayBuffer or a typed array");
	const digest = await subtle.digest("SHA-256", buffer);
	const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
	return assetIdFromDigest(hex);
}

/**
 * The stored size for a decoded image: the longest edge capped, aspect kept,
 * and never enlarged. Returns the source size unchanged (`scaled: false`) when
 * it already fits, so a small picture is stored exactly as it arrived.
 */
export function downscaleTarget(width, height, max = ASSET_MAX_DIMENSION) {
	const w = Math.max(0, Math.round(Number(width) || 0));
	const h = Math.max(0, Math.round(Number(height) || 0));
	if (!w || !h) return null;
	const longest = Math.max(w, h);
	if (longest <= max) return { width: w, height: h, scaled: false };
	const factor = max / longest;
	// Round to at least 1: a 4096 x 3 strip must not become 2048 x 0.
	return { width: Math.max(1, Math.round(w * factor)), height: Math.max(1, Math.round(h * factor)), scaled: true };
}

/** The card's width / height, from the picture the card wears. */
export function assetAspect(asset) {
	const width = Number(asset?.width);
	const height = Number(asset?.height);
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
	return width / height;
}

/**
 * Repair one stored asset record, or return null to drop it. Storage is never
 * trusted here either: a record without usable bytes or a usable size cannot
 * be drawn, and a card pointing at it is better shown as missing than as a
 * blank quad of the wrong shape.
 */
export function normalizeAsset(record) {
	if (!record || typeof record !== "object" || Array.isArray(record)) return null;
	if (!isAssetId(record.id)) return null;
	if (!isSupportedImageType(record.type)) return null;
	const width = Math.round(Number(record.width));
	const height = Math.round(Number(record.height));
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
	const bytes = record.bytes instanceof ArrayBuffer ? record.bytes : null;
	if (!bytes || !bytes.byteLength) return null;
	return { id: record.id, type: record.type.toLowerCase(), width, height, bytes, name: typeof record.name === "string" ? record.name : "" };
}

/**
 * The image files in a drop (or a paste), in the order they were dropped.
 *
 * Two quirks make this worth a function rather than a filter inline. A file
 * dragged from some applications arrives with an EMPTY type — the browser has
 * a name and bytes but no sniffed MIME — so the extension is the fallback, not
 * a shortcut. And a drag can carry directories and text as well as files, which
 * `files` reports as entries with no type and no extension; those are dropped
 * rather than handed to a decoder that will fail on them.
 */
export function imageFilesFrom(transfer) {
	const files = Array.from(transfer?.files ?? []);
	return files.filter((file) => {
		if (!file) return false;
		if (isSupportedImageType(file.type)) return true;
		if (file.type) return false;
		const extension = String(file.name ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
		return ["png", "webp", "jpg", "jpeg", "gif"].includes(extension);
	});
}

/* ------------------------------------------------------------- import ---- */

/** Scaling a picture re-encodes it, and the encoder has to be one that can
 * still carry alpha — a cutout IS its transparency. JPEG has none to lose, so
 * a photo stays a photo instead of tripling in size as a PNG. */
function storedTypeFor(sourceType) {
	return sourceType === "image/jpeg" ? "image/jpeg" : "image/png";
}

function defaultCanvas(width, height) {
	if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
	throw new Error("this browser cannot resize images — OffscreenCanvas is unavailable");
}

/**
 * One imported file as a storable asset record: decoded, capped to
 * ASSET_MAX_DIMENSION, and identified by the bytes that will actually be
 * stored (so two imports of the same photo dedupe even after a resize).
 *
 * Every browser API it needs is injectable, which is what lets the node tests
 * drive the whole path with stubs. Failures throw with a sentence fit to show
 * in a toast — the caller has no way to explain "NotReadableError" to anyone.
 */
export async function importImageFile(file, {
	subtle = globalThis.crypto?.subtle,
	createBitmap = globalThis.createImageBitmap,
	makeCanvas = defaultCanvas,
	maxDimension = ASSET_MAX_DIMENSION,
	maxSourceBytes = ASSET_MAX_SOURCE_BYTES,
} = {}) {
	if (!file || typeof file.arrayBuffer !== "function") throw new TypeError("importImageFile needs a File or Blob");
	const sourceType = typeof file.type === "string" ? file.type.toLowerCase() : "";
	if (!isSupportedImageType(sourceType)) throw new Error("that file is not an image CozyClay can import (PNG, WebP, JPEG or GIF)");
	if (Number(file.size) > maxSourceBytes) throw new Error(`that image is larger than ${Math.round(maxSourceBytes / (1024 * 1024))} MB`);
	if (typeof createBitmap !== "function") throw new Error("this browser cannot decode images — createImageBitmap is unavailable");

	const bitmap = await createBitmap(file);
	try {
		const target = downscaleTarget(bitmap.width, bitmap.height, maxDimension);
		if (!target) throw new Error("that image has no usable size");
		let type = sourceType;
		let bytes;
		if (target.scaled) {
			const canvas = makeCanvas(target.width, target.height);
			const context = canvas.getContext("2d");
			if (!context) throw new Error("this browser cannot resize images — no 2D context");
			context.drawImage(bitmap, 0, 0, target.width, target.height);
			type = storedTypeFor(sourceType);
			const blob = await canvas.convertToBlob({ type });
			bytes = await blob.arrayBuffer();
		} else {
			// Unscaled, the original bytes are stored verbatim: no re-encode means
			// no generation loss, and an untouched PNG keeps its exact alpha.
			bytes = await file.arrayBuffer();
		}
		const asset = normalizeAsset({
			id: await assetIdForBytes(bytes, subtle),
			type,
			width: target.width,
			height: target.height,
			bytes,
			name: typeof file.name === "string" ? file.name : "",
		});
		if (!asset) throw new Error("that image could not be prepared for the set");
		return asset;
	} finally {
		bitmap?.close?.();
	}
}

/* ------------------------------------------------------- reachability ---- */

/**
 * Every asset id the scenes still point at. Assets outlive the object that
 * imported them — undo brings a deleted cutout back, and two scenes can wear
 * the same picture — so nothing is deleted on the strength of one object
 * going away. This is the reachable set; `unreachableAssetIds` is the sweep.
 */
export function referencedAssetIds(scenes) {
	const ids = new Set();
	for (const scene of Array.isArray(scenes) ? scenes : []) {
		for (const object of Array.isArray(scene?.objects) ? scene.objects : []) {
			if (isAssetId(object?.assetId)) ids.add(object.assetId);
		}
	}
	return ids;
}

/** Stored ids that nothing points at any more, ready to be swept. */
export function unreachableAssetIds(storedIds, scenes) {
	const reachable = referencedAssetIds(scenes);
	return (Array.isArray(storedIds) ? storedIds : []).filter((id) => isAssetId(id) && !reachable.has(id));
}

/* ------------------------------------------------------------ storage ---- */

const request = (req) =>
	new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});

/** Open (and create) the asset database. Injectable factory so a test or a
 * non-browser host can hand in its own IndexedDB implementation. */
export function openAssetDb(factory = globalThis.indexedDB) {
	if (!factory) return Promise.reject(new Error("IndexedDB is unavailable"));
	return new Promise((resolve, reject) => {
		const open = factory.open(ASSET_DB_NAME, ASSET_DB_VERSION);
		open.onupgradeneeded = () => {
			if (!open.result.objectStoreNames.contains(ASSET_STORE_NAME)) {
				open.result.createObjectStore(ASSET_STORE_NAME, { keyPath: "id" });
			}
		};
		open.onsuccess = () => resolve(open.result);
		open.onerror = () => reject(open.error);
		open.onblocked = () => reject(new Error("the asset database is blocked by another tab"));
	});
}

/** Store a record. Content-addressed ids make this idempotent: re-importing
 * the same picture overwrites it with identical bytes. */
export async function putAsset(db, record) {
	const asset = normalizeAsset(record);
	if (!asset) throw new TypeError("putAsset needs a normalizable asset record");
	const tx = db.transaction(ASSET_STORE_NAME, "readwrite");
	tx.objectStore(ASSET_STORE_NAME).put(asset);
	await new Promise((resolve, reject) => {
		tx.oncomplete = resolve;
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
	return asset;
}

export async function getAsset(db, id) {
	if (!isAssetId(id)) return null;
	const tx = db.transaction(ASSET_STORE_NAME, "readonly");
	return normalizeAsset(await request(tx.objectStore(ASSET_STORE_NAME).get(id)));
}

export async function listAssetIds(db) {
	const tx = db.transaction(ASSET_STORE_NAME, "readonly");
	const keys = await request(tx.objectStore(ASSET_STORE_NAME).getAllKeys());
	return (keys ?? []).filter(isAssetId);
}

export async function deleteAsset(db, id) {
	if (!isAssetId(id)) return false;
	const tx = db.transaction(ASSET_STORE_NAME, "readwrite");
	tx.objectStore(ASSET_STORE_NAME).delete(id);
	await new Promise((resolve, reject) => {
		tx.oncomplete = resolve;
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
	return true;
}
