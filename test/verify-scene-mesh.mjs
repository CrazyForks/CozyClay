#!/usr/bin/env node
// GLB mesh-prop import: magic, POSITION bounds, the 0.05–10 m fit heuristic,
// drop splitting, and the mesh- vs img- id split. Fixtures are tiny cubes
// with accessor min/max so Node can measure them without three.js.
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import {
	ASSET_ID_PREFIX,
	ASSET_MAX_SOURCE_BYTES,
	ASSET_MESH_TYPES,
	MESH_ID_PREFIX,
	assetIdForBytes,
	isAssetId,
	isImageAssetId,
	isMeshAssetId,
	isSupportedMeshType,
	meshIdForBytes,
	normalizeAsset,
} from "../src/scene-assets.js";
import {
	MESH_DEFAULT_HEIGHT,
	MESH_HEIGHT_MAX,
	MESH_HEIGHT_MIN,
	fitMeshBounds,
	importMeshFile,
	isGlbMagic,
	meshFilesFrom,
	parseGlbBounds,
	compressedGlbReason,
	splitDroppedFiles,
} from "../src/scene-mesh.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

const EPS = 1e-4;
const approx = (value, expected, eps = EPS) => Number.isFinite(value) && Math.abs(value - expected) <= eps;
// importMeshFile nests a footprint; fitMeshBounds itself returns width/depth
// next to height. Read either spelling so the heuristic is what we pin.
function fittedBox(result) {
	if (!result || typeof result !== "object") return null;
	const width = Number(result.footprint?.width ?? result.width);
	const depth = Number(result.footprint?.depth ?? result.depth);
	const height = Number(result.height);
	if (![width, height, depth].every(Number.isFinite)) return null;
	return { width, height, depth };
}

const fixtureBytes = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const unitBytes = fixtureBytes("unit-cube.glb");
const giantBytes = fixtureBytes("giant-cube.glb");
const tinyBytes = fixtureBytes("tiny-cube.glb");
const glbFile = (bytes, name, type) => new File([bytes], name, { type });

const named = (name, type) => ({ name, type });
function padTo4(bytes, fill = 0x20) {
	const padding = (4 - (bytes.length % 4)) % 4;
	if (!padding) return bytes;
	const out = new Uint8Array(bytes.length + padding);
	out.set(bytes);
	out.fill(fill, bytes.length);
	return out;
}
function glbFromJson(json, jsonPad = 0x20) {
	const jsonBytes = padTo4(new TextEncoder().encode(JSON.stringify(json)), jsonPad);
	const total = 12 + 8 + jsonBytes.byteLength;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint32(0, 0x46546c67, true);
	view.setUint32(4, 2, true);
	view.setUint32(8, total, true);
	view.setUint32(12, jsonBytes.byteLength, true);
	view.setUint32(16, 0x4e4f534a, true);
	out.set(jsonBytes, 20);
	return out;
}
const measurableGlbJson = {
	asset: { version: "2.0" },
	meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
	accessors: [{ min: [0, 0, 0], max: [1, 1, 1], componentType: 5126, count: 8, type: "VEC3" }],
};
const box = (minY, maxY, halfXz) => ({
	min: { x: -halfXz, y: minY, z: -halfXz },
	max: { x: halfXz, y: maxY, z: halfXz },
});

/* ------------------------------------------------------------- magic ---- */

expect("the unit-cube fixture starts with the glTF magic", isGlbMagic(unitBytes) === true);
expect("ASCII glTF is the little-endian GLB magic", unitBytes[0] === 0x67 && unitBytes[1] === 0x6c && unitBytes[2] === 0x54 && unitBytes[3] === 0x46);
expect("PNG bytes are not a GLB", isGlbMagic(new Uint8Array([0x89, 0x50, 0x4e, 0x47])) === false);
expect("a short buffer is not a GLB", isGlbMagic(new Uint8Array([0x67, 0x6c, 0x54])) === false);
expect("empty bytes are not a GLB", isGlbMagic(new Uint8Array()) === false);

/* ------------------------------------------------------ parse bounds ---- */

