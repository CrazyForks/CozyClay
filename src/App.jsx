import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrthographicCamera, PerspectiveCamera, Text, useFBX } from "@react-three/drei";
import * as THREE from "three";
import { SkeletonUtils } from "three/examples/jsm/Addons.js";
import { buildArdyPose } from "./ardy/export.js";
import { checkBridge, generate as ardyGenerate } from "./ardy/client.js";
import { loadMotionFromUrl } from "./ardy/npz.js";
import { applyMotionFrame, captureArdyRoot, restorePlaybackBones, snapshotPlaybackBones } from "./ardy/playback.js";
import { movePromptClipFrames } from "./ardy/prompt-clips.js";
import Timeline from "./ardy/timeline.jsx";
import { alignArdyPath, judgeAuthoredPath, judgeNextWaypoint, toSceneRootOffset, PATH_LIMITS } from "./ardy/waypoints.js";
import { FlyControls, aimAt, forwardFrom } from "./controls.jsx";
import HierarchyPanel from "./hierarchy-panel.jsx";
import { PlanBoard } from "./planview.jsx";
import { DualRender, GIZMO_LAYER, SHOT_ASPECT, fitAspect } from "./dualview.jsx";
import { Room, StageLights } from "./room.jsx";
import {
	SHOT_AUTHORING_KEY,
	SHOT_AUTHORING_LEGACY_KEY,
	SHOT_AUTHORING_LEGACY_KEYS,
	SHOT_AUTHORING_QUARANTINE_KEY,
	createShotAuthoringDocument,
	readShotAuthoringDocument,
	readShotAuthoring,
} from "./shot-authoring.js";
import { buildFollowTrack, buildRail, buildRailFollowTrack, simplifyStroke } from "./camera-follow.js";
import { createCameraBlock, updateCameraBlock } from "./camera-block.js";
import { SetProps } from "./props.jsx";
import {
	DEFAULT_SCENE_OBJECTS,
	OBJECT_COLORS,
	createSceneObject,
	dropToSurfacePatch,
	objectSize,
	placementInFront,
	removeSceneObject,
	sceneObjectIdFromHierarchy,
	updateSceneObject,
} from "./scene-objects.js";
import { createSceneHistoryStore } from "./scene-history.js";
import {
	SCENES_QUARANTINE_KEY,
	SCENES_STORAGE_KEY,
	activeSceneIndex,
	addScene,
	createSceneDocument,
	duplicateScene,
	loadSceneDocumentFromStorage,
	removeScene,
	renameScene,
	serializeSceneDocument,
} from "./scenes.js";
import ObjectGizmo from "./object-gizmo.jsx";
import AddObjectMenu from "./object-catalog.jsx";
import ResultModal from "./result-modal.jsx";
import InstallApp from "./install-app.jsx";
import LocaleToggle from "./locale-toggle.jsx";
import { ko, isKo } from "./locale.js";
import {
	BUILT_IN_POSES,
	POSE_BONES,
	applyPose,
	primeBindPose,
	capturePose,
	deleteCustomPose,
	loadCustomPoses,
	saveCustomPoses,
} from "./poses.js";
import { IkHandles, PoseHandles, PoseStudioPanel } from "./posestudio.jsx";
import {
	MID_TRACKS,
	createIkState,
	ikBakeKeyframe,
	ikEvaluate,
	ikKeyframes,
	ikRemoveKeyframe,
	ikSeedTargets,
	ikTouch,
	resolveIkRig,
	solveIk,
	solveMidJoint,
	solveSwingAngle,
	solveEffectorSwing,
	solveHipsTranslate,
	ikPlantFeet,
	ikSolvePlantedFeet,
} from "./ardy/ik.js";
import { Dropdown, Field, Slider, Toast, Vector3Row } from "./ui.jsx";
import { RENDER_ACTIVITY_EVENT, useRenderActivity } from "./use-render-activity.js";
import {
	CAMERA_MOVES,
	CUSTOM_MOVE,
	IMAGE_MODELS,
	SUBJECT_HEIGHT_M,
	VIDEO_MODELS,
	composePrompt,
	deriveShot,
	slateLine,
} from "./shot.js";
import { captureFraming, classifyMove, cameraMoveAt, moveSequenceSlate, moveSequencePhrase } from "./camera-move.js";
import {
	cameraAtFrame,
	cutAtFrame,
	duplicateShot,
	initialShots,
	moveBoundary,
	removeShot,
	renameShot,
	reorderShot,
	shotIndexAtFrame,
} from "./cuts.js";

// Stated the way a crew states a setup: how far back, which side, how high the
// lens rides, and what glass is on it. Order matters — Medium is the setup a
// director reaches for first, so it leads.
const PRESETS = {
	medium: { label: ko("Medium", "미디엄"), distance: 2.6, azimuth: 22, elevation: 6, fov: 45, targetY: 1.35, two: false },
	wide: { label: ko("Wide", "와이드"), distance: 7, azimuth: 25, elevation: 4, fov: 38, targetY: 1.2, two: false },
	closeup: { label: ko("Close-Up", "클로즈업"), distance: 1.3, azimuth: 16, elevation: 2, fov: 45, targetY: 1.55, two: false },
	low: { label: ko("Low Angle", "로우 앵글"), distance: 3.5, azimuth: 20, elevation: -14, fov: 50, targetY: 1.1, two: false },
	high: { label: ko("High Angle", "하이 앵글"), distance: 4.5, azimuth: 20, elevation: 16, fov: 45, targetY: 1.1, two: false },
	ots: {
		label: ko("Over Shoulder", "오버 숄더"),
		distance: 2.8,
		azimuth: 200,
		elevation: 8,
		fov: 40,
		targetY: 1.5,
		two: true,
		// the foreground shoulder must sit between the lens and subject 1
		charB: { x: 0.62, z: 1.05, rot: 196 },
	},
	two: {
		label: ko("Two Shot", "투샷"),
		distance: 6,
		azimuth: 18,
		elevation: 5,
		fov: 42,
		targetY: 1.2,
		two: true,
		charB: { x: 1.15, z: 0.1, rot: -14 },
		aimMid: true,
	},
};

const RIG_HIERARCHY_FOCUS = {
	"rig.hips": "hips",
	"rig.spine": "spine",
	"rig.leftArm": "leftHand",
	"rig.rightArm": "rightHand",
	"rig.leftLeg": "leftFoot",
	"rig.rightLeg": "rightFoot",
};

const HIERARCHY_INSPECTOR_TITLES = {
	shot: ko("Shot settings", "샷 설정"),
	camera: ko("Camera", "카메라"),
	characters: ko("Characters", "인물"),
	characterA: ko("Character 1", "인물 1"),
	"characterA.rig": ko("Rig", "리그"),
	characterB: ko("Character 2", "인물 2"),
	environment: ko("Environment", "환경"),
	props: ko("Props", "소품"),
	"rig.hips": ko("Root / Hips", "루트 / 엉덩이"),
	"rig.spine": ko("Spine", "척추"),
	"rig.leftArm": ko("Left Arm", "왼팔"),
	"rig.rightArm": ko("Right Arm", "오른팔"),
	"rig.leftLeg": ko("Left Leg", "왼다리"),
	"rig.rightLeg": ko("Right Leg", "오른다리"),
};

const CAMERA_MOVE_LABELS_KO = new Map([
	["Static / locked-off", ko("Static / locked-off", "고정 샷")],
	["Zoom in", ko("Zoom in", "줌 인")],
	["Zoom out", ko("Zoom out", "줌 아웃")],
	["Push-in (dolly in)", ko("Push-in (dolly in)", "푸시인(돌리 인)")],
	["Pull-out (dolly out)", ko("Pull-out (dolly out)", "풀아웃(돌리 아웃)")],
	["Pan left", ko("Pan left", "왼쪽 팬")],
	["Pan right", ko("Pan right", "오른쪽 팬")],
	["Tilt up", ko("Tilt up", "틸트 업")],
	["Tilt down", ko("Tilt down", "틸트 다운")],
	["Tracking / follow", ko("Tracking / follow", "트래킹 / 팔로우")],
	["Orbit / arc", ko("Orbit / arc", "오빗 / 아크")],
	["Crane up", ko("Crane up", "크레인 업")],
	["Crane down", ko("Crane down", "크레인 다운")],
	["Handheld", ko("Handheld", "핸드헬드")],
	["Crash zoom in", ko("Crash zoom in", "크래시 줌 인")],
	["Dolly-zoom (vertigo)", ko("Dolly-zoom (vertigo)", "돌리 줌(버티고)")],
	["Whip pan", ko("Whip pan", "휩 팬")],
	["Aerial / drone", ko("Aerial / drone", "공중 / 드론")],
	[CUSTOM_MOVE, ko(CUSTOM_MOVE, "직접 입력…")],
]);

const POSE_LABELS_KO = new Map([
	["T-pose", ko("T-pose", "T 포즈")],
	["Relaxed", ko("Relaxed", "편안한 자세")],
	["Contrapposto", ko("Contrapposto", "콘트라포스토")],
	["Walking", ko("Walking", "걷는 자세")],
	["Seated", ko("Seated", "앉은 자세")],
	["Arms crossed", ko("Arms crossed", "팔짱")],
	["Pointing", ko("Pointing", "가리키기")],
	["Hands on hips", ko("Hands on hips", "허리에 손")],
	["Looking back", ko("Looking back", "뒤돌아보기")],
	["Hands up", ko("Hands up", "손 올리기")],
]);

const SHOT_SIZE_LABELS_KO = new Map([
	["extreme close-up", ko("extreme close-up", "익스트림 클로즈업")],
	["close-up", ko("close-up", "클로즈업")],
	["medium close-up", ko("medium close-up", "미디엄 클로즈업")],
	["medium shot", ko("medium shot", "미디엄 샷")],
	["medium-wide shot", ko("medium-wide shot", "미디엄 와이드 샷")],
	["wide shot", ko("wide shot", "와이드 샷")],
	["extreme wide shot", ko("extreme wide shot", "익스트림 와이드 샷")],
]);

const SHOT_LEVEL_LABELS_KO = new Map([
	["overhead", ko("overhead", "오버헤드")],
	["high angle", ko("high angle", "하이 앵글")],
	["eye level", ko("eye level", "아이 레벨")],
	["chest level", ko("chest level", "가슴 높이")],
	["hip level", ko("hip level", "엉덩이 높이")],
	["knee level", ko("knee level", "무릎 높이")],
	["ground level", ko("ground level", "바닥 높이")],
]);

const SCENE_RENDERER_LABELS_KO = new Map([
	["cube", ko("cube", "큐브")],
	["sphere", ko("sphere", "구")],
	["capsule", ko("capsule", "캡슐")],
	["cylinder", ko("cylinder", "원기둥")],
	["cone", ko("cone", "원뿔")],
	["plane", ko("plane", "평면")],
	["chair", ko("chair", "의자")],
	["car", ko("car", "자동차")],
	["aircraft", ko("aircraft", "비행기")],
]);

const SCENE_OBJECT_NAME_LABELS_KO = new Map([
	["Cube", ko("Cube", "큐브")],
	["Sphere", ko("Sphere", "구")],
	["Capsule", ko("Capsule", "캡슐")],
	["Cylinder", ko("Cylinder", "원기둥")],
	["Cone", ko("Cone", "원뿔")],
	["Plane", ko("Plane", "평면")],
	["Chair", ko("Chair", "의자")],
	["Car", ko("Car", "자동차")],
	["Plane (aircraft)", ko("Plane (aircraft)", "비행기")],
]);

function poseLabelKo(pose) {
	return pose?.custom ? pose.label : POSE_LABELS_KO.get(pose?.label) ?? pose?.label ?? "";
}

function cameraMoveLabelKo(move) {
	return CAMERA_MOVE_LABELS_KO.get(move) ?? move;
}

function sceneRendererLabelKo(renderer) {
	return SCENE_RENDERER_LABELS_KO.get(renderer) ?? renderer;
}

function sceneObjectNameDisplayKo(name) {
	const match = /^(.+?)(?: ([2-9]\d*))?$/.exec(name ?? "");
	if (!match) return name;
	const [, base, suffix] = match;
	const label = SCENE_OBJECT_NAME_LABELS_KO.get(base);
	return label ? `${label}${suffix ? ` ${suffix}` : ""}` : name;
}

function viewShortKo(viewShort) {
	if (viewShort === "front") return ko("front", "정면");
	if (viewShort === "back") return ko("back", "후면");
	if (viewShort?.includes("profile")) return viewShort.startsWith("left") ? ko("left profile", "왼쪽 측면") : ko("right profile", "오른쪽 측면");
	if (viewShort?.startsWith("front ¾")) return / L$/.test(viewShort) ? ko("front ¾ L", "정면 ¾ 왼쪽") : ko("front ¾ R", "정면 ¾ 오른쪽");
	if (viewShort?.startsWith("rear ¾")) return / L$/.test(viewShort) ? ko("rear ¾ L", "후면 ¾ 왼쪽") : ko("rear ¾ R", "후면 ¾ 오른쪽");
	return viewShort;
}

function slateLineKo(shot) {
	return [
		SHOT_SIZE_LABELS_KO.get(shot.sizeLabel) ?? shot.sizeLabel,
		viewShortKo(shot.viewShort),
		SHOT_LEVEL_LABELS_KO.get(shot.levelLabel) ?? shot.levelLabel,
		`${shot.focalMm}mm`,
	].filter(Boolean).join(" · ");
}

function moveSequenceSlateKo(segments) {
	if (!segments.length) return "";
	if (segments.length === 1) {
		const seg = segments[0];
		return `${slateLineKo(seg.from)} → ${slateLineKo(seg.to)} · ${cameraMoveLabelKo(seg.label)}`;
	}
	const parts = [slateLineKo(segments[0].from)];
	for (const seg of segments) parts.push(`${cameraMoveLabelKo(seg.label)} → ${slateLineKo(seg.to)}`);
	return parts.join(" · ");
}

function hierarchyIdForIkFocus(focus) {
	if (!focus) return null;
	if (focus === "hips") return "rig.hips";
	if (["spine", "chest", "neck", "head"].includes(focus)) return "rig.spine";
	if (focus.startsWith("left") && ["Hand", "Elbow", "Shoulder"].some((part) => focus.endsWith(part))) return "rig.leftArm";
	if (focus.startsWith("right") && ["Hand", "Elbow", "Shoulder"].some((part) => focus.endsWith(part))) return "rig.rightArm";
	if (focus === "leftFoot" || focus === "leftKnee") return "rig.leftLeg";
	if (focus === "rightFoot" || focus === "rightKnee") return "rig.rightLeg";
	return "characterA.rig";
}

const CAPTURE_W = 1920;
const CAPTURE_H = 1080;
// Pre-generated clip shipped with the build so a bridge-less session (a hosted
// static demo, or `npm run dev:ui`) still shows real generated motion.
// Relative on purpose: it has to resolve under a project sub-path too.
// Same reason as DEMO_MOTION_URL: a leading slash breaks the app the moment
// the build is served from a project sub-path (a GitHub Pages project site).
const CHARACTER_MODEL_URL = "models/y-bot-tpose.fbx";
const DEMO_MOTION_URL = "demo/walk-then-stop.npz";
const DEMO_MOTION_PROMPT = "a person walking then a person stops";
const CLAY = "#f2eee6";
const CLAY_B = "#ddd6ca";
const DEFAULT_POSE = BUILT_IN_POSES.find((p) => p.id === "relaxed") ?? BUILT_IN_POSES[0];
const DEFAULT_SUBJECT = "a young woman in a tan coat";
const DEFAULT_ENVIRONMENT = "a sunlit modern living room";
const DEFAULT_CAMERA_POSITION = { x: 0.97, y: 1.62, z: 2.39 };
const REST_BONES = Object.fromEntries(POSE_BONES.map((b) => [b.id, [0, 0, 0]]));
const DEFAULT_DURATION_S = 15; // pre-motion timeline duration; shown as duration × 20 frames
const DEFAULT_PLAYBACK_SPEED = 1;
const ARDY_PROMPT_HORIZON_FRAMES = 40; // core model horizon: 2 seconds at 20 fps
const MAX_WAYPOINTS = 32; // ARDY bridge contract: a root path holds 2..32 distinct waypoint frames
const ARDY_PROMPT_MAX = 500; // bridge contract: prompt must be non-empty, capped at 500 chars
const ARDY_DURATION_MIN = 1; // the UI works in whole seconds; the bridge floor is 0.15 s
const ARDY_DURATION_MAX = 1200; // bridge contract: duration capped at 1200 s
const ARDY_SEED_MAX = 2 ** 31 - 1; // bridge contract: optional seed, integer in 0..2**31-1
const DEFAULT_PROMPT_CLIPS = [];

/* ------------------------------------------------------------------ 3D --- */

function Character({ url, position, rot, tint, pose, onRig, pickId }) {
	const fbx = useFBX(url);
	const model = useMemo(() => {
		const clone = SkeletonUtils.clone(fbx);
		clone.scale.setScalar(0.01); // Mixamo exports centimetres
		clone.traverse((child) => {
			if (child.isMesh) {
				// warm clay reads as a maquette; cold grey reads as a broken render
				child.material = new THREE.MeshStandardMaterial({
					color: tint,
					roughness: 0.82,
					metalness: 0,
				});
				child.frustumCulled = false;
			}
		});
		// Stamp the bind pose while the rig is still untouched: the pose effect
		// below runs immediately after and would otherwise be baked into "rest".
		primeBindPose(clone);
		return clone;
	}, [fbx, tint]);

	useEffect(() => {
		// During playback the pose prop is null and the motion drives the rig;
		// this effect can flush AFTER the playback effect in a later commit
		// (measured: playback at t, pose reset at t+1.8ms), and resetting to
		// REST then would clobber the animation back to the bind pose. So a
		// null pose means "playback owns the rig" — do not touch it.
		if (!pose) return;
		// every joint is reset first, otherwise switching presets leaves stale limbs
		applyPose(model, { ...REST_BONES, ...pose.bones });
	}, [model, pose]);

	useEffect(() => {
		onRig?.(model);
	}, [model, onRig]);

	return (
		// characterPick makes the body a first-class click target: the Scene
		// picker walks up from any hit mesh, finds the tag, and routes the
		// selection to the hierarchy so the Inspector owns the controls.
		<group position={position} rotation={[0, (rot * Math.PI) / 180, 0]} userData={pickId ? { characterPick: pickId } : undefined}>
			<primitive object={model} />
		</group>
	);
}

