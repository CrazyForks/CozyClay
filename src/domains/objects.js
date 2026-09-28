import { useState, useRef } from "react";
import { readStoredObjectColors, rememberObjectColor, writeStoredObjectColors, sceneObjectIdFromHierarchy, updateSceneObject, removeSceneObject, dropToSurfacePatch, placementInFront, createSceneObject, createCutoutObject, CUTOUT_DEFAULT_HEIGHT, createMeshObject, CUTOUT_KIND, duplicateCutoutOptions, MESH_KIND, duplicateMeshOptions, objectSize, setSceneObjectAttach, setSceneObjectParent } from "../scene-objects.js";
import { withCommandHistory } from "../command-bus.js";
import { createSceneHistoryStore } from "../scene-history.js";
import { ko, isKo } from "../locale.js";
import { sceneObjectNameDisplayKo, attachWorldMatrix, sceneObjectMatrix, ATTACH_BONE_ROWS, HIERARCHY_INSPECTOR_TITLES, attachPlacementPatch, placeSceneObject } from "../app-stage.jsx";
import { rememberAsset, assetRecord } from "../scene-asset-cache.js";
import { importImageFile, assetAspect, openAssetDb, putAsset } from "../scene-assets.js";
import { importMeshFile, compressedGlbReason, meshBoundsFromAsset, fitMeshBounds } from "../scene-mesh.js";
import { cutOutBackground, maskAsset } from "../matte.js";
import { parseRigNodeId } from "../hierarchy-model.js";
import { StudioProtocolError } from "../studio-agent-protocol.js";