const unitBounds = parseGlbBounds(unitBytes);
const unitHeight = unitBounds ? unitBounds.max.y - unitBounds.min.y : NaN;
const unitWidth = unitBounds ? unitBounds.max.x - unitBounds.min.x : NaN;
const unitDepth = unitBounds ? unitBounds.max.z - unitBounds.min.z : NaN;
expect(
	"the unit cube's POSITION box is 1 m tall, sitting on y = 0, 1 m across XZ",
	Boolean(unitBounds) && approx(unitHeight, 1) && approx(unitBounds.min.y, 0) && approx(unitWidth, 1) && approx(unitDepth, 1),
	JSON.stringify(unitBounds),
);

const giantBounds = parseGlbBounds(giantBytes);
const tinyBounds = parseGlbBounds(tinyBytes);
expect(
	"the parser still sees the giant cube as 50 m — fitting is import-only",
	Boolean(giantBounds) && approx(giantBounds.max.y - giantBounds.min.y, 50),
	JSON.stringify(giantBounds),
);
expect(
	"the parser still sees the tiny cube as 0.01 m — fitting is import-only",
	Boolean(tinyBounds) && approx(tinyBounds.max.y - tinyBounds.min.y, 0.01),
	JSON.stringify(tinyBounds),
);
expect("unreadable bytes have no box", parseGlbBounds(new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0, 0, 0, 0])) === null);

/* ------------------------------------------------------ fit heuristic ---- */
// Heights inside [0.05, 10] were already metres; everything else is an outlier
// (a centimetre export, a 90 m hall) and is scaled so the result is 1 m tall.
// Width and depth share that factor so the object's proportions survive.

expect("the fit window is 5 cm through 10 m, defaulting to 1 m", MESH_HEIGHT_MIN === 0.05 && MESH_HEIGHT_MAX === 10 && MESH_DEFAULT_HEIGHT === 1);

const inRange = fittedBox(fitMeshBounds(box(0, 0.9, 0.45)));
expect(
	"a 0.9 m height is left unchanged",
	Boolean(inRange) && approx(inRange.height, 0.9) && approx(inRange.width, 0.9) && approx(inRange.depth, 0.9),
	JSON.stringify(inRange),
);

const floor = fittedBox(fitMeshBounds(box(0, MESH_HEIGHT_MIN, 0.5)));
expect("the 5 cm floor is inclusive — no rescale", Boolean(floor) && approx(floor.height, MESH_HEIGHT_MIN), JSON.stringify(floor));
const ceiling = fittedBox(fitMeshBounds({ min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: MESH_HEIGHT_MAX, z: 3 } }));
expect(
	"the 10 m ceiling is inclusive — width and depth stay put",
	Boolean(ceiling) && approx(ceiling.height, MESH_HEIGHT_MAX) && approx(ceiling.width, 2) && approx(ceiling.depth, 3),
	JSON.stringify(ceiling),
);

const hall = fittedBox(fitMeshBounds(box(0, 90, 45)));
expect(
	"a 90 m height is scaled to 1 m, and the 90 m footprint with it",
	Boolean(hall) && approx(hall.height, 1) && approx(hall.width, 1) && approx(hall.depth, 1),
	JSON.stringify(hall),
);

const speck = fittedBox(fitMeshBounds(box(0, 0.01, 0.005)));
expect(
	"a 0.01 m height is scaled to 1 m, and the millimetre footprint with it",
	Boolean(speck) && approx(speck.height, 1) && approx(speck.width, 1) && approx(speck.depth, 1),
	JSON.stringify(speck),
);

expect(
	"a non-positive height cannot be fitted",
	fitMeshBounds(box(0, 0, 0.5)) === null &&
		fitMeshBounds(box(1, 0.5, 0.5)) === null &&
		fitMeshBounds({ min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: Number.NaN, z: 1 } }) === null,
);

/* ---------------------------------------------------------- import ---- */