/** Applies a preset to the free-flying camera, then reports live metrics. */
function ShotRig({ preset, nonce, fovDeg, charA, charB, showB, probeX, probeZ, camRef, look, onMetrics }) {
	useEffect(() => {
		const cam = camRef.current;
		if (!cam) return;
		const p = PRESETS[preset];
		const az = (p.azimuth * Math.PI) / 180;
		const el = (p.elevation * Math.PI) / 180;
		const aim =
			p.aimMid && showB ? { x: (charA.x + charB.x) / 2, z: (charA.z + charB.z) / 2 } : { x: charA.x, z: charA.z };
		const horizontal = p.distance * Math.cos(el);
		cam.position.set(
			aim.x + horizontal * Math.sin(az),
			Math.max(p.targetY + p.distance * Math.sin(el), 0.15),
			aim.z + horizontal * Math.cos(az),
		);
		const angles = aimAt(cam.position, { x: aim.x, y: p.targetY, z: aim.z });
		look.current.yaw = angles.yaw;
		look.current.pitch = angles.pitch;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [preset, nonce]);


	useEffect(() => {
		const cam = camRef.current;
		if (!cam) return;
		cam.fov = fovDeg;
		cam.updateProjectionMatrix();
	}, [fovDeg, camRef]);

	// A blocking tool must not claim a framing it is not holding, so the subject's
	// feet and eyes are projected into the frame every tick.
	const probe = useRef(new THREE.Vector3());
	const lastMetrics = useRef({ x: NaN, y: NaN, z: NaN, visible: null });
	useFrame(() => {
		const cam = camRef.current;
		if (!cam) return;
		let visible = false;
		for (const y of [0.1, SUBJECT_HEIGHT_M * 0.94]) {
			// During motion playback the probe follows the played root, so the
			// "subject out of frame" caption stays honest.
			probe.current.set(probeX ?? charA.x, y, probeZ ?? charA.z).project(cam);
			if (probe.current.z < 1 && Math.abs(probe.current.x) <= 1 && Math.abs(probe.current.y) <= 1) visible = true;
		}
		const previous = lastMetrics.current;
		if (
			Math.abs(previous.x - cam.position.x) +
				Math.abs(previous.y - cam.position.y) +
				Math.abs(previous.z - cam.position.z) >
				1e-4 ||
			previous.visible !== visible
		) {
			lastMetrics.current = {
				x: cam.position.x,
				y: cam.position.y,
				z: cam.position.z,
				visible,
			};
			onMetrics(cam.position, visible);
		}
	});

	return null;
}

/** Plays an authored A→B camera move by driving the shot camera exactly the
    way a fly-drag does — position on the camera, orientation through the look
    ref — so ShotRig's metrics, the slate, and the inset all stay honest for
    free. A right-drag interrupts the dolly: the user always outranks it.

    Two clocks can drive the move. Standalone preview runs on its own clock;
    follow mode slaves the move to the timeline playhead, so the camera and
    the character motion are two views of the same time axis — playing or
    scrubbing frame 60 at 20 fps puts the camera exactly 3 s into its move. */
function MoveRig({ playing, following, followFrame, fps, keys, shots, anchor, camRef, look, isInterrupted, onDone }) {
	const clock = useRef(0);
	const invalidate = useThree((state) => state.invalidate);
	// The follow branch only re-applies when its time changes; in demand mode
	// each apply needs one more frame so ShotRig's metrics see the new pose.
	const appliedFrame = useRef(null);
	useEffect(() => {
		// Arming or reshaping the move must schedule a frame by hand: this
		// component owns no three objects, so in demand mode nothing else will.
		appliedFrame.current = null;
		if (following) invalidate();
	}, [keys, shots, anchor, fps, following, invalidate]);
	useEffect(() => {
		// A paused scrub changes the playhead without starting the render loop.
		if (following && !playing) invalidate();
	}, [followFrame, following, playing, invalidate]);
	useEffect(() => {
		if (playing) clock.current = 0;
	}, [playing]);
	useFrame((_, delta) => {
		if ((playing && keys.length < 1) || (!playing && following && !shots.some((shot) => shot.cameraKeys.length))) return;
		const cam = camRef.current;
		if (!cam) return;
		const firstFrame = keys[0]?.frame ?? 0;
		const spanFrames = Math.max((keys[keys.length - 1]?.frame ?? firstFrame) - firstFrame, 1);
		const apply = (frame) => {
			// Timeline/PlayView sampling follows the editorial strips. Standalone
			// preview stays scoped to the selected strip's keys.
			const f = following ? cameraAtFrame(shots, anchor, frame) : cameraMoveAt(keys, anchor, frame);
			if (!f) return null;
			cam.position.set(f.pos.x, f.pos.y, f.pos.z);
			look.current.yaw = f.yaw;
			look.current.pitch = f.pitch;
			if (Math.abs(cam.fov - f.fovDeg) > 1e-3) {
				cam.fov = f.fovDeg;
				cam.updateProjectionMatrix();
			}
			return f;
		};
		if (playing) {
			if (isInterrupted?.()) {
				onDone(cam.fov);
				return;
			}
			// The camera-only preview runs on its own clock across the key span:
			// N keys play through every segment back to back.
			const span = Math.max(spanFrames / Math.max(fps, 1), 0.1);
			clock.current = Math.min(clock.current + delta, span);
			const t = clock.current / span;
			const f = apply(firstFrame + t * spanFrames);
			if (t >= 1) onDone(f ? f.fovDeg : cam.fov);
			return;
		}
		if (!following) return;
		if (isInterrupted?.()) return; // the user is flying; yield until released
		if (appliedFrame.current === followFrame) return;
		appliedFrame.current = followFrame;
		apply(followFrame);
		invalidate();
	});
	return null;
}

/**
 * Applies the precomputed follow-camera track to the shot camera. The track
 * is derived offline from the subject trajectory (camera-follow.js), so this
 * rig only samples it at the playhead — scrub, play, PlayView and Record all
 * replay the identical deterministic move. Null-rendering, so every apply
 * must invalidate() by hand in demand mode, like MoveRig.
 */
function FollowCamRig({ enabled, frame, track, camRef, look, isInterrupted }) {
	const invalidate = useThree((state) => state.invalidate);
	const applied = useRef(null);
	useEffect(() => {
		applied.current = null;
		if (enabled) invalidate();
	}, [track, enabled, invalidate]);
	useEffect(() => {
		if (enabled) invalidate();
	}, [frame, enabled, invalidate]);
	useFrame(() => {
		if (!enabled || !track || track.length === 0) return;
		if (isInterrupted?.()) return; // the user is flying; yield until released
		const cam = camRef.current;
		if (!cam) return;
		const sample = track[Math.max(0, Math.min(frame, track.length - 1))];
		if (applied.current === sample) return;
		applied.current = sample;
		cam.position.set(sample.pos.x, sample.pos.y, sample.pos.z);
		look.current.yaw = sample.yaw;
		look.current.pitch = sample.pitch;
		invalidate();
	});
	return null;
}

function RenderLoopController({ stageRef }) {
	const frameloop = useThree((state) => state.frameloop);
	const setFrameloop = useThree((state) => state.setFrameloop);
	const invalidate = useThree((state) => state.invalidate);
	useEffect(() => {
		const apply = (next) => {
			setFrameloop(next ? "always" : "demand");
			if (next) invalidate();
		};
		const onActivity = (event) => apply(event.detail);
		window.addEventListener(RENDER_ACTIVITY_EVENT, onActivity);
		return () => window.removeEventListener(RENDER_ACTIVITY_EVENT, onActivity);
	}, [invalidate, setFrameloop]);
	useEffect(() => {
		if (stageRef.current) stageRef.current.dataset.actualRenderLoop = frameloop;
	}, [frameloop, stageRef]);
	return null;
}

function ViewportLayoutInvalidator({ insetX, insetY, insetWidth, insetHeight, hierarchyWidth, sidebarWidth, timelineHeight, planZoom }) {
	const invalidate = useThree((state) => state.invalidate);
	useEffect(() => {
		// The pane frame is regular DOM while its picture is a scissored WebGL
		// viewport. In demand mode a drag can commit its final DOM position just
		// after the continuous loop stops, leaving the picture at the previous
		// coordinates. Redraw now and once more after layout has settled.
		invalidate();
		const frame = requestAnimationFrame(invalidate);
		return () => cancelAnimationFrame(frame);
	}, [invalidate, insetX, insetY, insetWidth, insetHeight, hierarchyWidth, sidebarWidth, timelineHeight, planZoom]);
	return null;
}

/** The authored root path on the set floor while path editing is on: numbered
    pins connected in walk order. Lives on the gizmo layer, so the shot camera
    shows it but exports never do (the bird's-eye board draws its own copy). */
/**
 * The drawn camera rail in the 3D Scene view: editor furniture on the gizmo
 * layer, so PlayView, the ink prepass and exports never see it.
 */
function CameraRailScenePreview({ points }) {
	const rootRef = useRef(null);
	const line = useMemo(() => {
		if (!points || points.length < 2) return null;
		const positions = new Float32Array(points.length * 3);
		points.forEach((point, i) => {
			positions[i * 3] = point.x;
			positions[i * 3 + 1] = 0.03;
			positions[i * 3 + 2] = point.z;
		});
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
		return geometry;
	}, [points]);
	useEffect(() => () => line?.dispose(), [line]);
	useEffect(() => {
		rootRef.current?.traverse((node) => node.layers.set(GIZMO_LAYER));
	});
	if (!line) return null;
	return (
		<group ref={rootRef}>
			<line geometry={line}>
				<lineBasicMaterial color="#a78bfa" transparent opacity={0.8} depthWrite={false} />
			</line>
		</group>
	);
}

function ShotPathPreview({ waypoints, start, activeWaypointFrame }) {
	const rootRef = useRef(null);
	const line = useMemo(() => {
		if (!waypoints.length) return null;
		const points = [{ x: start.x, z: start.z }, ...waypoints];
		const positions = new Float32Array(points.length * 3);
		points.forEach((point, i) => {
			positions[i * 3] = point.x;
			positions[i * 3 + 1] = 0.03;
			positions[i * 3 + 2] = point.z;
		});
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
		return geometry;
	}, [start.x, start.z, waypoints]);
	useEffect(() => {
		// Every render: drei's Text meshes appear asynchronously, and each new
		// node must land on the gizmo layer before the next capture.
		rootRef.current?.traverse((node) => node.layers.set(GIZMO_LAYER));
	});
	if (!waypoints.length) return null;
	return (
		<group ref={rootRef}>
			{line && (
				<line geometry={line}>
					<lineBasicMaterial color="#4e9fb3" transparent opacity={0.8} depthWrite={false} />
				</line>
			)}
			{waypoints.map((waypoint, i) => {
				const active = waypoint.frame === activeWaypointFrame;
				const color = active ? "#ffd76c" : "#4e9fb3";
				return (
					<group key={waypoint.frame} position={[waypoint.x, 0.03, waypoint.z]}>
						<mesh rotation={[-Math.PI / 2, 0, 0]}>
							<ringGeometry args={[0.13, 0.19, 28]} />
							<meshBasicMaterial color={color} depthWrite={false} />
						</mesh>
						<Text
							position={[0, 0.02, 0.34]}
							rotation={[-Math.PI / 2, 0, 0]}
							fontSize={0.24}
							color={color}
							anchorX="center"
							anchorY="middle"
							outlineWidth={0.03}
							outlineColor="#1c1a17"
							outlineOpacity={0.85}
						>
							{String(i + 1)}
						</Text>
					</group>
				);
			})}
		</group>
	);
}

/** Unity-style scene grid: 1 m cells on the set floor, editor chrome only.
    It rides the gizmo layer so exports and the plan never pick it up, sits a
    hair above the deck to dodge z-fighting, and never swallows a raycast —
    floor clicks pass straight through to the ground plane. Warm greys tuned
    to the clay floor (#e7e1d7). */
function SceneGrid() {
	const grid = useMemo(() => {
		const helper = new THREE.GridHelper(24, 24, 0x8f8474, 0xa99f8e);
		helper.material.transparent = true;
		helper.material.opacity = 0.62;
		helper.material.depthWrite = false;
		helper.position.y = 0.002;
		helper.layers.set(GIZMO_LAYER);
		helper.raycast = () => null;
		return helper;
	}, []);
	return <primitive object={grid} />;
}

/** Offscreen 1920x1080 read-back, always from the shot camera. */
function CaptureRig({ apiRef, camRef }) {
	const { gl, scene } = useThree();
	useEffect(() => {
		apiRef.current = {
			render() {
				const source = camRef.current;
				if (!source) return null;
				const target = new THREE.WebGLRenderTarget(CAPTURE_W, CAPTURE_H, {
					colorSpace: THREE.SRGBColorSpace,
					samples: 4,
				});
				const cam = source.clone();
				// the transform gizmo is UI: it never reaches an exported frame
				cam.layers.disable(GIZMO_LAYER);
				// QA hook: the layer mask the export camera actually renders
				// with — the browser suite asserts GIZMO_LAYER (the gizmo AND
				// the selection cage) is never in it.
				window.__captureCameraMask = cam.layers.mask;
				cam.aspect = CAPTURE_W / CAPTURE_H;
				cam.updateProjectionMatrix();
				const previous = gl.getRenderTarget();
				gl.setRenderTarget(target);
				gl.render(scene, cam);
				const buffer = new Uint8Array(CAPTURE_W * CAPTURE_H * 4);
				gl.readRenderTargetPixels(target, 0, 0, CAPTURE_W, CAPTURE_H, buffer);
				gl.setRenderTarget(previous);
				target.dispose();
				return buffer;
			},
		};
		// QA hook: run one real export render and report what the capture
		// camera saw — the layer mask plus an amber scan of the 1920x1080
		// frame (the selection cage's warm tone). Lets the suite prove the
		// deliverable frame stays free of editor furniture without driving
		// the whole generation form.
		window.__captureFrame = () => {
			const buffer = apiRef.current?.render() ?? null;
			if (!buffer) return null;
			let amber = 0;
			for (let i = 0; i < buffer.length; i += 4) {
				const r = buffer[i];
				const g = buffer[i + 1];
				const b = buffer[i + 2];
				if (r >= 180 && g >= 165 && g - b >= 35) amber++;
			}
			return { layersMask: window.__captureCameraMask ?? 0, amber, pixels: buffer.length / 4 };
		};
	}, [gl, scene, camRef, apiRef]);
	return null;
}

/* ----------------------------------------------------------------- app --- */

// Unity's tool keys. They are free because camera movement now lives behind a
// held right button. (docs/unity-reference.md §9.2)
const GIZMO_HOTKEYS = { KeyW: "move", KeyE: "rotate", KeyR: "scale" };

const WORKSPACE_LAYOUT_KEY = "cozyclay.workspace-layout.v1";
const DEFAULT_WORKSPACE_LAYOUT = Object.freeze({
	hierarchyWidth: 300,
	sidebarWidth: 380,
	timelineHeight: 224,
	insetWidth: 310,
	insetHeight: 310,
	insetCollapsed: false,
	planZoom: 1,
});

function loadWorkspaceLayout() {
	try {
		const saved = JSON.parse(localStorage.getItem(WORKSPACE_LAYOUT_KEY) || "null");
		return saved ? { ...DEFAULT_WORKSPACE_LAYOUT, ...saved } : { ...DEFAULT_WORKSPACE_LAYOUT };
	} catch {
		return { ...DEFAULT_WORKSPACE_LAYOUT };
	}
}

/** Load the Scene envelope once. Legacy single-scene objects are migrated by
 * scenes.js; App only supplies the familiar starter set for a truly new room. */
function loadSceneStartup() {
	const defaults = () => DEFAULT_SCENE_OBJECTS.map((object) => ({ ...object, footprint: { ...object.footprint } }));
	try {
		const result = loadSceneDocumentFromStorage(localStorage);
		if (result.status === "future") {
			const document = createSceneDocument();
			document.scenes[0].objects = defaults();
			return {
				document,
				saveBlocked: true,
				error: null,
				toast: ko("Saved scenes were written by a newer CozyClay — they have been left untouched and this session will not save", "저장된 장면은 더 최신 CozyClay에서 만들어졌어요. 이 세션에서는 건드리지 않고 저장도 하지 않습니다."),
			};
		}
		const document = result.document;
		if ((result.status === "absent" || result.status === "corrupt") && document.scenes[0].objects.length === 0) {
			document.scenes[0].objects = defaults();
		}
		return {
			document,
			saveBlocked: false,
			error: null,
			toast: result.status === "corrupt"
				? ko(`Saved scenes were unreadable — starting fresh; the old data is kept under ${SCENES_QUARANTINE_KEY}`, `저장된 장면을 읽을 수 없어 새로 시작합니다. 기존 데이터는 ${SCENES_QUARANTINE_KEY}에 보관했어요.`)
				: result.dropped > 0
					? (isKo ? `저장된 장면 ${result.dropped}개를 복원하지 못했어요` : `${result.dropped} saved scene(s) could not be restored`)
					: null,
		};
	} catch {
		const document = createSceneDocument();
		document.scenes[0].objects = defaults();
		return { document, saveBlocked: false, error: null, toast: null };
	}
}

export default function App() {
	const [workspaceLayout, setWorkspaceLayout] = useState(loadWorkspaceLayout);
	const [preset, setPreset] = useState("medium");
	const [fovDeg, setFovDeg] = useState(PRESETS.medium.fov);
	const [nonce, setNonce] = useState(0);
	// The Top-View is always the inset: the old double-click swap that let the
	// plan own the big pane is gone, so there is no view mode to toggle.
	const planIsMain = false;
	// Unity Scene/Game tabs: PlayView is the framed output only — no editing
	// chrome (gizmo, inset, fly navigation) reaches it.
	const [centerTab, setCenterTab] = useState("scene");
globalThis.playMode = centerTab === "play";
	// PlayView is the player for the finished motion: entering starts playback,
	// leaving pauses it. Scene stays the manipulation surface.
	const [tlPlaying, setTlPlaying] = useState(false);
	useEffect(() => {
		// The player always starts the finished piece from frame 0; auto-play
		// only exists once there is a motion to play.
		if (centerTab === "play") setTlFrame(0);
		if (centerTab === "play" && motion) setTlPlaying(true);
		if (centerTab === "scene") setTlPlaying(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [centerTab]);
	const stageRef = useRef();
	const mainPaneRef = useRef();
	const insetPaneRef = useRef();
	// User-dragged inset position (px, stage-relative). null = the CSS default
	// (top-right); double-clicking the tag snaps back to it.
	const [insetPos, setInsetPos] = useState(null);
	// Timestamp of the last fold toggle that came from the tag strip (click or
	// caret). A double-click started on the tag lands its dblclick event on
	// the pane body afterwards — the body listener skips those, or every tag
	// double-click would toggle twice.
	const insetToggledAtRef = useRef(0);
	const planCamRef = useRef();
	const planHostRef = planIsMain ? mainPaneRef : insetPaneRef;

	useEffect(() => {
		localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify(workspaceLayout));
	}, [workspaceLayout]);

	// Wheel over the inset zooms the Top-View plan: scroll up closes in on
	// the pucks (camera lower), scroll down widens out (camera higher) — the
	// ortho extent is divided by planZoom in DualRender. React's onWheel is
	// passive and could never keep the page still, so a real listener.
	useEffect(() => {
		const pane = insetPaneRef.current;
		if (!pane) return;
		const onWheel = (e) => {
			e.preventDefault();
			setWorkspaceLayout((current) => {
				const next = Math.max(0.25, Math.min(4, current.planZoom * Math.pow(1.0015, -e.deltaY)));
				return next === current.planZoom ? current : { ...current, planZoom: Math.round(next * 100) / 100 };
			});
		};
		pane.addEventListener("wheel", onWheel, { passive: false });
		return () => pane.removeEventListener("wheel", onWheel);
	}, []);

	const workspaceStyle = {
		"--hierarchy-width": `${workspaceLayout.hierarchyWidth}px`,
		"--sidebar-width": `${workspaceLayout.sidebarWidth}px`,
		"--timeline-height": `${workspaceLayout.timelineHeight}px`,
		"--inset-width": `${workspaceLayout.insetWidth}px`,
		"--inset-height": `${workspaceLayout.insetHeight}px`,
	};

	function beginWorkspaceResize(kind, e) {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		const startX = e.clientX;
		const startY = e.clientY;
		const start = workspaceLayout;
		const onMove = (ev) => {
			const dx = ev.clientX - startX;
			const dy = ev.clientY - startY;
			setWorkspaceLayout((current) => {
				if (kind === "sidebar") {
					return {
						...current,
						sidebarWidth: Math.max(280, Math.min(window.innerWidth * 0.5, start.sidebarWidth - dx)),
					};
				}
				if (kind === "hierarchy") {
					return {
						...current,
						hierarchyWidth: Math.max(220, Math.min(window.innerWidth * 0.4, start.hierarchyWidth + dx)),
					};
				}
				return {
					...current,
					timelineHeight: Math.max(110, Math.min(window.innerHeight * 0.58, start.timelineHeight - dy)),
				};
			});
		};
		const onUp = () => {
			document.body.classList.remove("is-resizing", `resize-${kind}`);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
		};
		document.body.classList.add("is-resizing", `resize-${kind}`);
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	}

	// Double-clicking the inset body folds it (like a window titlebar). The
	// tag keeps its own double-click (snap back to the corner); the old
	// Scene↔Top-View big-pane swap on double-click is gone — the Top-View is
	// always the inset, folded or not. Pane divs are pointer-events:none off
	// the plan board, so this hit-tests the rect instead of DOM targeting.
	useEffect(() => {
		const onDblClick = (event) => {
			const pane = insetPaneRef.current;
			if (!pane) return;
			if (event.target.closest?.(".vp-inset-tag")) return; // the tag's own gesture
			if (Date.now() - insetToggledAtRef.current < 450) return; // a tag gesture already folded this double-click
			const rect = pane.getBoundingClientRect();
			if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
			setWorkspaceLayout((current) => ({ ...current, insetCollapsed: !current.insetCollapsed }));
		};
		window.addEventListener("dblclick", onDblClick);
		return () => window.removeEventListener("dblclick", onDblClick);
	}, []);

	// Drag the inset pane by its tag chip. Window-level listeners so a fast
	// drag off the chip keeps moving the pane; bounds clamp to the stage.
	function beginInsetDrag(e) {
		if (e.button !== 0) return;
		const stage = stageRef.current;
		const pane = insetPaneRef.current;
		if (!stage || !pane) return;
		e.preventDefault();
		e.stopPropagation();
		const stageRect = stage.getBoundingClientRect();
		const paneRect = pane.getBoundingClientRect();
		const grabX = e.clientX - paneRect.left;
		const grabY = e.clientY - paneRect.top;
		// Dragging the collapsed pill clamps against the EXPANDED size, so a
		// pill parked at an edge can never expand out from under the sidebar.
		const effW = workspaceLayout.insetCollapsed ? workspaceLayout.insetWidth : paneRect.width;
		const effH = workspaceLayout.insetCollapsed ? workspaceLayout.insetHeight : paneRect.height;
		// Foldout semantics on the tag strip: a click without movement folds,
		// a drag past the threshold moves the pane — same gesture family as the
		// inspector's foldout headers.
		let moved = false;
		const onMove = (ev) => {
			if (!moved && Math.abs(ev.clientX - e.clientX) < 4 && Math.abs(ev.clientY - e.clientY) < 4) return;
			moved = true;
			setInsetPos({
				x: Math.max(8, Math.min(ev.clientX - stageRect.left - grabX, stageRect.width - effW - 8)),
				y: Math.max(8, Math.min(ev.clientY - stageRect.top - grabY, stageRect.height - effH - 8)),
			});
		};
		const onUp = (ev) => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			// A double-click is one deliberate fold, not two: the second click's
			// pointerup carries detail=2 and is ignored, so rapid clicking never
			// flicker-toggles the inset.
			if (!moved && ev.detail <= 1) {
				insetToggledAtRef.current = Date.now();
				if (workspaceLayout.insetCollapsed) expandInset();
				else setWorkspaceLayout((current) => ({ ...current, insetCollapsed: true }));
			}
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	}

	// Expanding reclamps the parked position against the restored size: a
	// pill dragged to the stage edge must expand INTO the stage, not under
	// the inspector sidebar.
	function expandInset() {
		const stage = stageRef.current;
		if (stage) {
			const stageRect = stage.getBoundingClientRect();
			const maxX = Math.max(8, stageRect.width - workspaceLayout.insetWidth - 8);
			const maxY = Math.max(8, stageRect.height - workspaceLayout.insetHeight - 8);
			setInsetPos((pos) => (pos ? { x: Math.min(pos.x, maxX), y: Math.min(pos.y, maxY) } : pos));
		}
		setWorkspaceLayout((current) => ({ ...current, insetCollapsed: false }));
	}

	function beginInsetResize(e) {
		if (e.button !== 0) return;
		const stage = stageRef.current;
		const pane = insetPaneRef.current;
		if (!stage || !pane) return;
		e.preventDefault();
		e.stopPropagation();
		const stageRect = stage.getBoundingClientRect();
		const paneRect = pane.getBoundingClientRect();
		const startX = e.clientX;
		const startY = e.clientY;
		const originX = paneRect.left - stageRect.left;
		const originY = paneRect.top - stageRect.top;
		if (!insetPos) setInsetPos({ x: originX, y: originY });
		const onMove = (ev) => {
			const width = Math.max(190, Math.min(stageRect.width - originX - 8, paneRect.width + ev.clientX - startX));
			const height = Math.max(150, Math.min(stageRect.height - originY - 8, paneRect.height + ev.clientY - startY));
			setWorkspaceLayout((current) => ({ ...current, insetWidth: width, insetHeight: height }));
		};
		const onUp = () => {
			document.body.classList.remove("is-resizing", "resize-inset");
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
		};
		document.body.classList.add("is-resizing", "resize-inset");
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	}
	const [showB, setShowB] = useState(false);
	const [charA, setCharA] = useState({ x: 0, z: 0, rot: 0 });
	const [charB, setCharB] = useState({ x: 1.15, z: 0.1, rot: -14 });
	const [poseA, setPoseA] = useState(DEFAULT_POSE);
	const [poseB, setPoseB] = useState(DEFAULT_POSE);
	const [customPoses, setCustomPoses] = useState(() => loadCustomPoses());
	const [posing, setPosing] = useState(null);
	const [posingClosing, setPosingClosing] = useState(false);
	const [studioPick, setStudioPick] = useState(null);
	const [rigA, setRigA] = useState(null);
	const [rigB, setRigB] = useState(null);
	const [poseRevision, setPoseTick] = useState(0);

	/* ------------------------------ IK layer ------------------------------ */
	// IK posing for Subject 1: dragging a wrist/ankle handle FOCUSES that
	// joint and solves its chain backward (two-bone analytic IK) on top of
	// the current pose; joints never dragged stay purely on the FK pose.
	// Keys land on the Full-Body lane as sparse per-chain world targets and
	// evaluate as the playhead moves. State lives in a ref — it changes
	// every drag tick and must not re-render the scene; ikTick re-renders
	// only the timeline markers.
	const [ikMode, setIkMode] = useState(false);
	const [ikChains, setIkChains] = useState(null);
	const [ikFkJoints, setIkFkJoints] = useState(null);
	const [ikFocus, setIkFocus] = useState(null);
	const [selectedHierarchyId, setSelectedHierarchyId] = useState("characterA");
	// Right-sidebar tab. "inspector" shows the selection's properties; "shot"
	// holds shot-global settings (type presets, prompt); "motion" holds the
	// ARDY workflow in pipeline order. Selecting anything in the scene routes
	// to the inspector tab; the root SHOT row routes to the shot tab.
	const [sidebarTab, setSidebarTab] = useState("motion");
	// Scene persistence (plan §8): the startup load runs once in a lazy
	// initializer so the store below can seed from the restored scene; the
	// quarantine write and the save-block decision happen before the first
	// render, and the toast/error they produce ride along as initial UI state.
	const [startup] = useState(loadSceneStartup);
	const [scenes, setScenes] = useState(startup.document.scenes);
	const [activeSceneId, setActiveSceneId] = useState(startup.document.activeSceneId);
	const startupScene = startup.document.scenes[activeSceneIndex(startup.document.scenes, startup.document.activeSceneId)];
	const [sceneObjects, setSceneObjects] = useState(startupScene.objects);
	const [sceneSaveError, setSceneSaveError] = useState(startup.error);
	const saveBlockedRef = useRef(startup.saveBlocked);
	const dirtyRef = useRef(false);
	// One-shot save-failure toast: the persistent line stays for the session,
	// the toast fires once per failure episode (not on every failed tick).
	const saveFailureToastRef = useRef(false);
	// The single mutation owner (plan §5.3): every scene-object edit — gizmo
	// drags, plan-board drags, inspector scrubs, hierarchy atomics — routes
	// through this store so one interaction is exactly one undo entry and an
	// in-flight drag can be cancelled. setSceneObjects is stable, so the
	// store is constructed once, seeded with the initial scene.
	const storeRef = useRef(null);
	if (!storeRef.current) {
		storeRef.current = createSceneHistoryStore(sceneObjects, { onObjects: setSceneObjects });
	}
	const store = storeRef.current;
	const selectedSceneObjectId = sceneObjectIdFromHierarchy(selectedHierarchyId);
	const selectedSceneObject = sceneObjects.find((object) => object.id === selectedSceneObjectId) ?? null;
	// Foot snap (ground plant): while ON, body (hips) drags keep the feet at
	// the positions captured when the drag started — the knees bend instead
	// of the feet sinking through the floor. Toggleable in the timeline.
	const [footSnap, setFootSnap] = useState(true);
	const ikBodyDragRef = useRef(false); // true while a body drag is active
	// How far (in frames) a correction eases back to the underlying motion
	// outside its keyed range. 6 frames @ 20 fps = 0.3 s — long enough to
	// hide the seam, short enough that a mid-clip fix stays visibly local.
	const IK_CORRECTION_BLEND_FRAMES = 6;

	const ikStateRef = useRef(createIkState());
	const [ikTick, setIkTick] = useState(0);
	const [committedIkEdits, setCommittedIkEdits] = useState([]);
	// Sorted full-body key frames for the timeline markers. Derived from the
	// ref state; ikTick re-derives after every key add/remove.
	const ikFrames = useMemo(() => ikKeyframes(ikStateRef.current),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ikTick]);

	function selectHierarchy(id) {
		// A selection switch is the user starting something else: settle any open
		// drag so its applied travel becomes one committed entry first (plan §6.3).
		// This MUST stay inside the handler, never in the render body: a settle
		// during render runs the producer's cancel teardown, and since the first
		// applied tick re-renders, every drag would die after exactly one tick.
		store.settle();
		setSelectedHierarchyId(id);
		// The root SHOT row is the one non-object row kept as a bridge to the
		// shot-global settings; everything else is a scene entity.
		setSidebarTab(id === "shot" ? "shot" : "inspector");
		const focus = RIG_HIERARCHY_FOCUS[id];
		if (focus && ikMode) setIkFocus(focus);
	}
	// Producer drag lifecycle (plan §6.1): begin issues a token the producer
	// presents on every apply and on close; end commits the drag as one
	// history entry, or rolls it back when commit is false (Escape).
	function beginSceneTransaction({ owner, cancel }) {
		return store.begin(owner, cancel);
	}

	function endSceneTransaction(token, { commit }) {
		store.end(token, { commit });
	}

	function focusIkHandle(focus) {
		setIkFocus(focus);
		const hierarchyId = hierarchyIdForIkFocus(focus);
		if (hierarchyId) {
			setSelectedHierarchyId(hierarchyId);
			setSidebarTab("inspector");
		}
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
		if (wasSelected) {
			setSelectedHierarchyId("props");
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
		const patch = dropToSurfacePatch(object, sceneObjects.filter((item) => item.id !== object.id));
		if (patch === null) {
			setToast(ko("Nothing to drop", "내려놓을 대상이 없어요"));
			return;
		}
		changeSceneObject(object.id, patch);
		setToast(isKo ? `${sceneObjectNameDisplayKo(object.name)}을 표면 위에 내려놓았어요` : `${object.name} dropped to surface`);
	}

	const [gizmoMode, setGizmoMode] = useState("move");
	// Snap is a preference, not a law: with it on the gizmo blocks on the plan
	// board's grid, and Ctrl/Cmd during a drag gives a free one. Off, it is the
	// other way round. (docs/unity-reference.md §9.5)
	const [snapEnabled, setSnapEnabled] = useState(true);
	// True while the right mouse button is flying the camera. Tool hotkeys stand
	// down during a flythrough, because W/A/S/D belong to the camera then.
	const flyingRef = useRef(false);

	function addSceneObject(kind) {
		const camera = shotCamRef.current;
		const placement = camera
			? placementInFront({ x: camera.position.x, z: camera.position.z }, look.current.yaw)
			: {};
		const object = createSceneObject(kind, sceneObjects, placement);
		if (!object) return;
		store.applyAtomic((objects) => [...objects, object]);
		setSelectedHierarchyId(`object:${object.id}`);
		setSidebarTab("inspector");
		// Deliberate divergence from Unity's rename-on-create: creating an object
		// here is followed by placing it, and dropping focus into a text field
		// swallows the very next W/E/R. Renaming stays on F2/Return and the row's
		// context menu. (docs/unity-reference.md §9.7)
		setGizmoMode("move");
		setToast(isKo ? `${sceneObjectNameDisplayKo(object.name)} 추가됨 — W 이동, E 회전, R 크기` : `${object.name} added — W move, E rotate, R scale`);
	}

	function duplicateSelectedSceneObject(id = selectedSceneObjectId) {
		// Defaults to the selection (Ctrl/Cmd+D); the hierarchy context menu
		// passes a specific row's id. Same result either way: the copy is
		// selected, offset one grid step, and toasted.
		const object = sceneObjects.find((item) => item.id === id) ?? null;
		if (!object) return;
		const copy = createSceneObject(object.renderer, sceneObjects, {
			x: object.x,
			z: object.z,
			rot: object.rot,
		});
		if (!copy) return;
		// Unity drops the duplicate exactly on top of the original; for blocking,
		// one grid step to the side means you can see that it worked.
		const placed = { ...object, id: copy.id, name: copy.name, x: object.x + 0.5 };
		store.applyAtomic((objects) => [...objects, placed]);
		setSelectedHierarchyId(`object:${placed.id}`);
		setSidebarTab("inspector");
		setToast(isKo ? `${sceneObjectNameDisplayKo(placed.name)} 복제됨` : `${placed.name} duplicated`);
	}

	/** Frame the selection: fly the shot camera to a comfortable distance along
	 * the current view direction, the way Unity's F key does. Defaults to the
	 * selection; the hierarchy context menu passes a specific row's id. */
	function frameSelection(id = selectedSceneObjectId) {
		const camera = shotCamRef.current;
		const object = sceneObjects.find((item) => item.id === id) ?? null;
		if (!camera || !object) return;
		const size = objectSize(object);
		const target = {
			x: object.x,
			y: (object.y ?? 0) + size.height / 2,
			z: object.z,
		};
		const reach = Math.max(size.width, size.height, size.depth, 0.5);
		const distance = reach * 2.4 + 0.6;
		const back = forwardFrom(look.current.yaw, look.current.pitch).multiplyScalar(-distance);
		camera.position.set(target.x + back.x, Math.max(target.y + back.y, 0.3), target.z + back.z);
		const angles = aimAt(camera.position, target);
		look.current.yaw = angles.yaw;
		look.current.pitch = angles.pitch;
	}

	/** In-place rename commit from the hierarchy (F2 / Return / rename on
	 * create). The row label lives in the tree; the object name is shared
	 * state, so this is just the inspector's rename through another door. */
	function renameSceneObject(id, name) {
		changeSceneObject(id, { name });
	}
	// Undo/redo (plan §6.5). The store settles any open drag first, so a
	// mid-drag press commits that drag as one entry and then steps past it.
	// After a step the selection can point at a deleted object — drop it to
	// props so the inspector cannot show a ghost.
	function undoScene() {
		const restored = store.undo();
		if (restored === null) {
			setToast(ko("Nothing to undo", "실행 취소할 작업이 없어요"));
			return;
		}
		if (selectedSceneObjectId && !restored.some((object) => object.id === selectedSceneObjectId)) {
			setSelectedHierarchyId("props");
		}
		setToast(ko("Undone", "실행 취소됨"));
	}

	function redoScene() {
		const restored = store.redo();
		if (restored === null) {
			setToast(ko("Nothing to redo", "다시 실행할 작업이 없어요"));
			return;
		}
		if (selectedSceneObjectId && !restored.some((object) => object.id === selectedSceneObjectId)) {
			setSelectedHierarchyId("props");
		}
		setToast(ko("Redone", "다시 실행됨"));
	}

	useEffect(() => {
		const onKeyDown = (event) => {
			const target = event.target;
			if (
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement ||
				target instanceof HTMLSelectElement ||
				target?.isContentEditable
			) return;
			// While the right button is flying the camera, W/A/S/D/Q/E are the
			// camera's; a tool switch mid-flight would be a surprise.
			if (flyingRef.current) return;
			// Undo/redo (plan §6.5). The input guard above keeps Ctrl/Cmd+Z in
			// the Name field or the ARDY prompt as the browser's text undo.
			// Placed before the selection gate: undo works with nothing
			// selected, and mid-drag the store's settle commits then steps.
			if (event.code === "KeyZ" && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				if (event.shiftKey) redoScene();
				else undoScene();
				return;
			}
			if (GIZMO_HOTKEYS[event.code]) {
				event.preventDefault();
				setGizmoMode(GIZMO_HOTKEYS[event.code]);
				return;
			}
			if (event.code === "KeyF" && selectedSceneObjectId) {
				event.preventDefault();
				frameSelection();
				return;
			}
			if (event.code === "KeyD" && (event.ctrlKey || event.metaKey) && selectedSceneObjectId) {
				event.preventDefault();
				duplicateSelectedSceneObject();
				return;
			}
			if (event.key === "Escape" && selectedSceneObjectId) {
				setSelectedHierarchyId("props");
				return;
			}
			if (event.code === "End" && selectedSceneObjectId) {
				event.preventDefault();
				dropSelectedSceneObject();
				return;
			}
			if (!selectedSceneObjectId) return;
			if (event.key !== "Delete" && event.key !== "Backspace") return;
			event.preventDefault();
			deleteSelectedSceneObject();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	});

	const [mode, setMode] = useState("image");
	const [imageModel, setImageModel] = useState("gpt_image_2");
	const [videoModel, setVideoModel] = useState("seedance_2");
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
	const nestedShotStartup = readShotAuthoringDocument(startupScene.shotDocument ?? undefined);
	// The nested Scene document wins. The root v3 key remains a migration
	// fallback for users arriving from the single-scene build.
	const startupShotState = nestedShotStartup.state ?? shotStartup.state;
	// Each editorial strip owns its camera keys. The playhead chooses the
	// active strip; there is no shared key list that could blend through a cut.
	const [shots, setShots] = useState(() => startupShotState?.shots ?? initialShots(startupShotState?.frameCount ?? DEFAULT_DURATION_S * 20));
	const [movePlaying, setMovePlaying] = useState(false);
	// Follow slaves the move to the timeline playhead so camera and character
	// motion share one time axis; off frees the camera while both stay set.
	const [moveFollow, setMoveFollow] = useState(true);
	const [railDraw, setRailDraw] = useState(false);
	const [hasCharSheet, setHasCharSheet] = useState(false);
	const [hasEnvSheet, setHasEnvSheet] = useState(false);
	const [subject, setSubject] = useState(DEFAULT_SUBJECT);
	const [subject2, setSubject2] = useState("a man in a dark coat");
	const [environment, setEnvironment] = useState(DEFAULT_ENVIRONMENT);
	const [style, setStyle] = useState("moody cinematic lighting, 35mm film look");

	const [cameraPos, setCameraPos] = useState(DEFAULT_CAMERA_POSITION);
	const [subjectVisible, setSubjectVisible] = useState(true);
	const [result, setResult] = useState(null);
	const [resultOpen, setResultOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const [recordedVideoName, setRecordedVideoName] = useState(null);
	const [toast, setToast] = useState(startup.toast ?? "");
	const [bridge, setBridge] = useState(null);
	const [ardyPrompt, setArdyPrompt] = useState("");
	const [ardyDuration, setArdyDuration] = useState(DEFAULT_DURATION_S);
	// Optional native-ARDY seed: empty string = omit from the request (the
	// box picks its own); otherwise a plain integer in 0..2**31-1.
	const [ardySeed, setArdySeed] = useState("2"); // RT demo parity: its GUI seed defaults to 2, so generation is reproducible out of the box; clear the field for the box's random seed
	const [ardyRunning, setArdyRunning] = useState(false);
	const [ardyStatus, setArdyStatus] = useState("");
	const [consoleLines, setConsoleLines] = useState([]);
	const [bottomTab, setBottomTab] = useState("timeline");
	// ARDY status doubles as a Unity-style console line: the inspector keeps
	// the current line, the bottom Console tab keeps the session history.
	function reportArdyStatus(line) {
		setArdyStatus(line);
		setConsoleLines((current) => [...current.slice(-99), { time: new Date(), line }]);
	}
	const [ardyReport, setArdyReport] = useState(null);
	const [ardyOutcome, setArdyOutcome] = useState(null);
	const ardyAbortRef = useRef(null);
	// ARDY Core runs at 20 fps: the destination frame lives in [0, duration*20-1].
	const maxDst = Math.max(0, Math.round(ardyDuration) * 20 - 1);

	/* --------------------------- motion workspace --------------------------- */
	// The timeline playhead and the root waypoints are App-owned so the scene
	// (character rig, plan path, ARDY card) reacts to every scrub/play tick.
	const [tlFrame, setTlFrame] = useState(0);

	const renderActive = useRenderActivity(tlPlaying || movePlaying);
	const [tlFrameCount, setTlFrameCount] = useState(startupShotState?.frameCount ?? DEFAULT_DURATION_S * 20); // the generation clip length @ 20 fps
	const [tlFps, setTlFps] = useState(20);
	const activeShotIdx = shotIndexAtFrame(shots, tlFrame);
	const activeShot = shots[activeShotIdx] ?? null;
	const cameraKeys = activeShot?.cameraKeys ?? [];
	const activeCamera = createCameraBlock(activeShot?.camera);
	const followCam = activeCamera.followCam;
	const cameraRail = activeCamera.cameraRail;
	const hasCameraKeys = shots.some((shot) => shot.cameraKeys.length > 0);
	function changeActiveCamera(patch, index = activeShotIdx) {
		setShots((current) => current.map((shot, shotIndex) => shotIndex === index
			? { ...shot, camera: updateCameraBlock(shot.camera, patch) }
			: shot));
	}
	function changeFollowCam(patch) {
		changeActiveCamera({ followCam: { ...followCam, ...patch } });
	}
	function changeCameraRail(points) {
		changeActiveCamera({
			cameraRail: points,
			mode: points ? "rail" : activeCamera.mode === "rail" ? "follow" : activeCamera.mode,
		});
	}
	const frameCountRef = useRef(DEFAULT_DURATION_S * 20);
	frameCountRef.current = tlFrameCount;
	// Root waypoints {frame, x, z, heading: null}, kept sorted by frame —
	// the fixed bridge contract rejects out-of-order or duplicate frames.
	const [waypointMode, setWaypointMode] = useState(false);
	const [waypoints, setWaypoints] = useState(startupShotState?.waypoints ?? []);
	const [activeWaypointFrame, setActiveWaypointFrame] = useState(null);
	const [pendingWaypointFrame, setPendingWaypointFrame] = useState(null);
	useEffect(() => {
		// Subject 1 is the sole frame-zero root start. Drop any legacy seeded
		// waypoint so Top-View never renders two start markers.
		setWaypoints((current) => current.filter((waypoint) => waypoint.frame !== 0));
		setActiveWaypointFrame((current) => (current === 0 ? null : current));
		setPendingWaypointFrame((current) => (current === 0 ? null : current));
	}, []);

	/* --------------------------- Scene documents --------------------------- */
	// Refs make a Scene switch synchronous: the outgoing room is sealed with
	// its latest objects and camera department envelope before React opens the
	// destination room.
	const scenesRef = useRef(scenes);
	const activeSceneIdRef = useRef(activeSceneId);
	const shotDocumentRef = useRef(null);
	scenesRef.current = scenes;
	activeSceneIdRef.current = activeSceneId;
	shotDocumentRef.current = createShotAuthoringDocument({ shots, waypoints, frameCount: tlFrameCount });

	function snapshotActiveScene(sourceScenes = scenesRef.current) {
		return sourceScenes.map((scene) => scene.id === activeSceneIdRef.current
			? { ...scene, objects: storeRef.current.objects, shotDocument: shotDocumentRef.current }
			: scene);
	}

	function persistScenes(nextScenes, nextActiveSceneId) {
		if (saveBlockedRef.current) return false;
		try {
			localStorage.setItem(SCENES_STORAGE_KEY, serializeSceneDocument({
				version: 1,
				activeSceneId: nextActiveSceneId,
				scenes: nextScenes,
			}));
			dirtyRef.current = false;
			setSceneSaveError(null);
			if (saveFailureToastRef.current) {
				saveFailureToastRef.current = false;
				setToast("");
			}
			return true;
		} catch (err) {
			const message = `Scenes not saved: ${err?.name || "StorageError"}`;
			setSceneSaveError(message);
			if (!saveFailureToastRef.current) {
				saveFailureToastRef.current = true;
				setToast(message);
			}
			return false;
		}
	}

	function flushScenes() {
		if (!dirtyRef.current) return;
		persistScenes(snapshotActiveScene(), activeSceneIdRef.current);
	}

	function restoredShotState(scene) {
		const restored = readShotAuthoringDocument(scene?.shotDocument ?? undefined);
		if (restored.state) return restored.state;
		const frameCount = DEFAULT_DURATION_S * 20;
		return { shots: initialShots(frameCount), waypoints: [], frameCount };
	}

	function openScene(scene, nextScenes) {
		const shotState = restoredShotState(scene);
		const objects = Array.isArray(scene.objects) ? scene.objects : [];
		storeRef.current = createSceneHistoryStore(objects, { onObjects: setSceneObjects });
		setSceneObjects(objects);
		setShots(shotState.shots);
		setWaypoints(shotState.waypoints);
		setTlFrameCount(shotState.frameCount ?? DEFAULT_DURATION_S * 20);
		setTlFrame(0);
		setMovePlaying(false);
		setRailDraw(false);
		setActiveWaypointFrame(null);
		setPendingWaypointFrame(null);
		setSelectedHierarchyId("shot");
		scenesRef.current = nextScenes;
		activeSceneIdRef.current = scene.id;
		setScenes(nextScenes);
		setActiveSceneId(scene.id);
	}

	function selectSceneDocument(sceneId) {
		if (sceneId === activeSceneIdRef.current) return;
		const savedScenes = snapshotActiveScene();
		const target = savedScenes.find((scene) => scene.id === sceneId);
		if (!target) return;
		persistScenes(savedScenes, sceneId);
		openScene(target, savedScenes);
	}

	function createSceneDocumentFromUi() {
		const savedScenes = snapshotActiveScene();
		const nextScenes = addScene(savedScenes);
		const target = nextScenes[nextScenes.length - 1];
		persistScenes(nextScenes, target.id);
		openScene(target, nextScenes);
	}

	function duplicateSceneDocumentFromUi(sceneId) {
		const savedScenes = snapshotActiveScene();
		const index = savedScenes.findIndex((scene) => scene.id === sceneId);
		if (index < 0) return;
		const nextScenes = duplicateScene(savedScenes, index);
		const target = nextScenes[index + 1];
		persistScenes(nextScenes, target.id);
		openScene(target, nextScenes);
	}

	function renameSceneDocumentFromUi(sceneId, name) {
		const savedScenes = snapshotActiveScene();
		const index = savedScenes.findIndex((scene) => scene.id === sceneId);
		if (index < 0) return;
		const nextScenes = renameScene(savedScenes, index, name);
		scenesRef.current = nextScenes;
		setScenes(nextScenes);
		persistScenes(nextScenes, activeSceneIdRef.current);
	}

	function deleteSceneDocumentFromUi(sceneId) {
		const savedScenes = snapshotActiveScene();
		const index = savedScenes.findIndex((scene) => scene.id === sceneId);
		if (index < 0 || savedScenes.length <= 1) return;
		const nextScenes = removeScene(savedScenes, index);
		if (sceneId !== activeSceneIdRef.current) {
			scenesRef.current = nextScenes;
			setScenes(nextScenes);
			persistScenes(nextScenes, activeSceneIdRef.current);
			return;
		}
		const target = nextScenes[Math.min(index, nextScenes.length - 1)];
		persistScenes(nextScenes, target.id);
		openScene(target, nextScenes);
	}

	// One debounced Scene-document save owns both departments. Switching calls
	// persistScenes directly, so no outgoing edit can be overtaken by a render.
	useEffect(() => {
		dirtyRef.current = true;
		const timer = setTimeout(flushScenes, 400);
		return () => clearTimeout(timer);
	}, [sceneObjects, shots, waypoints, tlFrameCount, scenes, activeSceneId]);
	useEffect(() => {
		const onPageHide = () => flushScenes();
		const onVisibility = () => {
			if (document.visibilityState === "hidden") flushScenes();
		};
		window.addEventListener("pagehide", onPageHide);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("pagehide", onPageHide);
			document.removeEventListener("visibilitychange", onVisibility);
			flushScenes();
		};
	}, []);
	const [promptClips, setPromptClips] = useState(() => DEFAULT_PROMPT_CLIPS.map((clip) => ({ ...clip })));
	const [selectedPromptId, setSelectedPromptId] = useState(null);
	// Loaded motion: decoded arrays plus the world anchor captured at load.
	const [motion, setMotion] = useState(null);
	const [motionBusy, setMotionBusy] = useState(false);
	const [motionError, setMotionError] = useState("");
	// Pre-playback bone snapshot; restoring it (after Character's pose effect
	// has re-applied poseA) puts the rig back exactly where it was.
	const restoreRef = useRef(null);

	const shotCamRef = useRef(null);
	const captureRef = useRef(null);
	const look = useRef({ yaw: 0, pitch: 0 });
	// The poser camera is the IK-mode working view: orbit/dolly/WASD freely
	// while posing WITHOUT touching the shot camera, which stays frozen on
	// the framing and shows in the inset. Two separate screens by design.
	const poserCamRef = useRef(null);
	const poserLook = useRef({ yaw: 0, pitch: 0 });

	const shot = useMemo(
		() => deriveShot(cameraPos, charA, (fovDeg * Math.PI) / 180, SUBJECT_HEIGHT_M),
		[cameraPos, charA, fovDeg],
	);

	// The derived move sequence: what the keyframings geometrically prove
	// segment by segment, not what a dropdown claims. Present from two keys.
	const moveSequence = useMemo(() => {
		if (cameraKeys.length < 2) return null;
		const segs = [];
		for (let i = 0; i < cameraKeys.length - 1; i++) {
			segs.push(
				classifyMove(cameraKeys[i].framing, cameraKeys[i + 1].framing, charA, {
					durationS: (cameraKeys[i + 1].frame - cameraKeys[i].frame) / tlFps,
				}),
			);
		}
		return {
			segs,
			slate: moveSequenceSlate(segs),
			displaySlate: moveSequenceSlateKo(segs),
			phrase: moveSequencePhrase(segs),
			fromShot: segs[0].from,
			spanS: Math.round(((cameraKeys[cameraKeys.length - 1].frame - cameraKeys[0].frame) / tlFps) * 10) / 10,
		};
	}, [cameraKeys, charA, tlFps]);
	// With Follow armed, Preview means "watch the shot": it plays the timeline
	// from frame 0 so character motion and the camera move share one clock.
	// Follow off keeps the camera-only preview on its own clock.
	const followPreviewArmed = moveFollow && hasCameraKeys && !ikMode && !waypointMode && !posing;
	const previewActive = movePlaying || (followPreviewArmed && tlPlaying);

	/* --------------------------- shot video export --------------------------- */
	// Record = play the finished piece in PlayView while mirroring the shot
	// pane into an offscreen 16:9 canvas that MediaRecorder encodes. The mirror
	// crops the letterbox bars, so the file is exactly the frame the shot
	// camera renders — camera move, character motion and the ink pass, none of
	// the editor chrome. Recording rides the same clock as playback and stops
	// itself when the playhead wraps at the clip end.
	const [recState, setRecState] = useState("idle"); // "idle" | "recording"
	const recRef = useRef(null);
	const tlFrameRef = useRef(0);
	tlFrameRef.current = tlFrame;
	const tlPlayingRef = useRef(false);
	tlPlayingRef.current = tlPlaying;
	const playModeRef = useRef(false);
	playModeRef.current = centerTab === "play";
	const tlFrameCountRef2 = useRef(tlFrameCount);
	tlFrameCountRef2.current = tlFrameCount;
	const tlFpsRef2 = useRef(tlFps);
	tlFpsRef2.current = tlFps;
	// While recording, the recorder's wall-clock loop is the playhead's
	// master clock (fixed 1/RECORD_FPS cadence, immune to interval jitter);
	// the timeline's own interval stands down.
	const recordingRef = useRef(false);
	recordingRef.current = recState === "recording";

	function stopShotRecording(reason) {
		const rec = recRef.current;
		if (!rec) return;
		recRef.current = null;
		clearTimeout(rec.timer);
		if (reason === "abort") rec.aborted = true;
		recordingRef.current = false;
		setTlPlaying(false);
		setRecState("idle");
		if (rec.recorder.state !== "inactive") rec.recorder.stop();
		else if (!rec.armed) setToast(ko("Recording cancelled before any frame was captured", "프레임을 캡처하기 전에 녹화가 취소됐어요"));
	}

	// Seedance's reference-video floor is 24 fps while ARDY clips run at 20.
	// Recording plays the clip at 20/24 real time and stamps each captured
	// frame 41.67 ms apart, so the exported file is exactly 24 fps at true
	// motion speed — valid as a camera/motion reference out of the box.
	const RECORD_FPS = 24;

	function toggleShotRecording() {
		if (recRef.current) {
			stopShotRecording("manual");
			return;
		}
		const stage = stageRef.current;
		const glCanvas = stage ? stage.querySelector("canvas") : null;
		if (!glCanvas) return;
		// mp4 first where the platform encoder offers it (Safari, newer Chrome),
		// webm as the everywhere-else answer. No support at all = no feature.
		const MIMES = ["video/mp4;codecs=avc1.640028", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
		const mime = typeof MediaRecorder !== "undefined" ? MIMES.find((m) => MediaRecorder.isTypeSupported(m)) : null;
		if (!mime) {
			setToast(ko("This browser cannot encode video (MediaRecorder unavailable)", "이 브라우저는 영상 인코딩을 지원하지 않아요(MediaRecorder 없음)"));
			return;
		}
		const mirror = document.createElement("canvas");
		mirror.width = 1600;
		mirror.height = 900;
		const ctx = mirror.getContext("2d");
		// Frames go in manually (and only when one was actually drawn): the
		// track must be exactly RECORD_FPS, not whatever the display runs at.
		const track = mirror.captureStream(0).getVideoTracks()[0];
		const recorder = new MediaRecorder(new MediaStream([track]), { mimeType: mime, videoBitsPerSecond: 12_000_000 });
		const chunks = [];
		const slate = (moveSequence?.slate ?? "shot").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "shot";
		const rec = {
			recorder,
			track,
			// all wall-clock anchors land on the first frame so a startup
			// hiccup never stretches clip time
			t0: 0,
			playheadT0: 0,
			outputFrames: 0,
			armed: false,
			warmup: 2,
			aborted: false,
			done: false,
		};
		recorder.ondataavailable = (e) => {
			if (e.data && e.data.size > 0) chunks.push(e.data);
		};
		recorder.onstop = () => {
			if (rec.aborted || chunks.length === 0) return;
			const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
			const name = `cozyclay-${slate}.${ext}`;
			const url = URL.createObjectURL(new Blob(chunks, { type: mime }));
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = name;
			anchor.click();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
			setRecordedVideoName(name);
			setToast(isKo ? `${name} 저장됨` : `Saved ${name}`);
		};
		recRef.current = rec;
		setRecState("recording");
		recordingRef.current = true;
		// PlayView is the finished-output player, so record there: no gizmo, no
		// inset, and the move rides the playhead regardless of Follow. Playing
		// is forced even without a loaded motion so a camera-only move records.
		setCenterTab("play");
		setTlFrame(0);
		setTlPlaying(true);

		// The tick runs in setTimeout (the recorder keeps the event loop alive
		// even in a background tab, where rAF is throttled to zero): wall-clock
		// pacing must not depend on display refresh.
		const timeoutTick = () => {
			if (recRef.current !== rec) return;
			const main = mainPaneRef.current;
			if (!playModeRef.current || !main || !stage) {
				rec.timer = setTimeout(timeoutTick, 20);
				return;
			}
			// a couple of ticks for the PlayView layout + first playMode draw to
			// land, so the file never opens on a stale Scene-tab composite
			if (rec.warmup > 0) {
				rec.warmup -= 1;
				rec.timer = setTimeout(timeoutTick, 20);
				return;
			}
			const now = performance.now();
			if (!rec.armed) {
				rec.armed = true;
				rec.t0 = now;
				rec.playheadT0 = now;
				recorder.start();
			}
			// drive the playhead at fps/RECORD_FPS real time ourselves — the
			// timeline's own clock is suspended while recording (below), so the
			// exported speed is exact regardless of interval jitter
			const clipSeconds = tlFrameCountRef2.current / tlFpsRef2.current;
			const elapsed = now - rec.playheadT0;
			const frame = Math.floor(elapsed / (1000 / RECORD_FPS));
			if (frame >= tlFrameCountRef2.current || elapsed / 1000 > clipSeconds) {
				rec.done = true;
				setTlPlaying(false);
				setRecState("idle");
				recordingRef.current = false;
				recRef.current = null;
				recorder.stop();
				return;
			}
			setTlFrame(frame);
			const stageRect = stage.getBoundingClientRect();
			const mainRect = main.getBoundingClientRect();
			const pane = { x: mainRect.left - stageRect.left, y: mainRect.top - stageRect.top, w: mainRect.width, h: mainRect.height };
			if (pane.w < 2 || pane.h < 2) {
				rec.timer = setTimeout(timeoutTick, 20);
				return;
			}
			const img = fitAspect(pane, SHOT_ASPECT);
			const scale = glCanvas.width / stageRect.width;
			ctx.drawImage(
				glCanvas,
				img.x * scale,
				img.y * scale,
				img.w * scale,
				img.h * scale,
				0,
				0,
				mirror.width,
				mirror.height,
			);
			// fixed output cadence: each captured frame spans exactly one
			// 1/RECORD_FPS of the clip, so a stalled render repeats its frame
			// (hold) instead of compressing the clip
			const nextStamp = rec.t0 + (rec.outputFrames * 1000) / RECORD_FPS;
			rec.outputFrames += 1;
			if (typeof track.requestFrame === "function") {
				track.requestFrame();
				setTimeout(() => {
					if (typeof track.requestFrame === "function") track.requestFrame();
				}, 1000 / (2 * RECORD_FPS));
			}
			rec.timer = setTimeout(timeoutTick, Math.max(0, nextStamp - now + 1000 / RECORD_FPS));
		};
		rec.timer = setTimeout(timeoutTick, 20);
	}

	function captureCurrentFraming() {
		const cam = shotCamRef.current;
		const pos = cam ? cam.position : cameraPos;
		return captureFraming({ pos: { x: pos.x, y: pos.y, z: pos.z }, yaw: look.current.yaw, pitch: look.current.pitch, fovDeg });
	}

	// Key authoring lives in each unified Shot block's lower key strip: clicking
	// an empty point stores the CURRENT framing there. Re-keying overwrites it.
	function addCameraKeyframe(frame) {
		const framing = captureCurrentFraming();
		const target = Math.max(0, Math.min(Math.round(frame), tlFrameCount - 1));
		setShots((current) => {
			const index = shotIndexAtFrame(current, target);
			return current.map((shot, shotIndex) => shotIndex === index ? {
				...shot,
				cameraKeys: shot.cameraKeys.filter((key) => key.frame !== target)
					.concat({ frame: target, framing }).sort((a, b) => a.frame - b.frame),
			} : shot);
		});
		setSelectedHierarchyId("camera");
		setSidebarTab("inspector");
	}

	// Re-time a key by dragging its dot along the lane. Landing on another
	// key's frame is rejected — keys stay frame-unique.
	function moveCameraKeyframe(from, to) {
		const sourceIndex = shotIndexAtFrame(shots, from);
		const min = shots[sourceIndex]?.startFrame ?? 0;
		const max = (shots[sourceIndex + 1]?.startFrame ?? tlFrameCount) - 1;
		const target = Math.max(min, Math.min(Math.round(to), max));
		if (target === from) return;
		setShots((current) => {
			const index = shotIndexAtFrame(current, from);
			const keys = current[index]?.cameraKeys ?? [];
			if (keys.some((key) => key.frame === target)) return current;
			return current.map((shot, shotIndex) => shotIndex === index ? {
				...shot,
				cameraKeys: keys.map((key) => key.frame === from ? { ...key, frame: target } : key).sort((a, b) => a.frame - b.frame),
			} : shot);
		});
	}

	function removeCameraKeyframe(frame) {
		setShots((current) => {
			const index = shotIndexAtFrame(current, frame);
			return current.map((shot, shotIndex) => shotIndex === index
				? { ...shot, cameraKeys: shot.cameraKeys.filter((key) => key.frame !== frame) }
				: shot);
		});
	}

	function clearMove() {
		setMovePlaying(false);
		setShots((current) => current.map((shot, index) => index === activeShotIdx ? { ...shot, cameraKeys: [] } : shot));
	}

	function addTimelineShot() {
		setMovePlaying(false);
		const index = shotIndexAtFrame(shots, tlFrame);
		const start = shots[index]?.startFrame ?? 0;
		const end = shots[index + 1]?.startFrame ?? tlFrameCount;
		const target = tlFrame > start && tlFrame < end ? tlFrame : start + Math.floor((end - start) / 2);
		if (target <= start || target >= end) return;
		setShots((current) => cutAtFrame(current, target, captureCurrentFraming()));
		setTlFrame(target);
	}

	function selectTimelineShot(index) {
		const selected = shots[index];
		if (!selected) return;
		setTlFrame(selected.startFrame);
		setSelectedHierarchyId("camera");
		setSidebarTab("inspector");
	}

	function duplicateTimelineShot(index) {
		const next = duplicateShot(shots, index, tlFrameCount);
		setShots(next);
		if (next !== shots && next[index + 1]) setTlFrame(next[index + 1].startFrame);
	}

	function moveTimelineShot(fromIndex, targetFrame) {
		setShots((current) => {
			const targetIndex = shotIndexAtFrame(current, targetFrame);
			return reorderShot(current, fromIndex, targetIndex, tlFrameCount);
		});
	}

	function resizeTimelineEnd(endFrame) {
		const lastStart = shots.at(-1)?.startFrame ?? 0;
		const nextCount = Math.max(lastStart + 1, Math.round(endFrame) + 1);
		setTlFrameCount(nextCount);
		setTlFrame((current) => Math.min(current, nextCount - 1));
		setShots((current) => current.map((shot, index) => {
			if (index !== current.length - 1) return shot;
			const byFrame = new Map(shot.cameraKeys.map((key) => [Math.min(key.frame, nextCount - 1), { ...key, frame: Math.min(key.frame, nextCount - 1) }]));
			return { ...shot, cameraKeys: [...byFrame.values()].sort((a, b) => a.frame - b.frame) };
		}));
	}

	const allPoses = useMemo(() => [...BUILT_IN_POSES, ...customPoses], [customPoses]);
	const posedRig = () => (posing === "B" ? rigB : rigA);
	const setPosed = posing === "B" ? setPoseB : setPoseA;

	/* ------------------------- waypoint workspace --------------------------- */

	// A walking pace turns clicked distance into clip time, so pins land at
	// frames the character can actually reach without ice-skating.
	const WALK_SPEED_MPS = 1.4;
	const ROOT_ROOM_LIMIT = 11;
	const clampRootPosition = (value) => Math.max(-ROOT_ROOM_LIMIT, Math.min(ROOT_ROOM_LIMIT, value));
	const rootStart = () => ({ frame: 0, x: charA.x, z: charA.z });

	function validateWaypointAt(ordered, index, candidate) {
		const previous = index > 0 ? ordered[index - 1] : rootStart();
		const beforePrevious = index > 1 ? ordered[index - 2] : null;
		const inbound = judgeNextWaypoint(previous, candidate, tlFps, beforePrevious);
		if (!inbound.ok) return inbound;
		const next = ordered[index + 1];
		if (!next) return inbound;
		const outbound = judgeNextWaypoint(candidate, next, tlFps, previous);
		if (!outbound.ok) return outbound;
		return { ok: true, warnings: [...inbound.warnings, ...outbound.warnings] };
	}

	function queueRootWaypointFrame(frame) {
		const target = Math.max(1, Math.min(Math.round(frame), tlFrameCount - 1));
		if (waypoints.some((waypoint) => waypoint.frame === target)) {
			setActiveWaypointFrame(target);
			setPendingWaypointFrame(null);
			setTlFrame(target);
			setWaypointMode(true);
			setSidebarTab("motion");
			setToast(isKo ? `프레임 ${target}의 루트 웨이포인트를 선택했어요. 탑뷰에서 점을 드래그해 위치를 조정하세요.` : `Root waypoint at frame ${target} selected — drag the pin in the Top-View to reposition.`);
			return;
		}
		setPendingWaypointFrame(target);
		setActiveWaypointFrame(null);
		setTlFrame(target);
		setWaypointMode(true);
		setSidebarTab("motion");
		setToast(isKo ? `프레임 ${target}이 예약됐어요. 샷 뷰 바닥을 클릭하면 그 위치에 루트 웨이포인트가 생성됩니다.` : `Frame ${target} is reserved — click the Shot-view floor to drop the root waypoint there.`);
	}
	/** ARDY-demo style authoring: each empty-floor press in the Shot view drops
	    the next waypoint where it was clicked; the frame gap comes from walking
	    distance. The bird's-eye board selects and drags existing waypoints. */
	function addFloorWaypoint(point) {
		const x = clampRootPosition(point.x);
		const z = clampRootPosition(point.z);
		const ordered = [...waypoints].sort((a, b) => a.frame - b.frame);
		const last = ordered[ordered.length - 1] ?? rootStart();
		if (waypoints.length + 1 > MAX_WAYPOINTS) {
			setToast(isKo ? `루트 경로는 웨이포인트 ${MAX_WAYPOINTS}개까지 사용할 수 있어요` : `The root path is capped at ${MAX_WAYPOINTS} waypoints`);
			return;
		}
		const pendingFrame = pendingWaypointFrame == null ? null : Math.max(1, Math.min(Math.round(pendingWaypointFrame), tlFrameCount - 1));
		if (pendingFrame != null && ordered.some((waypoint) => waypoint.frame === pendingFrame)) {
			setToast(isKo ? `프레임 ${pendingFrame}에는 이미 루트 웨이포인트가 있어요. 타임라인에서 빈 프레임을 선택하세요.` : `Frame ${pendingFrame} already has a root waypoint — pick an empty frame on the timeline.`);
			setPendingWaypointFrame(null);
			return;
		}
		// A scrubbed playhead is an explicit statement of time: a click lands on
		// that exact frame. An untouched playhead (it snaps to the last pin
		// after every placement) falls back to walking-distance pacing.
		const playhead = Math.round(tlFrame);
		const pinned = pendingFrame != null || playhead > last.frame;
		const walkGap = Math.max(8, Math.round((Math.hypot(x - last.x, z - last.z) / WALK_SPEED_MPS) * tlFps));
		const frame = pendingFrame ?? (pinned ? Math.min(playhead, tlFrameCount - 1) : last.frame + walkGap);
		if (frame > tlFrameCount - 1) {
			setToast(ko("The path already fills the clip — extend the duration or clear a waypoint", "경로가 이미 클립 길이를 채웠어요. 시간을 늘리거나 웨이포인트를 지워 주세요"));
			return;
		}
		// The generator cannot refuse an impossible pin, so the click is the
		// last moment a human can: block out-of-band legs with the fix named.
		const insertAt = ordered.findIndex((waypoint) => waypoint.frame > frame);
		const index = insertAt === -1 ? ordered.length : insertAt;
		const waypoint = { frame, x, z, heading: null };
		const nextWaypoints = [...ordered.slice(0, index), waypoint, ...ordered.slice(index)];
		const verdict = validateWaypointAt(nextWaypoints, index, waypoint);
		if (!verdict.ok) {
			setToast(isKo ? `배치하지 못했어요 — ${verdict.error}` : `Not placed — ${verdict.error}`);
			return;
		}
		setWaypoints(nextWaypoints);
		setTlFrame(frame);
		setActiveWaypointFrame(frame);
		setPendingWaypointFrame(null);
		const placed = isKo
			? `루트 웨이포인트 ${index + 1} 추가: 프레임 ${frame}${pendingFrame != null ? " (타임라인 예약 프레임)" : pinned ? " (재생 헤드 위치)" : ` (~${(frame / tlFps).toFixed(1)}초 걷기 기준)`}`
			: `Waypoint ${ordered.length + 1} — frame ${frame} ${pendingFrame != null ? "(at the reserved frame)" : pinned ? "(at the playhead)" : `(~${(frame / tlFps).toFixed(1)}s at a walk)`}`;
		setToast(verdict.warnings.length ? `${placed} · ⚠ ${verdict.warnings[0]}` : placed);
	}

	function moveWaypoint(frame, x, z) {
		const target = Math.round(frame);
		const ordered = [...waypoints].sort((a, b) => a.frame - b.frame);
		const index = ordered.findIndex((waypoint) => waypoint.frame === target);
		if (index === -1) return;
		const nextWaypoint = {
			...ordered[index],
			x: clampRootPosition(x),
			z: clampRootPosition(z),
		};
		const nextOrdered = ordered.map((waypoint, i) => (i === index ? nextWaypoint : waypoint));
		const verdict = validateWaypointAt(nextOrdered, index, nextWaypoint);
		if (!verdict.ok) {
			setToast(isKo ? `이 위치는 루트 경로에 맞지 않아요: ${verdict.error}` : `This position doesn't fit the root path: ${verdict.error}`);
			return;
		}
		setWaypoints(nextOrdered);
		setActiveWaypointFrame(target);
		setPendingWaypointFrame((current) => (current === target ? null : current));
		if (verdict.warnings.length) setToast(isKo ? `루트 웨이포인트 이동됨: ${verdict.warnings[0]}` : `Root waypoint moved: ${verdict.warnings[0]}`);
	}

	function removeWaypoint(frame) {
		setWaypoints((prev) => prev.filter((w) => w.frame !== frame));
		setActiveWaypointFrame((current) => (current === frame ? null : current));
		setPendingWaypointFrame((current) => (current === frame ? null : current));
	}

	function toggleWaypointMode() {
		const next = !waypointMode;
		setWaypointMode(next);
		if (!next) {
			setPendingWaypointFrame(null);
			setToast(ko("2D Root path constraints off", "2D 루트 경로 제약 꺼짐"));
			return;
		}

		setToast(ko("2D Root path on — click the set floor in the Shot view to drop waypoints; Subject 1 is the frame 0 start", "2D 루트 경로 켜짐 — 샷 뷰의 세트 바닥을 클릭해 웨이포인트를 놓으세요. 인물 1이 0프레임 시작점입니다"));
	}

	function advanceFrame() {
		// recording paces the playhead on its own fixed-cadence clock
		if (recordingRef.current) return;
		setTlFrame((f) => (f >= frameCountRef.current - 1 ? 0 : f + 1));
	}

	function stepFrame(delta) {
		setTlFrame((f) => Math.max(0, Math.min(f + delta, frameCountRef.current - 1)));
	}

	/* --------------------------- motion playback ---------------------------- */

	// Decoded motion + the world anchor: frame 0 always starts at Subject 1.
	// Authored root destinations are generated by ARDY as sparse constraints,
	// so playback consumes the returned trajectory without coordinate warping.
	async function loadMotion(url, prompt, rotationDeg = charA.rot) {
		setMotionBusy(true);
		setMotionError("");
		// Loading a motion drops out of IK EDIT mode (playback is the new
		// context) — the IK KEYS stay and keep correcting the clip layer-style.
		setIkMode(false);
		try {
			// Re-loading while a motion is active: restore the previous
			// pre-playback baseline first, so the new snapshot is not taken
			// mid-animation and clearing always returns to the blocking pose.
			const previous = restoreRef.current;
			restoreRef.current = null;
			if (previous) restorePlaybackBones(previous.rig, previous.bones);
			const decoded = await loadMotionFromUrl(url);
			const rig = rigA;
			if (!rig) throw new Error(ko("Subject 1 rig is not loaded", "인물 1 리그가 로드되지 않았어요"));
			restoreRef.current = { rig, bones: snapshotPlaybackBones(rig) };
			setMotion({
			// Capture the exact prompt this motion was generated from; the
			// timeline keeps showing it even if the input field is edited
			// afterwards.
			prompt: typeof prompt === "string" ? prompt : "",
				...decoded,
				url,
				anchorX: charA.x,
				anchorZ: charA.z,
				anchorFrame: 0,
				rotationDeg,
			});
			setTlFrameCount(decoded.frames);
			setTlFps(decoded.fps);
			setTlFrame(0);
			setTlPlaying(false);
			setToast(isKo ? `모션 로드됨: ${decoded.frames}프레임 @ ${decoded.fps} fps` : `Motion loaded: ${decoded.frames} frames @ ${decoded.fps} fps`);
		} catch (err) {
			setMotion(null);
			setMotionError(err?.message || String(err));
		} finally {
			setMotionBusy(false);
		}
	}

	// Hosted-demo seed. A build served as static files has no ARDY sidecar, so
	// a first-time visitor would otherwise land on a character standing still
	// with no way to see generated motion. The clip below ships with the build
	// and is loaded once, only when the bridge is absent and nothing has been
	// loaded or generated yet. A local session with the bridge running is
	// untouched.
	const demoSeeded = useRef(false);
	useEffect(() => {
		if (demoSeeded.current) return;
		if (!bridge || bridge.ok) return;
		if (!rigA || motion || motionBusy) return;
		demoSeeded.current = true;
		// Loaded, not played: the clip walks the subject out of the default
		// framing, so autoplay would greet a first-time visitor with an empty
		// room. Frame 0 is composed; PLAYBACK is one click away.
		loadMotion(DEMO_MOTION_URL, DEMO_MOTION_PROMPT).catch(() => {
			/* the seed is a nicety, never a failure the visitor must act on */
		});
	}, [bridge, rigA, motion, motionBusy]);

	function clearMotion() {
		setMotion(null);
		setMotionError("");
		// Back to the pre-generation timeline: the current duration at 20 fps.
		setTlFrameCount(maxDst + 1);
		setTlFps(20);
		setTlFrame((f) => Math.min(f, maxDst));
		setTlPlaying(false);
	}

	// Drive Subject 1's rig from the loaded clip whenever the playhead moves.
	// During playback the pose prop is null so Character's effect never
	// overwrites the animation on unrelated re-renders.
	useEffect(() => {
		if (!motion || !rigA) return;
		applyMotionFrame(rigA, motion, tlFrame);
	}, [motion, rigA, tlFrame]);

	/* ------------------------------ IK logic ------------------------------ */

	// Resolve the IK rig (chains + FK swing joints) whenever Subject 1's rig
	// (re)loads. A rig missing any bone resolves to null and IK mode stays
	// unavailable.
	useEffect(() => {
		const resolved = resolveIkRig(rigA);
		const chains = resolved ? resolved.chains : null;
		setIkChains(chains);
		setIkFkJoints(resolved ? resolved.fkJoints : null);
		ikStateRef.current.chains = chains;
		if (!chains) setIkMode(false);
	}, [rigA]);

	function toggleIkMode() {
		const next = !ikMode;
		if (next) {
			// With a motion loaded, IK edits ON TOP of it: the motion is the
			// rough base layer, the IK keys the correction layer. Every frame
			// applies the clip first and the keyed corrections after, so the
			// composite is what gets pinned for re-generation. Pause playback
			// so a running playhead cannot fight the drag.
			setTlPlaying(false);
			// Self-heal the ref after a hot-reload with an older state shape:
			// a missing `tracked` set would throw on the first drag.
			if (!ikStateRef.current.tracked) ikStateRef.current = createIkState();
			ikStateRef.current.chains = ikChains;
			// Handles open exactly on the effectors of the CURRENT pose —
			// non-destructive entry. (The evaluate effect applies the keyed
			// pose at this frame right after ikMode flips, so re-seating on
			// frame changes is handled there.)
			if (ikChains) ikSeedTargets(ikChains, ikStateRef.current);
			// The main view switches to the poser camera: start it exactly on
			// the shot camera's pose so nothing jumps, then navigation moves
			// the POSER only — the shot camera (inset) stays frozen.
			const shotCam = shotCamRef.current;
			const poserCam = poserCamRef.current;
			if (shotCam && poserCam) {
				poserCam.position.copy(shotCam.position);
				poserCam.quaternion.copy(shotCam.quaternion);
				poserCam.rotation.order = "YXZ";
				poserLook.current = { yaw: shotCam.rotation.y, pitch: shotCam.rotation.x };
			}
			setIkMode(true);
			setToast(motion
				? ko("IK mode — correct the motion; drag end keys the fix at this frame", "IK 모드 — 모션을 보정합니다. 드래그를 끝내면 이 프레임에 보정 키가 찍혀요")
				: ko("IK mode — drag handles in the main view; the shot camera stays frozen in the inset", "IK 모드 — 메인 뷰에서 핸들을 드래그하세요. 샷 카메라는 인셋에 고정됩니다"));
			return;
		}
		// Exit: the keyed pose stays — the evaluate effect re-applies the
		// current frame's keyed rotations the moment ikMode flips, so nothing
		// the user authored is lost by toggling. Untracked/unkeyed parts keep
		// their current (FK) pose.
		setIkMode(false);
		setToast(ko("IK mode off — keyed poses keep playing", "IK 모드 꺼짐 — 키로 찍은 포즈는 계속 재생됩니다"));
	}

	// Drag solve, routed by handle kind: chain targets solve the two-bone
	// chain toward the target; mid joints reposition the elbow/knee with both
	// ends pinned (the handle snaps to the clamped position); FK joints swing
	// toward the pointer. Keys are baked on drag END — see ikDragEnd.
	function ikSolve(kind, trackId, targetWorld) {
		if (kind === "chain") {
			const chain = ikStateRef.current.chains?.get(trackId);
			if (!chain) return;
			ikTouch(ikStateRef.current, trackId);
			ikStateRef.current.targets.set(trackId, targetWorld.clone());
			solveIk(chain, targetWorld);
			return;
		}
		if (kind === "mid") {
			// Mid tracks reference their parent chain through MID_TRACKS.
			const midDef = MID_TRACKS.find((t) => t.id === trackId);
			const chain = midDef ? ikStateRef.current.chains?.get(midDef.chain) : null;
			if (!chain) return;
			ikTouch(ikStateRef.current, chain.track.id);
			solveMidJoint(chain, targetWorld);
			return;
		}
		// Effector swing: the rotation ring on a focused hand/foot. Rotates
		// only the end bone — the solved limb position is untouched — and the
		// bake on drag end now stores b2's quaternion with the chain's.
		if (kind === "swing") {
			const chain = ikStateRef.current.chains?.get(trackId);
			if (!chain || !targetWorld?.axis) return;
			ikTouch(ikStateRef.current, trackId);
			solveEffectorSwing(chain, targetWorld.axis, targetWorld.angle, targetWorld.startQuat, targetWorld.startParentQuat);
			return;
		}
		// Body root (hips): arrow drags translate ({ worldDelta, startLocalPos
		// }), the centre sphere swings ({ axis, angle, startQuat, ... }). With
		// foot snap ON the feet stay at the positions captured when the drag
		// started — the legs re-solve after every hips transform so the knees
		// bend instead of the feet sinking through the floor.
		if (kind === "body") {
			const joint = ikFkJoints?.get(trackId);
			if (!joint) return;
			ikTouch(ikStateRef.current, trackId);
			if (footSnap && !ikBodyDragRef.current && ikChains) {
				// Capture the plant points once, BEFORE the first hips move.
				ikPlantFeet(ikChains, ikStateRef.current);
				ikBodyDragRef.current = true;
			}
			if (targetWorld?.worldDelta && targetWorld?.startLocalPos) solveHipsTranslate(joint, targetWorld.worldDelta, targetWorld.startLocalPos);
			else if (targetWorld?.axis) solveSwingAngle(joint, targetWorld.axis, targetWorld.angle, targetWorld.startQuat, targetWorld.startParentQuat);
			if (footSnap && ikChains) {
				ikSolvePlantedFeet(ikChains, ikStateRef.current);
				// the planted re-solve wrote the leg bones — key them too
				ikTouch(ikStateRef.current, "leftFoot");
				ikTouch(ikStateRef.current, "rightFoot");
			}
			return;
		}
		// FK swing: targetWorld is the trackball payload { axis, angle,
		// startQuat, startParentQuat } from the drag layer.
		const joint = ikFkJoints?.get(trackId);
		if (!joint || !targetWorld?.axis) return;
		ikTouch(ikStateRef.current, trackId);
		solveSwingAngle(joint, targetWorld.axis, targetWorld.angle, targetWorld.startQuat, targetWorld.startParentQuat);
	}

	// Drag end: key the dragged part's local rotations at the playhead, so a
	// scrub away and back restores the dragged pose exactly (slerp).
	function ikDragEnd() {
		ikBodyDragRef.current = false;
		if (ikChains) ikBakeKeyframe(ikChains, ikStateRef.current, tlFrame, ikFkJoints);
		setIkTick((n) => n + 1);
	}

	// Manual key: bake the current tracked rotations at the playhead.
	function ikAddKeyframe() {
		if (!ikChains) return;
		ikBakeKeyframe(ikChains, ikStateRef.current, tlFrame, ikFkJoints);
		setIkTick((n) => n + 1);
		setToast(isKo ? `${tlFrame}프레임에 전신 IK 키를 추가했어요` : `Full-body IK key at frame ${tlFrame}`);
	}

	function ikDeleteKeyframe(frame) {
		ikRemoveKeyframe(ikStateRef.current, frame);
		setIkTick((n) => n + 1);
	}

	// Keyed-pose playback: the IK layer's keyed bone rotations apply at the
	// current frame whether or not IK edit mode is on — IK-authored keys are
	// the source of truth (the user designs first/end keys and ARDY in-
	// betweens them), so scrubbing/playing with IK OFF must still show them.
	// With a motion loaded the clip is the base layer: this effect runs
	// AFTER the motion-apply effect above (definition order), so the keys
	// override the generated pose exactly where corrections were authored —
	// and ONLY there: the blend window eases each correction back to the
	// clip outside its keyed range, so keying frame 39 alone no longer
	// stomps every earlier frame. Skipped while the pose studio is open (FK
	// edits there would be stomped). With no keys at all and IK off there is
	// nothing to apply — pure FK posing / pure motion playback stays
	// untouched.
	useEffect(() => {
		if (!ikChains || !rigA || posing) return;
		if (!ikMode && ikStateRef.current.keys.size === 0) return;
		ikEvaluate(ikChains, ikStateRef.current, tlFrame, ikFkJoints, motion ? IK_CORRECTION_BLEND_FRAMES : 0);
	}, [ikMode, ikChains, rigA, motion, posing, tlFrame, ikTick, ikFkJoints]);

	// Re-seat the handles on the keyed pose when the FRAME changes with IK
	// on — scrubbing to frame 39 shows that frame's interpolated pose AND
	// places the handles on its effectors, ready to edit into a new key.
	// Deliberately NOT in the evaluate effect above: a gizmo axis drag can
	// leave the target offset from the effector on purpose, and re-seeding
	// after every bake would wipe that relationship mid-workflow.
	const ikPrevFrameRef = useRef(tlFrame);
	useEffect(() => {
		const frameChanged = ikPrevFrameRef.current !== tlFrame;
		ikPrevFrameRef.current = tlFrame;
		if (!ikMode || !ikChains || !rigA || posing) return;
		if (!frameChanged) return; // pure toggle-on: evaluate already ran
		ikSeedTargets(ikChains, ikStateRef.current);
	}, [ikMode, ikChains, rigA, motion, posing, tlFrame, ikTick, ikFkJoints]);

	// QA hook: lets headless visual checks read the live rig/motion state
	// (tools/ardy/visual-qa.mjs). Harmless in normal use.
	useEffect(() => {
	window.__cozyclay = {
			rigA, motion, tlFrame, ikMode, ikChains, ikFocus, ik: ikStateRef.current,
			committedIkEdits, waypoints,
			// the camera the main view renders through (poser in IK mode) — QA
			// projections must use this one, not the frozen shot camera
			activeCam: ikMode ? poserCamRef.current : shotCamRef.current,
			shotCam: shotCamRef.current,
			poserCam: poserCamRef.current,
			planCam: planCamRef.current,
			charA,
			insetPane: insetPaneRef.current,
		};
	}, [rigA, motion, tlFrame, ikMode, ikChains, ikFocus, ikTick, charA, committedIkEdits, waypoints]);
	// QA hook (plan §6.5): exposes history depth and the present === objects
	// invariant so the browser suite can assert undo entry counts directly.
	// Reads live store state at call time; re-registered after every render.
	useEffect(() => {
		window.__sceneHistory = () => ({ ...store.depths(), settled: store.present() === store.objects });
	});

	// On clear, restore the exact pre-playback bone rotations. This runs in
	// the parent AFTER Character's pose effect (children flush first), so even
	// a pose change made during playback cannot leak into the restored rig.
	useEffect(() => {
		if (motion) return;
		const saved = restoreRef.current;
		if (!saved) return;
		restoreRef.current = null;
		restorePlaybackBones(saved.rig, saved.bones);
	}, [motion]);

	const motionPos = useMemo(() => {
		if (!motion) return null;
		const f = Math.min(tlFrame, motion.frames - 1);
		const a = Math.min(motion.anchorFrame, motion.frames - 1);
		const offset = toSceneRootOffset(
			motion.rootPos[f * 3] - motion.rootPos[a * 3],
			motion.rootPos[f * 3 + 2] - motion.rootPos[a * 3 + 2],
			motion.rotationDeg,
		);
		return {
			x: motion.anchorX + offset.x,
			z: motion.anchorZ + offset.z,
		};
	}, [motion, tlFrame]);

	// The subject's full per-frame scene trajectory — what the follow camera
	// is derived from. Without a loaded motion the subject stands still and
	// the follow camera simply composes a static frame.
	const subjectTrack = useMemo(() => {
		if (!shots.some((shot) => shot.camera?.mode === "follow" || shot.camera?.mode === "rail")) return null;
		const frames = Math.max(tlFrameCount, 1);
		if (!motion) return Array.from({ length: frames }, () => ({ x: charA.x, z: charA.z }));
		const a = Math.min(motion.anchorFrame, motion.frames - 1);
		return Array.from({ length: frames }, (_, f) => {
			const ff = Math.min(f, motion.frames - 1);
			const offset = toSceneRootOffset(
				motion.rootPos[ff * 3] - motion.rootPos[a * 3],
				motion.rootPos[ff * 3 + 2] - motion.rootPos[a * 3 + 2],
				motion.rotationDeg,
			);
			return { x: motion.anchorX + offset.x, z: motion.anchorZ + offset.z };
		});
	}, [shots, motion, tlFrameCount, charA.x, charA.z]);

	// The dense rail (spline through the drawn control points) — shared by
	// the follow controller and the Top-View display.
	const railCurve = useMemo(() => (cameraRail ? buildRail(cameraRail) : null), [cameraRail]);

	const followTrack = useMemo(() => {
		if (!subjectTrack) return null;
		const yaw = (charA.rot * Math.PI) / 180;
		const combined = new Array(subjectTrack.length).fill(null);
		for (let index = 0; index < shots.length; index += 1) {
			const shot = shots[index];
			const camera = createCameraBlock(shot.camera);
			if (camera.mode === "keys") continue;
			const start = shot.startFrame;
			const end = shots[index + 1]?.startFrame ?? subjectTrack.length;
			const subjectSlice = subjectTrack.slice(start, end);
			const params = { ...camera.followCam, initialDir: { x: Math.sin(yaw), z: Math.cos(yaw) } };
			const rail = camera.mode === "rail" ? buildRail(camera.cameraRail) : null;
			const track = rail
				? buildRailFollowTrack(subjectSlice, tlFps, rail, params)
				: buildFollowTrack(subjectSlice, tlFps, params);
			track.forEach((sample, offset) => { combined[start + offset] = sample; });
		}
		return combined;
	}, [shots, subjectTrack, tlFps, charA.rot]);

	// The follow camera owns the shot camera in the same situations key
	// following would: never while an authoring mode holds the viewport.
	const followCamActive =
		activeCamera.mode !== "keys" && !!followTrack?.[tlFrame] && (centerTab === "play" || (!ikMode && !waypointMode && !posing));

	// Implied locomotion speed per authored segment (@ 20 fps). Shown in the
	// timeline hint so a path that forces a crawl or a sprint is visible
	// before spending a generation on it.
	const pathSpeed = useMemo(() => {
		if (waypoints.length < 1) return null;
		let min = Infinity;
		let max = 0;
		const path = [rootStart(), ...[...waypoints].sort((a, b) => a.frame - b.frame)];
		for (let i = 1; i < path.length; i += 1) {
			const a = path[i - 1];
			const b = path[i];
			const seconds = (b.frame - a.frame) / tlFps;
			if (seconds <= 0) continue;
			const speed = Math.hypot(b.x - a.x, b.z - a.z) / seconds;
			min = Math.min(min, speed);
			max = Math.max(max, speed);
		}
		if (!Number.isFinite(min)) return null;
		return { min, max, warn: min < 0.5 || max > 3 };
	}, [charA.x, charA.z, tlFps, waypoints]);

	const stateBadge = ardyRunning
		? { label: ko("GENERATING", "생성 중"), kind: "generating" }
		: motion
			? { label: ko("PLAYBACK", "재생"), kind: "playback" }
			: waypointMode
				? { label: ko("ROOT PATH", "루트 경로"), kind: "root" }
				: null;

	function openStudio(which) {
		setPosing(which);
		setPosingClosing(false);
		setStudioPick((which === "B" ? poseB : poseA)?.id ?? null);
	}

	function closeStudio() {
		// let the panel play its exit animation before it leaves the tree
		setPosingClosing(true);
		window.setTimeout(() => {
			setPosing(null);
			setPosingClosing(false);
		}, 190);
	}

	function savePose() {
		const rig = posedRig();
		if (!rig) return;
		const pose = {
			id: `custom_${Date.now()}`,
		label: isKo ? `내 포즈 ${customPoses.length + 1}` : `My Pose ${customPoses.length + 1}`,
			prompt: "in the exact body pose shown in the blocking frame",
			bones: capturePose(rig),
			custom: true,
		};
		const next = [...customPoses, pose];
		setCustomPoses(next);
		saveCustomPoses(next);
		setStudioPick(pose.id);
		setPosed(pose);
		setToast(ko("Pose saved", "포즈 저장됨"));
	}

	function removePose(id) {
		const next = deleteCustomPose(id, customPoses);
		setCustomPoses(next);
		saveCustomPoses(next);
		if (poseA?.id === id) setPoseA(DEFAULT_POSE);
		if (poseB?.id === id) setPoseB(DEFAULT_POSE);
		if (studioPick === id) setStudioPick(DEFAULT_POSE.id);
	}

	function applyPreset(key) {
		const p = PRESETS[key];
		setPreset(key);
		setFovDeg(p.fov);
		setShowB(p.two);
		if (p.charB) setCharB(p.charB);
		setNonce((n) => n + 1);
	}

	function bufferToPng(buffer) {
		const canvas = document.createElement("canvas");
		canvas.width = CAPTURE_W;
		canvas.height = CAPTURE_H;
		const ctx = canvas.getContext("2d");
		const image = ctx.createImageData(CAPTURE_W, CAPTURE_H);
		// WebGL reads bottom-up; flip into canvas order.
		for (let row = 0; row < CAPTURE_H; row += 1) {
			const from = (CAPTURE_H - 1 - row) * CAPTURE_W * 4;
			image.data.set(buffer.subarray(from, from + CAPTURE_W * 4), row * CAPTURE_W * 4);
		}
		ctx.putImageData(image, 0, 0);
		return canvas.toDataURL("image/png");
	}

	/** Park the shot camera on a framing, read back a 1920x1080 PNG, and put
	    everything back before the next paint — the viewport never sees it. */
	function captureFramingPng(framing) {
		const cam = shotCamRef.current;
		if (!cam || !captureRef.current) return null;
		const prev = { x: cam.position.x, y: cam.position.y, z: cam.position.z, yaw: look.current.yaw, pitch: look.current.pitch, fov: cam.fov };
		cam.position.set(framing.pos.x, framing.pos.y, framing.pos.z);
		cam.rotation.order = "YXZ";
		cam.rotation.set(framing.pitch, framing.yaw, 0);
		cam.fov = framing.fovDeg;
		cam.updateProjectionMatrix();
		const buffer = captureRef.current.render();
		cam.position.set(prev.x, prev.y, prev.z);
		cam.rotation.set(prev.pitch, prev.yaw, 0);
		look.current.yaw = prev.yaw;
		look.current.pitch = prev.pitch;
		cam.fov = prev.fov;
		cam.updateProjectionMatrix();
		return buffer ? bufferToPng(buffer) : null;
	}

	function copyPrompt(prompt) {
		const write = navigator.clipboard?.writeText(prompt);
		if (!write) return;
		write
			.then(() => {
				setCopied(true);
				setToast(ko("Prompt copied to clipboard", "프롬프트를 클립보드에 복사했어요"));
			})
			.catch(() => {});
	}

	function generate() {
		const models = mode === "video" ? VIDEO_MODELS : IMAGE_MODELS;
		const model = models.find((m) => m.id === (mode === "video" ? videoModel : imageModel));
		// An authored keyframe move outranks the dropdown: the phrase is derived
		// from the framings, and the exported frames become first/last conditioning.
		const movePlan = mode === "video" ? moveSequence : null;
		const prompt = composePrompt({
			mode,
			model,
			shot: movePlan ? movePlan.fromShot : shot,
			subject,
			subject2: showB ? subject2 : null,
			posePhrase: poseA?.prompt ?? "",
			pose2Phrase: showB ? (poseB?.prompt ?? "") : "",
			environment,
			style,
			cameraMove: movePlan ? CUSTOM_MOVE : cameraMove,
			customMove: movePlan ? movePlan.phrase : customMove,
			hasCharSheet,
			hasEnvSheet,
		});
		let frame = null;
		let frameB = null;
		if (movePlan) {
			frame = captureFramingPng(cameraKeys[0].framing);
			frameB = captureFramingPng(cameraKeys[cameraKeys.length - 1].framing);
		} else {
			const buffer = captureRef.current?.render();
			frame = buffer ? bufferToPng(buffer) : null;
		}
		setResult({ prompt, frame, frameB, move: movePlan, mode, modelLabel: model?.label, downloaded: false });
		setResultOpen(true);
		setCopied(false);
		setRecordedVideoName(null);
		copyPrompt(prompt);
	}

	function download() {
		const save = (href, name) => {
			const a = document.createElement("a");
			a.href = href;
			a.download = name;
			document.body.appendChild(a);
			a.click();
			a.remove();
		};
		if (result.frameB) {
			// named for the seat they take in a first/last-frame video request
			save(result.frame, "blocking-frame-A-start.png");
			save(result.frameB, "blocking-frame-B-end.png");
			setToast(ko("Start & end frames downloaded", "시작·끝 프레임 다운로드됨"));
			setResult((current) => current ? { ...current, downloaded: true } : current);
			return;
		}
		save(result.frame, "blocking-frame.png");
		setToast(ko("Frame downloaded", "프레임 다운로드됨"));
		setResult((current) => current ? { ...current, downloaded: true } : current);
	}
	function downloadArdyPose() {
		const rig = posedRig();
		if (!rig) {
			setToast(ko("Character not loaded yet", "캐릭터가 아직 로드되지 않았어요"));
			return;
		}
		const pose = buildArdyPose({
			rig,
			camRef: shotCamRef,
			look,
			fovDeg,
			slate: slateLine(shot),
			rigName: posing === "B" ? "y-bot-tpose" : "x-bot-tpose",
			root: captureArdyRoot(rig),
		});
		const blob = new Blob([JSON.stringify(pose, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "cozyclay-pose.json";
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
		setToast(ko("ARDY pose exported", "ARDY 포즈 내보내기 완료"));
	}
	// Probe the dev sidecar exactly once. A missing bridge is an expected
	// state — CozyClay is a static app and the sidecar is an optional dev
	// companion — so the panel degrades to a hint instead of erroring.
	useEffect(() => {
		let alive = true;
		checkBridge().then((state) => {
			if (alive) setBridge(state);
		});
		return () => {
			alive = false;
		};
	}, []);

	function addPromptClip(frame) {
		const snapped = Math.max(0, Math.round(frame / ARDY_PROMPT_HORIZON_FRAMES) * ARDY_PROMPT_HORIZON_FRAMES);
		const startFrame = Math.max(snapped, promptClips.reduce((max, clip) => Math.max(max, clip.endFrame), 0));
		const clip = { id: `prompt-${Date.now()}`, startFrame, endFrame: startFrame + ARDY_PROMPT_HORIZON_FRAMES, text: "" };
		setPromptClips((prev) => [...prev, clip]);
		setSelectedPromptId(clip.id);
		setTlFrameCount((count) => Math.max(count, clip.endFrame));
		setArdyDuration(Math.max(ARDY_DURATION_MIN, clip.endFrame / 20));
	}

	function changePromptClip(id, text) {
		setPromptClips((prev) => prev.map((clip) => (clip.id === id ? { ...clip, text } : clip)));
		if (id === selectedPromptId) setArdyPrompt(text);
	}

	function resizePromptClip(id, edge, rawFrame) {
		setPromptClips((prev) => {
			const next = prev.map((clip) => {
				if (clip.id !== id) return clip;
				const snapped = Math.max(0, Math.round(rawFrame / ARDY_PROMPT_HORIZON_FRAMES) * ARDY_PROMPT_HORIZON_FRAMES);
				return edge === "start"
					? { ...clip, startFrame: Math.min(snapped, clip.endFrame - ARDY_PROMPT_HORIZON_FRAMES) }
					: { ...clip, endFrame: Math.max(clip.startFrame + ARDY_PROMPT_HORIZON_FRAMES, snapped) };
			});
			const end = next.reduce((max, clip) => Math.max(max, clip.endFrame), ARDY_PROMPT_HORIZON_FRAMES);
			setTlFrameCount((count) => Math.max(count, end));
			setArdyDuration(end / 20);
			return next;
		});
	}

	function movePromptClip(id, rawStartFrame) {
		setPromptClips((prev) => {
			const next = movePromptClipFrames(prev, id, rawStartFrame, ARDY_PROMPT_HORIZON_FRAMES);
			if (next === prev) return prev;
			const end = next.reduce((max, clip) => Math.max(max, clip.endFrame), ARDY_PROMPT_HORIZON_FRAMES);
			setTlFrameCount((count) => Math.max(count, end));
			setArdyDuration(end / 20);
			return next;
		});
	}

	function removePromptClip(id) {
		setPromptClips((prev) => prev.filter((clip) => clip.id !== id));
		if (selectedPromptId === id) setSelectedPromptId(null);
	}

	function changeDuration(value) {
	const duration = Math.max(ARDY_DURATION_MIN, Math.min(Math.round(Number(value)) || ARDY_DURATION_MIN, ARDY_DURATION_MAX));
		setArdyDuration(duration);
		// Keep a stale destination frame in range when duration shrinks.
		// The generation clip is duration × 20 frames; root waypoints beyond
		// its end would be invalid for a new shorter generation, so prune
		// them even while a motion is loaded (the frame-0 start survives).
		const last = Math.max(0, duration * 20 - 1);
		setWaypoints((prev) => prev.filter((w) => w.frame <= last));
		// Without a loaded motion the timeline IS the generation clip: resize
		// it to duration × 20 and clamp the playhead. While a motion is loaded
		// the timeline keeps the clip's own frame count and playhead until clear.
		if (!motion) {
			setTlFrameCount(last + 1);
			setTlFrame((f) => Math.min(f, last));
		}
	}

	// Optional native-ARDY seed. Empty = request omits seed; the raw string
	// is kept as typed (trimmed only). runArdy validates the bridge contract
	// (integer in 0..2**31-1) right before the request and toasts on a
	// violation, so an invalid seed can never reach the bridge silently.
	function changeArdySeed(value) {
		setArdySeed(value.trim());
	}

	function runAllPromptBlocks() {
		const clips = promptClips
			.filter((clip) => clip.text.trim())
			.sort((a, b) => a.startFrame - b.startFrame);
		if (!clips.length) {
			setToast(ko("Add at least one Prompt Block before generating", "생성하기 전에 프롬프트 블록을 하나 이상 추가하세요"));
			return;
		}
		const totalFrames = Math.max(...clips.map((clip) => clip.endFrame));
		const duration = Math.max(ARDY_DURATION_MIN, Math.ceil(totalFrames / 20));
		setArdyPrompt(clips[0].text);
		setArdyDuration(duration);
		runArdy({
			promptOverride: clips[0].text,
			durationOverride: duration,
			promptClipsOverride: clips,
		});
	}

	async function runArdy({
		promptOverride = ardyPrompt,
		durationOverride = ardyDuration,
		promptClipsOverride = [],
	} = {}) {
		const rig = posedRig();
		if (!rig) {
			setToast(ko("Character not loaded yet", "캐릭터가 아직 로드되지 않았어요"));
			return;
		}
		// Root guidance sends only authored sparse keys. ARDY owns every
		// in-between frame; no dense interpolation or playback warp is applied.
		// Prompt and duration are bridge-contract inputs too: reject bad
		// values here, before any pose build or network, with a specific toast.
		const prompt = promptOverride.trim();
		if (!prompt) {
			setToast(ko("Motion prompt is required — describe what the subject should do before generating", "모션 프롬프트가 필요해요 — 생성 전에 피사체가 할 동작을 설명하세요"));
			return;
		}
		if (prompt.length > ARDY_PROMPT_MAX) {
			setToast(isKo ? `모션 프롬프트는 ${ARDY_PROMPT_MAX}자까지예요(현재 ${prompt.length}자). 생성 전에 줄여 주세요` : `Motion prompt is capped at ${ARDY_PROMPT_MAX} characters (currently ${prompt.length}) — shorten it before generating`);
			return;
		}
		// Regeneration must keep the loaded clip's exact frame count. The form
		// may still show an older duration after a motion is loaded; using it
		// would ask ARDY for (for example) 120 frames against an 80-frame base.
		const duration = motion && ikFrames.length > 0
			? motion.frames / motion.fps
			: Math.round(Number(durationOverride)) || ARDY_DURATION_MIN;
		if (duration < ARDY_DURATION_MIN || duration > ARDY_DURATION_MAX) {
			setToast(isKo ? `길이는 ${ARDY_DURATION_MIN}초에서 ${ARDY_DURATION_MAX}초 사이여야 해요` : `Duration must be between ${ARDY_DURATION_MIN} and ${ARDY_DURATION_MAX} seconds`);
			return;
		}
		const seed = ardySeed === "" ? null : Number(ardySeed);
		if (seed !== null && (!Number.isInteger(seed) || seed < 0 || seed > ARDY_SEED_MAX)) {
			setToast(isKo ? `Seed는 0..${ARDY_SEED_MAX} 범위의 정수여야 해요. 비워 두면 자동으로 선택됩니다` : `Seed must be an integer in 0..${ARDY_SEED_MAX} — clear it to let the box pick one`);
			return;
		}
		// Prompt clips are real generation blocks. Gaps inherit the current
		// prompt so the bridge always receives one contiguous 0..N sequence.
		// Built BEFORE the root-path judge: whether the rollout is chained
		// changes which window limit binds the path (per block, not per clip).
		const clipFrames = duration * 20;
		const segments = [];
		let cursor = 0;
		const sourcePromptClips = promptClipsOverride
			.filter((clip) => clip.text.trim())
			.sort((a, b) => a.startFrame - b.startFrame);
		for (const clip of sourcePromptClips) {
			const startFrame = Math.max(cursor, Math.min(clipFrames, clip.startFrame));
			const endFrame = Math.max(startFrame, Math.min(clipFrames, clip.endFrame));
			if (startFrame > cursor) segments.push({ startFrame: cursor, endFrame: startFrame, prompt });
			if (endFrame - startFrame >= 3) segments.push({ startFrame, endFrame, prompt: clip.text.trim() || prompt });
			cursor = Math.max(cursor, endFrame);
			if (cursor >= clipFrames) break;
		}
		if (cursor < clipFrames) segments.push({ startFrame: cursor, endFrame: clipFrames, prompt });
		if (segments.length === 0) segments.push({ startFrame: 0, endFrame: clipFrames, prompt });
		const hasPromptSchedule = segments.length > 1;
		const rootPath = waypointMode
			? [{ frame: 0, x: charA.x, z: charA.z, heading: null }, ...waypoints]
			: [];
		if (waypointMode) {
			if (waypoints.length < 1) {
				setToast(ko("Add at least one root destination before generating", "생성하기 전에 루트 목적지를 하나 이상 추가하세요"));
				return;
			}
			if (rootPath.length > MAX_WAYPOINTS) {
				setToast(isKo ? `루트 경로는 드문 웨이포인트 ${MAX_WAYPOINTS}개까지 사용할 수 있어요` : `The root path is capped at ${MAX_WAYPOINTS} sparse waypoints`);
				return;
			}
			if (waypoints.some((waypoint) => waypoint.frame <= 0 || waypoint.frame >= clipFrames)) {
				setToast(isKo ? `루트 웨이포인트 프레임은 1..${clipFrames - 1} 안에 있어야 해요` : `Root waypoint frames must stay inside 1..${clipFrames - 1}`);
				return;
			}
			// Placement-time checks can be invalidated afterwards (removing a
			// middle pin merges two legs; the duration field can grow), so the
			// whole path is re-judged at the door. A prompt schedule chains
			// the rollout block by block, so the trained window binds each
			// block instead of the whole clip.
			const pathVerdict = judgeAuthoredPath(rootPath, 20, clipFrames, { chained: hasPromptSchedule });
			if (pathVerdict.errors.length > 0) {
				setToast(isKo ? `생성하지 못했어요 — ${pathVerdict.errors[0]}` : `Not generated — ${pathVerdict.errors[0]}`);
				return;
			}
			if (hasPromptSchedule) {
				const longBlock = segments.find((segment) => segment.endFrame - segment.startFrame > PATH_LIMITS.clipMaxS * 20);
				if (longBlock) {
					setToast(isKo
						? `생성하지 못했어요 — 루트 경로가 있을 때 각 프롬프트 블록은 ${PATH_LIMITS.clipMaxS}초 이내여야 해요(ARDY 연쇄 호출 학습 범위). ${((longBlock.endFrame - longBlock.startFrame) / 20).toFixed(1)}초 블록을 나눠 주세요`
						: `Not generated — with a root path every prompt block must stay within ${PATH_LIMITS.clipMaxS} s (ARDY's trained window per chained call); split the ${((longBlock.endFrame - longBlock.startFrame) / 20).toFixed(1)} s block`);
					return;
				}
			}
			if (pathVerdict.warnings.length > 0) setToast(`⚠ ${pathVerdict.warnings[0]}`);
		}
		// Align + densify, never the raw sparse path: the model forces frame-0
		// facing to +Z, so the path is rotated until its first travel tangent
		// is +Z (heading 0) and resampled with path-tangent headings — sparse
		// heading-less pins that fight the forced facing corrupt the whole
		// track (see the sign-convention notes in ardy/waypoints.js).
		const alignedRoot = waypointMode ? alignArdyPath(rootPath, charA.rot, MAX_WAYPOINTS) : null;
		const ardyWaypoints = alignedRoot ? alignedRoot.waypoints : [];

		// Capture every block boundary plus every authored IK key. Each sample
		// is the composite base-motion + IK pose at that frame and carries the
		// live ARDY root recovered from positional skinning.
		const editedSegments = motion && hasPromptSchedule
			? segments.filter((segment) =>
				ikFrames.some((frame) => frame >= segment.startFrame && frame < segment.endFrame)
			)
			: [];
		const hasBlockEdits = editedSegments.length > 0;
		const shouldPin = hasBlockEdits || (!hasPromptSchedule && Boolean(motion || ikFrames.length > 0));
		const constraintFrames = !shouldPin
			? []
			: waypointMode
				? [0]
				: hasBlockEdits
					? ikFrames.filter((frame) =>
						editedSegments.some((segment) => frame >= segment.startFrame && frame < segment.endFrame)
					)
				: [...new Set([
				...segments.flatMap((segment) => [
					segment.startFrame,
					Math.min(segment.endFrame - 1, segment.startFrame + 1),
					Math.max(segment.startFrame, segment.endFrame - 2),
					segment.endFrame - 1,
				]),
				...ikFrames.filter((frame) => frame >= 0 && frame < clipFrames),
			])].sort((a, b) => a - b);
		const currentFrame = tlFrame;
		const poses = constraintFrames.map((constraintFrame) => {
			if (motion) applyMotionFrame(rig, motion, constraintFrame);
			if (ikChains && ikStateRef.current.keys.size > 0) {
				ikEvaluate(ikChains, ikStateRef.current, constraintFrame, ikFkJoints, motion ? IK_CORRECTION_BLEND_FRAMES : 0);
			}
			return {
				frame: constraintFrame,
				pose: buildArdyPose({
					rig,
					camRef: shotCamRef,
					look,
					fovDeg,
					slate: slateLine(shot),
					rigName: posing === "B" ? "y-bot-tpose" : "x-bot-tpose",
					root: captureArdyRoot(rig),
				}),
			};
		});
		if (motion) applyMotionFrame(rig, motion, currentFrame);
		if (ikChains && ikStateRef.current.keys.size > 0) {
			ikEvaluate(ikChains, ikStateRef.current, currentFrame, ikFkJoints, motion ? IK_CORRECTION_BLEND_FRAMES : 0);
		}

		// ARDY generates in Subject 1's clip-local frame. Frame 0 is therefore
		// always the origin; scene placement and the total scene->clip rotation
		// (actor yaw plus the path-alignment fold) are restored only at
		// playback, without constraining any later generated root frame.
		const rootRotationDeg = alignedRoot ? alignedRoot.rotationDeg : charA.rot;
		const controller = new AbortController();
		ardyAbortRef.current = controller;
		setArdyRunning(true);
		reportArdyStatus(ko("connecting…", "연결 중…"));
		setArdyReport(null);
		setArdyOutcome(null);
		try {
			const body = { prompt, duration, posePin: shouldPin };
			if (shouldPin && !hasBlockEdits) body.poses = poses;
			if (ardySeed !== "") body.seed = Number(ardySeed);
			if (waypointMode) {
				body.waypoints = ardyWaypoints;
				// A root path and a prompt schedule now travel TOGETHER: the
				// sequence generator threads the Root2D constraint set through
				// its chained calls (the interactive demo's pattern), so
				// neither authored surface is silently dropped any more.
				if (hasPromptSchedule && !hasBlockEdits) body.segments = segments;
			} else if (hasBlockEdits) {
				if (!motion?.url) {
					throw new Error(ko("The current motion has no bridge source; generate the prompt blocks once before regenerating IK edits", "현재 모션에 브리지 원본이 없어요. 프롬프트 블록을 한 번 생성한 뒤 IK 보정을 다시 생성하세요"));
				}
				const startFrame = Math.min(...editedSegments.map((segment) => segment.startFrame));
				const endFrame = Math.max(...editedSegments.map((segment) => segment.endFrame));
				const posesByFrame = new Map(poses.map((entry) => [entry.frame, entry.pose]));
				body.motionEdit = {
					sourceMotion: motion.url,
					startFrame,
					endFrame,
					contextBefore: 40,
					contextAfter: 20,
					edits: constraintFrames.map((frame) => ({
						frame,
						tracks: [...(ikStateRef.current.keys.get(frame)?.keys() || [])],
						pose: posesByFrame.get(frame),
					})),
				};
			} else if (hasPromptSchedule) body.segments = segments;
			let editCommitReport = null;
			const done = await ardyGenerate(
				body,
				(event) => {
					if (event.event === "status") reportArdyStatus(event.message);
					else if (event.event === "report") {
						setArdyReport(event.report);
						if (hasBlockEdits) editCommitReport = event.report;
					}
				},
				{ signal: controller.signal },
			);
			if (
				hasBlockEdits &&
				(
					editCommitReport?.commit_verified !== true ||
					!body.motionEdit.edits.every((entry) =>
						editCommitReport.committed_keys?.includes(entry.frame)
					)
				)
			) {
				throw new Error(ko("ARDY returned motion without verified authored IK keys", "ARDY가 검증된 수동 IK 키 없이 모션을 반환했어요"));
			}
			setArdyOutcome({ ok: true, output: done.output, bytes: done.bytes, motionUrl: done.motionUrl, rotationDeg: rootRotationDeg });
			// Fetch and decode the real npz right away; decode errors are shown
			// in the card, playback is never faked.
			if (done.motionUrl) await loadMotion(done.motionUrl, prompt, rootRotationDeg);
			if (hasBlockEdits) {
				setCommittedIkEdits((current) => [
					...current,
					...body.motionEdit.edits.map(({ frame, tracks }) => ({ frame, tracks })),
				]);
				ikStateRef.current.keys.clear();
				ikStateRef.current.tracked.clear();
				ikStateRef.current.plants.clear();
				setIkTick((value) => value + 1);
			}
			setToast(ko("ARDY motion generated", "ARDY 모션 생성됨"));
		} catch (err) {
			// Cancellation surfaces as an AbortError; everything else is the
			// bridge or the generator explaining itself.
			setArdyOutcome({
				ok: false,
				message: err?.name === "AbortError" ? ko("Cancelled", "취소됨") : err?.message || String(err),
			});
		} finally {
			setArdyRunning(false);
			ardyAbortRef.current = null;
		}
	}

	function cancelArdy() {
		ardyAbortRef.current?.abort();
	}

	const models = mode === "video" ? VIDEO_MODELS : IMAGE_MODELS;

	return (
		<div className={"app" + (renderActive ? "" : " render-idle")}>
			<header className="topbar">
				<div className="logo">
					<span className="wordmark">
						Cozy <span>Clay</span>
					</span>
				</div>
				<div className="topbar-actions">
					<LocaleToggle />
					<InstallApp />
				</div>
			</header>

			<div className="main" style={workspaceStyle}>
			<div className="workspace">
				<aside className="panel hierarchy-left" aria-label={ko("Hierarchy", "계층")}>
				<HierarchyPanel
					selectedId={selectedHierarchyId}
					onSelect={selectHierarchy}
					showB={showB}
					motionFrames={motion?.frames ?? 0}
					ikFrames={ikFrames.length}
					ikMode={ikMode}
					waypointCount={waypoints.length}
					sceneObjects={sceneObjects}
					scenes={scenes}
					activeSceneId={activeSceneId}
					onSceneSelect={selectSceneDocument}
					onSceneCreate={createSceneDocumentFromUi}
					onSceneDuplicate={duplicateSceneDocumentFromUi}
					onSceneRename={renameSceneDocumentFromUi}
					onSceneDelete={deleteSceneDocumentFromUi}
					onAddObject={addSceneObject}
					onRenameObject={renameSceneObject}
					onDuplicateObject={duplicateSelectedSceneObject}
					onDeleteObject={deleteSceneObject}
					onFrameObject={frameSelection}
				/>
				</aside>
				<div
					className="workspace-splitter workspace-splitter-vertical"
					role="separator"
					aria-label={ko("Resize hierarchy panel", "계층 패널 크기 조절")}
					onPointerDown={(event) => beginWorkspaceResize("hierarchy", event)}
				/>
				<div className="viewport">
				<div className="pane-tabs" role="tablist" aria-label={ko("Center view", "가운데 보기")}>
					<button
						type="button"
						role="tab"
						aria-selected={centerTab === "scene"}
						className={centerTab === "scene" ? "active" : ""}
						onClick={() => setCenterTab("scene")}
					>
						{ko("Scene", "장면")}
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={centerTab === "play"}
						className={centerTab === "play" ? "active" : ""}
						onClick={() => setCenterTab("play")}
					>
						{ko("PlayView", "재생 보기")}
					</button>
				</div>
				{centerTab === "scene" && (
				<div className="editor-toolbar scene-tools" aria-label={ko("Scene tools", "장면 도구")}>
						<div className="tool-switch" role="group" aria-label={ko("Gizmo tool", "기즈모 도구")}>
							<button
								type="button"
								className={gizmoMode === "move" ? "active" : ""}
								title={ko("Move tool (W)", "이동 도구 (W)")}
								aria-pressed={gizmoMode === "move"}
								onClick={() => setGizmoMode("move")}
							>
								<svg viewBox="0 0 16 16" aria-hidden="true" className="tool-icon"><path d="M8 1v14M1 8h14" stroke="currentColor" strokeWidth="1.4"/><path d="M8 1 6 3h4L8 1zM8 15l-2-2h4l-2 2zM1 8l2-2v4L1 8zM15 8l-2-2v4l2-2z" fill="currentColor"/></svg>
								{ko("Move", "이동")}
							</button>
							<button
								type="button"
								className={gizmoMode === "rotate" ? "active" : ""}
								title={ko("Rotate tool (E)", "회전 도구 (E)")}
								aria-pressed={gizmoMode === "rotate"}
								onClick={() => setGizmoMode("rotate")}
							>
								<svg viewBox="0 0 16 16" aria-hidden="true" className="tool-icon"><circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M13.4 8l2-2v4l-2 2z" fill="currentColor" transform="rotate(45 13.4 8)"/></svg>
								{ko("Rotate", "회전")}
							</button>
							<button
								type="button"
								className={gizmoMode === "scale" ? "active" : ""}
								title={ko("Scale tool (R)", "크기 도구 (R)")}
								aria-pressed={gizmoMode === "scale"}
								onClick={() => setGizmoMode("scale")}
							>
								<svg viewBox="0 0 16 16" aria-hidden="true" className="tool-icon"><rect x="3" y="3" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M13 13h-4M13 13V9M13 13l-3.5-3.5" stroke="currentColor" strokeWidth="1.4" fill="none"/></svg>
								{ko("Scale", "크기")}
							</button>
						</div>
						<button
							type="button"
							className={"snap-switch" + (snapEnabled ? " active" : "")}
							title={ko("Grid snapping — hold Ctrl during a drag to invert", "그리드 스냅 — 드래그 중 Ctrl을 누르면 반대로 작동")}
							aria-pressed={snapEnabled}
							onClick={() => setSnapEnabled((v) => !v)}
						>
							{ko("Snap", "스냅")}
						</button>
					</div>
				)}

					<div className="stage" id="stage" ref={stageRef} data-render-loop={renderActive ? "always" : "demand"}>
						<Canvas frameloop={renderActive ? "always" : "demand"} dpr={[1, 2]} gl={{ preserveDrawingBuffer: true, antialias: true }}>
							<RenderLoopController stageRef={stageRef} />
							<ViewportLayoutInvalidator
								insetX={insetPos?.x ?? null}
								insetY={insetPos?.y ?? null}
								insetWidth={workspaceLayout.insetWidth}
								insetHeight={workspaceLayout.insetHeight}
								hierarchyWidth={workspaceLayout.hierarchyWidth}
								sidebarWidth={workspaceLayout.sidebarWidth}
								timelineHeight={workspaceLayout.timelineHeight}
								planZoom={workspaceLayout.planZoom}
							/>
							<color attach="background" args={["#eef4f3"]} />
							<StageLights />
							<Room />
							<SetProps objects={sceneObjects} selectedId={selectedSceneObjectId} />

							<PerspectiveCamera
								ref={shotCamRef}
								makeDefault={!ikMode}
								fov={fovDeg}
								near={0.1}
								far={100}
								position={[0.97, 1.62, 2.39]}
							/>
							{/* the poser camera is the default (event/raycast) camera in
							    IK mode so handle hit-testing matches what you see */}
							<PerspectiveCamera
								ref={poserCamRef}
								makeDefault={ikMode}
								fov={fovDeg}
								near={0.1}
								far={100}
								position={[0.97, 1.62, 2.39]}
							/>
							{/* a plan is a plan: orthographic, framed to the working area, so
							    pucks stay the same size wherever they sit */}
							<OrthographicCamera
								ref={planCamRef}
								near={0.1}
								far={80}
								position={[0, 24, 0]}
								rotation={[-Math.PI / 2, 0, 0]}
							/>

							<Character
								url={CHARACTER_MODEL_URL}
								position={motion ? [motion.anchorX, 0, motion.anchorZ] : [charA.x, 0, charA.z]}
								rot={motion ? motion.rotationDeg : charA.rot}
								tint={CLAY}
								pose={motion ? null : poseA}
								onRig={setRigA}
								pickId="A"
							/>
							{showB && (
								<Character
									url={CHARACTER_MODEL_URL}
									position={[charB.x, 0, charB.z]}
									rot={charB.rot}
									tint={CLAY_B}
									pose={poseB}
									onRig={setRigB}
									pickId="B"
								/>
							)}

							<ShotRig
								preset={preset}
								nonce={nonce}
								fovDeg={fovDeg}
								charA={charA}
								charB={charB}
								showB={showB}
								probeX={motionPos ? motionPos.x : charA.x}
								probeZ={motionPos ? motionPos.z : charA.z}
								camRef={shotCamRef}
								look={look}
								onMetrics={(p, visible) => {
									setCameraPos((prev) =>
										Math.abs(prev.x - p.x) + Math.abs(prev.y - p.y) + Math.abs(prev.z - p.z) > 1e-4
											? { x: p.x, y: p.y, z: p.z }
											: prev,
									);
									setSubjectVisible((prev) => (prev === visible ? prev : visible));
								}}
							/>
							<MoveRig
								playing={movePlaying}
								// Authoring modes own the viewport: placing or dragging a root
								// waypoint scrubs the playhead as a side effect, and follow
								// must not turn that scrub into a camera lurch. Same for IK
								// and pose studio, where the shot camera is deliberately frozen.
								// PlayView is the finished-output player: the move always rides
								// the playhead there. The Follow toggle and authoring-mode gates
								// only protect the Scene tab's manipulation surfaces.
								// This shot's Camera Block owns the camera while Follow or Rail is active;
								// editorial camera keys resume when the block returns to Keys mode.
								following={!followCamActive && hasCameraKeys && (centerTab === "play" || (moveFollow && !ikMode && !waypointMode && !posing))}
								followFrame={tlFrame}
								fps={tlFps}
								keys={cameraKeys}
								shots={shots}
								anchor={charA}
								camRef={shotCamRef}
								look={look}
								isInterrupted={() => flyingRef.current}
								onDone={(finalFov) => {
									setMovePlaying(false);
									setFovDeg(Math.round(finalFov * 10) / 10);
								}}
							/>
							<FollowCamRig
								enabled={followCamActive && !movePlaying}
								frame={tlFrame}
								track={followTrack}
								camRef={shotCamRef}
								look={look}
								isInterrupted={() => flyingRef.current}
							/>
							{/* Camera stays live in IK mode but drives the POSER camera,
							    never the shot camera: the handle layer only consumes
							    pointerdowns that hit a handle, so empty-space drags orbit
							    and the wheel dollies without wrecking the framing. */}
							<FlyControls
								enabled={!posing && !playMode}
								camRef={ikMode ? poserCamRef : shotCamRef}
								look={ikMode ? poserLook : look}
								getPivot={() => {
									if (!selectedSceneObject) return null;
									const size = objectSize(selectedSceneObject);
									return { x: selectedSceneObject.x, y: (selectedSceneObject.y ?? 0) + size.height / 2, z: selectedSceneObject.z };
								}}
								onFlyStateChange={(flying) => {
									flyingRef.current = flying;
								}}
							/>
							<PoseHandles
								root={posing === "B" ? rigB : rigA}
								enabled={!!posing && !planIsMain && !playMode}
								onChange={() => setPoseTick((n) => n + 1)}
							/>
							<IkHandles
								chains={ikChains}
								fkJoints={ikFkJoints}
								ikState={ikStateRef.current}
								enabled={ikMode && !posing && !playMode}
								focus={ikFocus}
								onFocus={focusIkHandle}
								onSolve={ikSolve}
								onDragEnd={ikDragEnd}
							/>
							<PlanBoard
								hostRef={planHostRef}
								planCamRef={planCamRef}
								shotCamRef={shotCamRef}
								look={look}
								fovDeg={fovDeg}
								charA={charA}
								setCharA={setCharA}
								charB={charB}
								setCharB={setCharB}
								showB={showB}
								waypoints={waypoints}
								activeWaypointFrame={activeWaypointFrame}
								onSelectWaypoint={(frame) => { setActiveWaypointFrame(frame); setTlFrame(Math.min(frame, tlFrameCount - 1)); setWaypointMode(true); }}
								onMoveWaypoint={moveWaypoint}
								// Selection switch first, then the producer begins its
								// transaction (plan §6.4): the settle here commits any
								// previously open drag as one entry so the fresh token
								// issued by onObjectMoveStart cannot leak.
								onSelectEntity={(id) => {
									store.settle();
									setSelectedHierarchyId(id.startsWith("object:") ? id : id === "cam" ? "camera" : id === "b" ? "characterB" : "characterA");
								}}
								sceneObjects={sceneObjects}
								selectedSceneObjectId={selectedSceneObjectId}
								onMoveSceneObject={changeSceneObject}
								onObjectMoveStart={beginSceneTransaction}
								onObjectMoveEnd={endSceneTransaction}
								cameraRailPoints={railCurve ? railCurve.points : null}
								railDraw={railDraw}
								onRailStroke={(stroke) => {
									const simplified = simplifyStroke(stroke, 0.12);
									if (simplified.length < 2) return;
									changeCameraRail(simplified);
									setRailDraw(false);
									const curve = buildRail(simplified);
									setToast(isKo ? `카메라 레일 완성 — ${curve ? curve.length.toFixed(1) : "?"} m, 제어점 ${simplified.length}개` : `Camera rail drawn — ${curve ? curve.length.toFixed(1) : "?"} m, ${simplified.length} control points`);
								}}
							/>
							{/* Object gizmo: the shot pane's direct manipulation. Off while
							    the plan owns the big pane (the pucks are the handles there)
							    and while posing/IK owns the pointer. */}
							<ObjectGizmo
								object={selectedSceneObject}
								objects={sceneObjects}
								mode={gizmoMode}
								snap={snapEnabled}
								enabled={!planIsMain && !posing && !ikMode && !playMode}
								paneRef={mainPaneRef}
								camRef={shotCamRef}
								onChange={changeSceneObject}
								onDragStart={beginSceneTransaction}
								onDragEnd={endSceneTransaction}
								onSelect={(id) =>
									selectHierarchy(
										id === "char:A" ? "characterA" : id === "char:B" ? "characterB" : id ? `object:${id}` : "props",
									)
								}
								onGroundClick={waypointMode && !planIsMain ? addFloorWaypoint : undefined}
							/>
							{/* Authoring chrome: the grid and pins belong to the Scene tab
							    only — PlayView is the finished output and shows none of it. */}
							{centerTab === "scene" && <SceneGrid />}
							{centerTab === "scene" && railCurve && <CameraRailScenePreview points={railCurve.points} />}
							{waypointMode && centerTab === "scene" && (
								<ShotPathPreview waypoints={waypoints} start={charA} activeWaypointFrame={activeWaypointFrame} />
							)}
							<CaptureRig apiRef={captureRef} camRef={shotCamRef} />
							<DualRender
								stageRef={stageRef}
								mainRef={mainPaneRef}
								insetRef={insetPaneRef}
								shotCamRef={shotCamRef}
								planCamRef={planCamRef}
								poserCamRef={poserCamRef}
								ikMode={ikMode}
								planIsMain={planIsMain}
								playMode={playMode}
								insetCollapsed={workspaceLayout.insetCollapsed}
								planZoom={workspaceLayout.planZoom}
							/>
						</Canvas>

						<div ref={mainPaneRef} className={"vp-pane vp-main" + (planIsMain ? " plan" : "")} />
						<div
							ref={insetPaneRef}
							hidden={playMode}
							className={"vp-pane vp-inset" + (planIsMain || ikMode ? " shot" : " plan") + (workspaceLayout.insetCollapsed ? " collapsed" : "")}
							style={insetPos ? { left: insetPos.x, top: insetPos.y, right: "auto" } : undefined}
						>
							<span
								className="vp-inset-tag"
								title={workspaceLayout.insetCollapsed ? ko("Click or ▸ to expand · drag to move", "클릭 또는 ▸로 펼치기 · 드래그로 이동") : ko("Click or ▾ to fold · drag to move", "클릭 또는 ▾로 접기 · 드래그로 이동")}
								onPointerDown={beginInsetDrag}
							>
								<span
									className="vp-inset-caret"
									role="button"
									tabIndex={-1}
									aria-expanded={!workspaceLayout.insetCollapsed}
									aria-label={workspaceLayout.insetCollapsed ? ko("Expand inset view", "인셋 보기 펼치기") : ko("Collapse inset view", "인셋 보기 접기")}
									title={workspaceLayout.insetCollapsed ? ko("Expand inset view", "인셋 보기 펼치기") : ko("Collapse inset view", "인셋 보기 접기")}
									onPointerDown={(e) => e.stopPropagation()}
									// Same one-fold-per-gesture rule as the tag: ignore the
									// second click of a double-click (detail=2).
									onClick={(e) => {
										if (e.detail > 1) return;
										insetToggledAtRef.current = Date.now();
										if (workspaceLayout.insetCollapsed) expandInset();
										else setWorkspaceLayout((current) => ({ ...current, insetCollapsed: true }));
									}}
								>
									{workspaceLayout.insetCollapsed ? "▸" : "▾"}
								</span>
								{planIsMain || ikMode ? ko("Shot view", "샷 뷰") : ko("Top-View", "탑뷰")}
								{!planIsMain && !ikMode && workspaceLayout.planZoom !== 1 && !workspaceLayout.insetCollapsed && (
									<em className="vp-inset-zoom">{workspaceLayout.planZoom.toFixed(2).replace(/\.?0+$/, "")}×</em>
								)}
							</span>
							{!workspaceLayout.insetCollapsed && (
								<span
									className="vp-inset-resize"
									role="separator"
								aria-label={ko("Resize inset view", "인셋 보기 크기 조절")}
									onPointerDown={beginInsetResize}
								/>
							)}
						</div>

						<div className="film-frame" hidden={playMode}>
							<span />
							<span />
							<span />
							<span />
						</div>
						<div className={"caption" + (subjectVisible ? "" : " off")} hidden={playMode}>
							{subjectVisible ? slateLineKo(shot) : ko("SUBJECT OUT OF FRAME", "피사체가 프레임 밖에 있어요")}
						</div>

						{playMode && !motion && (
							<div className="playview-empty" role="status">
								<strong>{ko("No motion yet", "아직 모션이 없어요")}</strong>
								<span>{ko("Generate motion in the Scene tab — PlayView plays the finished result.", "장면 탭에서 모션을 생성하세요. 재생 보기는 완성 결과를 보여줍니다.")}</span>
							</div>
						)}

						{posing && (
							<PoseStudioPanel
								subject={posing === "B" ? 2 : 1}
								poses={allPoses}
								selectedId={studioPick}
								closing={posingClosing}
								motionActive={Boolean(motion)}
								onSelect={setStudioPick}
								onApply={(selectedPoseId) => {
									const pose = allPoses.find((p) => p.id === selectedPoseId);
									if (pose) {
										const hadMotion = Boolean(motion);
										if (hadMotion) clearMotion();
										setPosed(pose);
										closeStudio();
										setToast(hadMotion ? ko("Cleared the current motion and applied the pose", "현재 모션을 지우고 포즈를 적용했어요") : ko("Pose applied", "포즈를 적용했어요"));
									} else {
										setToast(ko("Couldn't find the selected pose — pick again", "선택한 포즈를 찾지 못했어요. 다시 골라 주세요"));
									}
								}}
								onReset={() => {
									if (motion) clearMotion();
									setStudioPick(DEFAULT_POSE.id);
									setPosed(DEFAULT_POSE);
									setToast(ko("Back to the default pose", "기본 포즈로 돌아왔어요"));
								}}
								onSave={savePose}
								onDelete={removePose}
								onClose={closeStudio}
							/>
						)}
						</div>
					</div>

				<div
					className="workspace-splitter workspace-splitter-vertical"
					role="separator"
					aria-label={ko("Resize hierarchy and inspector panel", "계층 및 속성 패널 크기 조절")}
					onPointerDown={(event) => beginWorkspaceResize("sidebar", event)}
				/>
				<aside className="panel hierarchy-sidebar inspector-sidebar" data-inspector={selectedHierarchyId} data-tab={sidebarTab}>
					{/* Save failures live above the tab content, not inside the Props
					    card: that card is hidden whenever any hierarchy node is
					    selected, and saves fire exactly while objects are being
					    edited — the one case where a failure line inside it is
					    invisible. As a sibling of the tab panes this line stays
					    on screen for every selection and every tab until the
					    next successful write clears it (plan §8.4); the one-shot
					    toast still announces each failure episode. */}
					{sceneSaveError && (
						<p className="scene-save-error" role="status">
							{sceneSaveError}
						</p>
					)}
					<section className="inspector-pane">
					<div className="inspector-tabs" role="tablist" aria-label={ko("Sidebar tabs", "사이드바 탭")}>
						{[
							["inspector", ko("Inspector", "속성")],
							["shot", ko("Shot", "샷")],
							["motion", ko("Motion", "모션")],
						].map(([tab, label]) => (
							<button
								key={tab}
								type="button"
								role="tab"
								aria-selected={sidebarTab === tab}
								className={sidebarTab === tab ? "active" : ""}
								onClick={() => setSidebarTab(tab)}
							>
								{label}
							</button>
						))}
					</div>
					{sidebarTab === "inspector" && (
						<div className="inspector-heading">
						<strong>{ko("Inspector", "속성")}</strong>
						<span className="inspector-heading-selection">{selectedSceneObject ? sceneObjectNameDisplayKo(selectedSceneObject.name) : HIERARCHY_INSPECTOR_TITLES[selectedHierarchyId] ?? ko("Selection", "선택 항목")}</span>
						</div>
					)}
					<div className="inspector-scroll">
				<Foldout hidden={sidebarTab !== "shot"} title={ko("Shot type", "샷 종류")}>
						<div className="presets">
							{Object.entries(PRESETS).map(([key, p]) => (
								<button key={key} className={preset === key ? "active" : ""} onClick={() => applyPreset(key)}>
									{p.label}
								</button>
							))}
						</div>
					</Foldout>

					{/* Camera animation is authored against the same playhead as motion,
					    so keep its controls beside the Motion tools as well as Shot setup. */}
					<Foldout hidden={!(sidebarTab === "shot" || sidebarTab === "motion" || (sidebarTab === "inspector" && selectedHierarchyId === "camera"))} title={ko("Camera", "카메라")}>
					<Slider label={ko("Lens (FOV)", "렌즈 (FOV)")} min={14} max={90} step={1} value={fovDeg} unit="°" onChange={setFovDeg} />
						<div className="readout">
						<span title={ko("camera to subject", "카메라와 피사체 거리")}>{shot.distance.toFixed(2)} m</span>
						<span title={ko("nearest prime on a full-frame sensor", "풀프레임 기준 가장 가까운 단렌즈")}>{shot.focalMm} mm</span>
						<span title={ko("angle relative to the subject's eyes", "피사체 눈높이 기준 각도")}>{shot.elevationDeg.toFixed(0)}°</span>
						</div>
						<button className="btn ghost" onClick={() => setNonce((n) => n + 1)}>
							{ko("Recenter on subject", "피사체 다시 맞추기")}
						</button>

						<h3 className="move-head">{ko("Move keys", "움직임 키")}</h3>
						<div className="move-ab">
							<button
								type="button"
								className="btn ghost"
								title={ko("Key the current framing at the playhead frame", "현재 프레이밍을 재생 헤드 프레임에 키로 저장")}
								onClick={() => addCameraKeyframe(tlFrame)}
							>
								{ko("+ Key here", "+ 여기 키 찍기")}
							</button>
							<button
								type="button"
								className="btn ghost"
								disabled={!hasCameraKeys}
								title={ko("Play the move. With Follow on it plays the timeline too, so character motion rides along; right-drag interrupts", "카메라 움직임을 재생합니다. 따라가기가 켜져 있으면 타임라인도 함께 재생되어 캐릭터 모션이 따라옵니다. 오른쪽 드래그로 중단됩니다")}
								onClick={() => {
									if (followPreviewArmed) {
										if (tlPlaying) {
											setTlPlaying(false);
											return;
										}
										setTlFrame(0);
										setTlPlaying(true);
										return;
									}
									setMovePlaying((playing) => !playing);
								}}
							>
								{previewActive ? ko("Stop", "정지") : ko("Preview", "미리보기")}
							</button>
							<button
								type="button"
								className="btn ghost"
								disabled={!hasCameraKeys}
								title={ko("Slave the move to the timeline: play or scrub and the camera rides along. Turn off to fly freely while keys stay set", "움직임을 타임라인에 연결합니다. 재생하거나 스크럽하면 카메라가 함께 움직입니다. 끄면 키는 유지한 채 자유롭게 이동할 수 있습니다")}
								onClick={() => setMoveFollow((follow) => !follow)}
							>
								{moveFollow ? ko("Follow ✓", "따라가기 ✓") : ko("Follow", "따라가기")}
							</button>
							<button type="button" className="btn ghost" disabled={cameraKeys.length < 1} onClick={clearMove}>
								{ko("Clear", "지우기")}
							</button>
							<button
								type="button"
								className={"btn ghost" + (recState === "recording" ? " rec-live" : "")}
								disabled={!hasCameraKeys && !motion}
								title={ko("Play the piece in PlayView and save it as a video file — camera move and character motion, no editor chrome", "재생 보기에서 장면을 재생하고 영상 파일로 저장합니다. 카메라 움직임과 캐릭터 모션만 담고 편집 UI는 제외됩니다")}
								onClick={toggleShotRecording}
							>
								{recState === "recording" ? ko("■ Stop rec", "■ 녹화 정지") : ko("● Record", "● 녹화")}
							</button>
						</div>
						{moveSequence ? (
							<div className="move-slate" title={ko("derived from the keyframings, not chosen from a list", "목록에서 고른 값이 아니라 키프레임에서 계산된 움직임입니다")}>
								{moveSequence.displaySlate} · {moveSequence.spanS}{ko("s", "초")}
							</div>
						) : (
							<div className="move-slate">
								{cameraKeys.length === 1
									? (isKo ? `프레임 ${cameraKeys[0].frame}부터 고정 샷 — 샷 블록 아래 빈 줄을 클릭해 움직임을 추가하세요` : `locked-off hold from frame ${cameraKeys[0].frame} — click the empty lower strip in a Shot block to add a move`)
									: ko("click a Shot block's lower strip to key the current framing at that frame", "샷 블록 아래 빈 줄을 클릭하면 해당 프레임에 현재 프레이밍을 저장합니다")}
							</div>
						)}

						<h3 className="move-head">{ko("Follow cam", "팔로우 카메라")}</h3>
						<div className="move-ab">
							<button
								type="button"
								className="btn ghost"
								title={ko("Derive the camera from the subject's trajectory: a steadicam trailing behind, or a dolly on a drawn rail. Keys pause while it owns the camera", "피사체 이동 경로에서 카메라를 계산합니다. 뒤에서 따라가는 스테디캠 또는 그린 레일 위 돌리로 동작합니다. 이 모드가 카메라를 잡고 있을 때 키는 멈춥니다")}
								onClick={() => changeActiveCamera({ mode: activeCamera.mode === "keys" ? (cameraRail ? "rail" : "follow") : "keys" })}
							>
								{activeCamera.mode !== "keys" ? ko("Follow ●", "따라가기 ●") : ko("Follow cam", "팔로우 카메라")}
							</button>
							<button
								type="button"
								className={"btn ghost" + (railDraw ? " rec-live" : "")}
								disabled={activeCamera.mode === "keys"}
								title={ko("Draw the camera rail in the Top-View: drag one stroke across the deck. Esc mid-stroke cancels", "탑뷰에서 카메라 레일을 그립니다. 바닥 위로 한 번 드래그하세요. 그리는 중 Esc를 누르면 취소됩니다")}
								onClick={() => {
									const next = !railDraw;
									setRailDraw(next);
									if (next) {
										setWorkspaceLayout((current) => ({ ...current, insetCollapsed: false }));
									setToast(ko("Draw the rail in the Top-View — drag one stroke across the deck", "탑뷰에서 레일을 그리세요 — 바닥 위로 한 번 드래그하면 됩니다"));
									}
								}}
							>
								{railDraw ? ko("Drawing…", "그리는 중…") : ko("✏ Rail", "✏ 레일")}
							</button>
							<button
								type="button"
								className="btn ghost"
								disabled={!cameraRail}
								title={ko("Remove the drawn rail; follow-cam settings and subject motion stay unchanged", "그린 레일만 지웁니다. 팔로우 카메라 설정과 피사체 모션은 그대로 유지됩니다")}
								onClick={() => changeCameraRail(null)}
							>
								{ko("Clear rail", "레일 지우기")}
							</button>
						</div>
						{activeCamera.mode !== "keys" && (
							<>
								{railCurve && (
									<button
										type="button"
										className={"btn ghost" + (followCam.railStartMode === "head" ? " active" : "")}
										title={ko("Start at the rail's drawn head. Turn off to auto-place the dolly at the nearest useful point; rail direction and speed stay unchanged", "레일을 그리기 시작한 지점에서 출발합니다. 끄면 돌리를 가까운 유효 지점에 자동 배치하며, 레일 방향과 속도는 바뀌지 않습니다")}
										onClick={() => changeFollowCam({ railStartMode: followCam.railStartMode === "head" ? "nearest" : "head" })}
									>
										{followCam.railStartMode === "head" ? ko("Start at rail head ✓", "레일 시작점에서 출발 ✓") : ko("Auto-place nearest", "가까운 지점에 자동 배치")}
									</button>
								)}
								<div title={ko("Set the camera-to-subject spacing; this does not change dolly speed or lens height", "카메라와 피사체 사이 간격을 정합니다. 돌리 속도와 렌즈 높이는 바꾸지 않습니다")}>
									<Slider label={ko("Distance", "거리")} min={1} max={8} step={0.1} value={followCam.distance} unit=" m" onChange={(distance) => changeFollowCam({ distance })} />
								</div>
								<div title={ko("Set the physical lens height; this does not tilt the camera", "렌즈의 물리적 높이를 정합니다. 카메라 틸트는 바꾸지 않습니다")}>
									<Slider label={ko("Height", "높이")} min={0.4} max={4} step={0.05} value={followCam.height} unit=" m" onChange={(height) => changeFollowCam({ height })} />
								</div>
								<div title={ko("Set how softly the dolly catches up; this changes acceleration feel, not its top speed", "돌리가 얼마나 부드럽게 따라붙는지 정합니다. 가속 느낌만 바꾸며 최고 속도는 바꾸지 않습니다")}>
									<Slider label={ko("Damping", "댐핑")} min={0.2} max={2} step={0.05} value={followCam.response} unit=" s" onChange={(response) => changeFollowCam({ response })} />
								</div>
								<div title={ko("Aim ahead along the subject's motion; this changes framing only, not dolly speed", "피사체가 움직일 앞쪽을 조준합니다. 프레이밍만 바꾸며 돌리 속도는 그대로입니다")}>
									<Slider label={ko("Look-ahead", "조준 선행")} min={0} max={0.6} step={0.05} value={followCam.lead} unit=" s" onChange={(lead) => changeFollowCam({ lead })} />
								</div>
								{railCurve && (
									<div title={ko("Cap dolly travel speed along the rail; this does not change damping or the subject's motion", "레일 위 돌리의 최고 이동 속도를 제한합니다. 댐핑과 피사체 모션은 바꾸지 않습니다")}>
										<Slider label={ko("Dolly speed", "돌리 속도")} min={0.2} max={8} step={0.1} value={followCam.maxDollySpeed} unit=" m/s" onChange={(maxDollySpeed) => changeFollowCam({ maxDollySpeed })} />
									</div>
								)}
								<div title={ko("Tilt above or below automatic subject aim; this does not move the camera or change lens height", "피사체 자동 조준각에서 위아래로 틸트합니다. 카메라 위치와 렌즈 높이는 바꾸지 않습니다")}>
									<Slider label={ko("Pitch offset", "피치 오프셋")} min={-30} max={30} step={1} value={followCam.pitchOffsetDeg} unit="°" onChange={(pitchOffsetDeg) => changeFollowCam({ pitchOffsetDeg })} />
								</div>
								<div className="move-slate" title={ko("what the rig is doing, derived from the setup — a rail makes it a dolly, none makes it a steadicam", "설정에서 계산한 카메라 동작입니다. 레일이 있으면 돌리, 없으면 스테디캠입니다")}>
									{railCurve
										? (isKo
											? `레일 돌리 · ${railCurve.length.toFixed(1)} m · ${followCam.railStartMode === "head" ? "시작점 출발" : "가까운 지점 자동 배치"} · 최고 ${followCam.maxDollySpeed.toFixed(1)} m/s`
											: `DOLLY ON RAIL · ${railCurve.length.toFixed(1)} m · ${followCam.railStartMode === "head" ? "START HEAD" : "AUTO NEAREST"} · MAX ${followCam.maxDollySpeed.toFixed(1)} m/s`)
										: ko("STEADICAM FOLLOW", "스테디캠 팔로우")} · {isKo ? `${followCam.distance.toFixed(1)} m 유지 · 피치 ${followCam.pitchOffsetDeg >= 0 ? "+" : ""}${followCam.pitchOffsetDeg.toFixed(0)}°` : `HOLD ${followCam.distance.toFixed(1)} m · PITCH ${followCam.pitchOffsetDeg >= 0 ? "+" : ""}${followCam.pitchOffsetDeg.toFixed(0)}°`}
								</div>
							</>
						)}
					</Foldout>

				<Foldout hidden={sidebarTab !== "inspector" || !["characters", "characterA", "characterB"].includes(selectedHierarchyId)} title={showB ? ko("Subjects", "인물들") : ko("Subject", "인물")}>
						<div className={"subjects-row" + (showB ? "" : " single")}>
							<SubjectBox
							label={ko("Subject 1", "인물 1")}
								value={charA}
								onChange={setCharA}
								onPose={() => openStudio("A")}
								posing={posing === "A"}
							/>
							{showB && (
								<SubjectBox
								label={ko("Subject 2", "인물 2")}
									value={charB}
									onChange={setCharB}
									onRemove={() => setShowB(false)}
									onPose={() => openStudio("B")}
									posing={posing === "B"}
								/>
							)}
						</div>
						{!showB && (
							<button type="button" className="add-subject" onClick={() => setShowB(true)}>
								<span className="as-plus">＋</span>
								<span>{ko("Add second subject", "두 번째 인물 추가")}</span>
							</button>
						)}
					</Foldout>

				<Foldout hidden={sidebarTab !== "inspector" || !["characters", "characterA", "characterB"].includes(selectedHierarchyId)} title={ko("Pose", "포즈")}>
					<Field label={showB ? ko("Subject 1 pose", "인물 1 포즈") : ko("Pose", "포즈")}>
							<Dropdown
							ariaLabel={ko("Subject 1 pose", "인물 1 포즈")}
								value={poseA?.id}
							options={allPoses.map((p) => ({ value: p.id, label: poseLabelKo(p) }))}
								onChange={(id) => setPoseA(allPoses.find((p) => p.id === id))}
							/>
						</Field>
						{showB && (
						<Field label={ko("Subject 2 pose", "인물 2 포즈")}>
								<Dropdown
								ariaLabel={ko("Subject 2 pose", "인물 2 포즈")}
									value={poseB?.id}
								options={allPoses.map((p) => ({ value: p.id, label: poseLabelKo(p) }))}
									onChange={(id) => setPoseB(allPoses.find((p) => p.id === id))}
								/>
							</Field>
						)}
					</Foldout>

				<Foldout hidden={sidebarTab !== "shot"} title={ko("Prompt", "프롬프트")}>
						<div className="segmented" data-active={mode}>
							<button className={mode === "image" ? "active" : ""} onClick={() => setMode("image")}>
							{ko("Image", "이미지")}
							</button>
							<button className={mode === "video" ? "active" : ""} onClick={() => setMode("video")}>
							{ko("Video", "영상")}
							</button>
						</div>
					<Field label={ko("Model", "모델")}>
							<Dropdown
							ariaLabel={ko("Model", "모델")}
								value={mode === "video" ? videoModel : imageModel}
								options={models.map((m) => ({ value: m.id, label: m.label }))}
								onChange={mode === "video" ? setVideoModel : setImageModel}
							/>
						</Field>

						<div className="sheet-checks">
							<label className="check">
								<input type="checkbox" checked={hasCharSheet} onChange={(e) => setHasCharSheet(e.target.checked)} />
								<span>{ko("I have a character sheet", "캐릭터 시트가 있어요")}</span>
							</label>
							<label className="check">
								<input type="checkbox" checked={hasEnvSheet} onChange={(e) => setHasEnvSheet(e.target.checked)} />
								<span>{ko("I have an environment sheet", "환경 시트가 있어요")}</span>
							</label>
						</div>

						{!hasCharSheet && (
						<Field label={showB ? ko("Subject 1", "인물 1") : ko("Subject", "인물")}>
								<input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} />
							</Field>
						)}
						{!hasCharSheet && showB && (
						<Field label={ko("Subject 2", "인물 2")}>
								<input type="text" value={subject2} onChange={(e) => setSubject2(e.target.value)} />
							</Field>
						)}
						{!hasEnvSheet && (
						<Field label={ko("Environment", "환경")}>
								<input type="text" value={environment} onChange={(e) => setEnvironment(e.target.value)} />
							</Field>
						)}
						{mode === "video" && !moveSequence && (
						<Field label={ko("Camera move", "카메라 움직임")}>
								<Dropdown
								ariaLabel={ko("Camera move", "카메라 움직임")}
									value={cameraMove}
								options={CAMERA_MOVES.map((m) => ({ value: m, label: cameraMoveLabelKo(m) }))}
									onChange={setCameraMove}
								/>
							</Field>
						)}
						{mode === "video" && !moveSequence && cameraMove === CUSTOM_MOVE && (
						<Field label={ko("Custom camera move", "직접 쓴 카메라 움직임")}>
								<input
									type="text"
									value={customMove}
									onChange={(e) => setCustomMove(e.target.value)}
								placeholder={ko("describe the camera move", "카메라 움직임을 설명하세요")}
								/>
							</Field>
						)}
						{mode === "video" && moveSequence && (
						<Field label={ko("Camera move", "카메라 움직임")}>
								<div
									className="move-slate inline"
								title={ko("authored from the timeline keyframings — select Camera in the hierarchy to edit", "타임라인 키프레임으로 만든 움직임입니다. 편집하려면 계층에서 카메라를 선택하세요")}
								>
								{moveSequence.displaySlate} · {moveSequence.spanS}{ko("s", "초")}
								</div>
							</Field>
						)}
					<Field label={ko("Look / style", "룩 / 스타일")}>
							<input type="text" value={style} onChange={(e) => setStyle(e.target.value)} />
						</Field>

						<button
							className="btn ghost full"
							title={ko("Export the posed character as an ARDY CozyClayPoseV1 JSON", "포즈가 잡힌 캐릭터를 ARDY CozyClayPoseV1 JSON으로 내보내기")}
							onClick={downloadArdyPose}
						>
							{ko("Export ARDY pose", "ARDY 포즈 내보내기")}
						</button>
						<button className="btn primary full generate" onClick={generate}>
							{ko("Generate", "만들기")}
						</button>
					</Foldout>
				<Foldout hidden={sidebarTab !== "motion"} title={ko("ARDY motion", "ARDY 모션")}>
					{bridge === null ? (
						<p className="ardy-hint">{ko("Checking for the dev bridge…", "개발 브리지를 확인하는 중…")}</p>
					) : bridge.ok ? (
						<>
							<p className="ardy-meta">
								{bridge.host ?? ko("box", "로컬")} · {isKo ? `장치 ${bridge.device ?? "알 수 없음"}` : bridge.device ?? "device?"} · {ko("encoder", "인코더")}{" "}
								{bridge.encoder ?? ko("?", "알 수 없음")}
							</p>
							<p className="ardy-hint">{ko("Neutral skeleton · block boundaries and IK keys are pinned automatically.", "중립 스켈레톤 · 블록 경계와 IK 키는 자동으로 고정됩니다.")}</p>
							<Field label={ko("Motion prompt", "모션 프롬프트")}>
								<input
									type="text"
									value={ardyPrompt}
									onChange={(e) => setArdyPrompt(e.target.value)}
									placeholder={ko("what the subject should do", "피사체가 할 동작을 설명하세요")}
									maxLength={ARDY_PROMPT_MAX}
								/>
								<span className="ardy-clamp">{isKo ? `최대 ${ARDY_PROMPT_MAX}자 · 필수` : `max ${ARDY_PROMPT_MAX} chars · required`}</span>
							</Field>
							<Field label={ko("Duration (s)", "길이 (초)")}>
								<input
									type="number"
									min={ARDY_DURATION_MIN}
									max={ARDY_DURATION_MAX}
									step={1}
									value={ardyDuration}
									onChange={(e) => changeDuration(e.target.value)}
								/>
							</Field>
							<Field label={ko("Seed (optional)", "Seed (선택)")}>
								<input
									type="text"
									inputMode="numeric"
									value={ardySeed}
									onChange={(e) => changeArdySeed(e.target.value)}
									placeholder={ko("empty = random", "비우면 랜덤")}
								/>
								<span className="ardy-clamp">{isKo ? `RT 기본값 2 · 비우면 랜덤 · 0..${ARDY_SEED_MAX}` : `RT default 2 · empty = random · 0..${ARDY_SEED_MAX}`}</span>
							</Field>
							{ardyRunning ? (
								<button type="button" className="btn ghost full" onClick={cancelArdy}>
									{ko("Cancel run", "실행 취소")}
								</button>
							) : (
								<button
									type="button"
									className="btn primary full generate"
									onClick={() => runArdy()}
								>
									{ko("Generate motion", "모션 생성")}
								</button>
							)}
							{ardyStatus && <p className="ardy-status">{ardyStatus}</p>}
							{ardyReport && (
								<div className="ardy-report">
									<div className="ardy-report-grid">
									<span>{ko("shape mean error", "형태 평균 오차")}</span>
										<b>{fmtMeters(ardyReport.shape_mean_error_m)}</b>
									<span>{ko("shape max error", "형태 최대 오차")}</span>
										<b>{fmtMeters(ardyReport.shape_max_error_m)}</b>
									<span>{ko("max jump", "최대 점프")}</span>
										<b>{fmtMeters(ardyReport.continuity?.max_jump_m)}</b>
									</div>
									<p className="ardy-caveat">
										{ko("Shape error proves joint-center placement only —", "형태 오차는 관절 중심 배치만 검증합니다 —")}{" "}
										{ardyReport.surface_contact_verified
											? ko("contact verified", "접촉 검증됨")
											: ko("foot-to-floor contact NOT verified", "발과 바닥의 접촉은 검증되지 않음")}{" "}
										· {ko("target_space", "대상 좌표계")} {ardyReport.target_space ?? ko("unknown", "알 수 없음")}
									</p>
								</div>
							)}
							{ardyOutcome?.ok && (
								<>
									<p className="ardy-outcome done">
									{ko("Output", "출력")} <code>{ardyOutcome.output}</code> ({ardyOutcome.bytes}{ko(" bytes", "바이트")})
										{ardyOutcome.motionUrl && (
											<>
												{" "}
											· {ko("motion", "모션")} <code>{ardyOutcome.motionUrl}</code>
											</>
										)}
									</p>
									{motionBusy ? (
								<p className="ardy-hint">{ko("Decoding motion…", "모션 디코딩 중…")}</p>
									) : motion ? (
										<p className="ardy-outcome done">
									{isKo ? `모션 로드됨 — ${motion.frames}프레임 @ ${motion.fps} fps, 인물 1에 재생 중` : `Motion loaded — ${motion.frames} frames @ ${motion.fps} fps, playing on Subject 1`}
										</p>
									) : motionError ? (
										<>
								<p className="ardy-outcome error">{ko("Motion decode failed:", "모션 디코딩 실패:")} {motionError}</p>
											{ardyOutcome.motionUrl && (
												<button
													type="button"
													className="btn ghost full"
													onClick={() => loadMotion(ardyOutcome.motionUrl, undefined, ardyOutcome.rotationDeg ?? charA.rot)}
												>
										{ko("Retry load", "다시 로드")}
												</button>
											)}
										</>
									) : null}
								</>
							)}
							{ardyOutcome && !ardyOutcome.ok && (
								<p className="ardy-outcome error">{ardyOutcome.message}</p>
							)}
						</>
					) : (
						<>
							<p className="ardy-hint">
								{isKo ? (
									<>
										모션 생성은 사용자의 컴퓨터에서 실행되므로 여기서는 꺼져 있어요. 타임라인의 클립은 미리 생성된 샘플입니다.
										스테이징, 경로, 카메라, 재생은 브리지 없이도 작동합니다. 직접 생성하려면 저장소를 클론하고
										<code>node tools/ardy/bridge.mjs</code>로 브리지를 시작하세요.
									</>
								) : (
									<>
										Motion generation runs on your own machine, so it is off here. The clip
										on the timeline was generated ahead of time; staging, paths, cameras and
										playback all work without it. To generate your own, clone the repo and
										start the bridge with <code>node tools/ardy/bridge.mjs</code>.
									</>
								)}
							</p>
							{bridge.reason && <p className="ardy-hint">{bridge.reason}</p>}
						</>
					)}
				</Foldout>
				<Foldout hidden={sidebarTab !== "motion"} title={ko("Prompt Blocks", "프롬프트 블록")}>
					<p className="inspector-hint">{ko("Blocks define what ARDY generates over each frame range. Selecting one also moves editing context to that prompt.", "블록은 각 프레임 범위에서 ARDY가 생성할 내용을 정합니다. 블록을 선택하면 편집 기준도 해당 프롬프트로 이동합니다.")}</p>
						<div className="inspector-list">
							{promptClips.map((clip) => (
								<button
									type="button"
									key={clip.id}
									className={selectedPromptId === clip.id ? "active" : ""}
									onClick={() => {
										setSelectedPromptId(clip.id);
										setArdyPrompt(clip.text);
										setTlFrame(Math.min(clip.startFrame, tlFrameCount - 1));
									}}
								>
								<span>{clip.text || ko("Untitled motion", "이름 없는 모션")}</span>
									<small>{clip.startFrame}–{clip.endFrame}f</small>
								</button>
							))}
						</div>
						{selectedPromptId && (
						<Field label={ko("Selected block prompt", "선택한 블록 프롬프트")}>
								<input
									type="text"
									value={promptClips.find((clip) => clip.id === selectedPromptId)?.text ?? ""}
									onChange={(event) => {
										changePromptClip(selectedPromptId, event.target.value);
										setArdyPrompt(event.target.value);
									}}
								placeholder={ko("describe this motion block", "이 모션 블록을 설명하세요")}
								/>
							</Field>
						)}
						<button
							type="button"
							className="btn primary full generate prompt-block-generate"
							disabled={!bridge?.ok || !promptClips.some((clip) => clip.text.trim()) || ardyRunning}
							onClick={runAllPromptBlocks}
						>
							{ardyRunning
								? (isKo ? `${promptClips.length}개 블록 생성 중…` : `Generating ${promptClips.length} blocks…`)
								: (isKo ? `${promptClips.length}개 블록 모두 생성` : `Generate all ${promptClips.length} blocks`)}
						</button>
					{!bridge?.ok && <p className="ardy-hint">{ko("Start the ARDY bridge to enable generation.", "생성을 사용하려면 ARDY 브리지를 시작하세요.")}</p>}
						{ardyStatus && <p className="ardy-status">{ardyStatus}</p>}
						<button type="button" className="btn ghost full" onClick={() => addPromptClip(tlFrame)}>
						{isKo ? `프레임 ${tlFrame}에 블록 추가` : `Add block at frame ${tlFrame}`}
						</button>
					</Foldout>

				<Foldout hidden={sidebarTab !== "inspector" || !(selectedHierarchyId === "characterA.rig" || selectedHierarchyId.startsWith("rig."))} title={ko("Rig Control", "리그 제어")}>
						<p className="inspector-hint">
							{selectedHierarchyId.startsWith("rig.")
							? (isKo ? `${HIERARCHY_INSPECTOR_TITLES[selectedHierarchyId]}이 활성 제어 그룹입니다.` : `${HIERARCHY_INSPECTOR_TITLES[selectedHierarchyId]} is the active control group.`)
							: ko("Choose a body group in the hierarchy, then manipulate its handle in the main view.", "계층에서 몸 그룹을 고른 뒤 메인 뷰의 핸들을 조작하세요.")}
						</p>
						<div className="inspector-status-grid">
						<span>{ko("Rig", "리그")}</span><b>{ikChains ? ko("Ready", "준비됨") : ko("Unavailable", "사용 불가")}</b>
						<span>{ko("Focus", "초점")}</span><b>{ikFocus ?? ko("None", "없음")}</b>
						<span>{ko("Foot lock", "발 고정")}</span><b>{footSnap ? ko("ON", "켜짐") : ko("OFF", "꺼짐")}</b>
						</div>
						<button type="button" className={"btn full" + (ikMode ? " primary" : "")} onClick={toggleIkMode} disabled={!ikChains}>
						{ikMode ? ko("Finish rig editing", "리그 편집 끝내기") : ko("Edit rig with IK", "IK로 리그 편집")}
						</button>
					</Foldout>

				<Foldout hidden={sidebarTab !== "motion"} title={ko("Root Path", "루트 경로")}>
						<div className="inspector-status-grid">
						<span>{ko("Path mode", "경로 모드")}</span><b>{waypointMode ? ko("ON", "켜짐") : ko("OFF", "꺼짐")}</b>
						<span>{ko("Waypoints", "웨이포인트")}</span><b>{waypoints.length}</b>
						<span>{ko("Current frame", "현재 프레임")}</span><b>{tlFrame}</b>
						</div>
						<button type="button" className={"btn full" + (waypointMode ? " primary" : "")} onClick={toggleWaypointMode}>
						{waypointMode ? ko("Finish path editing", "경로 편집 끝내기") : ko("Edit root path", "루트 경로 편집")}
						</button>
						{waypointMode && (
						<p className="inspector-hint">{ko("Pick a frame on the timeline's 2D root lane first, and the next Shot-view floor click lands there. Already-placed pins can be dragged in the Top-View.", "타임라인 2D 루트 레인에서 프레임을 먼저 고르면 다음 샷 뷰 바닥 클릭이 그 프레임에 놓입니다. 이미 놓은 점은 탑뷰에서 드래그해 위치를 조정하세요.")}</p>
						)}
						<div className="inspector-list compact">
							{waypoints.map((waypoint) => (
								<button
									type="button"
									key={waypoint.frame}
									className={activeWaypointFrame === waypoint.frame ? "active" : ""}
									onClick={() => {
										setActiveWaypointFrame(waypoint.frame);
										setTlFrame(waypoint.frame);
										setWaypointMode(true);
									}}
									onContextMenu={(event) => {
										event.preventDefault();
										removeWaypoint(waypoint.frame);
									}}
								>
								<span>{isKo ? `프레임 ${waypoint.frame}` : `Frame ${waypoint.frame}`}</span>
									<small>{waypoint.x.toFixed(2)}, {waypoint.z.toFixed(2)}</small>
								</button>
							))}
						</div>
					</Foldout>

				<Foldout hidden={sidebarTab !== "motion"} title={ko("IK Corrections", "IK 보정")}>
						<div className="inspector-status-grid">
						<span>{ko("IK mode", "IK 모드")}</span><b>{ikMode ? ko("ON", "켜짐") : ko("OFF", "꺼짐")}</b>
						<span>{ko("Current frame", "현재 프레임")}</span><b>{tlFrame}</b>
						<span>{ko("Keys", "키")}</span><b>{ikFrames.length}</b>
						</div>
						<button type="button" className={"btn full" + (ikMode ? " primary" : "")} onClick={toggleIkMode} disabled={!ikChains}>
						{ikMode ? ko("Exit IK mode", "IK 모드 나가기") : ko("Enter IK mode", "IK 모드 들어가기")}
						</button>
						<label className="check">
							<input type="checkbox" checked={footSnap} onChange={() => setFootSnap((value) => !value)} />
						<span>{ko("Keep feet planted during body edits", "몸을 편집하는 동안 발 고정")}</span>
						</label>
						<button type="button" className="btn ghost full" onClick={ikAddKeyframe} disabled={!ikChains}>
						{isKo ? `프레임 ${tlFrame}에 키 추가` : `Add key at frame ${tlFrame}`}
						</button>
						<div className="inspector-list compact">
							{ikFrames.map((frame) => (
								<button
									type="button"
									key={frame}
									className={tlFrame === frame ? "active" : ""}
									onClick={() => setTlFrame(frame)}
									onContextMenu={(event) => {
										event.preventDefault();
										ikDeleteKeyframe(frame);
									}}
								>
								<span>{isKo ? `프레임 ${frame}` : `Frame ${frame}`}</span>
								<small>{tlFrame === frame ? ko("Current", "현재") : ko("right-click removes", "오른쪽 클릭으로 삭제")}</small>
								</button>
							))}
						</div>
					</Foldout>

				<Foldout hidden={sidebarTab !== "inspector" || selectedHierarchyId !== "environment"} title={ko("Environment", "환경")}>
						<label className="check">
							<input type="checkbox" checked={hasEnvSheet} onChange={(event) => setHasEnvSheet(event.target.checked)} />
						<span>{ko("I have an environment sheet", "환경 시트가 있어요")}</span>
						</label>
						{!hasEnvSheet && (
						<Field label={ko("Environment description", "환경 설명")}>
								<input type="text" value={environment} onChange={(event) => setEnvironment(event.target.value)} />
							</Field>
						)}
					<Field label={ko("Look / style", "룩 / 스타일")}>
							<input type="text" value={style} onChange={(event) => setStyle(event.target.value)} />
						</Field>
					</Foldout>

				<Foldout hidden={sidebarTab !== "inspector" || selectedHierarchyId !== "props"} title={ko("Props", "소품")}>
					<p className="inspector-hint">{ko("Everything you add to the set lives here. Pick one to edit it, or click it in the shot view.", "세트에 추가한 모든 소품이 여기에 모입니다. 편집하려면 하나를 고르거나 샷 뷰에서 클릭하세요.")}</p>
					<AddObjectMenu onAdd={addSceneObject} label={ko("Add object to the set", "세트에 오브젝트 추가")} />
						<div className="inspector-list compact">
							{sceneObjects.map((object) => (
								<button
									type="button"
									key={object.id}
									onClick={() => selectHierarchy(`object:${object.id}`)}
								>
									<span>{sceneObjectNameDisplayKo(object.name)}</span>
								<small>{sceneRendererLabelKo(object.renderer)}</small>
								</button>
							))}
						</div>
					</Foldout>

				<Foldout hidden={sidebarTab !== "inspector" || !selectedSceneObject} title={ko("Object Transform", "오브젝트 변환")}>
						{selectedSceneObject && (
							<>
								<p className="inspector-hint">
								{ko("Type a value and press Enter, or drag an axis letter to scrub.", "값을 입력하고 Enter를 누르거나 축 글자를 드래그해 조절하세요.")}
								</p>
								<div className="presets gizmo-modes">
									<button type="button" className={gizmoMode === "move" ? "active" : ""} onClick={() => setGizmoMode("move")}>
									{ko("Move", "이동")} <kbd>W</kbd>
									</button>
									<button type="button" className={gizmoMode === "rotate" ? "active" : ""} onClick={() => setGizmoMode("rotate")}>
									{ko("Rotate", "회전")} <kbd>E</kbd>
									</button>
									<button type="button" className={gizmoMode === "scale" ? "active" : ""} onClick={() => setGizmoMode("scale")}>
									{ko("Scale", "크기")} <kbd>R</kbd>
									</button>
								</div>
								<label className="check snap-toggle">
									<input type="checkbox" checked={snapEnabled} onChange={(event) => setSnapEnabled(event.target.checked)} />
								<span>
									{isKo ? (
										<>
											그리드 스냅 — <kbd>Ctrl</kbd>을 누르면 반대로 작동
										</>
									) : (
										<>
											Snap to grid — hold <kbd>Ctrl</kbd> to invert
										</>
									)}
								</span>
								</label>
						<Field label={ko("Name", "이름")}>
									<input
										type="text"
								value={sceneObjectNameDisplayKo(selectedSceneObject.name)}
										onChange={(event) => changeSceneObject(selectedSceneObject.id, { name: event.target.value })}
									/>
								</Field>
								<Vector3Row
							label={ko("Position", "위치")}
									fields={[
										{ axis: "X", value: selectedSceneObject.x, step: 0.05, precision: 2, onChange: (x) => changeSceneObject(selectedSceneObject.id, { x }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Y", value: selectedSceneObject.y ?? 0, step: 0.05, precision: 2, onChange: (y) => changeSceneObject(selectedSceneObject.id, { y }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Z", value: selectedSceneObject.z, step: 0.05, precision: 2, onChange: (z) => changeSceneObject(selectedSceneObject.id, { z }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
									]}
								/>
								<Vector3Row
							label={ko("Rotation", "회전")}
									fields={[
										{ axis: "X", value: selectedSceneObject.rotX ?? 0, step: 1, precision: 1, onChange: (rotX) => changeSceneObject(selectedSceneObject.id, { rotX }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Y", value: selectedSceneObject.rot, step: 1, precision: 1, onChange: (rot) => changeSceneObject(selectedSceneObject.id, { rot }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Z", value: selectedSceneObject.rotZ ?? 0, step: 1, precision: 1, onChange: (rotZ) => changeSceneObject(selectedSceneObject.id, { rotZ }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
									]}
								/>
								<Vector3Row
							label={ko("Scale", "크기")}
									fields={[
										{ axis: "X", value: selectedSceneObject.scaleX ?? 1, step: 0.05, precision: 2, onChange: (scaleX) => changeSceneObject(selectedSceneObject.id, { scaleX }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Y", value: selectedSceneObject.scaleY ?? 1, step: 0.05, precision: 2, onChange: (scaleY) => changeSceneObject(selectedSceneObject.id, { scaleY }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Z", value: selectedSceneObject.scaleZ ?? 1, step: 0.05, precision: 2, onChange: (scaleZ) => changeSceneObject(selectedSceneObject.id, { scaleZ }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
									]}
								/>
						<div className="object-colors" role="group" aria-label={ko("Object colour", "오브젝트 색상")}>
									{OBJECT_COLORS.map((color) => (
										<button
											type="button"
											key={color}
											className={"object-color" + (selectedSceneObject.color === color ? " active" : "")}
											style={{ background: color }}
									aria-label={isKo ? `색상 ${color}` : `Colour ${color}`}
											aria-pressed={selectedSceneObject.color === color}
											onClick={() => changeSceneObject(selectedSceneObject.id, { color })}
										/>
									))}
								</div>
							</>
						)}
					</Foldout>
					</div>
					{selectedSceneObject && (
						<div className="inspector-footer">
							<button
								type="button"
								className="btn ghost full"
							title={ko("You can also press Delete or Backspace", "Delete 또는 Backspace를 눌러도 삭제할 수 있어요")}
								onClick={deleteSelectedSceneObject}
							>
							{isKo ? `${sceneObjectNameDisplayKo(selectedSceneObject.name)} 삭제` : `Remove ${selectedSceneObject.name}`}
							</button>
						</div>
					)}
					</section>
				</aside>
			</div>

			<div
				className="workspace-splitter timeline-splitter"
				role="separator"
				aria-label={ko("Resize frame monitor", "프레임 모니터 크기 조절")}
				onPointerDown={(event) => beginWorkspaceResize("timeline", event)}
			/>
			<div className="bottom-window">
				<nav className="bottom-window-tabs" aria-label={ko("Bottom window", "하단 창")}>
					<button
						type="button"
						className={bottomTab === "timeline" ? "active" : ""}
						aria-pressed={bottomTab === "timeline"}
						onClick={() => setBottomTab("timeline")}
					>
						{ko("Animation", "애니메이션")}
					</button>
					<button
						type="button"
						className={bottomTab === "console" ? "active" : ""}
						aria-pressed={bottomTab === "console"}
						onClick={() => setBottomTab("console")}
					>
						{ko("Console", "콘솔")}
					</button>
				</nav>
				<div className="console-pane" hidden={bottomTab !== "console"}>
					{consoleLines.length === 0 ? (
						<p className="console-empty">{ko("No messages yet — ARDY status lines appear here.", "아직 메시지가 없어요 — ARDY 상태 줄이 여기에 표시됩니다.")}</p>
					) : (
						consoleLines.map((entry, index) => (
							<p className="console-line" key={index}>
								<time>{entry.time.toLocaleTimeString()}</time>
								<span>{entry.line}</span>
							</p>
						))
					)}
				</div>
				<div className="bottom-timeline" hidden={bottomTab !== "timeline"}>
				<Timeline
					frame={tlFrame}
					frameCount={tlFrameCount}
					fps={tlFps}
					playbackSpeed={DEFAULT_PLAYBACK_SPEED}
				playing={tlPlaying}
				waypointMode={waypointMode}
				waypointFrames={waypoints.map((w) => w.frame)}
				pathSpeed={pathSpeed}
				pendingWaypointFrame={pendingWaypointFrame}
				promptClips={promptClips}
				selectedPromptId={selectedPromptId}
				badge={stateBadge}
				ikMode={ikMode}
				ikDisabled={!ikChains}
				ikFrames={ikFrames}
				footSnap={footSnap}
					shots={shots}
					activeShotIdx={activeShotIdx}
				shotCutDisabled={!!posing || ikMode || waypointMode || ((shots[activeShotIdx + 1]?.startFrame ?? tlFrameCount) - (shots[activeShotIdx]?.startFrame ?? 0) < 2)}
				onIkToggle={toggleIkMode}
				onIkKeyframeAdd={ikAddKeyframe}
				onIkKeyframeRemove={ikDeleteKeyframe}
				onFootSnapToggle={() => {
					setFootSnap((v) => {
				setToast(v ? ko("Foot snap off — the feet follow the body", "발 스냅 꺼짐 — 발이 몸을 따라갑니다") : ko("Foot snap on — the feet stay planted while the body moves", "발 스냅 켜짐 — 몸이 움직여도 발은 바닥에 고정됩니다"));
						return !v;
					});
				}}
				onScrub={setTlFrame}
				onAdvance={advanceFrame}
				onStep={stepFrame}
				onPlayToggle={() => setTlPlaying((v) => !v)}
				onWaypointToggle={toggleWaypointMode}
				onMarkerSelect={(f) => {
					const frame = Math.min(f, tlFrameCount - 1);
					setTlFrame(frame);
					setWaypointMode(true);
					setSidebarTab("motion");
					if (waypoints.some((waypoint) => waypoint.frame === frame)) {
						setActiveWaypointFrame(frame);
						setPendingWaypointFrame(null);
					} else {
						setActiveWaypointFrame(null);
						setPendingWaypointFrame(frame);
					}
				}}
				onMarkerRemove={removeWaypoint}
				onRootKeyframeAdd={queueRootWaypointFrame}
				onPromptAdd={addPromptClip}
				onPromptSelect={(id) => {
					setSelectedPromptId(id);
					setArdyPrompt(promptClips.find((clip) => clip.id === id)?.text ?? "");
					setSidebarTab("motion");
				}}
				onPromptChange={changePromptClip}
				onPromptResize={resizePromptClip}
				onPromptMove={movePromptClip}
				onPromptRemove={removePromptClip}
				onCameraMoveSelect={() => {
					setSelectedHierarchyId("camera");
					setSidebarTab("inspector");
				}}
				onCameraKeyframeAdd={addCameraKeyframe}
				onCameraKeyframeMove={moveCameraKeyframe}
					onCameraKeyframeRemove={removeCameraKeyframe}
					onCameraBlockSelect={(index) => {
						const selected = shots[index];
						if (!selected) return;
						setTlFrame(selected.startFrame);
						setSelectedHierarchyId("camera");
						setSidebarTab("motion");
					}}
					onCameraBlockChange={(patch) => {
						changeActiveCamera(patch);
						if (patch.mode === "rail" && !cameraRail) {
							setRailDraw(true);
							setWorkspaceLayout((current) => ({ ...current, insetCollapsed: false }));
							setToast(ko("Draw this Camera Block's rail in the Top-View", "탑뷰에서 이 카메라 블록의 레일을 그리세요"));
						}
					}}
				onShotSelect={selectTimelineShot}
				onShotBoundaryMove={(index, frame) => setShots((current) => moveBoundary(current, index, frame, tlFrameCount))}
				onShotRename={(index, name) => setShots((current) => renameShot(current, index, name))}
				onShotRemove={(index) => setShots((current) => removeShot(current, index))}
				onShotDuplicate={duplicateTimelineShot}
				onShotCut={addTimelineShot}
				onShotEndResize={resizeTimelineEnd}
				onShotMove={moveTimelineShot}
				onClearMotion={motion ? clearMotion : null}
			/>
				</div>
			</div>
		</div>

			<footer className="brandbar">
				<span className="wordmark">
					Cozy <span>Clay</span>
				</span>
			</footer>

			{result && resultOpen && (
				<ResultModal
					result={result}
					copied={copied}
					recordedVideoName={result.mode === "video" ? recordedVideoName : null}
					onClose={() => setResultOpen(false)}
					onCopy={() => copyPrompt(result.prompt)}
					onDownload={download}
				/>
			)}

			<Toast message={toast} onDone={() => setToast("")} />
		</div>
	);
}
/** ARDY report meters: missing/failed values render as an em dash, never NaN. */
function fmtMeters(value) {
	return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(4)} m` : "—";
}

/** Mid-clip frame of a base motion, the sensible default for the destination. */

/** Unity Inspector-style foldout: a titled section the user can collapse.
 * Cards default to open; the fold state is per-title session state. */
function Foldout({ title, hidden, children }) {
	const [open, setOpen] = useState(true);
	return (
		<section className={"card foldout" + (open ? " open" : "")} hidden={hidden}>
			<h3>
				<button type="button" className="foldout-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
					<span className="foldout-arrow" aria-hidden="true">{open ? "\u25BE" : "\u25B8"}</span>
					<span className="foldout-title">{title}</span>
				</button>
			</h3>
			{open && <div className="foldout-body">{children}</div>}
		</section>
	);
}

function SubjectBox({ label, value, onChange, onRemove, onPose, posing }) {
	const set = (key) => (v) => onChange((prev) => ({ ...prev, [key]: v }));
	return (
		<div className="subject-box">
			<div className="subject-box-head">
				<span className="sb-name">{label}</span>
				<div className="sb-actions">
					{onPose && (
						<button
							type="button"
							className={"cam-toggle" + (posing ? " active" : "")}
							title={isKo ? `${label} 포즈` : `Pose ${label}`}
							onClick={onPose}
						>
							⌘
						</button>
					)}
					{onRemove && (
						<button type="button" className="sb-remove" title={ko("Remove subject", "인물 제거")} onClick={onRemove}>
							✕
						</button>
					)}
				</div>
			</div>
			<Slider compact label={ko("Left / right", "좌 / 우")} min={-4} max={4} step={0.1} value={value.x} onChange={set("x")} />
			<Slider compact label={ko("Depth", "깊이")} min={-4} max={4} step={0.1} value={value.z} onChange={set("z")} />
			<Slider compact label={ko("Rotate", "회전")} min={-180} max={180} step={1} value={value.rot} unit="°" onChange={set("rot")} />
		</div>
	);
}
