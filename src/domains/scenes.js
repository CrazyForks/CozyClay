import { useState } from "react";
import {
	SCENES_STORAGE_KEY,
	readSceneDocument,
	serializeSceneDocument,
	SCENES_VERSION,
	migrateStageFrames,
	activeSceneIndex,
	createSceneDocument,
	createSceneStage,
	addScene,
	duplicateScene,
	renameScene,
	removeScene,
} from "../scenes.js";
import {
	loadProjectSession,
	loadWorkflowGraph,
	createProjectDocument,
	storeProjectSession,
	verifyEmbeddedAsset,
	hasFileSystemAccess,
	pickProjectFileForSave,
	writeProjectFile,
	rememberRecentProject,
	downloadProjectFallback,
	PROJECT_EXTENSION,
	normalizeWorkflowGraph,
	storeWorkflowGraph,
	pickProjectFileForOpen,
	readProjectFile,
	openProjectFallback,
	readProjectDocument,
	requestHandlePermission,
	createWorkflowGraph,
	clearStoredProjectHandle,
} from "../project.js";
import { playgroundSceneUrl, fetchSceneProject } from "../playground.js";
import { openAssetDb, referencedAssetIds, getAsset, putAsset } from "../scene-assets.js";
import { internWorkflowOutputs, workflowOutputRefs, resolveWorkflowOutputs } from "../workflow/workflow-resources.js";
import { encodeMotionResource } from "../motion-resources.js";
import { openMotionDb, putMotion, sweepMotions } from "../motion-store.js";
import { resourceManifest } from "../project-resources.js";
import { isKo, ko } from "../locale.js";
import { track, bucketCount, bucketProjectAge } from "../analytics.js";
import { mergeProjectCustomPoses } from "../project-poses.js";
import { DEFAULT_WORKSPACE_LAYOUT, DEFAULT_DURATION_S, TIMELINE_FPS } from "../app-stage.jsx";
import { saveCustomPoses } from "../poses.js";
import { readShotAuthoringDocument } from "../shot-authoring.js";
import { initialShots } from "../cuts.js";
import { withCommandHistory } from "../command-bus.js";
import { createSceneHistoryStore } from "../scene-history.js";
import { createIkState } from "../ardy/ik.js";

