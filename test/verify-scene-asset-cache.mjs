#!/usr/bin/env node
import assert from "node:assert/strict";
import { createAssetTextureCache } from "../src/scene-asset-cache.js";

const id = `img-${"a".repeat(32)}`;
const record = { id, type: "image/png", width: 1, height: 1, bytes: new Uint8Array([1]).buffer, name: "race.png" };

const bitmapResolvers = [];
let bitmapStarts = 0;
const textures = [];
const cache = createAssetTextureCache({
	getRecord: async () => record,
	putRecord: async (asset) => asset,
	createBitmap: async () => {
		bitmapStarts += 1;
		return new Promise((resolve) => bitmapResolvers.push(resolve));
	},
	makeTexture: (bitmap) => {
		const texture = {
			image: bitmap,
			userData: {},
			disposed: false,
			dispose() { this.disposed = true; },
		};
		textures.push(texture);
		return texture;
	},
});

const updates = [];
const unsubscribe = cache.subscribeToAssetTexture(id, (texture) => updates.push(texture));
const inFlight = cache.loadAssetTexture(id);
await new Promise((resolve) => queueMicrotask(resolve));
assert.equal(bitmapStarts, 1, "the first decode reaches the deterministic bitmap seam");

cache.evictAssetTexture(id);
assert.deepEqual(updates, [null], "eviction immediately tells mounted subscribers their texture is gone");
bitmapResolvers.shift()({ close() {} });
assert.equal(await inFlight, null, "an invalidated decode cannot install a stale texture");
assert.equal(textures[0].disposed, true, "a late texture is disposed instead of leaked or announced");
assert.deepEqual(updates, [null], "a late decode sends no stale subscriber update");

const restore = cache.rememberAsset(record);
await new Promise((resolve) => queueMicrotask(resolve));
assert.equal(bitmapStarts, 2, "undo creates a fresh decode after eviction");
bitmapResolvers.shift()({ close() {} });
await restore;
assert.equal(updates.length, 2, "undo reannounces to the still-mounted subscriber");
assert.equal(updates.at(-1), textures[1], "undo announces the newly decoded texture, never deleted bytes");
unsubscribe();

console.log("scene asset cache generation race checks PASS");
