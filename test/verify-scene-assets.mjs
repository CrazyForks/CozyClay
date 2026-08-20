#!/usr/bin/env node
import { webcrypto } from "node:crypto";
import {
	ASSET_ID_PREFIX,
	ASSET_MAX_DIMENSION,
	assetAspect,
	assetIdForBytes,
	assetIdFromDigest,
	downscaleTarget,
	imageFilesFrom,
	imageFilesFromClipboard,
	importImageFile,
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
expect("a derived record preserves its storage role", normalizeAsset({ ...record, role: "derived" }).role === "derived");
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

const rendered = `${ASSET_ID_PREFIX}${"a".repeat(32)}`;
const orphan = `${ASSET_ID_PREFIX}${"b".repeat(32)}`;
const source = `${ASSET_ID_PREFIX}${"c".repeat(32)}`;
const matte = `${ASSET_ID_PREFIX}${"d".repeat(32)}`;
const secondSceneAsset = `${ASSET_ID_PREFIX}${"e".repeat(32)}`;
const scenes = [
	{
		objects: [
			{ id: "cube", renderer: "cube" },
			{ id: "matted-cutout", renderer: "cutout", assetId: rendered, sourceAssetId: source, matteAssetId: matte },
			{ id: "duplicated-matted-cutout", renderer: "cutout", assetId: rendered, sourceAssetId: source, matteAssetId: matte },
			{ id: "source-only-cutout", renderer: "cutout", assetId: id, sourceAssetId: id, matteAssetId: "" },
		],
	},
	{ objects: [{ id: "second-scene-cutout", renderer: "cutout", assetId: secondSceneAsset, sourceAssetId: secondSceneAsset, matteAssetId: "" }] },
];
const reachable = referencedAssetIds(scenes);
expect(
	"a matted cutout keeps its rendered picture, source and matte reachable",
	reachable.has(rendered) && reachable.has(source) && reachable.has(matte),
);
expect("a source-only cutout has no phantom references", reachable.has(id) && !reachable.has(""));
expect("duplicated matted cutouts count their shared id trio once", reachable.size === 5);
expect("an asset in a second scene is reachable", reachable.has(secondSceneAsset));
expect("a malformed document is empty, not fatal", referencedAssetIds(null).size === 0 && referencedAssetIds([{ objects: "no" }, null]).size === 0);
expect(
	"only truly unreferenced ids are swept",
	JSON.stringify(unreachableAssetIds([id, rendered, source, matte, secondSceneAsset, orphan], scenes)) === JSON.stringify([orphan]),
);
expect(
	"a picture shared by two scenes is never swept",
	unreachableAssetIds([secondSceneAsset], scenes).length === 0 && unreachableAssetIds([rendered], [scenes[0]]).length === 0,
);
expect("a junk stored key is not mistaken for an asset", JSON.stringify(unreachableAssetIds(["junk", orphan], scenes)) === JSON.stringify([orphan]));

/* ------------------------------------------------------------ import ---- */

// Stubs for the three browser APIs the import path needs. `drawn` records what
// the resize actually asked for, so the test can prove the cap was applied.
const drawn = [];
function fakeFile(name, type, bytes, size = bytes.byteLength) {
	return { name, type, size, arrayBuffer: async () => bytes.buffer.slice(0) };
}
function stubs(bitmapWidth, bitmapHeight) {
	let closed = false;
	return {
		subtle: webcrypto.subtle,
		createBitmap: async () => ({ width: bitmapWidth, height: bitmapHeight, close: () => { closed = true; } }),
		makeCanvas: (width, height) => ({
			getContext: () => ({ drawImage: (_bitmap, x, y, w, h) => drawn.push({ x, y, w, h }) }),
			convertToBlob: async ({ type }) => ({ type, arrayBuffer: async () => new Uint8Array([width & 0xff, height & 0xff, 7]).buffer }),
		}),
		wasClosed: () => closed,
	};
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
const smallImport = await importImageFile(fakeFile("sofa.png", "image/png", png), stubs(1200, 800));
expect(
	"a picture inside the cap is stored as it arrived",
	smallImport.width === 1200 && smallImport.height === 800 && smallImport.type === "image/png" && smallImport.name === "sofa.png",
	JSON.stringify({ ...smallImport, bytes: smallImport.bytes.byteLength }),
);
expect("an unscaled import is identified by its own bytes", smallImport.id === (await assetIdForBytes(png, webcrypto.subtle)));
expect("nothing is re-encoded when nothing is resized", drawn.length === 0);
expect("the imported aspect is the card's aspect", assetAspect(smallImport) === 1.5);

const bigStubs = stubs(7296, 5472);
const bigImport = await importImageFile(fakeFile("wall.png", "image/png", png, 12 * 1024 * 1024), bigStubs);
expect(
	"an oversized picture is capped before it is stored",
	bigImport.width === ASSET_MAX_DIMENSION && bigImport.height === 1536 && drawn.at(-1).w === ASSET_MAX_DIMENSION,
	JSON.stringify({ width: bigImport.width, height: bigImport.height, drawn: drawn.at(-1) }),
);
expect("a resized import is identified by its stored bytes, not its source", bigImport.id !== smallImport.id);
expect("the decoded bitmap is released", bigStubs.wasClosed());
expect(
	"a resized picture keeps a format that can carry alpha",
	bigImport.type === "image/png" && (await importImageFile(fakeFile("photo.jpg", "image/jpeg", png, 12 * 1024 * 1024), stubs(6000, 4000))).type === "image/jpeg",
);

const refuses = async (name, file, options, pattern) => {
	try {
		await importImageFile(file, options);
		expect(name, false, "resolved instead of throwing");
	} catch (error) {
		expect(name, pattern.test(error.message), error.message);
	}
};
await refuses("a non-image is refused with a readable reason", fakeFile("notes.pdf", "application/pdf", png), stubs(10, 10), /not an image/);
await refuses("an svg is refused with the rest", fakeFile("logo.svg", "image/svg+xml", png), stubs(10, 10), /not an image/);
await refuses(
	"a file past the source ceiling is refused before it is decoded",
	fakeFile("huge.png", "image/png", png, 64 * 1024 * 1024),
	stubs(10, 10),
	/larger than 32 MB/,
);
await refuses("a file-shaped nothing is refused", null, stubs(10, 10), /File or Blob/);
await refuses(
	"an undecodable picture is refused",
	fakeFile("broken.png", "image/png", png),
	{ ...stubs(0, 0), createBitmap: async () => ({ width: 0, height: 0 }) },
	/no usable size/,
);

/* -------------------------------------------------------------- a drop -- */

const dropped = (files) => imageFilesFrom({ files });
const named = (name, type) => ({ name, type });
expect(
	"the images in a drop come back in order",
	JSON.stringify(dropped([named("a.png", "image/png"), named("b.webp", "image/webp")]).map((f) => f.name)) === '["a.png","b.webp"]',
);
expect(
	"a file with no MIME falls back to its extension",
	dropped([named("Sofa.PNG", ""), named("shot.jpeg", "")]).length === 2,
);
expect(
	"documents, folders and text are left where they are",
	dropped([named("notes.pdf", "application/pdf"), named("logo.svg", "image/svg+xml"), named("Untitled Folder", ""), named("", "")]).length === 0,
);
expect("a drop with nothing in it is not fatal", dropped([]).length === 0 && imageFilesFrom(null).length === 0 && imageFilesFrom({}).length === 0);

/* ------------------------------------------------------ clipboard --- */
// "Copy image" in a browser puts BYTES on the clipboard, which is the only way
// a picture from the web can reach the matte: dragging one hands over a
// cross-origin URL whose pixels a canvas may never read back.

const clipboardItem = (type, file) => ({ kind: "file", type, getAsFile: () => file });
const clipPng = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });

const pasted = imageFilesFromClipboard({ items: [clipboardItem("image/png", clipPng)] });
expect("a pasted picture is imported", pasted.length === 1, JSON.stringify(pasted.map((f) => f.type)));
expect("the generic clipboard name is replaced", pasted[0].name !== "image.png" && /^pasted-/.test(pasted[0].name), pasted[0].name);
expect("the pasted bytes survive", pasted[0].type === "image/png" && pasted[0].size === 3);

const clipNamed = new File([new Uint8Array([1])], "sofa.png", { type: "image/png" });
expect(
  "a real filename is kept",
  imageFilesFromClipboard({ items: [clipboardItem("image/png", clipNamed)] })[0].name === "sofa.png",
);

expect("pasted text is ignored", imageFilesFromClipboard({ items: [{ kind: "string", type: "text/plain" }] }).length === 0);
expect(
  "an unsupported image type is refused",
  imageFilesFromClipboard({ items: [clipboardItem("image/svg+xml", new File([""], "a.svg", { type: "image/svg+xml" }))] }).length === 0,
);
expect("an empty clipboard yields nothing", imageFilesFromClipboard({}).length === 0);
expect("a clipboard exposing only files still works", imageFilesFromClipboard({ files: [clipPng] }).length === 1);


if (failures) process.exit(1);
console.log("all scene asset checks PASS");
