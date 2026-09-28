import { useState } from "react";
import { PRESETS, DEFAULT_DURATION_S, TIMELINE_FPS } from "../app-stage.jsx";
import { CAMERA_MOVES } from "../shot.js";
import { SHOT_AUTHORING_KEY, readShotAuthoring, SHOT_AUTHORING_LEGACY_KEYS, SHOT_AUTHORING_LEGACY_KEY, SHOT_AUTHORING_QUARANTINE_KEY, readShotAuthoringDocument } from "../shot-authoring.js";
import { useSemanticState } from "../use-semantic-state.js";
import { initialShots, shotIndexAtFrame, moveCameraKey, removeCameraKey, addShotAtFrame, cutAtFrame, duplicateShot, reorderShot, resizeShot, removeShot } from "../cuts.js";
import { createCameraBlock, updateCameraBlock, removeCameraRail } from "../camera-block.js";
import { updateStableItem, createStableItemId } from "../stable-items.js";
import { craneHeightAt, followFramingFromCamera } from "../camera-follow.js";
import { trackFeature } from "../analytics.js";
import { StudioProtocolError } from "../studio-agent-protocol.js";
import { railFollowForNewGeometry, defaultRailRange } from "../camera-rail-schedule.js";
import { ko } from "../locale.js";

export function useShots(appContext) {
	const [fovDeg, setFovDeg] = useState(PRESETS.medium.fov);

	function recordShotUndo() {
		appContext.recordShotUndo(appContext.shared.snapshotCast(true));
	}

	const [cameraMove, setCameraMove] = useState(CAMERA_MOVES[1]);

	const [customMove, setCustomMove] = useState("");

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

	const startupShotState = nestedShotStartup.state ?? shotStartup.state;

	const [shots, setShots, editShots] = useSemanticState(() => startupShotState?.shots ?? initialShots(startupShotState?.frameCount ?? DEFAULT_DURATION_S * TIMELINE_FPS), appContext.shared.markSemanticEdit, "shots");

	const [movePlaying, setMovePlaying] = useState(false);

	const [moveFollow, setMoveFollow] = useState(true);

	const [railDraw, setRailDraw] = useState(false);

	const [craneSelectedIndex, setCraneSelectedIndex] = useState(null);

	const [tlFrame, setTlFrame] = useState(0);

	const [tlFrameCount, setTlFrameCount] = useState(startupShotState?.frameCount ?? DEFAULT_DURATION_S * TIMELINE_FPS);

	const [tlFps, setTlFps] = useState(TIMELINE_FPS);

	const activeShotIdx = shotIndexAtFrame(shots, tlFrame);

	const activeShot = shots[activeShotIdx] ?? null;

	const cameraKeys = activeShot?.cameraKeys ?? [];

	const activeCamera = createCameraBlock(activeShot?.camera);

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

	function beginCameraFramingGesture() {
		if (appContext.shared.ikMode || appContext.shared.playMode || !activeShot) return;
		appContext.shared.recordSessionUndo(appContext.shared.framingSessionRef, `framing:${activeShot.id}`, recordShotUndo);
	}

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
			appContext.shared.setToast(ko("Draw the selected Shot's rail in the Top-View", "탑뷰에서 선택한 샷의 레일을 그리세요"));
		}
	}

	function deleteCameraRail() {
		if (!cameraRail || !activeShot) return;
		setRailDraw(false);
		if (!appContext.shared.runStudioAction("shot.clearCameraRail", { shotId: activeShot.id })) return;
		appContext.shared.setToast(ko("Camera rail deleted — Follow keeps the current distance", "카메라 레일 삭제됨 — 팔로우가 현재 거리를 유지합니다"));
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
	return { fovDeg, setFovDeg, recordShotUndo, cameraMove, setCameraMove, customMove, setCustomMove, shotStartup, nestedShotStartup, startupShotState, shots, setShots, editShots, movePlaying, setMovePlaying, moveFollow, setMoveFollow, railDraw, setRailDraw, craneSelectedIndex, setCraneSelectedIndex, tlFrame, setTlFrame, tlFrameCount, setTlFrameCount, tlFps, setTlFps, activeShotIdx, activeShot, cameraKeys, activeCamera, craneActive, followCam, cameraRail, activeShotDuration, hasCameraKeys, changeActiveCamera, changeShotTargetModel, addActiveCranePoint, deleteSelectedCranePoint, syncActiveCameraFraming, commitManualCameraFraming, beginCameraFramingGesture, beginTimelineEditGesture, setShotCameraRail, clearShotCameraRail, changeCameraRail, toggleCameraRailDraw, deleteCameraRail, previewCameraShot, addCameraKeyframe, moveCameraKeyframe, removeCameraKeyframe, clearMove, addTimelineShot, splitTimelineShot, selectTimelineShot, duplicateTimelineShot, moveTimelineShot, setTimelineShotRange, removeTimelineShot };
}
