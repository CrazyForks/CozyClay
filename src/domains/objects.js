import { useState, useRef } from "react";
import {
	readStoredObjectColors,
	rememberObjectColor,
	writeStoredObjectColors,
	sceneObjectIdFromHierarchy,
	updateSceneObject,
	removeSceneObject,
	dropToSurfacePatch,
	placementInFront,
	createSceneObject,
	createCutoutObject,
	CUTOUT_DEFAULT_HEIGHT,
	createMeshObject,
	CUTOUT_KIND,
	duplicateCutoutOptions,
	MESH_KIND,
	duplicateMeshOptions,
	objectSize,
	setSceneObjectAttach,
	setSceneObjectParent,
} from "../scene-objects.js";
import { withCommandHistory } from "../command-bus.js";
import { createSceneHistoryStore } from "../scene-history.js";
import { ko, isKo } from "../locale.js";
import {
	sceneObjectNameDisplayKo,
	attachWorldMatrix,
	sceneObjectMatrix,
	ATTACH_BONE_ROWS,
	HIERARCHY_INSPECTOR_TITLES,
	attachPlacementPatch,
	placeSceneObject,
} from "../app-stage.jsx";
import { rememberAsset, assetRecord } from "../scene-asset-cache.js";
import { importImageFile, assetAspect, openAssetDb, putAsset } from "../scene-assets.js";
import { importMeshFile, compressedGlbReason, meshBoundsFromAsset, fitMeshBounds } from "../scene-mesh.js";
import { cutOutBackground, maskAsset } from "../matte.js";
import { parseRigNodeId } from "../hierarchy-model.js";
import { StudioProtocolError } from "../studio-agent-protocol.js";