const unitImport = await importMeshFile(glbFile(unitBytes, "unit-cube.glb", "model/gltf-binary"), webcrypto.subtle);
expect(
	"a unit cube imports as a mesh asset, 1 m tall, 1 m × 1 m on the floor",
	isMeshAssetId(unitImport.asset.id) &&
		unitImport.asset.type === "model/gltf-binary" &&
		approx(unitImport.height, 1) &&
		approx(unitImport.footprint.width, 1) &&
		approx(unitImport.footprint.depth, 1),
	JSON.stringify({ id: unitImport.asset?.id, type: unitImport.asset?.type, height: unitImport.height, footprint: unitImport.footprint }),
);
expect(
	"the imported record is normalizeAsset-ready without pixel size",
	normalizeAsset(unitImport.asset)?.id === unitImport.asset.id && unitImport.asset.bytes instanceof ArrayBuffer && unitImport.asset.bytes.byteLength > 0,
	JSON.stringify({ ...unitImport.asset, bytes: unitImport.asset?.bytes?.byteLength }),
);

const giantImport = await importMeshFile(glbFile(giantBytes, "giant-cube.glb", "model/gltf-binary"), webcrypto.subtle);
const tinyImport = await importMeshFile(glbFile(tinyBytes, "tiny-cube.glb", "model/gltf-binary"), webcrypto.subtle);
expect("a 50 m cube is fitted to 1 m on import", approx(giantImport.height, 1), String(giantImport.height));
expect("a 0.01 m cube is fitted to 1 m on import", approx(tinyImport.height, 1), String(tinyImport.height));

const octetImport = await importMeshFile(glbFile(unitBytes, "cooker.glb", "application/octet-stream"), webcrypto.subtle);
expect(
	"octet-stream plus a .glb name is still a mesh — browsers often omit the glTF MIME",
	isMeshAssetId(octetImport.asset.id) && approx(octetImport.height, 1) && octetImport.asset.name === "cooker.glb",
	JSON.stringify({ id: octetImport.asset?.id, name: octetImport.asset?.name, height: octetImport.height }),
);

const refuses = async (name, file, pattern) => {
	try {
		await importMeshFile(file, webcrypto.subtle);
		expect(name, false, "resolved instead of throwing");
	} catch (error) {
		expect(name, error instanceof Error && pattern.test(error.message), error.message);
	}
};
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
await refuses("PNG bytes are refused as not a GLB", glbFile(pngBytes, "photo.png", "image/png"), /not a GLB/i);
await refuses("plain text named .glb is refused as not a GLB", glbFile(new TextEncoder().encode("hello"), "hello.glb", "model/gltf-binary"), /not a GLB/i);
await refuses("a non-file is refused with a readable reason", null, /file/i);
await refuses(
	"a file past the source ceiling is refused before it is parsed",
	{ name: "huge.glb", type: "model/gltf-binary", size: 64 * 1024 * 1024, arrayBuffer: async () => unitBytes.buffer.slice(0) },
	/too large|larger than 32/i,
);
expect("the source ceiling is the same 32 MiB pictures already use", ASSET_MAX_SOURCE_BYTES === 32 * 1024 * 1024);

const nulPadded = glbFromJson({ ...measurableGlbJson, extras: { note: "pad" } }, 0);
const nulBounds = parseGlbBounds(nulPadded);
expect(
	"JSON chunk NULs (illegal padding some exporters write) still parse",
	Boolean(nulBounds) && approx(nulBounds.max.y - nulBounds.min.y, 1),
	JSON.stringify(nulBounds),
);

const dracoJson = {
	...measurableGlbJson,
	extensionsUsed: ["KHR_draco_mesh_compression"],
	meshes: [{ primitives: [{ attributes: { POSITION: 0 }, extensions: { KHR_draco_mesh_compression: { bufferView: 0 } } }] }],
};
const dracoBytes = glbFromJson(dracoJson);
expect("Draco is named as compressed, not as unreadable geometry", /compress/i.test(compressedGlbReason(dracoBytes) ?? ""));
await refuses(
	"a Draco GLB is refused with a compression toast, not stood up as a grey box",
	glbFile(dracoBytes, "draco-cube.glb", "model/gltf-binary"),
	/compress/i,
);
const meshoptBytes = glbFromJson({ ...measurableGlbJson, extensionsRequired: ["EXT_meshopt_compression"] });
await refuses(
	"meshopt is refused the same way",
	glbFile(meshoptBytes, "meshopt-cube.glb", "model/gltf-binary"),
	/compress/i,
);
expect("an ordinary cube is not compressed", compressedGlbReason(unitBytes) === null);

