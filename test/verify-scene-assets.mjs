#!/usr/bin/env node
import { webcrypto } from "node:crypto";
import {
	ASSET_ID_PREFIX,
	ASSET_MAX_DIMENSION,
	assetAspect,
	assetIdForBytes,
	assetIdFromDigest,
	downscaleTarget,
	isAssetId,
	isSupportedImageType,
	normalizeAsset,
	referencedAssetIds,
	unreachableAssetIds,
} from "../src/scene-assets.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

/* ------------------------------------------------------------- ids ---- */

const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const id = await assetIdForBytes(bytes, webcrypto.subtle);
const again = await assetIdForBytes(bytes.slice(), webcrypto.subtle);
expect("the same bytes always get the same id", id === again && isAssetId(id), `${id} vs ${again}`);
expect(
	"different bytes get a different id",
	(await assetIdForBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 5]), webcrypto.subtle)) !== id,
);
expect("an id is prefixed and hex", id.startsWith(ASSET_ID_PREFIX) && /^[0-9a-f]{32}$/.test(id.slice(ASSET_ID_PREFIX.length)));
expect("an ArrayBuffer and its view agree", (await assetIdForBytes(bytes.buffer, webcrypto.subtle)) === id);
expect(
	"a digest becomes an id, case and whitespace tolerated",
	assetIdFromDigest("  ABCDEF0123456789ABCDEF0123456789ABCDEF  ") === `${ASSET_ID_PREFIX}abcdef0123456789abcdef0123456789`,
);
expect(
	"a short or non-hex digest is not an id",
	assetIdFromDigest("abc") === null && assetIdFromDigest("zzzz0123456789abcdef0123456789ab") === null && assetIdFromDigest(null) === null,
);
expect(
	"only a well-formed id passes isAssetId",
	!isAssetId("") && !isAssetId("img-nope") && !isAssetId(`${ASSET_ID_PREFIX}abcdef`) && !isAssetId(null),
);
await assetIdForBytes(bytes, { digest: null }).then(
	() => expect("a missing SubtleCrypto is a clear failure", false, "resolved instead of throwing"),
	(error) => expect("a missing SubtleCrypto is a clear failure", /secure context/.test(error.message), error.message),
);

/* ------------------------------------------------------------ types ---- */

expect("the image types an import accepts", isSupportedImageType("image/png") && isSupportedImageType("IMAGE/WEBP") && isSupportedImageType("image/jpeg"));
expect("svg and non-images are refused", !isSupportedImageType("image/svg+xml") && !isSupportedImageType("application/pdf") && !isSupportedImageType(""));

/* -------------------------------------------------------- downscale ---- */

const small = downscaleTarget(800, 600);
expect("a picture inside the cap is stored untouched", small.width === 800 && small.height === 600 && small.scaled === false);
const big = downscaleTarget(7296, 5472);
expect(
	"the longest edge is capped and the aspect kept",
	big.width === ASSET_MAX_DIMENSION && big.height === 1536 && big.scaled === true,
	JSON.stringify(big),
);
const portrait = downscaleTarget(3000, 6000);
expect("a portrait picture caps on its height", portrait.height === ASSET_MAX_DIMENSION && portrait.width === 1024);
expect("a degenerate edge still survives as one pixel", downscaleTarget(8192, 1).height === 1 && downscaleTarget(4096, 3).height === 2);
expect("a zero or nonsense size has no target", downscaleTarget(0, 100) === null && downscaleTarget(100, Number.NaN) === null);
expect("the cap never enlarges", downscaleTarget(10, 10, 2048).scaled === false);

/* ------------------------------------------------------------ records ---- */

const record = { id, type: "image/png", width: 1200, height: 800, bytes: bytes.buffer, name: "sofa.png" };
const asset = normalizeAsset(record);
expect("a well-formed record survives repair", asset.id === id && asset.width === 1200 && asset.name === "sofa.png");
expect("the aspect comes from the stored size", assetAspect(asset) === 1.5 && assetAspect({ width: 0, height: 4 }) === null);
expect(
	"a record with no drawable bytes is dropped",
	normalizeAsset({ ...record, bytes: null }) === null && normalizeAsset({ ...record, bytes: new ArrayBuffer(0) }) === null,
);
expect(
	"a record with an unusable size is dropped",
	normalizeAsset({ ...record, width: 0 }) === null && normalizeAsset({ ...record, height: -4 }) === null && normalizeAsset({ ...record, width: "wide" }) === null,
);
expect("a record with a foreign id or type is dropped", normalizeAsset({ ...record, id: "sofa" }) === null && normalizeAsset({ ...record, type: "image/svg+xml" }) === null);
expect("a non-record is dropped, not fatal", normalizeAsset(null) === null && normalizeAsset([record]) === null && normalizeAsset("id") === null);

/* ------------------------------------------------------ reachability ---- */

const other = `${ASSET_ID_PREFIX}${"a".repeat(32)}`;
const orphan = `${ASSET_ID_PREFIX}${"b".repeat(32)}`;
const scenes = [
	{ objects: [{ id: "cube", renderer: "cube" }, { id: "cutout", renderer: "cutout", assetId: id }] },
	{ objects: [{ id: "cutout", renderer: "cutout", assetId: other }, { id: "cutout-2", renderer: "cutout", assetId: id }] },
];
const reachable = referencedAssetIds(scenes);
expect("every scene's cutouts are reachable, counted once", reachable.size === 2 && reachable.has(id) && reachable.has(other));
expect("a malformed document is empty, not fatal", referencedAssetIds(null).size === 0 && referencedAssetIds([{ objects: "no" }, null]).size === 0);
expect(
	"only unreferenced ids are swept",
	JSON.stringify(unreachableAssetIds([id, other, orphan], scenes)) === JSON.stringify([orphan]),
);
expect(
	"a picture shared by two scenes is never swept",
	unreachableAssetIds([id], scenes).length === 0 && unreachableAssetIds([other], [scenes[1]]).length === 0,
);
expect("a junk stored key is not mistaken for an asset", JSON.stringify(unreachableAssetIds(["junk", orphan], scenes)) === JSON.stringify([orphan]));

if (failures) process.exit(1);
console.log("all scene asset checks PASS");