export function useObjects(appContext) {
	const [recentObjectColors, setRecentObjectColors] = useState(() => readStoredObjectColors(globalThis.localStorage));

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

	function beginSceneTransaction({ owner, cancel }) {
		return store.begin(owner, cancel);
	}

	function endSceneTransaction(token, { commit }) {
		store.end(token, { commit });
	}

	function changeSceneObject(id, patch, token) {
		const apply = (objects) => updateSceneObject(objects, id, patch);
		if (token != null) store.applyIn(token, apply);
		else store.applyAtomic(apply);
	}

	function deleteSelectedSceneObject() {
		deleteSceneObject(selectedSceneObjectId);
	}

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

	function dropSelectedSceneObject() {
		const object = sceneObjects.find((item) => item.id === selectedSceneObjectId) ?? null;
		if (!object) return;
		const patch = dropToSurfacePatch(object, sceneObjects.filter((item) => item.id !== object.id), appContext.shared.characters);
		if (patch === null) {
			appContext.shared.setToast(ko("Nothing to drop", "내려놓을 대상이 없어요"));
			return;
		}
		changeSceneObject(object.id, patch);
		appContext.shared.setToast(isKo ? `${sceneObjectNameDisplayKo(object.name)}을 표면 위에 내려놓았어요` : `${object.name} dropped to surface`);
	}

	const [matteTolerance, setMatteTolerance] = useState(0.18);

	const [matteBrush, setMatteBrush] = useState(18);

	const [matteShrink, setMatteShrink] = useState(1);

	const [matteFeather, setMatteFeather] = useState(1);

	const [matteMode, setMatteMode] = useState("paint");

	const [matteStats, setMatteStats] = useState({ painted: 0, coverage: 0, zoom: 1, canUndo: false, canRedo: false });

	const [matteBusy, setMatteBusy] = useState(false);

	const [gizmoMode, setGizmoMode] = useState("move");

	const [snapEnabled, setSnapEnabled] = useState(true);

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
		appContext.shared.setToast(isKo ? `${sceneObjectNameDisplayKo(object.name)} 추가됨 — W 이동, E 회전, R 크기` : `${object.name} added — W move, E rotate, R scale`);
	}

	function cutoutNameFromFile(fileName) {
		const base = String(fileName ?? "").replace(/\.[^.]+$/, "").trim();
		return base || ko("Cutout", "컷아웃");
	}

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
			appContext.shared.setToast(
				isKo
					? `${object.name} 추가됨 — 실제 높이(m)를 입력하면 크기가 맞습니다`
					: `${object.name} added — type its real height in metres to set the scale`,
			);
		} catch (error) {
			appContext.shared.setToast(isKo ? `이미지를 가져오지 못했어요 — ${error.message}` : `Could not import that image — ${error.message}`);
		}
	}

	async function importCutouts(files) {
		for (const file of files) await importCutout(file);
	}

	async function spawnCutoutAt(assetId, placement) {
		appContext.shared.markCraftAction("cutout");
		const record = await assetRecord(assetId);
		if (!record) {
			appContext.shared.setToast(ko("That image is no longer stored", "그 이미지는 더 이상 저장되어 있지 않아요"));
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
		appContext.shared.setToast(
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
			appContext.shared.setToast(
				isKo
					? `${object.name} 추가됨 — 실제 높이(m)를 입력하면 크기가 맞습니다`
					: `${object.name} added — type its real height in metres to set the scale`,
			);
		} catch (error) {
			appContext.shared.setToast(isKo ? `모델을 가져오지 못했어요 — ${error.message}` : `Could not import that model — ${error.message}`);
		}
	}

	async function importMeshes(files) {
		for (const file of files) await importMesh(file);
	}

	async function spawnMeshAt(assetId, placement) {
		appContext.shared.markCraftAction("object");
		const record = await assetRecord(assetId);
		if (!record) {
			appContext.shared.setToast(ko("That model is no longer stored", "그 모델은 더 이상 저장되어 있지 않아요"));
			return;
		}
		const compressed = compressedGlbReason(record.bytes);
		if (compressed) {
			appContext.shared.setToast(isKo ? `모델을 가져오지 못했어요 — ${compressed}` : `Could not import that model — ${compressed}`);
			return;
		}
		const bounds = meshBoundsFromAsset(record);
		const fitted = bounds ? fitMeshBounds(bounds) : null;
		if (!fitted) {
			appContext.shared.setToast(ko("That model has no measurable geometry", "그 모델은 측정할 수 있는 형태가 없어요"));
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
		appContext.shared.setToast(
			isKo
				? `${object.name} 추가됨 — 실제 높이(m)를 입력하면 크기가 맞습니다`
				: `${object.name} added — type its real height in metres to set the scale`,
		);
	}

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
			appContext.shared.setToast(
				isKo
					? `${object.name} 배경 제거 — ${Math.round(cut.removed * 100)}% 지움. 원본과 칠한 영역은 그대로 남습니다`
					: `${object.name} — ${Math.round(cut.removed * 100)}% removed. The original and your selection are kept`,
			);
		} catch (error) {
			appContext.shared.setToast(isKo ? `배경을 제거하지 못했어요 — ${error.message}` : `Could not remove the background — ${error.message}`);
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
		appContext.shared.setToast((isKo, ko) => isKo ? `${sceneObjectNameDisplayKo(placed.name)} 복제됨` : `${placed.name} duplicated`);
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

	function renameSceneObject(id, name) {
		changeSceneObject(id, { name });
	}

	function sceneObjectWorldMatrix(object) {
		return appContext.shared.propWorldRef.current?.(object.id, attachWorldMatrix)
			?? ((object.attach ?? null) ? null : sceneObjectMatrix(object, attachWorldMatrix));
	}

	function attachTargetForRow(rowId) {
		const charId = appContext.shared.charIdFromHierarchyId(rowId);
		if (charId) return appContext.shared.characters.some((entry) => entry.id === charId) ? { characterId: charId, bone: null } : null;
		const rig = parseRigNodeId(rowId);
		const owner = rig ? appContext.shared.charIdFromHierarchyId(rig.rowId) : null;
		const bone = rig ? ATTACH_BONE_ROWS.get(rig.token) : null;
		if (!bone || !owner || !appContext.shared.characters.some((entry) => entry.id === owner)) return null;
		return { characterId: owner, bone };
	}

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
	return { recentObjectColors, setRecentObjectColors, objectColorDraft, setObjectColorDraft, rememberSceneObjectColor, objectDeleteUndo, setObjectDeleteUndo, sceneObjects, setSceneObjects, storeRef, store, selectedSceneObjectId, selectedSceneObject, beginSceneTransaction, endSceneTransaction, changeSceneObject, deleteSelectedSceneObject, deleteSceneObject, dropSelectedSceneObject, matteTolerance, setMatteTolerance, matteBrush, setMatteBrush, matteShrink, setMatteShrink, matteFeather, setMatteFeather, matteMode, setMatteMode, matteStats, setMatteStats, matteBusy, setMatteBusy, gizmoMode, setGizmoMode, snapEnabled, setSnapEnabled, addSceneObject, cutoutNameFromFile, importCutout, importCutouts, spawnCutoutAt, meshNameFromFile, persistMeshAsset, placementInFrontOfShot, importMesh, importMeshes, spawnMeshAt, applyMatte, duplicateSelectedSceneObject, frameSelection, renameSceneObject, sceneObjectWorldMatrix, attachTargetForRow, attachTargetLabel, attachSceneObject };
}
