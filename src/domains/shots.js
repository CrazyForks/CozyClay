import { aimAt } from "../controls.jsx";
import { CAMERA_PRESETS, cameraPresetFraming } from "../camera-move.js";
import { timelineSpan, timelineContentExtent } from "../timeline-extent.js";
import { useState } from "react";
import { PRESETS, DEFAULT_DURATION_S, TIMELINE_FPS } from "../app-stage.jsx";
import { CAMERA_MOVES, SUBJECT_HEIGHT_M, focalMmToFov, fovToFocalMm } from "../shot.js";
import {
	SHOT_AUTHORING_KEY,
	readShotAuthoring,
	SHOT_AUTHORING_LEGACY_KEYS,
	SHOT_AUTHORING_LEGACY_KEY,
	SHOT_AUTHORING_QUARANTINE_KEY,
	readShotAuthoringDocument,
} from "../shot-authoring.js";
import { useSemanticState } from "../use-semantic-state.js";
import {
	initialShots,
	shotIndexAtFrame,
	moveCameraKey,
	removeCameraKey,
	addShotAtFrame,
	cutAtFrame,
	duplicateShot,
	reorderShot,
	resizeShot,
	removeShot,
	renameShot,
} from "../cuts.js";
import { createCameraBlock, updateCameraBlock, removeCameraRail } from "../camera-block.js";
import { updateStableItem, createStableItemId } from "../stable-items.js";
import { craneHeightAt, followFramingFromCamera, buildRail, simplifyStroke } from "../camera-follow.js";
import { trackFeature } from "../analytics.js";
import { StudioProtocolError } from "../studio-agent-protocol.js";
import { railFollowForNewGeometry, defaultRailRange, clampRailRange } from "../camera-rail-schedule.js";
import { ko, isKo } from "../locale.js";

