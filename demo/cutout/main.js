/**
 * Cutout bench — the feature from issue #17, standing on its own.
 *
 * This page imports two files from the studio and nothing else:
 *
 *   src/scene-objects.js  — the record, its metric size, its clamps
 *   src/scene-assets.js   — the import path: decode, cap, content-address
 *
 * Everything around them (the viewer, the sample pictures, this UI) belongs to
 * the demo. That split is the point: if a card comes out 1.8 m tall and the
 * right width HERE, in a page that shares no state, no store and no renderer
 * with App.jsx, then that behaviour lives in the model rather than in the app.
 *
 * Two seams are exercised on purpose, because a published page has neither
 * IndexedDB nor (always) a usable SubtleCrypto:
 *   - the asset store is a Map instead of the studio's IndexedDB adapter,
 *   - the digest is injected, so `assetIdForBytes` still content-addresses.
 */

import * as THREE from "three";
import {
	CUTOUT_DEFAULT_HEIGHT,
	createCutoutObject,
	objectSize,
	updateSceneObject,
} from "../../src/scene-objects.js";
import { ASSET_IMAGE_TYPES, ASSET_MAX_DIMENSION, assetAspect, importImageFile } from "../../src/scene-assets.js";
import { cutOutBackground } from "../../src/matte.js";
import { createViewer } from "./scene.js";
import { SAMPLES, sampleFile } from "./samples.js";

/* ------------------------------------------------------------ the seams --- */

/** FNV-1a ×4, used only when SubtleCrypto is unavailable (a sandboxed page).
 * Same contract as `crypto.subtle.digest`: bytes in, an ArrayBuffer out. */
const fallbackDigest = {
	digest: async (_algorithm, buffer) => {
		const bytes = new Uint8Array(buffer);
		const out = new Uint8Array(32);
		for (let lane = 0; lane < 8; lane++) {
			let hash = 0x811c9dc5 ^ (lane * 0x01000193);
			for (let i = lane; i < bytes.length; i += 8) {
				hash ^= bytes[i];
				hash = Math.imul(hash, 0x01000193) >>> 0;
			}
			out[lane * 4] = hash >>> 24;
			out[lane * 4 + 1] = (hash >>> 16) & 0xff;
			out[lane * 4 + 2] = (hash >>> 8) & 0xff;
			out[lane * 4 + 3] = hash & 0xff;
		}
		return out.buffer;
	},
};
const digest = globalThis.crypto?.subtle ?? fallbackDigest;

/** The studio keeps assets in IndexedDB; the bench keeps them in a Map. The
 * records either side of that swap are identical. */
const assets = new Map();
const textures = new Map();

async function textureFor(asset) {
	if (textures.has(asset.id)) return textures.get(asset.id);
	// ImageBitmap ignores Texture.flipY, so the flip is asked of the decoder —
	// without it every card hangs upside down.
	const bitmap = await createImageBitmap(new Blob([asset.bytes], { type: asset.type }), { imageOrientation: "flipY" });
	const texture = new THREE.Texture(bitmap);
	texture.flipY = false;
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.minFilter = THREE.LinearMipmapLinearFilter;
	texture.anisotropy = 4;
	texture.needsUpdate = true;
	textures.set(asset.id, texture);
	return texture;
}

/* --------------------------------------------------------------- state --- */

const state = { objects: [], selectedId: null, blockout: false, imports: 0, deduped: 0 };
const $ = (id) => document.getElementById(id);

/** No WebGL (a locked-down browser, a headless check) is not the end of the
 * page: the import path, the sizing and the rail all still work, and saying so
 * beats a blank rectangle. */
function createFallbackViewer() {
	$("stage").hidden = true;
	const message = document.createElement("p");
	message.className = "hint";
	message.style.padding = "24px";
	message.textContent = "This browser could not open a 3D view, so the set is not drawn. Everything else on this page still works.";
	$("stage").parentElement.append(message);
	return { render() {}, frameCards() {}, dispose() {} };
}

let viewer;
try {
	viewer = createViewer($("stage"));
} catch (error) {
	console.warn("[cutout bench] no 3D view", error);
	viewer = createFallbackViewer();
}

const selected = () => state.objects.find((object) => object.id === state.selectedId) ?? null;

function draw() {
	viewer.render(state.objects, textures, { asBlockout: state.blockout, selectedId: state.selectedId });
	paintRail();
}

/* -------------------------------------------------------------- import --- */

async function addCutout(file) {
	try {
		const asset = await importImageFile(file, { subtle: digest });
		const known = assets.has(asset.id);
		if (known) state.deduped += 1;
		assets.set(asset.id, asset);
		await textureFor(asset);
		state.imports += 1;

		const name = String(asset.name ?? "").replace(/\.[^.]+$/, "") || "Cutout";
		const preset = SAMPLES.find((sample) => sample.name === name);
		const object = createCutoutObject(
			{
				assetId: asset.id,
				aspect: assetAspect(asset) ?? 1,
				// A sample knows what it is; a picked file starts at the figure's
				// own height, which is at least an honest thing to correct from.
				height: preset?.metres ?? CUTOUT_DEFAULT_HEIGHT,
				name,
			},
			state.objects,
			nextPlacement(),
		);
		if (!object) throw new Error("that image could not be turned into a card");
		state.objects = [...state.objects, object];
		state.selectedId = object.id;
		note(
			known
				? `${object.name} — same picture as one already imported, so it reuses the stored asset`
				: `${object.name} — ${asset.width} × ${asset.height} px stored, ${(asset.bytes.byteLength / 1024).toFixed(0)} KB`,
		);
		draw();
	} catch (error) {
		note(`Could not import that image — ${error.message}`, true);
	}
}

