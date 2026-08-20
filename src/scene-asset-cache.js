/**
 * The bridge between stored asset bytes and a texture the set can wear.
 *
 * A cutout record holds an `assetId` and nothing else, so something has to
 * turn that id into a THREE.Texture exactly once per session: the same picture
 * on two cards, or on cards in two scenes, is one decode and one upload.
 *
 * Loading is async and the renderer is not, so `useAssetTexture` (props.jsx)
 * subscribes and re-renders when the texture lands. A card with no texture yet
 * draws as a blank placeholder rather than popping into existence — the
 * geometry is already correct, and that is what blocking needs first.
 */

import * as THREE from "three";
import { getAsset, openAssetDb, putAsset } from "./scene-assets.js";

/** id → { texture, promise, listeners } */
const entries = new Map();
let dbPromise = null;

function db() {
	if (!dbPromise) dbPromise = openAssetDb();
	return dbPromise;
}

function entryFor(id) {
	let entry = entries.get(id);
	if (!entry) {
		entry = { texture: null, record: null, promise: null, listeners: new Set() };
		entries.set(id, entry);
	}
	return entry;
}

function announce(entry) {
	for (const listener of entry.listeners) listener(entry.texture);
}

/**
 * A texture from asset bytes. ImageBitmap ignores `Texture.flipY`, so the flip
 * is asked of the decoder instead — without it every cutout hangs upside down.
 */
async function textureFromAsset(asset) {
	const bitmap = await createImageBitmap(new Blob([asset.bytes], { type: asset.type }), { imageOrientation: "flipY" });
	const texture = new THREE.Texture(bitmap);
	texture.flipY = false;
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.generateMipmaps = true;
	texture.minFilter = THREE.LinearMipmapLinearFilter;
	texture.magFilter = THREE.LinearFilter;
	// A card is nearly always seen at an angle; without anisotropy the picture
	// smears the moment the camera is off its normal.
	texture.anisotropy = 4;
	texture.needsUpdate = true;
	texture.userData.assetId = asset.id;
	return texture;
}

/** The texture for this id, decoded once and shared. Null when the asset is
 * gone — a scene can outlive its pictures (another browser, cleared storage),
 * and a missing picture must not take the studio down with it. */
export function loadAssetTexture(id) {
	if (typeof id !== "string" || !id) return Promise.resolve(null);
	const entry = entryFor(id);
	if (entry.texture) return Promise.resolve(entry.texture);
	if (!entry.promise) {
		entry.promise = (async () => {
			const asset = entry.record ?? (await getAsset(await db(), id));
			if (!asset) return null;
			entry.record = asset;
			entry.texture = await textureFromAsset(asset);
			announce(entry);
			return entry.texture;
		})().catch((error) => {
			console.warn(`[cozyclay] could not load image asset ${id}`, error);
			return null;
		});
	}
	return entry.promise;
}

/** The stored record behind an id — the bytes, not the texture. Editing a
 * picture (cutting its background out) needs the source it started from. */
export async function assetRecord(id) {
	if (typeof id !== "string" || !id) return null;
	const entry = entryFor(id);
	if (entry.record) return entry.record;
	entry.record = await getAsset(await db(), id);
	return entry.record;
}

/** Warm the cache with an asset that is already in hand. An import has the
 * decoded bytes right there; going back to IndexedDB for them would decode the
 * same picture twice and delay the card by a frame or two. */
export async function rememberAsset(asset) {
	const stored = await putAsset(await db(), asset);
	const entry = entryFor(stored.id);
	entry.record = stored;
	entry.texture?.dispose();
	entry.texture = await textureFromAsset(stored);
	entry.promise = Promise.resolve(entry.texture);
	announce(entry);
	return stored;
}

/** Forget a deleted asset so undo cannot render stale in-memory bytes. */
export function evictAssetTexture(id) {
	const entry = entries.get(id);
	if (!entry) return;
	entry.texture?.image?.close?.();
	entry.texture?.dispose();
	entry.texture = null;
	announce(entry);
	entries.delete(id);
}

/** Subscribe to one id; returns an unsubscribe. The listener fires
 * immediately when the texture is already cached, so a mount never waits a
 * frame for something that is in memory. */
export function subscribeToAssetTexture(id, listener) {
	if (typeof id !== "string" || !id) return () => {};
	const entry = entryFor(id);
	entry.listeners.add(listener);
	if (entry.texture) listener(entry.texture);
	else loadAssetTexture(id);
	return () => entry.listeners.delete(listener);
}

/** Drop everything (a test harness, or a hard document reload). */
export function clearAssetTextures() {
	for (const entry of entries.values()) {
		entry.texture?.image?.close?.();
		entry.texture?.dispose();
	}
	entries.clear();
}