export function useShots(appContext) {
	const [fovDeg, setFovDeg] = useState(PRESETS.medium.fov);

	/** One Ctrl+Z entry for a structural shot edit (delete, split, duplicate,
	 * add, reorder): the same history as the cast, with the shot list aboard. */
	function recordShotUndo() {
		appContext.recordShotUndo(appContext.shared.snapshotCast(true));
	}

	const [cameraMove, setCameraMove] = useState(CAMERA_MOVES[1]);

	const [customMove, setCustomMove] = useState("");

	// Authored shot state (camera keys, waypoints, clip length) restored from
	// the last session — camera moves must survive a reload like the scene does.
	const [shotStartup] = useState(() => {
		try {
			const currentRaw = localStorage.getItem(SHOT_AUTHORING_KEY);
			let sourceKey = SHOT_AUTHORING_KEY;
			let raw = currentRaw;
			let loaded = readShotAuthoring(raw);
			for (const legacyKey of SHOT_AUTHORING_LEGACY_KEYS ?? [SHOT_AUTHORING_LEGACY_KEY]) {
				if (loaded.status !== "absent") break;
				sourceKey = legacyKey;
				raw = localStorage.getItem(sourceKey);
				loaded = readShotAuthoring(raw);
			}
			if (loaded.status === "corrupt") {
				// Preserve the unreadable roll byte-for-byte before a fresh v3 save.
				localStorage.setItem(SHOT_AUTHORING_QUARANTINE_KEY, raw);
				localStorage.removeItem(sourceKey);
				return { state: null, saveBlocked: false };
			}
			// A future body belongs to a future build. Do not replace it merely
			// because this build cannot project it onto today's controls.
			if (loaded.status === "future") return { state: null, saveBlocked: true };
			return { state: loaded.state, saveBlocked: false };
		} catch {
			return { state: null, saveBlocked: false };
		}
	});

	const nestedShotStartup = readShotAuthoringDocument(appContext.shared.startupScene.shotDocument ?? undefined);

	// The nested Scene document wins. The root v3 key remains a migration
	// fallback for users arriving from the single-scene build.
	const startupShotState = nestedShotStartup.state ?? shotStartup.state;

	// Each editorial strip owns its camera keys. The playhead chooses the
	// active strip; there is no shared key list that could blend through a cut.
	const [shots, setShots, editShots] = useSemanticState(() => startupShotState?.shots ?? initialShots(startupShotState?.frameCount ?? DEFAULT_DURATION_S * TIMELINE_FPS), appContext.shared.markSemanticEdit, "shots");

	const [movePlaying, setMovePlaying] = useState(false);

	// Follow slaves the move to the timeline playhead so camera and character
	// motion share one time axis; off frees the camera while both stay set.
	const [moveFollow, setMoveFollow] = useState(true);

	const [railDraw, setRailDraw] = useState(false);

	/* Objects with a travel path stand where their path puts them at the
	 * playhead. Authoring still edits the RECORD (the path and its start
	 * pose); this derived list is what the scene, the plan board and the
	 * export all draw, so preview and recording can never disagree. */
	// Which crane height mark the scene dots have selected; the timeline's
	// Point height input edits this one. Reset lives after activeCamera below.
	const [craneSelectedIndex, setCraneSelectedIndex] = useState(null);

	/* --------------------------- motion workspace --------------------------- */
	// The timeline playhead and the root waypoints are App-owned so the scene
	// (character rig, plan path, ARDY card) reacts to every scrub/play tick.
	const [tlFrame, setTlFrame] = useState(0);

	const [tlFrameCount, setTlFrameCount] = useState(startupShotState?.frameCount ?? DEFAULT_DURATION_S * TIMELINE_FPS);

	const [tlFps, setTlFps] = useState(TIMELINE_FPS);

	const activeShotIdx = shotIndexAtFrame(shots, tlFrame);

	const activeShot = shots[activeShotIdx] ?? null;

	const cameraKeys = activeShot?.cameraKeys ?? [];

	const activeCamera = createCameraBlock(activeShot?.camera);

	// A crane/shot switch invalidates the scene-dot selection.
	const craneActive = !!activeCamera.craneHeight;

	const followCam = activeCamera.followCam;

	const cameraRail = activeCamera.cameraRail;

	const activeShotDuration = activeShot ? activeShot.endFrame - activeShot.startFrame + 1 : 0;

	const hasCameraKeys = shots.some((shot) => shot.cameraKeys.length > 0);

	function changeActiveCamera(patch, shotId = activeShot?.id, authored = true) {
		// Every camera-block commit (mode switch, rail draw, rail delete, lens
		// patch) funnels through here, so this is where the shot snapshot goes.
		// No shot resolved means the setShots below is a no-op — record nothing.
		// The live read model, so a run_action edit sees the shots of the same tick.
		if (!appContext.live.state.shots.some((shot) => shot.id === shotId)) return;
		// A framing capture in the same gesture (rail draw toggle, Follow switch
		// re-measure) already snapshotted the pre-gesture shots, so this commit
		// joins that entry instead of pushing a second one for one click.
		if (appContext.shared.framingSessionOpen(shotId)) appContext.shared.framingSessionRef.current = null;
		else recordShotUndo();
		(authored ? editShots : setShots)((current) => updateStableItem(current, shotId, (shot) => ({ ...shot, camera: updateCameraBlock(shot.camera, patch) }), "shots"));
	}

	/** Which video model this shot is being cut FOR. A label, never a
	 * constraint: nothing re-times or re-crops the shot, the timeline simply
	 * says when the cut breaks the target's limits. One Ctrl+Z entry per pick,
	 * exactly like a camera-block commit. */
	function changeShotTargetModel(targetModel, shotId = activeShot?.id) {
		if (!shots.some((entry) => entry.id === shotId)) return;
		recordShotUndo();
		editShots((current) => updateStableItem(current, shotId, (entry) => ({ ...entry, targetModel: targetModel || null }), "shots"));
	}

	function addActiveCranePoint(requestedT = null, shotId = activeShot?.id) {
		const shot = shots.find((entry) => entry.id === shotId);
		const camera = createCameraBlock(shot?.camera);
		const points = camera.craneHeight?.points;
		if (!points || points.length >= 8) return;
		let t = Number.isFinite(requestedT) ? Math.max(0.02, Math.min(0.98, requestedT)) : null;
		if (t != null) {
			const nearbyIndex = points.findIndex((point) => Math.abs(point.t - t) < 0.02);
			if (nearbyIndex >= 0) {
				setCraneSelectedIndex(nearbyIndex);
				return;
			}
		}
		let gapIndex = 0;
		if (t == null) {
			for (let i = 1; i < points.length - 1; i += 1) {
				if (points[i + 1].t - points[i].t > points[gapIndex + 1].t - points[gapIndex].t) gapIndex = i;
			}
			t = (points[gapIndex].t + points[gapIndex + 1].t) / 2;
		} else {
			gapIndex = points.findIndex((point, index) => index < points.length - 1 && t > point.t && t < points[index + 1].t);
			if (gapIndex < 0) return;
		}
		const added = [
			...points.slice(0, gapIndex + 1),
			{ t, height: craneHeightAt(camera.craneHeight, t) },
			...points.slice(gapIndex + 1),
		];
		changeActiveCamera({ craneHeight: { points: added } }, shotId);
		trackFeature("crane_graph");
		setCraneSelectedIndex(gapIndex + 1);
	}

	function deleteSelectedCranePoint() {
		const points = activeCamera.craneHeight?.points;
		if (!points || craneSelectedIndex == null || craneSelectedIndex <= 0 || craneSelectedIndex >= points.length - 1) return;
		changeActiveCamera({ craneHeight: { points: points.filter((_, index) => index !== craneSelectedIndex) } });
		setCraneSelectedIndex(null);
	}

	// Navigation (including look-through / MCP set_camera) can persist framing,
	// but is not a semantic edit. Keep this on the passive shot setter.
	function syncActiveCameraFraming() {
		const cam = appContext.shared.shotCamRef.current;
		if (!cam || !activeShot || appContext.shared.ikMode || appContext.shared.playMode) return;
		const subjectPosition = appContext.shared.motionPos ?? appContext.shared.charA;
		const subjectYaw = (appContext.shared.charA.rot * Math.PI) / 180;
		const measured = followFramingFromCamera(
			cam.position,
			appContext.shared.look.current.pitch,
			subjectPosition,
			followCam.aimHeight,
			{ x: Math.sin(subjectYaw), z: Math.cos(subjectYaw) },
		);
		const unchanged = (previous) =>
			previous.distance === measured.distance &&
			previous.height === measured.height &&
			previous.pitchOffsetDeg === measured.pitchOffsetDeg &&
			previous.orbitOffsetDeg === measured.orbitOffsetDeg;
		// Framing is re-measured on every orbit/drag tick, so the entry is per
		// GESTURE: the first tick that actually moves the framing records, the
		// rest of the drag keeps writing into that same session.
		if (!unchanged(createCameraBlock(activeShot.camera).followCam)) {
			appContext.shared.recordSessionUndo(appContext.shared.framingSessionRef, `framing:${activeShot.id}`, recordShotUndo);
		}
		setShots((current) => current.map((shot) => {
			if (shot.id !== activeShot?.id) return shot;
			const camera = createCameraBlock(shot.camera);
			const previous = camera.followCam;
			if (unchanged(previous)) return shot;
			return { ...shot, camera: updateCameraBlock(camera, { followCam: { ...previous, ...measured } }) };
		}));
	}

	function commitManualCameraFraming() {
		if (appContext.shared.ikMode || appContext.shared.playMode) return;
		trackFeature("orbit");
		appContext.shared.manualCameraOverrideRef.current = true;
		syncActiveCameraFraming();
	}

	/** Camera-puck / viewport framing gesture start. Opens the SAME framing
	 * session syncActiveCameraFraming writes into, so the whole drag is one
	 * Ctrl+Z entry snapshotted before the first tick moves the lens. */
	function beginCameraFramingGesture() {
		if (appContext.shared.ikMode || appContext.shared.playMode || !activeShot) return;
		appContext.shared.recordSessionUndo(appContext.shared.framingSessionRef, `framing:${activeShot.id}`, recordShotUndo);
	}

	/** One Ctrl+Z entry per timeline editing gesture. The timeline fires this
	 * once when a drag (or an arrow nudge, or a text session) begins, before
	 * any mutation lands; the per-tick handlers then write on top of it. */
	function beginTimelineEditGesture(kind, id) {
		if (kind === "camera-key" || kind === "rail" || kind === "shot-boundary") {
			recordShotUndo();
			return;
		}
		if (kind === "prompt-move" || kind === "prompt-resize") {
			appContext.shared.recordCharacterUndo();
			return;
		}
		// Typing shares changePromptClip's per-session entry: focusing the chip
		// opens the session so the first keystroke joins it instead of pushing
		// a second entry for one edit.
		if (kind === "prompt-text") appContext.shared.recordSessionUndo(appContext.shared.promptTextSessionRef, `prompt-text:${id}`);
	}

	/* One camera-rail core for every shot, shared by the Top-View rail stroke,
	 * the Delete rail button and run_action. */
	function setShotCameraRail(shotId, points) {
		const shot = appContext.live.state.shots.find((entry) => entry.id === shotId);
		if (!shot) throw new StudioProtocolError("STALE_TARGET", `Shot ${shotId} is not in this scene.`);
		const camera = createCameraBlock(shot.camera);
		window.dispatchEvent(new CustomEvent("cozyclay:playground-signal", { detail: { kind: "rail" } }));
		changeActiveCamera({
			cameraRail: points.map(({ x, z }) => ({ x, z })),
			railFollow: railFollowForNewGeometry(camera.railFollow, shot.endFrame - shot.startFrame + 1),
			mode: "rail",
		}, shotId);
	}

	function clearShotCameraRail(shotId) {
		const shot = appContext.live.state.shots.find((entry) => entry.id === shotId);
		if (!shot) throw new StudioProtocolError("STALE_TARGET", `Shot ${shotId} is not in this scene.`);
		// The camera block being edited: this shot's, whichever shot is active.
		const activeCamera = createCameraBlock(shot.camera);
		if (!activeCamera.cameraRail) throw new StudioProtocolError("TARGET_NOT_READY", `${shot.name || shotId} has no camera rail.`);
		changeActiveCamera(removeCameraRail(activeCamera), shotId);
	}

	function changeCameraRail(points) {
		if (activeShot) appContext.shared.runStudioAction("shot.setCameraRail", { shotId: activeShot.id, points: points.map(({ x, z }) => ({ x, z })) });
	}

	function toggleCameraRailDraw() {
		if (!activeShot || appContext.shared.waypointMode) return;
		// The viewport is the framing control. Capture it before Rail takes over
		// the camera so the dolly opens at the distance, height and tilt the
		// operator is actually looking through.
		syncActiveCameraFraming();
		if (activeCamera.mode !== "rail") {
			changeActiveCamera({
				mode: "rail",
				railFollow: activeCamera.railFollow?.mode === "off" ? defaultRailRange(activeShotDuration) : activeCamera.railFollow,
			}, activeShot.id, false); // tool preparation; accepted rail geometry is the edit
		}
		const next = !railDraw;
		trackFeature("dolly_rail");
		setRailDraw(next);
		if (next) {
			appContext.shared.setWorkspaceLayout((current) => ({ ...current, insetCollapsed: false }));
			appContext.notify(ko("Draw the selected Shot's rail in the Top-View", "탑뷰에서 선택한 샷의 레일을 그리세요"));
		}
	}

	function deleteCameraRail() {
		if (!cameraRail || !activeShot) return;
		setRailDraw(false);
		if (!appContext.shared.runStudioAction("shot.clearCameraRail", { shotId: activeShot.id })) return;
		appContext.notify(ko("Camera rail deleted — Follow keeps the current distance", "카메라 레일 삭제됨 — 팔로우가 현재 거리를 유지합니다"));
	}

	function previewCameraShot(shotId) {
		const selected = shots.find((entry) => entry.id === shotId);
		if (!selected) throw new Error(`Unknown shots ID: ${shotId}`);
		if (appContext.shared.waypointMode) return;
		if (appContext.shared.tlPlaying && appContext.shared.cameraPreviewEndRef.current === selected.endFrame) {
			appContext.shared.cameraPreviewEndRef.current = null;
			appContext.shared.setTlPlaying(false);
			return;
		}
		setMovePlaying(false);
		appContext.shared.manualCameraOverrideRef.current = false;
		appContext.shared.cameraPreviewEndRef.current = selected.endFrame;
		setTlFrame(selected.startFrame);
		appContext.shared.setTlPlaying(true);
	}

	// Key authoring lives in each unified Shot block's lower key strip: clicking
	// an empty point stores the CURRENT framing there. Re-keying overwrites it.
	function addCameraKeyframe(frame, shotId = activeShot?.id) {
		const framing = appContext.shared.captureCurrentFraming();
		const target = Math.max(0, Math.min(Math.round(frame), tlFrameCount - 1));
		// Out-of-range keys are dropped by the updater below; only a key that will
		// actually land gets a Ctrl+Z entry.
		const owner = shots.find((entry) => entry.id === shotId);
		const lands = Boolean(owner) && target >= owner.startFrame && target <= owner.endFrame;
		if (lands) {
			appContext.shared.markCraftAction("camera_key");
			recordShotUndo();
			editShots((current) => updateStableItem(current, shotId, (shot) => {
				if (target < shot.startFrame || target > shot.endFrame) return shot;
				const replaced = shot.cameraKeys.filter((key) => key.frame !== target);
				return { ...shot, cameraKeys: [...replaced, { id: createStableItemId("camera-key"), frame: target, framing }].sort((a, b) => a.frame - b.frame) };
			}, "shots"));
		}
		appContext.shared.setSelectedHierarchyId("camera");
	}

	// Re-time a key by dragging its dot along the lane. Landing on another
	// key's frame is rejected — keys stay frame-unique.
	function moveCameraKeyframe(shotId, keyId, from, to) {
		const shot = shots.find((entry) => entry.id === shotId);
		if (!shot) throw new Error(`Unknown shots ID: ${shotId}`);
		const target = Math.max(shot.startFrame, Math.min(Math.round(to), shot.endFrame));
		if (target === from) return;
		editShots((current) => updateStableItem(current, shotId, (entry) => ({ ...entry, cameraKeys: moveCameraKey(entry.cameraKeys, keyId, target) }), "shots"));
	}

	function removeCameraKeyframe(shotId, keyId) {
		const owner = shots.find((shot) => shot.id === shotId);
		if (!owner) throw new Error(`Unknown shots ID: ${shotId}`);
		if (!owner.cameraKeys.some((key) => key.id === keyId)) return;
		recordShotUndo();
		editShots((current) => updateStableItem(current, shotId, (shot) => ({ ...shot, cameraKeys: removeCameraKey(shot.cameraKeys, keyId) }), "shots"));
	}

	function clearMove() {
		setMovePlaying(false);
		if (!activeShot || activeShot.cameraKeys.length === 0) return;
		recordShotUndo();
		editShots((current) => updateStableItem(current, activeShot?.id, (shot) => ({ ...shot, cameraKeys: [] }), "shots"));
	}

	function addTimelineShot() {
		setMovePlaying(false);
		const next = addShotAtFrame(shots, tlFrame, tlFrameCount, appContext.shared.captureCurrentFraming());
		if (next === shots) return;
		recordShotUndo();
		editShots(next);
		trackFeature("shot_add");
		window.dispatchEvent(new CustomEvent("cozyclay:playground-signal", { detail: { kind: "shot" } }));
	}

	function splitTimelineShot(shotId) {
		setMovePlaying(false);
		const shot = shots.find((entry) => entry.id === shotId);
		if (!shot) throw new Error(`Unknown shots ID: ${shotId}`);
		if (tlFrame <= shot.startFrame || tlFrame > shot.endFrame) return;
		const next = cutAtFrame(shots, shotId, tlFrame, appContext.shared.captureCurrentFraming());
		if (next === shots) return;
		recordShotUndo();
		editShots(next);
		trackFeature("shot_cut");
	}

	function selectTimelineShot(shotId) {
		const selected = shots.find((entry) => entry.id === shotId);
		if (!selected) throw new Error(`Unknown shots ID: ${shotId}`);
		appContext.shared.manualCameraOverrideRef.current = false;
		setTlFrame(selected.startFrame);
		appContext.shared.setSelectedHierarchyId("camera");
		if (appContext.shared.workflowMode !== "camera") appContext.shared.selectWorkflowMode("camera");
	}

	function duplicateTimelineShot(shotId) {
		const next = duplicateShot(shots, shotId, tlFrameCount);
		if (next !== shots) recordShotUndo();
		editShots(next);
		if (next !== shots) {
			const duplicate = next.find((shot) => shot.id !== shotId && !shots.some((existing) => existing.id === shot.id));
			if (duplicate) setTlFrame(duplicate.startFrame);
		}
	}

	function moveTimelineShot(shotId, targetFrame) {
		const next = reorderShot(shots, shotId, targetFrame, tlFrameCount);
		if (next === shots) return;
		recordShotUndo();
		editShots(next);
	}

	/** Both edges in one Ctrl+Z entry, through the same resize the boundary
	 * drag uses. The edge moving away from the other goes first, so a range
	 * that jumps past the old one never inverts on the way. */
	function setTimelineShotRange(shotId, startFrame, endFrame) {
		const shot = shots.find((entry) => entry.id === shotId);
		if (!shot) throw new Error(`Unknown shots ID: ${shotId}`);
		const edges = startFrame > shot.endFrame ? [["end", endFrame], ["start", startFrame]] : [["start", startFrame], ["end", endFrame]];
		const next = edges.reduce((current, [edge, frame]) => resizeShot(current, shotId, edge, frame, tlFrameCount), shots);
		if (next === shots) return;
		recordShotUndo();
		editShots(next);
	}

	function removeTimelineShot(shotId) {
		const next = removeShot(shots, shotId);
		if (next === shots) return;
		recordShotUndo();
		editShots(next);
	}
	function publishStudioShots(state) {
		appContext.patchLive({ shots: state.shots });
		setShots(state.shots);
		publishStudioCamera(state.camera, state.manual);
	}
	function commitStudioShots(draft) {
		appContext.patchLive({ shots: draft.shotDocument.shots });
		editShots(draft.shotDocument.shots);
		publishStudioCamera(draft.camera, draft.manual);
	}
	function publishStudioCamera(camera, manual) {
		const angles = aimAt(camera.position, camera.lookAt), live = appContext.live.state;
		const fov = focalMmToFov(camera.focalMm, live.filmback.sensorId, live.filmback.aspectRatio) * 180 / Math.PI;
		Object.assign(appContext.shared.look.current, angles); appContext.shared.shotCameraPosRef.current = { ...camera.position };
		if (appContext.shared.shotCamRef.current) {
			appContext.shared.shotCamRef.current.position.copy(camera.position); appContext.shared.shotCamRef.current.rotation.order = "YXZ";
			appContext.shared.shotCamRef.current.rotation.set(angles.pitch, angles.yaw, 0); appContext.shared.shotCamRef.current.fov = fov; appContext.shared.shotCamRef.current.updateProjectionMatrix();
		}
		appContext.shared.manualCameraOverrideRef.current = manual; appContext.patchLive({ camera: camera.position }); appContext.patchLive({ fovDeg: fov }); appContext.patchLive({ studioCamera: camera });
		appContext.shared.setCameraPos(camera.position); setFovDeg(fov);
	}
	function applyPreset(key) {
		const p = PRESETS[key];
		appContext.shared.stageDomain.setPreset(key);
		setFovDeg(p.fov);
		// Camera presets no longer touch the cast: with a free-form cast the
		// old two:false semantics would hide every extra character.
		appContext.shared.setNonce((n) => n + 1);
	}
	/** Export the shot under the playhead (else the first one) as an MP4.
	 *  Repeated clicks never cancel an in-flight attempt.
	 *
	 *  Two preflights (#193) stand between the menu item and runShotExport:
	 *  a shot with no camera keys has nothing for cameraMoveAt to interpolate,
	 *  so the recording would capture wherever the physical shot camera happens
	 *  to sit — one framing key from the current camera, the same default
	 *  addShotAtFrame writes, makes the static shot exportable. And without
	 *  motion the timeline extent ignores shots and falls back to the whole
	 *  production duration, so a 40-frame static shot must record its own
	 *  [startFrame, endFrame] range instead of 360 frames of held pose. */
	async function exportShotVideo({ download = true, shotId = null } = {}, commandContext = null) {
		if (appContext.shared.recRef.current) return null;
		const atPlayhead = shotIndexAtFrame(shots, tlFrame);
		const target = shotId ? shots.find((entry) => entry.id === shotId) : shots[atPlayhead >= 0 ? atPlayhead : 0] ?? null;
		if (shotId && !target) return null;
		let exportShots = shots;
		if (target && target.cameraKeys.length === 0 && !shotId) {
			const framing = appContext.shared.captureCurrentFraming();
			exportShots = updateStableItem(shots, target.id,
				(entry) => ({ ...entry, cameraKeys: [{ id: createStableItemId("camera-key"), frame: entry.startFrame, framing }] }), "shots");
			// Keep #193's initial static-shot preflight, but never repeat this
			// authoring action when retrying the immutable request below.
			recordShotUndo();
			setShots(exportShots);
		}
		const range = target && (shotId || !appContext.shared.motion)
			? { startFrame: target.startFrame, endFrame: target.endFrame }
			: { startFrame: 0, endFrame: Math.max(0, appContext.shared.currentRecordFrameCount() - 1) };
		return appContext.shared.executeExportRequest(appContext.shared.exportRequest("video", async (job) => {
			const abort = () => job.controller.abort(commandContext.signal.reason);
			commandContext?.signal.addEventListener("abort", abort, { once: true });
			try { commandContext?.signal.throwIfAborted(); return await appContext.shared.runShotExport({ ...range, download }, job); }
			finally { commandContext?.signal.removeEventListener("abort", abort); }
		}, { exportShots, download }));
	}
	function clampShotRailRanges() {
		setShots((current) => {
			let changed = false;
			const next = current.map((shot, index) => {
				const railFollow = shot.camera?.railFollow;
				if (railFollow?.mode !== "range") return shot;
				const duration = shot.endFrame - shot.startFrame + 1;
				const clamped = clampRailRange(railFollow, duration);
				if (!clamped || (clamped.startFrame === railFollow.startFrame && clamped.endFrame === railFollow.endFrame)) return shot;
				changed = true;
				return { ...shot, camera: updateCameraBlock(shot.camera, { railFollow: { mode: "range", ...clamped } }) };
			});
			return changed ? next : current;
		});
	}
	function setLiveCamera(rawArgs, finitePatch) {
		const live = appContext.live.state;
		// A named preset is shorthand for a full framing: it is resolved
		// against the ACTIVE subject and the CURRENT filmback, so the same
		// preset re-frames correctly after the subject moves or the output
		// ratio changes. Everything below then runs on plain coordinates.
		let args = rawArgs;
		if (rawArgs.preset !== undefined) {
			if (typeof rawArgs.preset !== "string" || !CAMERA_PRESETS[rawArgs.preset]) throw new Error("Unknown camera preset");
			const actor = live.characters.find((entry) => entry.id === live.activeCharacterId) ?? live.characters[0];
			const framing = cameraPresetFraming(rawArgs.preset, {
				x: actor?.x ?? 0,
				z: actor?.z ?? 0,
				height: SUBJECT_HEIGHT_M * (actor?.scale ?? 1),
			}, live.filmback);
			if (!framing) throw new Error("Unknown camera preset");
			args = {
				x: framing.pos.x, y: framing.pos.y, z: framing.pos.z,
				lookAtX: actor?.x ?? 0,
				lookAtY: SUBJECT_HEIGHT_M * (actor?.scale ?? 1) * 0.52,
				lookAtZ: actor?.z ?? 0,
				focalMm: framing.focalMm,
			};
			appContext.shared.runStudioAction("stage.setFilmback", { cameraPresetId: rawArgs.preset });
		} else if (Object.keys(finitePatch(rawArgs, ["x", "y", "z", "lookAtX", "lookAtY", "lookAtZ"])).length || rawArgs.focalMm !== undefined) {
			// Any manual placement invalidates the recorded preset: the scene
			// must not claim a framing it no longer has.
			appContext.shared.runStudioAction("stage.setFilmback", { cameraPresetId: null });
		}
		const patch = finitePatch(args, ["x", "y", "z"]);
		let nextFov = live.fovDeg;
		if (args.focalMm !== undefined) {
			if (!Number.isFinite(args.focalMm) || args.focalMm <= 0) throw new Error("Invalid focalMm");
			nextFov = (focalMmToFov(
				args.focalMm,
				live.filmback.sensorId,
				live.filmback.aspectRatio,
			) * 180) / Math.PI;
			if (nextFov < 14 || nextFov > 90) throw new Error("focalMm is outside the editor lens range");
		}
		const next = { ...live.camera, ...patch };
		// Optional aim target (live protocol v1, additive): all three or none.
		// frame_shot always sends it, because a camera that is placed but not
		// aimed keeps whatever the last gesture was pointing at and drops the
		// subject out of frame for every view except `front`. The yaw/pitch go
		// into look.current as well as the camera: that ref is the orientation
		// of record here — FlyControls writes rotation from it, and the framing
		// commit below measures the shot from look.current.pitch, so a bare
		// camera.lookAt would be both overwritten and mismeasured.
		const aim = finitePatch(args, ["lookAtX", "lookAtY", "lookAtZ"]);
		const aimed = Object.keys(aim).length === 3;
		const camera = appContext.shared.shotCamRef.current;
		const angles = aimed ? aimAt(next, { x: aim.lookAtX, y: aim.lookAtY, z: aim.lookAtZ }) : null;
		if (angles) {
			appContext.shared.look.current.yaw = angles.yaw;
			appContext.shared.look.current.pitch = angles.pitch;
		}
		if (camera) {
			camera.position.set(next.x, next.y, next.z);
			camera.fov = nextFov;
			if (angles) {
				camera.rotation.order = "YXZ";
				camera.rotation.set(angles.pitch, angles.yaw, 0);
			}
			camera.updateProjectionMatrix();
		}
		// While a cast model's FBX is still downloading, the Canvas subtree is
		// suspended and the shot camera is unmounted, so `camera` is null and
		// the write above is skipped. The pose still has to survive: ShotRig
		// restores it from this ref (and look.current) when the camera
		// remounts, instead of re-seeding the preset over it (#86 on slow
		// runners — the position and aim were being dropped here).
		appContext.shared.shotCameraPosRef.current = { x: next.x, y: next.y, z: next.z };
		appContext.patchLive({ camera: next });
		appContext.patchLive({ fovDeg: nextFov });
		appContext.shared.setCameraPos(next);
		setFovDeg(nextFov);
		live.commitManualCameraFraming();
		return {
			camera: {
				...next,
				focalMm: Math.round(fovToFocalMm(
					(nextFov * Math.PI) / 180,
					live.filmback.sensorId,
					live.filmback.aspectRatio,
				) * 100) / 100,
			},
		};
	}
	function syncTimelineExtent() {
		const extent = timelineContentExtent(
			appContext.shared.characters,
			appContext.shared.activeChar.id,
			appContext.shared.motion,
			appContext.shared.promptClips,
			appContext.shared.multiModelFootage?.frames,
		);
		// Never leave the end under an authored shot: a shot outside the
		// timeline is an invalid scene for the Studio agent (and for playback).
		if (extent > 0) {
			const span = timelineSpan(extent, shots);
			setTlFrameCount(span);
			setTlFrame((frame) => Math.min(frame, span - 1));
		} else {
			setTlFrameCount((count) => timelineSpan(0, shots, count));
		}
	}
	function finishCameraMove(finalFov) {
		setMovePlaying(false);
		setFovDeg(Math.round(finalFov * 10) / 10);
	}
	function drawCameraRail(stroke) {
		const simplified = simplifyStroke(stroke, 0.12);
		if (simplified.length < 2) return;
		changeCameraRail(simplified);
		setRailDraw(false);
		const curve = buildRail(simplified);
		if (appContext.shared.playgroundMode && activeShot && curve) {
			// Playground: a first-timer drew a dolly and wants to see the
			// whole ride. Stretch the cut to the rail's travel time at the
			// dolly's speed cap and put them behind the shot camera, so ▶
			// plays the move full-screen instead of in the corner monitor.
			const speed = Math.max(0.2, activeCamera.followCam?.maxDollySpeed ?? 4);
			const travel = Math.ceil((curve.length / speed) * tlFps) + Math.round(tlFps * 0.5);
			const endFrame = Math.min(tlFrameCount - 1, activeShot.startFrame + Math.max(travel, activeShot.endFrame - activeShot.startFrame));
			editShots((current) => resizeShot(current, activeShot.id, "end", endFrame, tlFrameCount));
			appContext.shared.enterPreview();
			setTlFrame(activeShot.startFrame);
			appContext.notify(isKo ? "레일 완성 — 샷 카메라 시점으로 전환했습니다. ▶ 로 재생, Esc 로 복귀" : "Rail drawn — you are looking through the shot camera. Press ▶ to ride it; Esc goes back to flying.");
			return;
		}
		appContext.notify(isKo ? `카메라 레일 완성 — ${curve ? curve.length.toFixed(1) : "?"} m, 제어점 ${simplified.length}개` : `Camera rail drawn — ${curve ? curve.length.toFixed(1) : "?"} m, ${simplified.length} control points`);
	}
	function changeCranePoints(points, options) {
		if (!options?.dragging) {
			changeActiveCamera({ craneHeight: { points } });
			return;
		}
		editShots((current) =>
			updateStableItem(
				current,
				activeShot.id,
				(shot) => ({ ...shot, camera: updateCameraBlock(shot.camera, { craneHeight: { points } }) }),
				"shots",
			),
		);
	}
	function changeCraneRail(points, options) {
		if (!options?.dragging) {
			changeActiveCamera({ cameraRail: points });
			return;
		}
		editShots((current) =>
			updateStableItem(
				current,
				activeShot.id,
				(shot) => ({ ...shot, camera: updateCameraBlock(shot.camera, { cameraRail: points }) }),
				"shots",
			),
		);
	}
	function resizeTimelineShot(shotId, edge, frame) { return editShots((current) => resizeShot(current, shotId, edge, frame, tlFrameCount)); }
	function renameTimelineShot(shotId, name) {
		const shot = shots.find((entry) => entry.id === shotId);
		if (!shot) throw new Error(`Unknown shots ID: ${shotId}`);
		// The rename dialog commits once on accept. renameShot ignores a
		// blank name and stores the trimmed one, so an unchanged or empty
		// name is no edit at all: it neither writes nor records.
		if (typeof name !== "string" || !name.trim() || shot.name === name.trim()) return;
		recordShotUndo();
		editShots((current) => renameShot(current, shotId, name));
	}
	function changeLens(value) { setFovDeg(value); }
	return {
		publishStudioShots, commitStudioShots, publishStudioCamera, applyPreset, exportShotVideo, clampShotRailRanges, setLiveCamera, syncTimelineExtent, finishCameraMove, drawCameraRail, changeCranePoints, changeCraneRail, resizeTimelineShot, renameTimelineShot, changeLens,
		fovDeg, setFovDeg, recordShotUndo, cameraMove, customMove, startupShotState, shots, setShots, editShots,
		movePlaying, setMovePlaying, moveFollow, railDraw, setRailDraw, craneSelectedIndex,
		setCraneSelectedIndex, tlFrame, setTlFrame, tlFrameCount, setTlFrameCount, tlFps, setTlFps,
		activeShotIdx, activeShot, cameraKeys, activeCamera, craneActive, cameraRail, activeShotDuration,
		hasCameraKeys, changeActiveCamera, changeShotTargetModel, addActiveCranePoint, deleteSelectedCranePoint,
		syncActiveCameraFraming, commitManualCameraFraming, beginCameraFramingGesture, beginTimelineEditGesture,
		setShotCameraRail, clearShotCameraRail, changeCameraRail, toggleCameraRailDraw, deleteCameraRail,
		previewCameraShot, addCameraKeyframe, moveCameraKeyframe, removeCameraKeyframe, addTimelineShot,
		splitTimelineShot, selectTimelineShot, duplicateTimelineShot, moveTimelineShot, setTimelineShotRange,
		removeTimelineShot,
	};
}