/** Cards land in a row along the back of the set, a metre apart, so a second
 * import never hides inside the first. */
function nextPlacement() {
	const n = state.objects.length;
	return { x: 0.9 + (n % 4) * 1.4, z: -0.4 - Math.floor(n / 4) * 1.6, rot: -18 };
}

function note(message, bad = false) {
	const line = $("note");
	line.textContent = message;
	line.dataset.bad = bad ? "true" : "false";
}

/* ----------------------------------------------------------------- rail --- */

function paintRail() {
	const object = selected();
	$("cards").innerHTML = "";
	for (const card of state.objects) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "card-row" + (card.id === state.selectedId ? " is-selected" : "");
		button.innerHTML = `<span>${card.name}</span><small>${card.height.toFixed(2)} × ${card.footprint.width.toFixed(2)} m</small>`;
		button.addEventListener("click", () => {
			state.selectedId = card.id;
			draw();
		});
		$("cards").append(button);
	}
	$("empty").hidden = state.objects.length > 0;

	$("editor").hidden = !object;
	if (object) {
		const size = objectSize(object);
		$("height").value = object.height.toFixed(2);
		$("heightRange").value = String(object.height);
		$("rotRange").value = String(object.rot);
		$("derived").textContent = `${size.width.toFixed(2)} m wide`;
		$("assetId").textContent = object.assetId;
		const asset = assets.get(object.assetId);
		$("assetMeta").textContent = asset ? `${asset.width} × ${asset.height} px · ${asset.type.replace("image/", "").toUpperCase()} · ${(asset.bytes.byteLength / 1024).toFixed(0)} KB` : "—";
		$("ratio").textContent = `${(object.height / 1.8).toFixed(2)}× the figure`;
	}
	$("stats").textContent = `${state.objects.length} card${state.objects.length === 1 ? "" : "s"} · ${assets.size} asset${assets.size === 1 ? "" : "s"} stored${state.deduped ? ` · ${state.deduped} import${state.deduped === 1 ? "" : "s"} deduped` : ""}`;
}

function editSelected(patch) {
	const object = selected();
	if (!object) return;
	state.objects = updateSceneObject(state.objects, object.id, patch);
	draw();
}

/* ------------------------------------------------------------- wiring --- */

$("pick").addEventListener("click", () => $("file").click());
$("file").accept = ASSET_IMAGE_TYPES.join(",");
$("file").addEventListener("change", (event) => {
	const [file] = event.target.files ?? [];
	event.target.value = "";
	if (file) addCutout(file);
});

const drop = $("drop");
for (const type of ["dragenter", "dragover"]) {
	drop.addEventListener(type, (event) => {
		event.preventDefault();
		drop.dataset.over = "true";
	});
}
for (const type of ["dragleave", "drop"]) {
	drop.addEventListener(type, (event) => {
		event.preventDefault();
		drop.dataset.over = "false";
	});
}
drop.addEventListener("drop", (event) => {
	const [file] = event.dataTransfer?.files ?? [];
	if (file) addCutout(file);
});

$("samples").innerHTML = "";
SAMPLES.forEach((sample, index) => {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "chip";
	button.innerHTML = `${sample.name}<small>${sample.metres.toFixed(2)} m</small>`;
	button.title = sample.note;
	button.addEventListener("click", async () => addCutout(await sampleFile(index)));
	$("samples").append(button);
});

$("height").addEventListener("change", (event) => editSelected({ height: Number(event.target.value) }));
$("heightRange").addEventListener("input", (event) => editSelected({ height: Number(event.target.value) }));
$("rotRange").addEventListener("input", (event) => editSelected({ rot: Number(event.target.value) }));
$("tolerance").addEventListener("input", (event) => {
	$("toleranceValue").textContent = Number(event.target.value).toFixed(2);
});

$("matte").addEventListener("click", async () => {
	const object = selected();
	const source = object && assets.get(object.assetId);
	if (!object || !source) return;
	const button = $("matte");
	button.disabled = true;
	button.textContent = "Removing…";
	try {
		const { asset, heightScale, removed } = await cutOutBackground(source, { tolerance: Number($("tolerance").value) }, { subtle: digest });
		assets.set(asset.id, asset);
		await textureFor(asset);
		// The subject stays the size it was: trimming the margin only changed
		// how much of the frame it fills, not how tall the thing really is.
		state.objects = updateSceneObject(state.objects, object.id, {
			assetId: asset.id,
			aspect: assetAspect(asset) ?? 1,
			height: object.height * heightScale,
		});
		note(`${object.name} — ${Math.round(removed * 100)}% of the frame removed, trimmed to ${asset.width} × ${asset.height} px`);
		draw();
	} catch (error) {
		note(`Could not remove the background — ${error.message}`, true);
	} finally {
		button.disabled = false;
		button.textContent = "Remove background";
	}
});

$("remove").addEventListener("click", () => {
	const object = selected();
	if (!object) return;
	state.objects = state.objects.filter((card) => card.id !== object.id);
	state.selectedId = state.objects.at(-1)?.id ?? null;
	note(`${object.name} removed — its picture stays in the store until nothing points at it`);
	draw();
});

const blockoutToggle = $("blockout");
blockoutToggle.addEventListener("change", () => {
	state.blockout = blockoutToggle.checked;
	draw();
});
addEventListener("keydown", (event) => {
	if (event.key !== " " || event.target.tagName === "INPUT") return;
	event.preventDefault();
	blockoutToggle.checked = !blockoutToggle.checked;
	blockoutToggle.dispatchEvent(new Event("change"));
});

$("cap").textContent = `${ASSET_MAX_DIMENSION} px`;

// Open on something to look at: the doorway, at the height a doorway is.
(async () => {
	await addCutout(await sampleFile(0));
	viewer.frameCards();
})();