export function useScenes(appContext) {
	// Scene persistence (plan §8): the startup load runs once in a lazy
	// initializer so the store below can seed from the restored scene; the
	// quarantine write and the save-block decision happen before the first
	// render, and the toast/error they produce ride along as initial UI state.
	const [scenes, setScenes] = useState(appContext.shared.startup.document.scenes);

	const [activeSceneId, setActiveSceneId] = useState(appContext.shared.startup.document.activeSceneId);

	const [sceneSaveError, setSceneSaveError] = useState(appContext.shared.startup.error);

	function snapshotActiveScene(sourceScenes = appContext.live.scenes) {
		return sourceScenes.map((scene) => scene.id === appContext.shared.activeSceneIdRef.current
			? { ...scene, objects: appContext.shared.storeRef.current.objects, shotDocument: appContext.shared.shotDocumentRef.current, stage: appContext.shared.actorStageRef.current }
			: scene);
	}

	function persistScenes(nextScenes, nextActiveSceneId) {
		if (appContext.shared.saveBlockedRef.current) return false;
		try {
			localStorage.setItem(SCENES_STORAGE_KEY, serializeSceneDocument({
					version: SCENES_VERSION,
				activeSceneId: nextActiveSceneId,
				scenes: nextScenes,
			}));
			appContext.shared.dirtyRef.current = false;
			setSceneSaveError(null);
			if (appContext.shared.saveFailureToastRef.current) {
				appContext.shared.saveFailureToastRef.current = false;
				appContext.notify("");
			}
			return true;
		} catch (err) {
			const message = `Scenes not saved: ${err?.name || "StorageError"}`;
			setSceneSaveError(message);
			if (!appContext.shared.saveFailureToastRef.current) {
				appContext.shared.saveFailureToastRef.current = true;
				appContext.notify(message);
			}
			return false;
		}
	}

	/* ============================ project files ============================
	 * Game-engine workflow: the authoring state (scenes + cast + layers,
	 * workspace layout, custom poses) round-trips through a real
	 * `.cclayproject` file. localStorage stays as the always-on session
	 * cache; the file is the portable, user-owned document. */
	const [projectName, setProjectName] = useState(() => loadProjectSession()?.name ?? null);

	const [projectDirty, setProjectDirty] = useState(false);

	const [projectSaveState, setProjectSaveState] = useState("idle");

	const [projectMenuOpen, setProjectMenuOpen] = useState(false);

	const [projectBrowserOpen, setProjectBrowserOpen] = useState(false);

	const [projectNameDialog, setProjectNameDialog] = useState(null);

	// A first-run author should choose a document (or explicitly start a named
	// local draft). Keep this as a light startup sheet so the studio remains
	// inspectable while the choice is pending; it never traps the topbar.
	// ?tutorial=camera opens the starter scene itself (#209), so the chooser is
	// suppressed the same way a ?scene= launch suppresses it.
	const [projectStartupOpen, setProjectStartupOpen] = useState(() => !appContext.shared.playgroundMode && !appContext.shared.cameraTutorialQuery && !playgroundSceneUrl(globalThis.location?.search) && !loadProjectSession()?.name);

	const [projectManifest, setProjectManifest] = useState({ items: [], totals: { embedded: 0, external: 0, missing: 0, bytes: 0 }, missing: [] });

	const [saveBlockedReasons, setSaveBlockedReasons] = useState(null);

	const [workflowRevision, setWorkflowRevision] = useState(0);

	function projectDocumentInput(name) {
		return {
			scenesDocument: {
				version: SCENES_VERSION,
				activeSceneId: appContext.shared.activeSceneIdRef.current,
				scenes: snapshotActiveScene(),
			},
			workspaceLayout: appContext.shared.projectStateRef.current.workspaceLayout,
			customPoses: appContext.shared.projectStateRef.current.customPoses,
			workflow: loadWorkflowGraph(),
			name,
		};
	}

	function collectProjectSnapshot(name) {
		return JSON.stringify(createProjectDocument(projectDocumentInput(name)));
	}

	async function collectProjectSerialized(name) {
		const input = projectDocumentInput(name);
		const scenesDocument = {
			...input.scenesDocument,
			scenes: input.scenesDocument.scenes.map((scene) => ({
				...scene,
				stage: scene.stage
					? {
						...scene.stage,
						characters: (scene.stage.characters ?? []).map((character) => ({
							...character,
							motionRef: character.motionRef ? { ...character.motionRef } : character.motionRef,
						})),
					}
					: scene.stage,
			})),
		};
		const db = await openAssetDb();
		try {
			const ids = [...referencedAssetIds(scenesDocument.scenes)];
			const assets = await Promise.all(ids.map((id) => getAsset(db, id)));
			const workflowResult = await internWorkflowOutputs(input.workflow);
			const referencedMotionIds = new Set(
				scenesDocument.scenes.flatMap((scene) => (scene.stage?.characters ?? [])
					.map((character) => character.motionRef?.motionId?.toLowerCase())
					.filter(Boolean)),
			);
			const motions = [...appContext.shared.projectMotionsRef.current.entries()]
				.filter(([id]) => referencedMotionIds.has(id))
				.map(([, record]) => record);
			const motionCache = new Map();
			for (const record of motions) motionCache.set(record.motionId.toLowerCase(), record);
			for (const scene of scenesDocument.scenes) for (const character of scene.stage?.characters ?? []) {
				const clip = appContext.shared.motionFullRef.current.get(character.id);
				if (!clip?.sourceBytes) continue;
				let record = appContext.shared.motionEncodingCacheRef.current.get(clip.sourceBytes);
				if (!record) {
					record = await encodeMotionResource(clip.sourceBytes, { prompt: character.motionRef?.prompt, sourceUrl: character.motionRef?.url });
					appContext.shared.motionEncodingCacheRef.current.set(clip.sourceBytes, record);
				}
				const cached = motionCache.get(record.motionId) ?? record;
				motionCache.set(record.motionId, cached);
				if (!motions.includes(cached)) motions.push(cached);
				appContext.shared.projectMotionsRef.current.set(record.motionId.toLowerCase(), cached);
				character.motionRef = { ...(character.motionRef || {}), motionId: cached.motionId };
			}
			try { const motionDb = await openMotionDb(); await Promise.all(motions.map((record) => putMotion(motionDb, record))); motionDb.close(); } catch (error) { console.warn("[cozyclay] could not cache motions", error); }
			const allAssets = [...assets.filter(Boolean), ...workflowResult.assets];
			const nextInput = { ...input, scenesDocument, workflow: workflowResult.graph, assets: allAssets, motions };
			const manifest = resourceManifest({ scenesDocument: nextInput.scenesDocument, workflow: nextInput.workflow, poseLibrary: nextInput.customPoses, assets: allAssets, motions, workflowOutputRefs });
			setProjectManifest(manifest);
			if (manifest.missing.length) {
				const error = new Error("Project has missing resources");
				error.code = "missing-resources";
				error.items = manifest.missing;
				throw error;
			}
			return JSON.stringify(createProjectDocument({ ...nextInput, savedAt: Date.now() }), null, 2);
		} finally {
			db.close();
		}
	}

	function markProjectClean(name) {
		appContext.shared.projectSnapshotRef.current = collectProjectSnapshot(name);
		setProjectDirty(false);
		setProjectName(name);
		storeProjectSession(name);
	}

	function projectProblemsNotice(problems) {
		if (!Array.isArray(problems) || !problems.length) return "";
		const codes = [...new Set(problems.map((problem) => problem?.code).filter(Boolean))].join(", ");
		return isKo
			? ` · 포함된 자원 ${problems.length}개를 건너뛰었어요${codes ? ` (${codes})` : ""}`
			: ` · skipped ${problems.length} embedded resource${problems.length === 1 ? "" : "s"}${codes ? ` (${codes})` : ""}`;
	}

	async function rehydrateProjectAssets(project, warnings = []) {
		for (const warning of warnings) console.warn(`[cozyclay] ${warning}`);
		if (!project.assets.length) return;
		try {
			const db = await openAssetDb();
			try {
				const referenced = referencedAssetIds(project.scenesDocument.scenes);
				const results = await Promise.allSettled(project.assets.map(async (asset) => {
					if (!referenced.has(asset.id)) {
						console.warn(`[cozyclay] skipped embedded asset outside the project closure: ${asset.id}`);
						return;
					}
					if (!(await verifyEmbeddedAsset(asset))) {
						console.warn(`[cozyclay] skipped embedded asset with mismatched content address: ${asset.id}`);
						return;
					}
					await putAsset(db, asset);
				}));
				for (const result of results) if (result.status === "rejected") console.warn("[cozyclay] could not restore an embedded asset", result.reason);
			} finally {
				db.close();
			}
		} catch (error) {
			console.warn("[cozyclay] could not open the asset store for project restore", error);
		}
	}

	/** Save the project; the answer says what happened, for project.save:
	 * { saved, name, fileName, downloaded } or { saved: false, naming |
	 * cancelled | failure }. Every outcome is also shown to the user here. */
	async function saveProject(saveAs = false, explicitName = null) {
		if (projectName === null && explicitName === null) {
			setProjectNameDialog({ kind: "save", initialName: "My Project" });
			return { saved: false, naming: true };
		}
		setProjectSaveState("saving");
		const name = (explicitName ?? projectName ?? "My Project").trim() || "My Project";
		let downloaded = false;
		try {
			const serialized = await collectProjectSerialized(name);
			let handle = appContext.shared.projectHandleRef.current;
			if (saveAs || !handle || !hasFileSystemAccess()) {
				if (hasFileSystemAccess()) {
					handle = await pickProjectFileForSave(name);
					appContext.shared.projectHandleRef.current = handle;
					await writeProjectFile(handle, serialized);
					await rememberRecentProject(handle, name);
				} else {
					downloadProjectFallback(serialized, name);
					downloaded = true;
				}
			} else {
				await writeProjectFile(handle, serialized);
			}
			markProjectClean(name);
			setSaveBlockedReasons(null);
			setProjectSaveState("saved");
			track("project:saved", {
				object_count_bucket: bucketCount(appContext.shared.projectStateRef.current.sceneObjects?.length ?? 0),
				shot_count_bucket: bucketCount(appContext.shared.shots.length),
			});
			appContext.notify((isKo, ko) => isKo ? `프로젝트 저장됨: ${name}${PROJECT_EXTENSION}` : `Project saved: ${name}${PROJECT_EXTENSION}`);
			return { saved: true, name, fileName: downloaded ? `${name}${PROJECT_EXTENSION}` : appContext.shared.projectHandleRef.current?.name ?? `${name}${PROJECT_EXTENSION}`, downloaded };
		} catch (err) {
			if (err?.name === "AbortError") {
				setProjectSaveState(projectDirty ? "dirty" : "saved");
				return { saved: false, cancelled: true }; // user closed the picker
			}
			setProjectSaveState("error");
			if (err?.code === "missing-resources") setSaveBlockedReasons([{ code: err.code, items: err.items }]);
			else if (err?.code === "resources-too-large") setSaveBlockedReasons([err]);
			else appContext.notify(ko("Could not save the project", "프로젝트를 저장하지 못했어요"));
			return { saved: false, failure: err?.code ?? err?.name ?? "error" };
		}
	}

	function applyProject(project) {
		appContext.shared.studioDocumentEpochRef.current = crypto.randomUUID();
		appContext.shared.tutorialProjectEpochRef.current += 1;
		appContext.shared.tutorialSeedEpochRef.current = null;
		appContext.shared.setTutorialSeedPending(false);
		appContext.shared.setCameraTutorialHandoff(null);
		appContext.shared.exportShotIdRef.current = null;
		appContext.shared.projectMotionsRef.current = new Map((project.motions ?? []).map((record) => [record.motionId?.toLowerCase(), record]).filter(([id]) => id));
		const source = project.scenesDocument;
		openMotionDb().then(async (db) => { try { await Promise.all([...appContext.shared.projectMotionsRef.current.values()].map((record) => putMotion(db, record))); const ids = new Set((source?.scenes ?? []).flatMap((scene) => (scene.stage?.characters ?? []).map((character) => character.motionRef?.motionId?.toLowerCase()).filter(Boolean))); await sweepMotions(db, ids); } finally { db.close(); } }).catch(() => {});
		// A project FILE carries its own scene document and never passes the
		// storage reader, so the 20 fps → 24 fps clock migration is applied here
		// too — otherwise an older .cozyclay would open a sixth too fast.
		const doc = Number.isInteger(source.version) && source.version < SCENES_VERSION
			? { ...source, version: SCENES_VERSION, scenes: source.scenes.map((scene) => ({ ...scene, stage: migrateStageFrames(scene.stage) })) }
			: source;
		const mergedCustomPoses = mergeProjectCustomPoses(appContext.shared.customPoses, project.customPoses);
		setScenes(doc.scenes);
		setActiveSceneId(doc.activeSceneId);
		if (project.workspaceLayout) appContext.shared.setWorkspaceLayout({ ...DEFAULT_WORKSPACE_LAYOUT, ...project.workspaceLayout });
		appContext.shared.setCustomPoses(mergedCustomPoses);
		const resolvedWorkflow = resolveWorkflowOutputs(normalizeWorkflowGraph(project.workflow), new Map((project.assets ?? []).map((asset) => [asset.id, asset])));
		storeWorkflowGraph(resolvedWorkflow);
		saveCustomPoses(mergedCustomPoses);
		persistScenes(doc.scenes, doc.activeSceneId);
		openScene(doc.scenes[activeSceneIndex(doc.scenes, doc.activeSceneId)], doc.scenes);
		appContext.shared.projectSnapshotRef.current = collectProjectSnapshot(project.name);
		setProjectDirty(false);
		setProjectName(project.name);
		storeProjectSession(project.name);
		setProjectStartupOpen(false);
		// Whatever document this is, it is no longer the scene the tutorial opened
		// for itself; startCameraTutorial re-arms the flag after its own open.
		appContext.shared.tutorialStarterRef.current = false;
		setProjectManifest(resourceManifest({ scenesDocument: doc, workflow: resolvedWorkflow, poseLibrary: mergedCustomPoses, assets: project.assets ?? [], motions: appContext.shared.projectMotionsRef.current, workflowOutputRefs }));
		track("project:opened", { age_bucket: bucketProjectAge(Date.now() - (project.savedAt ?? Date.now())) });
	}

	/** Open a bundled starter scene as a fresh, saveable project. Used by the
	 * first-run dialog and by `npx cozyclay --scene <id>` (`?scene=`), which is
	 * how the landing-page tutorial hands people into the local studio. */
	async function openStarterScene(id, source = "starter") {
		const before = source === "tutorial" ? collectProjectSnapshot("Tutorial") : null;
		const epoch = appContext.shared.tutorialProjectEpochRef.current;
		const url = playgroundSceneUrl(`?scene=${encodeURIComponent(id)}`);
		const project = url ? await fetchSceneProject(url) : null;
		// A pending tutorial fetch has no authority over work authored/opened
		// while it was loading, including an unnamed project.
		if (source === "tutorial" && (epoch !== appContext.shared.tutorialProjectEpochRef.current || before !== collectProjectSnapshot("Tutorial"))) return false;
		if (!project) {
			appContext.notify(ko("That starter scene is not in this build", "이 빌드에는 그 시작 장면이 없어요"));
			return false;
		}
		applyProject({ ...project, savedAt: null });
		appContext.shared.projectHandleRef.current = null;
		track("scene:loaded", { scene_source: source });
		return true;
	}

	async function openProject() {
		try {
			let file = null;
			let handle = null;
			if (hasFileSystemAccess()) {
				handle = await pickProjectFileForOpen();
				file = await readProjectFile(handle);
			} else {
				file = await openProjectFallback();
			}
			if (!file) return;
			const result = readProjectDocument(file.text);
			if (!result.ok) {
				appContext.notify(isKo ? `프로젝트를 열 수 없어요: ${result.reason}` : `Cannot open project: ${result.reason}`);
				return;
			}
			result.project.savedAt = result.project.savedAt ?? file.savedAt ?? null;
			appContext.shared.projectHandleRef.current = handle;
			if (handle) await rememberRecentProject(handle, result.project.name);
			await rehydrateProjectAssets(result.project, result.warnings);
			applyProject(result.project);
			setProjectStartupOpen(false);
			appContext.notify(`${isKo ? `프로젝트 열림: ${result.project.name}` : `Project opened: ${result.project.name}`}${projectProblemsNotice(result.problems)}`);
		} catch (err) {
			if (err?.name === "AbortError") return;
			console.error("openProject failed", err);
			appContext.notify(ko("Could not open the project", "프로젝트를 열지 못했어요"));
		}
	}

	/** Open a project from the browser dialog: a stored handle from the
	 * recents list or a file enumerated in the projects folder. */
	async function openProjectByHandle(handle) {
		try {
			// A stored handle may have been demoted to "prompt" since the last
			// session (#51); this click is the user gesture that can re-grant it.
			if ((await requestHandlePermission(handle)) !== "granted") {
				appContext.notify(ko("Project access was not granted — allow access and try again.", "프로젝트 접근이 허용되지 않았어요. 접근을 허용하고 다시 시도해 주세요."));
				return;
			}
			const file = await readProjectFile(handle);
			const result = readProjectDocument(file.text);
			if (!result.ok) {
				appContext.notify(isKo ? `프로젝트를 열 수 없어요: ${result.reason}` : `Cannot open project: ${result.reason}`);
				return;
			}
			result.project.savedAt = result.project.savedAt ?? file.savedAt ?? null;
			appContext.shared.projectHandleRef.current = handle;
			await rememberRecentProject(handle, result.project.name);
			await rehydrateProjectAssets(result.project, result.warnings);
			applyProject(result.project);
		setProjectBrowserOpen(false);
		setProjectStartupOpen(false);
		appContext.notify(`${isKo ? `프로젝트 열림: ${result.project.name}` : `Project opened: ${result.project.name}`}${projectProblemsNotice(result.problems)}`);
		} catch (err) {
			console.error("openProjectByHandle failed", err);
			appContext.notify(ko("Could not open the project", "프로젝트를 열지 못했어요"));
		}
	}

	function requestNewProject() {
		if (projectDirty && !window.confirm(ko("Discard unsaved changes and start a new project?", "저장되지 않은 변경사항을 버리고 새 프로젝트를 시작할까요?"))) return;
		setProjectNameDialog({ kind: "new", initialName: projectName ?? "My Project" });
	}

	function newProject(name) {
		if (typeof name !== "string") return requestNewProject();
		setProjectNameDialog(null);
		const fresh = createSceneDocument(ko("SCENE 01", "씬 01"));
		storeWorkflowGraph(createWorkflowGraph());
		setScenes(fresh.scenes);
		setActiveSceneId(fresh.activeSceneId);
		persistScenes(fresh.scenes, fresh.activeSceneId);
		openScene(fresh.scenes[0], fresh.scenes);
		appContext.shared.projectHandleRef.current = null;
		clearStoredProjectHandle();
		appContext.shared.projectSnapshotRef.current = JSON.stringify(createProjectDocument({
			scenesDocument: fresh,
			workspaceLayout: appContext.shared.projectStateRef.current.workspaceLayout,
			customPoses: appContext.shared.customPoses,
			workflow: createWorkflowGraph(),
			name,
		}));
		setProjectDirty(false);
		setProjectName(name);
		storeProjectSession(name);
		setProjectStartupOpen(false);
		appContext.shared.setFirstSuccessGuideOpen(true);
		appContext.notify(ko(`New project: ${name}`, `새 프로젝트: ${name}`));
	}

	const [restoreOffer, setRestoreOffer] = useState(null);

	async function restoreStoredProject(record) {
		try {
			const file = await readProjectFile(record.handle);
			const result = readProjectDocument(file.text);
			if (!result.ok) return;
			result.project.savedAt = result.project.savedAt ?? file.savedAt ?? null;
			appContext.shared.projectHandleRef.current = record.handle;
			await rehydrateProjectAssets(result.project, result.warnings);
			applyProject(result.project);
			appContext.notify(`${isKo ? `프로젝트 복원됨: ${result.project.name}` : `Project restored: ${result.project.name}`}${projectProblemsNotice(result.problems)}`);
		} catch {
			/* missing or unreadable file: fall back to the session cache */
		}
	}

	function flushScenes() {
		if (!appContext.shared.dirtyRef.current) return;
		persistScenes(snapshotActiveScene(), appContext.shared.activeSceneIdRef.current);
	}

	function restoredShotState(scene) {
		const restored = readShotAuthoringDocument(scene?.shotDocument ?? undefined);
		if (restored.state) return restored.state;
		const frameCount = DEFAULT_DURATION_S * TIMELINE_FPS;
		return { shots: initialShots(frameCount), waypoints: [], frameCount };
	}

	function openScene(scene, nextScenes) {
		appContext.shared.tutorialProjectEpochRef.current += 1;
		appContext.shared.tutorialSeedEpochRef.current = null;
		appContext.shared.setTutorialSeedPending(false);
		appContext.shared.setCameraTutorial(false);
		appContext.shared.setCameraTutorialHandoff(null);
		appContext.shared.exportShotIdRef.current = null;
		appContext.shared.studioSceneEpochRef.current = crypto.randomUUID();
		appContext.shared.studioHistoryRef.current.clear();
		const shotState = restoredShotState(scene);
		const stage = createSceneStage(scene.stage);
		const objects = Array.isArray(scene.objects) ? scene.objects : [];
		const loaded = appContext.loadStoreDomains({ ...scene, stage, objects, shot: shotState, cast: stage.characters });
		if (!loaded.has("objects")) {
			appContext.shared.storeRef.current = withCommandHistory(createSceneHistoryStore(objects, {
				onCommit: (before, after) => appContext.shared.markSemanticEdit("objects", before, after),
				onObjects: (next) => {
					appContext.objectChanged();
					appContext.shared.setSceneObjects(next);
				},
			}));
			appContext.shared.setSceneObjects(objects);
		}
		if (!loaded.has("shot")) {
			appContext.shared.setShots(shotState.shots);
			appContext.shared.setTlFrameCount(shotState.frameCount ?? DEFAULT_DURATION_S * TIMELINE_FPS);
		}
		if (!loaded.has("cast")) appContext.shared.setCharacters(stage.characters);
		appContext.shared.setRigMountEpoch((value) => value + 1);
		appContext.shared.setHasCharSheet(stage.hasCharSheet);
		if (!loaded.has("stage")) appContext.shared.stageDomain.load(stage);
		// The motion-layer buffer reloads from the scene's first character.
		const firstLayer = stage.characters[0]?.layer;
		appContext.shared.setWaypoints(firstLayer?.waypoints ?? shotState.waypoints ?? []);
		appContext.shared.setPromptClips(firstLayer?.promptClips?.map((clip) => ({ ...clip })) ?? []);
		appContext.shared.setMotion(null);
		// Takes belong to the room being left; restoreMotionRefs re-fetches the
		// incoming scene's, and a stale full take must never survive the switch.
		appContext.shared.motionFullRef.current.clear();
		appContext.shared.setSelectedPromptId(null);
		appContext.shared.ikStatesRef.current.clear();
		appContext.shared.ikStateRef.current = createIkState();
		appContext.shared.loadedLayerCharRef.current = stage.characters[0]?.id ?? null;
		appContext.shared.setActiveCharacterId(stage.characters[0]?.id ?? null);
		appContext.resetCastHistory();
		appContext.shared.restoreMotionRefs(stage.characters);
		appContext.shared.setTlFrame(0);
		appContext.shared.setMovePlaying(false);
		appContext.shared.manualCameraOverrideRef.current = false;
		appContext.shared.setRailDraw(false);
		appContext.shared.setActiveWaypointId(null);
		appContext.shared.setPendingWaypointFrame(null);
		appContext.shared.setSelectedHierarchyId("shot");
		appContext.publishScenes(nextScenes);
		appContext.shared.activeSceneIdRef.current = scene.id;
		setScenes(nextScenes);
		setActiveSceneId(scene.id);
		track("scene:loaded", { scene_source: "local" });
	}

	/** The scene controls' doors (the scene pill, the Hierarchy scene menu)
	 * into the shared registry; run_action reaches the same scene actions. */
	function selectSceneDocument(sceneId) { return appContext.shared.runStudioAction("scene.switch", { sceneId }); }

	function createSceneDocumentFromUi() { return appContext.shared.runStudioAction("scene.create"); }

	function duplicateSceneDocumentFromUi(sceneId) { return appContext.shared.runStudioAction("scene.duplicate", { sceneId }); }

	function renameSceneDocumentFromUi(sceneId, name) { return appContext.shared.runStudioAction("scene.rename", { sceneId, name }); }

	function deleteSceneDocumentFromUi(sceneId) { return appContext.shared.runStudioAction("scene.delete", { sceneId }); }

	function switchSceneDocument(sceneId) {
		if (sceneId === appContext.shared.activeSceneIdRef.current) return;
		const savedScenes = snapshotActiveScene();
		const target = savedScenes.find((scene) => scene.id === sceneId);
		if (!target) return;
		persistScenes(savedScenes, sceneId);
		openScene(target, savedScenes);
	}

	function addSceneDocument() {
		const savedScenes = snapshotActiveScene();
		const nextScenes = addScene(savedScenes);
		const target = nextScenes[nextScenes.length - 1];
		persistScenes(nextScenes, target.id);
		openScene(target, nextScenes);
		track("scene:created", { scene_source: "ui" });
	}

	function duplicateSceneDocument(sceneId) {
		const savedScenes = snapshotActiveScene();
		const index = savedScenes.findIndex((scene) => scene.id === sceneId);
		if (index < 0) return;
		const nextScenes = duplicateScene(savedScenes, index);
		const target = nextScenes[index + 1];
		persistScenes(nextScenes, target.id);
		openScene(target, nextScenes);
	}

	function renameSceneDocument(sceneId, name) {
		const savedScenes = snapshotActiveScene();
		const index = savedScenes.findIndex((scene) => scene.id === sceneId);
		if (index < 0) return;
		const nextScenes = renameScene(savedScenes, index, name);
		appContext.publishScenes(nextScenes);
		setScenes(nextScenes);
		persistScenes(nextScenes, appContext.shared.activeSceneIdRef.current);
	}

	function deleteSceneDocument(sceneId) {
		const savedScenes = snapshotActiveScene();
		const index = savedScenes.findIndex((scene) => scene.id === sceneId);
		if (index < 0 || savedScenes.length <= 1) return;
		const nextScenes = removeScene(savedScenes, index);
		if (sceneId !== appContext.shared.activeSceneIdRef.current) {
			appContext.publishScenes(nextScenes);
			setScenes(nextScenes);
			persistScenes(nextScenes, appContext.shared.activeSceneIdRef.current);
			return;
		}
		const target = nextScenes[Math.min(index, nextScenes.length - 1)];
		persistScenes(nextScenes, target.id);
		openScene(target, nextScenes);
	}
	function applyExternalScene(incoming) {
		if (!incoming || !Array.isArray(incoming.scenes)) return;
		const incomingActiveId = typeof incoming.activeSceneId === "string" ? incoming.activeSceneId : appContext.shared.activeSceneIdRef.current;
		const incomingScenes = incoming.scenes;
		const incomingScene = incomingScenes.find((scene) => scene?.id === incomingActiveId) ?? incomingScenes[0];
		if (!incomingScene?.id) return;
		const currentSnapshot = {
			version: SCENES_VERSION,
			activeSceneId: appContext.shared.activeSceneIdRef.current,
			scenes: snapshotActiveScene(),
		};
		if (JSON.stringify(currentSnapshot) === JSON.stringify({ version: SCENES_VERSION, activeSceneId: incomingActiveId, scenes: incomingScenes })) return;
		const nextScenes = incomingScenes;
		if (incomingScene.id !== appContext.shared.activeSceneIdRef.current) {
			openScene(incomingScene, nextScenes);
			return;
		}
		const currentScene = currentSnapshot.scenes.find((scene) => scene?.id === incomingScene.id);
		if (JSON.stringify(currentScene?.objects ?? []) !== JSON.stringify(incomingScene.objects ?? [])) {
			appContext.shared.objectsDomain.applyExternalObjects(incomingScene.objects);
		}
		const incomingStage = createSceneStage(incomingScene.stage);
		const currentStage = currentScene?.stage;
		if (JSON.stringify(currentStage ?? null) !== JSON.stringify(incomingStage)) {
			appContext.shared.castDomain.applyExternalCharacters(incomingStage.characters);
		}
		appContext.publishScenes(nextScenes);
		setScenes(nextScenes);
	}
	function loadLiveScenes(args) {
		if (!args.document || typeof args.document !== "object" || Array.isArray(args.document)) throw new Error("Invalid scene document");
		const loaded = readSceneDocument(JSON.stringify(args.document));
		if (loaded.status !== "valid" && loaded.status !== "migrated") throw new Error("Invalid scene document");
		const document = loaded.document;
		const target = document.scenes[activeSceneIndex(document.scenes, document.activeSceneId)];
		const live = appContext.live.state;
		live.persistScenes(document.scenes, document.activeSceneId);
		live.openScene(target, document.scenes);
		appContext.patchLive({ scenes: document.scenes });
		appContext.patchLive({ activeSceneId: document.activeSceneId });
		appContext.patchLive({ objects: appContext.shared.storeRef.current.objects });
		appContext.patchLive({ characters: createSceneStage(target.stage).characters });
		appContext.publishCharacters(live.characters);
		return {
			sceneName: target.name,
			activeSceneId: document.activeSceneId,
			scenes: document.scenes.map((scene) => ({ id: scene.id, name: scene.name })),
		};
	}
	function refreshProjectDirty() {
		if (projectName === null) return; // untitled sessions are never "dirty"
		const serialized = collectProjectSnapshot(projectName);
		const dirty = serialized !== appContext.shared.projectSnapshotRef.current;
		setProjectDirty(dirty);
		setProjectSaveState((current) => current === "saving" ? current : dirty ? "dirty" : "saved");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}
	return {
		applyExternalScene, loadLiveScenes, refreshProjectDirty,
		scenes, setScenes, activeSceneId, sceneSaveError, snapshotActiveScene, persistScenes, projectName,
		projectDirty, setProjectDirty, projectSaveState, setProjectSaveState, projectMenuOpen,
		setProjectMenuOpen, projectBrowserOpen, setProjectBrowserOpen, projectNameDialog, setProjectNameDialog,
		projectStartupOpen, setProjectStartupOpen, projectManifest, setProjectManifest, saveBlockedReasons,
		setSaveBlockedReasons, workflowRevision, setWorkflowRevision, collectProjectSnapshot,
		collectProjectSerialized, projectProblemsNotice, rehydrateProjectAssets, saveProject, applyProject,
		openStarterScene, openProject, openProjectByHandle, requestNewProject, newProject, restoreOffer,
		setRestoreOffer, restoreStoredProject, flushScenes, openScene, selectSceneDocument,
		createSceneDocumentFromUi, duplicateSceneDocumentFromUi, renameSceneDocumentFromUi,
		deleteSceneDocumentFromUi, switchSceneDocument, addSceneDocument, duplicateSceneDocument,
		renameSceneDocument, deleteSceneDocument,
	};
}