export function useObjects(appContext) {
	// Hand-mixed object tints, newest first. An editor preference like the
	// guides above — it belongs to this browser, never to the scene, so it is
	// kept out of the scene document and written straight back to storage.
	const [recentObjectColors, setRecentObjectColors] = useState(() => readStoredObjectColors(globalThis.localStorage));

	// What is being typed into the hex field right now, or null when nobody is
	// typing. Held apart from the record so a half-written "#ff3" survives on
	// screen without ever repainting the prop, and so the field snaps back to
	// the object's real colour the moment the edit ends.
	const [objectColorDraft, setObjectColorDraft] = useState(null);

	function rememberSceneObjectColor(hex) {
		setRecentObjectColors((previous) => {
			const next = rememberObjectColor(previous, hex);
			// rememberObjectColor returns the same array when nothing changed, so a
			// re-pick of the same tint neither writes storage nor re-renders.
			if (next !== previous) writeStoredObjectColors(globalThis.localStorage, next);
			return next;
		});
	}

	const [objectDeleteUndo, setObjectDeleteUndo] = useState(null);

	const [sceneObjects, setSceneObjects] = useState(appContext.shared.startupScene.objects);

	// The single mutation owner (plan §5.3): every scene-object edit — gizmo
	// drags, plan-board drags, inspector scrubs, hierarchy atomics — routes
	// through this store so one interaction is exactly one undo entry and an
	// in-flight drag can be cancelled. setSceneObjects is stable, so the
	// store is constructed once, seeded with the initial scene.
	const storeRef = useRef(null);

	if (!storeRef.current) {
		storeRef.current = withCommandHistory(createSceneHistoryStore(sceneObjects, {
		onCommit: (before, after) => appContext.shared.markSemanticEdit("objects", before, after),
		onObjects: (objects) => {
			// Object-side ops join the shared undo clock here; undo/redo of the
			// object store bumps the clock explicitly in undoScene/redoScene.
			appContext.objectChanged();
			setSceneObjects(objects);
		},
	}));
	}

	const store = storeRef.current;

	const selectedSceneObjectId = sceneObjectIdFromHierarchy(appContext.shared.selectedHierarchyId);

	const selectedSceneObject = sceneObjects.find((object) => object.id === selectedSceneObjectId) ?? null;

	// Producer drag lifecycle (plan §6.1): begin issues a token the producer
	// presents on every apply and on close; end commits the drag as one
	// history entry, or rolls it back when commit is false (Escape).
	function beginSceneTransaction({ owner, cancel }) {
		return store.begin(owner, cancel);
	}

	function endSceneTransaction(token, { commit }) {
		store.end(token, { commit });
	}

	// App's single scene-object mutation entry (plan §6.1). A token means a
	// producer drag stream: apply inside the open transaction so the change
	// lands in the live array without its own history entry. No token is an
	// atomic edit — one entry. updateSceneObject returns the same array when
	// nothing changed, so a no-op can never create an entry.
	function changeSceneObject(id, patch, token) {
		const apply = (objects) => updateSceneObject(objects, id, patch);
		if (token != null) store.applyIn(token, apply);
		else store.applyAtomic(apply);
	}

	function deleteSelectedSceneObject() {
		deleteSceneObject(selectedSceneObjectId);
	}

	/** Delete by id — the hierarchy context menu's Delete. Unlike the
	 * selection-based path above, removing a row that is not the selection
	 * must leave the selection alone. */
	function deleteSceneObject(id) {
		if (!id) return;
		const wasSelected = id === selectedSceneObjectId;
		store.applyAtomic((objects) => removeSceneObject(objects, id));
		setObjectDeleteUndo({ id, pastDepth: store.depths().past });
		appContext.shared.setInspectorActionsOpen(false);
		if (wasSelected) {
			appContext.shared.setSelectedHierarchyId("props");
		}
	}

	/** Drop-to-surface (plan §9.2/§9.3): End, no modifier. Strict drop-down —
	 * the selection falls until its base touches the highest support top at or
	 * below it, or the floor. dropToSurfacePatch is pure and returns null when
	 * already resting, so a redundant press never creates a history entry, and
	 * x/z are never written. One applyAtomic = one undo entry. */
	function dropSelectedSceneObject() {
		const object = sceneObjects.find((item) => item.id === selectedSceneObjectId) ?? null;
		if (!object) return;
		const patch = dropToSurfacePatch(object, sceneObjects.filter((item) => item.id !== object.id), appContext.shared.characters);
		if (patch === null) {
			appContext.notify(ko("Nothing to drop", "내려놓을 대상이 없어요"));
			return;
		}
		changeSceneObject(object.id, patch);
		appContext.notify(isKo ? `${sceneObjectNameDisplayKo(object.name)}을 표면 위에 내려놓았어요` : `${object.name} dropped to surface`);
	}

	// How much of the wall counts as the wall, and how wide the brush that
	// argues with the answer is.
	const [matteTolerance, setMatteTolerance] = useState(0.18);

	const [matteBrush, setMatteBrush] = useState(18);

	// Edge cleanup for the cut: shrink eats the blended rim, feather softens
	// what is left. Both ride into applyMask; the defaults match applyMask's.
	const [matteShrink, setMatteShrink] = useState(1);

	const [matteFeather, setMatteFeather] = useState(1);

	const [matteMode, setMatteMode] = useState("paint");

	const [matteStats, setMatteStats] = useState({ painted: 0, coverage: 0, zoom: 1, canUndo: false, canRedo: false });

	const [matteBusy, setMatteBusy] = useState(false);

	const [gizmoMode, setGizmoMode] = useState("move");

	// Snap is a preference, not a law: with it on the gizmo blocks on the plan
	// board's grid, and Ctrl/Cmd during a drag gives a free one. Off, it is the
	// other way round. (docs/unity-reference.md §9.5)
	const [snapEnabled, setSnapEnabled] = useState(true);

	/** `at` overrides the floor point: the Assets-shelf drop already knows
	 * where the pointer hit, everyone else gets in-front-of-camera. */
	function addSceneObject(kind, at) {
		const camera = (appContext.shared.lookThroughShot ? appContext.shared.shotCamRef : appContext.shared.editorCamRef).current;
		const paneYaw = (appContext.shared.lookThroughShot ? appContext.shared.look : appContext.shared.editorLook).current.yaw;
		const placement = at ?? (camera
			? placementInFront({ x: camera.position.x, z: camera.position.z }, paneYaw)
			: {});
		const object = createSceneObject(kind, sceneObjects, placement);
		if (!object) return;
		store.applyAtomic((objects) => [...objects, object]);
		appContext.shared.markCraftAction("object");
		appContext.shared.setSelectedHierarchyId(`object:${object.id}`);
		// Deliberate divergence from Unity's rename-on-create: creating an object
		// here is followed by placing it, and dropping focus into a text field
		// swallows the very next W/E/R. Renaming stays on F2/Return and the row's
		// context menu. (docs/unity-reference.md §9.7)
		setGizmoMode("move");
		appContext.notify(isKo ? `${sceneObjectNameDisplayKo(object.name)} 추가됨 — W 이동, E 회전, R 크기` : `${object.name} added — W move, E rotate, R scale`);
	}

	/** "Sofa 2.png" reads as a set piece; "sofa-2.png" does not. The extension
	 * goes, the rest is the user's own name for the thing. */
	function cutoutNameFromFile(fileName) {
		const base = String(fileName ?? "").replace(/\.[^.]+$/, "").trim();
		return base || ko("Cutout", "컷아웃");
	}

	/**
	 * Import one image and stand it up in the set. The card arrives at the
	 * figure's own height, because a standee whose scale is a guess is worse
	 * than useless in a tool where every camera level is a height in metres —
	 * 1.8 m is at least an honest starting point to correct from.
	 */
	async function importCutout(file) {
		if (!file) return;
		try {
			const asset = await rememberAsset(await importImageFile(file));
			const camera = (appContext.shared.lookThroughShot ? appContext.shared.shotCamRef : appContext.shared.editorCamRef).current;
			const placement = camera
				? placementInFront({ x: camera.position.x, z: camera.position.z }, (appContext.shared.lookThroughShot ? appContext.shared.look : appContext.shared.editorLook).current.yaw)
				: {};
			const object = createCutoutObject(
				{ assetId: asset.id, aspect: assetAspect(asset) ?? 1, height: CUTOUT_DEFAULT_HEIGHT, name: cutoutNameFromFile(asset.name) },
				sceneObjects,
				placement,
			);
			if (!object) return;
			store.applyAtomic((objects) => [...objects, object]);
			appContext.shared.setSelectedHierarchyId(`object:${object.id}`);
			setGizmoMode("move");
			appContext.notify(
				isKo
					? `${object.name} 추가됨 — 실제 높이(m)를 입력하면 크기가 맞습니다`
					: `${object.name} added — type its real height in metres to set the scale`,
			);
		} catch (error) {
			appContext.notify(isKo ? `이미지를 가져오지 못했어요 — ${error.message}` : `Could not import that image — ${error.message}`);
		}
	}

	/** A drop can carry several pictures. They go in one at a time so each
	 * lands in its own place and the last one is the one left selected. */
	async function importCutouts(files) {
		for (const file of files) await importCutout(file);
	}

	/**
	 * Stand an ALREADY-STORED picture up as a fresh cutout — the Assets-shelf
	 * drop. The bytes are content-addressed and in the store, so this is
	 * `importCutout` without the import: read the record for its true aspect
	 * and name, mint the card, one atomic history entry.
	 */
	async function spawnCutoutAt(assetId, placement) {
		appContext.shared.markCraftAction("cutout");
		const record = await assetRecord(assetId);
		if (!record) {
			appContext.notify(ko("That image is no longer stored", "그 이미지는 더 이상 저장되어 있지 않아요"));
			return;
		}
		const object = createCutoutObject(
			{ assetId: record.id, aspect: assetAspect(record) ?? 1, height: CUTOUT_DEFAULT_HEIGHT, name: cutoutNameFromFile(record.name) },
			sceneObjects,
			placement,
		);
		if (!object) return;
		store.applyAtomic((objects) => [...objects, object]);
		appContext.shared.setSelectedHierarchyId(`object:${object.id}`);
		setGizmoMode("move");
		appContext.notify(
			isKo
				? `${object.name} 추가됨 — 실제 높이(m)를 입력하면 크기가 맞습니다`
				: `${object.name} added — type its real height in metres to set the scale`,
		);
	}

	function meshNameFromFile(fileName) {
		const base = String(fileName ?? "").replace(/\.[^.]+$/, "").trim();
		return base || ko("Model", "모델");
	}

	async function persistMeshAsset(asset) {
		const db = await openAssetDb();
		try {
			return await putAsset(db, asset);
		} finally {
			db.close?.();
		}
	}

	function placementInFrontOfShot() {
		const camera = (appContext.shared.lookThroughShot ? appContext.shared.shotCamRef : appContext.shared.editorCamRef).current;
		return camera
			? placementInFront({ x: camera.position.x, z: camera.position.z }, (appContext.shared.lookThroughShot ? appContext.shared.look : appContext.shared.editorLook).current.yaw)
			: {};
	}

	/**
	 * Import one GLB and stand it on the floor. Bytes go through putAsset —
	 * never rememberAsset — because the texture cache would decode them as a
	 * bitmap. Height and footprint come from the import heuristic once;
	 * later instances reuse those stored metres.
	 */
	async function importMesh(file) {
		if (!file) return;
		try {
			const { asset, height, footprint } = await importMeshFile(file);
			await persistMeshAsset(asset);
			const object = createMeshObject(
				{ assetId: asset.id, height, footprint, name: meshNameFromFile(asset.name) },
				store.objects,
				placementInFrontOfShot(),
			);
			if (!object) return;
			store.applyAtomic((objects) => [...objects, object]);
			appContext.shared.setSelectedHierarchyId(`object:${object.id}`);
			setGizmoMode("move");
			appContext.notify(
				isKo
					? `${object.name} 추가됨 — 실제 높이(m)를 입력하면 크기가 맞습니다`
					: `${object.name} added — type its real height in metres to set the scale`,
			);
		} catch (error) {
			appContext.notify(isKo ? `모델을 가져오지 못했어요 — ${error.message}` : `Could not import that model — ${error.message}`);
		}
	}

	async function importMeshes(files) {
		for (const file of files) await importMesh(file);
	}

	/**
	 * Stand an already-stored GLB up as a fresh instance. The shelf drop does
	 * not keep a previous object's size: it re-reads the blob and fits once,
	 * the same as a first import, because there is no prior record to copy.
	 */
	async function spawnMeshAt(assetId, placement) {
		appContext.shared.markCraftAction("object");
		const record = await assetRecord(assetId);
		if (!record) {
			appContext.notify(ko("That model is no longer stored", "그 모델은 더 이상 저장되어 있지 않아요"));
			return;
		}
		const compressed = compressedGlbReason(record.bytes);
		if (compressed) {
			appContext.notify(isKo ? `모델을 가져오지 못했어요 — ${compressed}` : `Could not import that model — ${compressed}`);
			return;
		}
		const bounds = meshBoundsFromAsset(record);
		const fitted = bounds ? fitMeshBounds(bounds) : null;
		if (!fitted) {
			appContext.notify(ko("That model has no measurable geometry", "그 모델은 측정할 수 있는 형태가 없어요"));
			return;
		}
		const object = createMeshObject(
			{
				assetId: record.id,
				height: fitted.height,
				footprint: fitted.footprint,
				name: meshNameFromFile(record.name),
			},
			store.objects,
			placement,
		);
		if (!object) return;
		store.applyAtomic((objects) => [...objects, object]);
		appContext.shared.setSelectedHierarchyId(`object:${object.id}`);
		setGizmoMode("move");
		appContext.notify(
			isKo
				? `${object.name} 추가됨 — 실제 높이(m)를 입력하면 크기가 맞습니다`
				: `${object.name} added — type its real height in metres to set the scale`,
		);
	}

	/**
	 * Apply what the background editor is showing.
	 *
	 * Nothing is destroyed. The card keeps three things: the photograph it was
	 * imported from, the purple someone painted on it, and the cut picture the
	 * set actually renders — so the next edit starts from the original with the
	 * selection still on it, however many times it is re-cut.
	 *
	 * Trimming the dead margin changes how much of the frame the subject fills,
	 * so the card's height is scaled with it. The scale is stored rather than
	 * multiplied in, or a second cut would compound one trim onto the last.
	 */
	async function applyMatte(id = selectedSceneObjectId) {
		const object = sceneObjects.find((item) => item.id === id) ?? null;
		const options = appContext.shared.matteEditorRef.current?.options();
		// Nothing purple means nothing was asked for. Removing "the background"
		// on a picture nobody has marked would be a guess applied to their set.
		if (!object || object.renderer !== CUTOUT_KIND || !options || matteBusy) return;
		setMatteBusy(true);
		try {
			const sourceId = object.sourceAssetId || object.assetId;
			const source = await assetRecord(sourceId);
			if (!source) throw new Error(ko("its picture is missing from the store", "저장소에 사진이 없습니다"));
			const [cut, matte] = await Promise.all([
				cutOutBackground(source, { mask: options.mask, shrink: matteShrink, feather: matteFeather }),
				maskAsset(options.mask, { width: options.maskWidth, height: options.maskHeight, name: `${source.name || "cutout"} matte` }),
			]);
			await Promise.all([
				rememberAsset({ ...cut.asset, role: "derived" }),
				rememberAsset({ ...matte, role: "derived" }),
			]);
			const fullFrameHeight = object.height / (object.matteScale || 1);
			changeSceneObject(object.id, {
				assetId: cut.asset.id,
				sourceAssetId: source.id,
				matteAssetId: matte.id,
				matteScale: cut.heightScale,
				aspect: cut.asset.width / cut.asset.height,
				height: fullFrameHeight * cut.heightScale,
			});
			appContext.notify(
				isKo
					? `${object.name} 배경 제거 — ${Math.round(cut.removed * 100)}% 지움. 원본과 칠한 영역은 그대로 남습니다`
					: `${object.name} — ${Math.round(cut.removed * 100)}% removed. The original and your selection are kept`,
			);
		} catch (error) {
			appContext.notify(isKo ? `배경을 제거하지 못했어요 — ${error.message}` : `Could not remove the background — ${error.message}`);
		} finally {
			setMatteBusy(false);
		}
	}

	function duplicateSelectedSceneObject(id = selectedSceneObjectId) {
		// Defaults to the selection (Ctrl/Cmd+D); the hierarchy context menu
		// passes a specific row's id. Same result either way: the copy is
		// selected, offset one grid step, and toasted.
		const object = sceneObjects.find((item) => item.id === id) ?? null;
		if (!object) return;
		const placement = { x: object.x, z: object.z, rot: object.rot };
		// A cutout cannot be minted from the catalogue — it needs the picture the
		// original is already wearing — so the copy is created through its own
		// door and shares the asset rather than importing it twice.
		const copy = object.renderer === CUTOUT_KIND
			? createCutoutObject(duplicateCutoutOptions(object), sceneObjects, placement)
			: object.renderer === MESH_KIND
				? createMeshObject(duplicateMeshOptions(object), sceneObjects, placement)
				: createSceneObject(object.renderer, sceneObjects, placement);
		if (!copy) return;
		// Unity drops the duplicate exactly on top of the original; for blocking,
		// one grid step to the side means you can see that it worked.
		const placed = { ...object, id: copy.id, name: copy.name, x: object.x + 0.5 };
		store.applyAtomic((objects) => [...objects, placed]);
		appContext.shared.setSelectedHierarchyId(`object:${placed.id}`);
		appContext.notify((isKo, ko) => isKo ? `${sceneObjectNameDisplayKo(placed.name)} 복제됨` : `${placed.name} duplicated`);
	}

	function frameSelection(id = selectedSceneObjectId) {
		const object = sceneObjects.find((item) => item.id === id) ?? null;
		if (!object) return;
		const size = objectSize(object);
		appContext.shared.frameWorldTarget(
			{ x: object.x, y: (object.y ?? 0) + size.height / 2, z: object.z },
			Math.max(size.width, size.height, size.depth, 0.5),
		);
	}

	/** In-place rename commit from the hierarchy (F2 / Return / rename on
	 * create). The row label lives in the tree; the object name is shared
	 * state, so this is just the inspector's rename through another door. */
	function renameSceneObject(id, name) {
		changeSceneObject(id, { name });
	}

	/** The prop's live world matrix, falling back to its authored numbers while
	 * it is unattached (those ARE world) and the set has not mounted it yet. */
	function sceneObjectWorldMatrix(object) {
		return appContext.shared.propWorldRef.current?.(object.id, attachWorldMatrix)
			?? ((object.attach ?? null) ? null : sceneObjectMatrix(object, attachWorldMatrix));
	}

	/** The attachment a hierarchy row offers, or null when the row is not a
	 * frame. A character row means the whole body's animated root; a bone row
	 * means that one frame. Bone rows are namespaced per character (#76), so
	 * the row itself names whose frame it is. */
	function attachTargetForRow(rowId) {
		const charId = appContext.shared.charIdFromHierarchyId(rowId);
		if (charId) return appContext.shared.characters.some((entry) => entry.id === charId) ? { characterId: charId, bone: null } : null;
		const rig = parseRigNodeId(rowId);
		const owner = rig ? appContext.shared.charIdFromHierarchyId(rig.rowId) : null;
		const bone = rig ? ATTACH_BONE_ROWS.get(rig.token) : null;
		if (!bone || !owner || !appContext.shared.characters.some((entry) => entry.id === owner)) return null;
		return { characterId: owner, bone };
	}

	/** "Character 1 · Right Hand" — the same words the rows the user dropped on
	 * carry, so the Inspector names the target the way the tree does. */
	function attachTargetLabel(attach) {
		const index = appContext.shared.characters.findIndex((entry) => entry.id === attach.characterId);
		const who = index < 0
			? ko("Missing character", "없는 인물")
			: index === 0
				? ko("Character 1", "인물 1")
				: index === 1
					? ko("Character 2", "인물 2")
					: isKo ? `인물 ${index + 1}` : `Character ${index + 1}`;
		const bone = attach.bone
			? HIERARCHY_INSPECTOR_TITLES[`rig.${attach.bone}`] ?? attach.bone
			: ko("Root", "루트");
		return `${who} · ${bone}`;
	}

	/** Carry a prop on a character's root (`bone` null) or one of its bones, or
	 * put it back in the world with `attach` null — the Hierarchy's character,
	 * bone and Props drops, the Inspector's Detach and run_action
	 * object.attach/detach. */
	function attachSceneObject(id, attach) {
		const object = storeRef.current.objects.find((entry) => entry.id === id);
		if (!object) throw new StudioProtocolError("STALE_TARGET", `Object ${id} is not in this scene.`);
		if (attach) appContext.shared.castMemberOf(attach.characterId);
		// Where the prop is on screen right now, expressed in the frame it is
		// joining (or left as world when it joins none). ONE conversion, whether
		// the prop is coming from the world or from another frame.
		const shown = appContext.shared.animatedSceneObjects.find((entry) => entry.id === id) ?? object;
		const placement = attachPlacementPatch(sceneObjectWorldMatrix(shown), attach, appContext.shared.attachFrameRef.current);
		// A placement that could not be computed refuses the attachment, not just
		// the numbers: attaching without converting would silently reinterpret the
		// old frame's numbers in the new frame, which is the jump itself.
		if (!placement) {
			throw new StudioProtocolError("TARGET_NOT_READY", attach
				? `The ${attach.bone ?? "root"} frame of character ${attach.characterId} is not on stage (its rig has not loaded).`
				: `${object.name || id} is not on stage, so where it is now cannot be read.`);
		}
		// ONE atomic: a single undo puts back both the field and the numbers.
		storeRef.current.applyAtomic((objects) => {
			let next = setSceneObjectAttach(objects, id, attach);
			// Back to the world means "world-anchored again", which drops the
			// grouping parent too — attach and parent are the same slot.
			if (attach === null) next = setSceneObjectParent(next, id, null);
			if (next === objects) return objects;
			return placeSceneObject(next, id, placement);
		});
	}
	return {
		recentObjectColors, objectColorDraft, setObjectColorDraft, rememberSceneObjectColor, objectDeleteUndo,
		setObjectDeleteUndo, sceneObjects, setSceneObjects, storeRef, store, selectedSceneObjectId,
		selectedSceneObject, beginSceneTransaction, endSceneTransaction, changeSceneObject,
		deleteSelectedSceneObject, deleteSceneObject, dropSelectedSceneObject, matteTolerance, setMatteTolerance,
		matteBrush, setMatteBrush, matteShrink, setMatteShrink, matteFeather, setMatteFeather, matteMode,
		setMatteMode, matteStats, setMatteStats, matteBusy, gizmoMode, setGizmoMode, snapEnabled, setSnapEnabled,
		addSceneObject, importCutout, importCutouts, spawnCutoutAt, persistMeshAsset, importMesh, importMeshes,
		spawnMeshAt, applyMatte, duplicateSelectedSceneObject, frameSelection, renameSceneObject,
		sceneObjectWorldMatrix, attachTargetForRow, attachTargetLabel, attachSceneObject,
	};
}