/* -------------------------------------------------------------- drop -- */

expect(
	"model/gltf-binary is the mesh MIME — octet-stream is not enough on its own",
	isSupportedMeshType("model/gltf-binary") &&
		isSupportedMeshType("MODEL/GLTF-BINARY") &&
		!isSupportedMeshType("application/octet-stream") &&
		!isSupportedMeshType("image/png") &&
		ASSET_MESH_TYPES.includes("model/gltf-binary"),
);
expect(
	"meshFilesFrom keeps a .glb and leaves pictures and documents behind",
	JSON.stringify(meshFilesFrom({ files: [named("cooker.glb", "model/gltf-binary"), named("a.png", "image/png"), named("notes.pdf", "application/pdf")] }).map((file) => file.name)) === '["cooker.glb"]',
);
expect(
	"a GLB with no MIME, octet-stream, or application/gltf-binary still counts by extension",
	meshFilesFrom({ files: [named("Stove.GLB", ""), named("pot.glb", "application/octet-stream"), named("pan.glb", "application/gltf-binary")] }).length === 3,
);
expect("an empty drop is not fatal", meshFilesFrom({ files: [] }).length === 0 && meshFilesFrom(null).length === 0);

const png = named("a.png", "image/png");
const glb = named("b.glb", "model/gltf-binary");
const pdf = named("c.pdf", "application/pdf");
const split = splitDroppedFiles([png, glb, pdf]);
expect(
	"a mixed drop splits into one picture, one mesh and one reject",
	split.images.length === 1 && split.meshes.length === 1 && split.rejected.length === 1,
	JSON.stringify(split),
);
expect(
	"the GLB is the mesh, never an image — useImageDrop must not toast it as an unsupported picture",
	split.meshes[0].name === "b.glb" && split.images[0].name === "a.png" && split.rejected[0].name === "c.pdf" && !split.images.some((file) => /\.glb$/i.test(file.name)),
	JSON.stringify(split),
);
const splitFromTransfer = splitDroppedFiles({ files: [png, glb, pdf] });
expect(
	"a DataTransfer-shaped drop splits the same way",
	splitFromTransfer.images.length === 1 && splitFromTransfer.meshes.length === 1 && splitFromTransfer.rejected.length === 1,
);

/* --------------------------------------------------------------- ids ---- */

const meshId = await meshIdForBytes(unitBytes, webcrypto.subtle);
const meshIdAgain = await meshIdForBytes(unitBytes.slice(), webcrypto.subtle);
const imageId = await assetIdForBytes(unitBytes, webcrypto.subtle);
expect("the same GLB bytes always get the same mesh id", meshId === meshIdAgain && isMeshAssetId(meshId), `${meshId} vs ${meshIdAgain}`);
expect(
	"mesh and image ids share the digest and differ only by prefix — otherwise the GLB would be stored as a broken picture",
	meshId.startsWith(MESH_ID_PREFIX) &&
		imageId.startsWith(ASSET_ID_PREFIX) &&
		meshId.slice(MESH_ID_PREFIX.length) === imageId.slice(ASSET_ID_PREFIX.length) &&
		meshId !== imageId,
	`${meshId} vs ${imageId}`,
);
expect("isAssetId is the union of both prefixes", isAssetId(meshId) && isAssetId(imageId));
expect("a mesh id is not an image id", isImageAssetId(meshId) === false && isMeshAssetId(meshId) === true);
expect("an image id is not a mesh id", isMeshAssetId(imageId) === false && isImageAssetId(imageId) === true);
expect(
	"short or junk values fail both predicates",
	!isMeshAssetId("") &&
		!isMeshAssetId("mesh-nope") &&
		!isMeshAssetId(`${MESH_ID_PREFIX}abcdef`) &&
		!isImageAssetId(null) &&
		!isAssetId("mesh-nope"),
);

if (failures) process.exit(1);
console.log("all scene mesh checks PASS");
