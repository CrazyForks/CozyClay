import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrthographicCamera, PerspectiveCamera, useFBX } from "@react-three/drei";
import * as THREE from "three";
import { SkeletonUtils } from "three/examples/jsm/Addons.js";
import { buildArdyPose } from "./ardy/export.js";
import { checkBridge, generate as ardyGenerate } from "./ardy/client.js";
import { loadMotionFromUrl } from "./ardy/npz.js";
import { applyMotionFrame, captureArdyRoot, restorePlaybackBones, snapshotPlaybackBones } from "./ardy/playback.js";
import { movePromptClipFrames } from "./ardy/prompt-clips.js";
import Timeline from "./ardy/timeline.jsx";
import { defaultWaypointPosition, toArdyWaypoints, toSceneRootOffset } from "./ardy/waypoints.js";
import { FlyControls, aimAt, forwardFrom } from "./controls.jsx";
import HierarchyPanel from "./hierarchy-panel.jsx";
import { PlanBoard } from "./planview.jsx";
import { DualRender, GIZMO_LAYER } from "./dualview.jsx";
import { Room, StageLights } from "./room.jsx";
import { SetProps } from "./props.jsx";
import {
	DEFAULT_SCENE_OBJECTS,
	OBJECT_COLORS,
	SCENE_QUARANTINE_KEY,
	SCENE_STORAGE_KEY,
	createSceneObject,
	dropToSurfacePatch,
	loadScene,
	objectSize,
	placementInFront,
	removeSceneObject,
	sceneObjectIdFromHierarchy,
	serializeScene,
	updateSceneObject,
} from "./scene-objects.js";
import { createSceneHistoryStore } from "./scene-history.js";
import ObjectGizmo from "./object-gizmo.jsx";
import AddObjectMenu from "./object-catalog.jsx";
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

// Stated the way a crew states a setup: how far back, which side, how high the
// lens rides, and what glass is on it. Order matters — Medium is the setup a
// director reaches for first, so it leads.
const PRESETS = {
	medium: { label: "Medium", distance: 2.6, azimuth: 22, elevation: 6, fov: 45, targetY: 1.35, two: false },
	wide: { label: "Wide", distance: 7, azimuth: 25, elevation: 4, fov: 38, targetY: 1.2, two: false },
	closeup: { label: "Close-Up", distance: 1.3, azimuth: 16, elevation: 2, fov: 45, targetY: 1.55, two: false },
	low: { label: "Low Angle", distance: 3.5, azimuth: 20, elevation: -14, fov: 50, targetY: 1.1, two: false },
	high: { label: "High Angle", distance: 4.5, azimuth: 20, elevation: 16, fov: 45, targetY: 1.1, two: false },
	ots: {
		label: "Over Shoulder",
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
		label: "Two Shot",
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
	shot: "Shot settings",
	camera: "Camera",
	characters: "Characters",
	characterA: "Character 1",
	"characterA.character": "Character 1",
	"characterA.motion": "Motion",
	"characterA.baseMotion": "Base Motion",
	"characterA.promptBlocks": "Prompt Blocks",
	"characterA.ik": "IK Corrections",
	"characterA.rig": "Rig",
	characterB: "Character 2",
	"characterB.character": "Character 2",
	rootPath: "Root Path",
	environment: "Environment",
	props: "Props",
	"rig.hips": "Root / Hips",
	"rig.spine": "Spine",
	"rig.leftArm": "Left Arm",
	"rig.rightArm": "Right Arm",
	"rig.leftLeg": "Left Leg",
	"rig.rightLeg": "Right Leg",
};

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
const CLAY = "#f2eee6";
const CLAY_B = "#ddd6ca";
const DEFAULT_POSE = BUILT_IN_POSES.find((p) => p.id === "relaxed") ?? BUILT_IN_POSES[0];
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

function Character({ url, position, rot, tint, pose, onRig }) {
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
		<group position={position} rotation={[0, (rot * Math.PI) / 180, 0]}>
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

function ViewportLayoutInvalidator({ insetX, insetY, insetWidth, insetHeight, sidebarWidth, timelineHeight }) {
	const invalidate = useThree((state) => state.invalidate);
	useEffect(() => {
		// The pane frame is regular DOM while its picture is a scissored WebGL
		// viewport. In demand mode a drag can commit its final DOM position just
		// after the continuous loop stops, leaving the picture at the previous
		// coordinates. Redraw now and once more after layout has settled.
		invalidate();
		const frame = requestAnimationFrame(invalidate);
		return () => cancelAnimationFrame(frame);
	}, [invalidate, insetX, insetY, insetWidth, insetHeight, sidebarWidth, timelineHeight]);
	return null;
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
	}, [gl, scene, camRef, apiRef]);
	return null;
}

/* ----------------------------------------------------------------- app --- */

// Unity's tool keys. They are free because camera movement now lives behind a
// held right button. (docs/unity-reference.md §9.2)
const GIZMO_HOTKEYS = { KeyW: "move", KeyE: "rotate", KeyR: "scale" };

const WORKSPACE_LAYOUT_KEY = "cozyclay.workspace-layout.v1";
const DEFAULT_WORKSPACE_LAYOUT = Object.freeze({
	sidebarWidth: 380,
	timelineHeight: 190,
	insetWidth: 310,
	insetHeight: 310,
});

function loadWorkspaceLayout() {
	try {
		const saved = JSON.parse(localStorage.getItem(WORKSPACE_LAYOUT_KEY) || "null");
		return saved ? { ...DEFAULT_WORKSPACE_LAYOUT, ...saved } : { ...DEFAULT_WORKSPACE_LAYOUT };
	} catch {
		return { ...DEFAULT_WORKSPACE_LAYOUT };
	}
}

/**
 * The startup scene load (plan §8.3): a tagged result from loadScene plus the
 * session's durability posture. Runs once inside a lazy initializer, so the
 * quarantine write happens before the first render and the toast/error ride
 * along as initial UI state. A throwing getItem counts as absent — private
 * browsing must never crash the studio.
 */
function loadSceneStartup() {
	let raw = null;
	try {
		raw = localStorage.getItem(SCENE_STORAGE_KEY);
	} catch {
		raw = null;
	}
	// DEFAULT_SCENE_OBJECTS stays the fallback, never a seed over storage
	// (plan §8.5); the clone keeps the record footprint copies independent.
	const defaults = () => DEFAULT_SCENE_OBJECTS.map((object) => ({ ...object, footprint: { ...object.footprint } }));
	const result = loadScene(raw);
	if (result.status === "valid") {
		return {
			objects: result.objects,
			saveBlocked: false,
			error: null,
			toast: result.dropped > 0 ? `${result.dropped} saved object(s) could not be restored` : null,
		};
	}
	if (result.status === "future") {
		// A newer build wrote this scene. Overwriting it with our older schema
		// would destroy newer data, so this session never writes the primary key.
		return {
			objects: defaults(),
			saveBlocked: true,
			error: null,
			toast: "Saved scene was written by a newer CozyClay — it has been left untouched and this session will not save",
		};
	}
	if (result.status === "corrupt") {
		try {
			// Keep the unreadable bytes under the quarantine key before the
			// first save overwrites the primary.
			localStorage.setItem(SCENE_QUARANTINE_KEY, raw);
			return {
				objects: defaults(),
				saveBlocked: false,
				error: null,
				toast: "Saved scene was unreadable — starting empty; the old data is kept under cozyclay.scene.v1.quarantine",
			};
		} catch {
			// If the backup write fails, overwriting the corrupt primary would
			// lose the only copy of the data — saving stays blocked instead.
			return {
				objects: defaults(),
				saveBlocked: true,
				error: "Saved scene was unreadable and could not be backed up — this session will not save",
				toast: null,
			};
		}
	}
	// absent: nothing saved, or a read that threw — either way a fresh scene.
	return { objects: defaults(), saveBlocked: false, error: null, toast: null };
}

export default function App() {
	const [workspaceLayout, setWorkspaceLayout] = useState(loadWorkspaceLayout);
	const [preset, setPreset] = useState("medium");
	const [fovDeg, setFovDeg] = useState(PRESETS.medium.fov);
	const [nonce, setNonce] = useState(0);
	// viewMode now selects which pane is BIG; both render every frame.
	const [viewMode, setViewMode] = useState("shot");
	const planIsMain = viewMode === "plan";
	const stageRef = useRef();
	const mainPaneRef = useRef();
	const insetPaneRef = useRef();
	// User-dragged inset position (px, stage-relative). null = the CSS default
	// (top-right); double-clicking the tag snaps back to it.
	const [insetPos, setInsetPos] = useState(null);
	const planCamRef = useRef();
	const planHostRef = planIsMain ? mainPaneRef : insetPaneRef;

	useEffect(() => {
		localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify(workspaceLayout));
	}, [workspaceLayout]);

	const workspaceStyle = {
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
		const onMove = (ev) => {
			setInsetPos({
				x: Math.max(8, Math.min(ev.clientX - stageRect.left - grabX, stageRect.width - paneRect.width - 8)),
				y: Math.max(8, Math.min(ev.clientY - stageRect.top - grabY, stageRect.height - paneRect.height - 8)),
			});
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
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
	const [, setPoseTick] = useState(0);

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
	const [selectedHierarchyId, setSelectedHierarchyId] = useState("characterA.motion");
	const [rightPanelTab, setRightPanelTab] = useState("hierarchy");
	// Scene persistence (plan §8): the startup load runs once in a lazy
	// initializer so the store below can seed from the restored scene; the
	// quarantine write and the save-block decision happen before the first
	// render, and the toast/error they produce ride along as initial UI state.
	const [startup] = useState(loadSceneStartup);
	const [sceneObjects, setSceneObjects] = useState(startup.objects);
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

	// ---- scene persistence (plan §8.4) ----
	// Every write serialises the store at invocation time — the LIVE read,
	// never a value captured by the caller. A stale closure would flush
	// startup state over the latest edit, so flushScene closes over refs only.
	function flushScene() {
		if (saveBlockedRef.current || !dirtyRef.current) return;
		try {
			localStorage.setItem(SCENE_STORAGE_KEY, serializeScene(storeRef.current.objects));
			dirtyRef.current = false;
			setSceneSaveError(null);
			// The next successful write clears the whole failure surface (plan
			// §8.4) without clobbering an unrelated toast that replaced it.
			if (saveFailureToastRef.current) {
				saveFailureToastRef.current = false;
				setToast("");
			}
		} catch (err) {
			const message = `Scene not saved: ${err?.name || "StorageError"}`;
			setSceneSaveError(message);
			if (!saveFailureToastRef.current) {
				saveFailureToastRef.current = true;
				setToast(message);
			}
		}
	}
	// Debounced write: the cleanup clears the timer only — clearing IS the
	// debounce; flushing there would write on every tick.
	useEffect(() => {
		dirtyRef.current = true;
		const timer = setTimeout(flushScene, 400);
		return () => clearTimeout(timer);
	}, [sceneObjects]);
	// Lifecycle flush: pagehide covers navigation/tab close, visibilitychange
	// covers backgrounding, the effect cleanup covers unmount. `beforeunload`
	// is deliberately not used — it defeats bfcache. The [] deps capture only
	// refs and flushScene, so this closure can never hold a stale scene.
	useEffect(() => {
		const onPageHide = () => flushScene();
		const onVisibility = () => {
			if (document.visibilityState === "hidden") flushScene();
		};
		window.addEventListener("pagehide", onPageHide);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("pagehide", onPageHide);
			document.removeEventListener("visibilitychange", onVisibility);
			flushScene(); // unmount: the last chance to persist a dirty scene
		};
	}, []);
	const selectedSceneObjectId = sceneObjectIdFromHierarchy(selectedHierarchyId);
	const selectedSceneObject = sceneObjects.find((object) => object.id === selectedSceneObjectId) ?? null;
	const rightPanelDetailLabel = selectedHierarchyId === "characterA.promptBlocks"
		? "Prompt Block"
		: selectedSceneObject?.name ?? HIERARCHY_INSPECTOR_TITLES[selectedHierarchyId] ?? "Inspector";
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
		setRightPanelTab("detail");
		const focus = RIG_HIERARCHY_FOCUS[id];
		if (focus && ikMode) setIkFocus(focus);
		if (id === "camera") setViewMode("shot");
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
		if (hierarchyId) setSelectedHierarchyId(hierarchyId);
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
			setRightPanelTab("detail");
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
			setToast("Nothing to drop");
			return;
		}
		changeSceneObject(object.id, patch);
		setToast(`${object.name} dropped to surface`);
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
		// Deliberate divergence from Unity's rename-on-create: creating an object
		// here is followed by placing it, and dropping focus into a text field
		// swallows the very next W/E/R. Renaming stays on F2/Return and the row's
		// context menu. (docs/unity-reference.md §9.7)
		setRightPanelTab("detail");
		setGizmoMode("move");
		setToast(`${object.name} added — W move, E rotate, R scale`);
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
		setRightPanelTab("detail");
		setToast(`${placed.name} duplicated`);
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
		setViewMode("shot");
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
			setToast("Nothing to undo");
			return;
		}
		if (selectedSceneObjectId && !restored.some((object) => object.id === selectedSceneObjectId)) {
			setSelectedHierarchyId("props");
		}
		setToast("Undone");
	}

	function redoScene() {
		const restored = store.redo();
		if (restored === null) {
			setToast("Nothing to redo");
			return;
		}
		if (selectedSceneObjectId && !restored.some((object) => object.id === selectedSceneObjectId)) {
			setSelectedHierarchyId("props");
		}
		setToast("Redone");
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
	const [hasCharSheet, setHasCharSheet] = useState(false);
	const [hasEnvSheet, setHasEnvSheet] = useState(false);
	const [subject, setSubject] = useState("a young woman in a tan coat");
	const [subject2, setSubject2] = useState("a man in a dark coat");
	const [environment, setEnvironment] = useState("a sunlit modern living room");
	const [style, setStyle] = useState("moody cinematic lighting, 35mm film look");

	const [cameraPos, setCameraPos] = useState({ x: 0.97, y: 1.62, z: 2.39 });
	const [subjectVisible, setSubjectVisible] = useState(true);
	const [result, setResult] = useState(null);
	const [copied, setCopied] = useState(false);
	const [toast, setToast] = useState(startup.toast ?? "");
	const [bridge, setBridge] = useState(null);
	const [ardyPrompt, setArdyPrompt] = useState("");
	const [ardyDuration, setArdyDuration] = useState(DEFAULT_DURATION_S);
	// Optional native-ARDY seed: empty string = omit from the request (the
	// box picks its own); otherwise a plain integer in 0..2**31-1.
	const [ardySeed, setArdySeed] = useState("2"); // RT demo parity: its GUI seed defaults to 2, so generation is reproducible out of the box; clear the field for the box's random seed
	const [ardyRunning, setArdyRunning] = useState(false);
	const [ardyStatus, setArdyStatus] = useState("");
	const [ardyReport, setArdyReport] = useState(null);
	const [ardyOutcome, setArdyOutcome] = useState(null);
	const ardyAbortRef = useRef(null);
	// ARDY Core runs at 20 fps: the destination frame lives in [0, duration*20-1].
	const maxDst = Math.max(0, Math.round(ardyDuration) * 20 - 1);

	/* --------------------------- motion workspace --------------------------- */
	// The timeline playhead and the root waypoints are App-owned so the scene
	// (character rig, plan path, ARDY card) reacts to every scrub/play tick.
	const [tlFrame, setTlFrame] = useState(0);
	const [tlPlaying, setTlPlaying] = useState(false);
	const renderActive = useRenderActivity(tlPlaying);
	const [tlFrameCount, setTlFrameCount] = useState(DEFAULT_DURATION_S * 20); // the generation clip length @ 20 fps
	const [tlFps, setTlFps] = useState(20);
	const frameCountRef = useRef(DEFAULT_DURATION_S * 20);
	frameCountRef.current = tlFrameCount;
	// Root waypoints {frame, x, z, heading: null}, kept sorted by frame —
	// the fixed bridge contract rejects out-of-order or duplicate frames.
	const [waypointMode, setWaypointMode] = useState(false);
	const [waypoints, setWaypoints] = useState([]);
	const [activeWaypointFrame, setActiveWaypointFrame] = useState(null);
	useEffect(() => {
		// Subject 1 is the sole frame-zero root start. Drop any legacy seeded
		// waypoint so Bird's-eye never renders two start markers.
		setWaypoints((current) => current.filter((waypoint) => waypoint.frame !== 0));
		setActiveWaypointFrame((current) => (current === 0 ? null : current));
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

	const allPoses = useMemo(() => [...BUILT_IN_POSES, ...customPoses], [customPoses]);
	const posedRig = () => (posing === "B" ? rigB : rigA);
	const setPosed = posing === "B" ? setPoseB : setPoseA;

	/* ------------------------- waypoint workspace --------------------------- */

	function addRootKeyframe(frame) {
		const nextFrame = Math.max(0, Math.min(Math.round(frame), tlFrameCount - 1));
		if (nextFrame === 0) {
			setToast("Subject 1 already defines the frame 0 root start — add a destination after frame 0");
			return;
		}
		const exists = waypoints.some((waypoint) => waypoint.frame === nextFrame);
		const addedCount = exists ? 0 : 1;
		if (waypoints.length + addedCount > MAX_WAYPOINTS) {
			setToast(`The root path is capped at ${MAX_WAYPOINTS} waypoint frames — update an existing waypoint instead`);
			return;
		}

		if (!exists) {
			setWaypoints((prev) => {
				const next = [...prev];
				const position = defaultWaypointPosition(
					next.sort((a, b) => a.frame - b.frame),
					charA,
				);
				next.push({
					frame: nextFrame,
					x: Math.max(-6.5, Math.min(6.5, position.x)),
					z: Math.max(-6.5, Math.min(6.5, position.z)),
					heading: null,
				});
				return next.sort((a, b) => a.frame - b.frame);
			});
		}
		setTlFrame(nextFrame);
		setActiveWaypointFrame(nextFrame);
		setWaypointMode(true);
		setToast(`Root keyframe ${nextFrame} ready — drag its numbered marker directly in Bird's-eye`);
	}

	function moveWaypoint(frame, x, z) {
		setActiveWaypointFrame(frame);
		setTlFrame(Math.min(frame, tlFrameCount - 1));
		setWaypointMode(true);
		setWaypoints((prev) => prev.map((waypoint) => (waypoint.frame === frame ? { ...waypoint, x, z } : waypoint)));
	}

	function removeWaypoint(frame) {
		setWaypoints((prev) => prev.filter((w) => w.frame !== frame));
		setActiveWaypointFrame((current) => (current === frame ? null : current));
	}

	function toggleWaypointMode() {
		const next = !waypointMode;
		setWaypointMode(next);
		if (!next) {
			setToast("2D Root path constraints off");
			return;
		}

		setToast("2D Root path on — Subject 1 is the frame 0 start; add destination keys after frame 0");
	}

	function advanceFrame() {
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
			if (!rig) throw new Error("Subject 1 rig is not loaded");
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
			setToast(`Motion loaded: ${decoded.frames} frames @ ${decoded.fps} fps`);
		} catch (err) {
			setMotion(null);
			setMotionError(err?.message || String(err));
		} finally {
			setMotionBusy(false);
		}
	}

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
			setViewMode("shot"); // posing happens in the big poser view
			setIkMode(true);
			setToast(motion
				? "IK mode — correct the motion; drag end keys the fix at this frame"
				: "IK mode — drag handles in the main view; the shot camera stays frozen in the inset");
			return;
		}
		// Exit: the keyed pose stays — the evaluate effect re-applies the
		// current frame's keyed rotations the moment ikMode flips, so nothing
		// the user authored is lost by toggling. Untracked/unkeyed parts keep
		// their current (FK) pose.
		setIkMode(false);
		setToast("IK mode off — keyed poses keep playing");
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
		setToast(`Full-body IK key at frame ${tlFrame}`);
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

	// Implied locomotion speed per authored segment (@ 20 fps). Shown in the
	// timeline hint so a path that forces a crawl or a sprint is visible
	// before spending a generation on it.
	const pathSpeed = useMemo(() => {
		if (waypoints.length < 2) return null;
		let min = Infinity;
		let max = 0;
		for (let i = 1; i < waypoints.length; i += 1) {
			const a = waypoints[i - 1];
			const b = waypoints[i];
			const seconds = (b.frame - a.frame) / 20;
			if (seconds <= 0) continue;
			const speed = Math.hypot(b.x - a.x, b.z - a.z) / seconds;
			min = Math.min(min, speed);
			max = Math.max(max, speed);
		}
		if (!Number.isFinite(min)) return null;
		return { min, max, warn: min < 0.5 || max > 3 };
	}, [waypoints]);

	const stateBadge = ardyRunning
		? { label: "GENERATING", kind: "generating" }
		: motion
			? { label: "PLAYBACK", kind: "playback" }
			: waypointMode
				? { label: "ROOT PATH", kind: "root" }
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
			label: `My Pose ${customPoses.length + 1}`,
			prompt: "in the exact body pose shown in the blocking frame",
			bones: capturePose(rig),
			custom: true,
		};
		const next = [...customPoses, pose];
		setCustomPoses(next);
		saveCustomPoses(next);
		setStudioPick(pose.id);
		setPosed(pose);
		setToast("Pose saved");
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
		setViewMode("shot");
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

	function generate() {
		const models = mode === "video" ? VIDEO_MODELS : IMAGE_MODELS;
		const model = models.find((m) => m.id === (mode === "video" ? videoModel : imageModel));
		const prompt = composePrompt({
			mode,
			model,
			shot,
			subject,
			subject2: showB ? subject2 : null,
			posePhrase: poseA?.prompt ?? "",
			pose2Phrase: showB ? (poseB?.prompt ?? "") : "",
			environment,
			style,
			cameraMove,
			customMove,
			hasCharSheet,
			hasEnvSheet,
		});
		const buffer = captureRef.current?.render();
		setResult({ prompt, frame: buffer ? bufferToPng(buffer) : null });
		setCopied(false);
		navigator.clipboard
			?.writeText(prompt)
			.then(() => {
				setCopied(true);
				setToast("Prompt copied to clipboard");
			})
			.catch(() => {});
	}

	function download() {
		const a = document.createElement("a");
		a.href = result.frame;
		a.download = "blocking-frame.png";
		document.body.appendChild(a);
		a.click();
		a.remove();
		setToast("Frame downloaded");
	}
	function downloadArdyPose() {
		const rig = posedRig();
		if (!rig) {
			setToast("Character not loaded yet");
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
		setToast("ARDY pose exported");
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
			setToast("Add at least one Prompt Block before generating");
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
			setToast("Character not loaded yet");
			return;
		}
		// Root guidance sends only authored sparse keys. ARDY owns every
		// in-between frame; no dense interpolation or playback warp is applied.
		// Prompt and duration are bridge-contract inputs too: reject bad
		// values here, before any pose build or network, with a specific toast.
		const prompt = promptOverride.trim();
		if (!prompt) {
			setToast("Motion prompt is required — describe what the subject should do before generating");
			return;
		}
		if (prompt.length > ARDY_PROMPT_MAX) {
			setToast(`Motion prompt is capped at ${ARDY_PROMPT_MAX} characters (currently ${prompt.length}) — shorten it before generating`);
			return;
		}
		// Regeneration must keep the loaded clip's exact frame count. The form
		// may still show an older duration after a motion is loaded; using it
		// would ask ARDY for (for example) 120 frames against an 80-frame base.
		const duration = motion && ikFrames.length > 0
			? motion.frames / motion.fps
			: Math.round(Number(durationOverride)) || ARDY_DURATION_MIN;
		if (duration < ARDY_DURATION_MIN || duration > ARDY_DURATION_MAX) {
			setToast(`Duration must be between ${ARDY_DURATION_MIN} and ${ARDY_DURATION_MAX} seconds`);
			return;
		}
		const seed = ardySeed === "" ? null : Number(ardySeed);
		if (seed !== null && (!Number.isInteger(seed) || seed < 0 || seed > ARDY_SEED_MAX)) {
			setToast(`Seed must be an integer in 0..${ARDY_SEED_MAX} — clear it to let the box pick one`);
			return;
		}
		// Prompt clips are real generation blocks. Gaps inherit the current
		// prompt so the bridge always receives one contiguous 0..N sequence.
		const clipFrames = duration * 20;
		const rootPath = waypointMode
			? [{ frame: 0, x: charA.x, z: charA.z, heading: null }, ...waypoints]
			: [];
		if (waypointMode) {
			if (waypoints.length < 1) {
				setToast("Add at least one root destination before generating");
				return;
			}
			if (rootPath.length > MAX_WAYPOINTS) {
				setToast(`The root path is capped at ${MAX_WAYPOINTS} sparse waypoints`);
				return;
			}
			if (waypoints.some((waypoint) => waypoint.frame <= 0 || waypoint.frame >= clipFrames)) {
				setToast(`Root waypoint frames must stay inside 1..${clipFrames - 1}`);
				return;
			}
		}
		const ardyWaypoints = waypointMode ? toArdyWaypoints(rootPath, charA.rot) : [];
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

		// Capture every block boundary plus every authored IK key. Each sample
		// is the composite base-motion + IK pose at that frame and carries the
		// live ARDY root recovered from positional skinning.
		const hasPromptSchedule = segments.length > 1;
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
		// always the origin; scene placement and actor yaw are restored only at
		// playback, without constraining any later generated root frame.
		const rootRotationDeg = charA.rot;
		const controller = new AbortController();
		ardyAbortRef.current = controller;
		setArdyRunning(true);
		setArdyStatus("connecting…");
		setArdyReport(null);
		setArdyOutcome(null);
		try {
			const body = { prompt, duration, posePin: shouldPin };
			if (shouldPin && !hasBlockEdits) body.poses = poses;
			if (ardySeed !== "") body.seed = Number(ardySeed);
			if (waypointMode) body.waypoints = ardyWaypoints;
			else if (hasBlockEdits) {
				if (!motion?.url) {
					throw new Error("The current motion has no bridge source; generate the prompt blocks once before regenerating IK edits");
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
					if (event.event === "status") setArdyStatus(event.message);
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
				throw new Error("ARDY returned motion without verified authored IK keys");
			}
			setArdyOutcome({ ok: true, output: done.output, bytes: done.bytes, motionUrl: done.motionUrl });
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
			setToast("ARDY motion generated");
		} catch (err) {
			// Cancellation surfaces as an AbortError; everything else is the
			// bridge or the generator explaining itself.
			setArdyOutcome({
				ok: false,
				message: err?.name === "AbortError" ? "Cancelled" : err?.message || String(err),
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
				<div className="viewmode" aria-label="Workspace view">
					<button
						type="button"
						className={viewMode === "shot" ? "active" : ""}
						aria-pressed={viewMode === "shot"}
						onClick={() => setViewMode("shot")}
					>
						Shot view
					</button>
					<button
						type="button"
						className={viewMode === "plan" ? "active" : ""}
						aria-pressed={viewMode === "plan"}
						onClick={() => setViewMode("plan")}
					>
						Bird&apos;s-eye
					</button>
				</div>
				<details className="controls-menu">
					<summary>
						Controls
						<span aria-hidden="true">⌄</span>
					</summary>
					<div className="controls-popover">
					{posing ? (
						<p><strong>Pose mode</strong>Drag joint handles, then click Done.</p>
					) : ikMode ? (
						<p><strong>IK mode</strong>Drag a wrist or ankle. Keys land on Full-Body.</p>
					) : (
						<div className="controls-grid">
							<kbd>Right-drag</kbd><span>Look around (fly)</span>
							<kbd>RMB + WASD</kbd><span>Walk while flying</span>
							<kbd>RMB + Q/E</kbd><span>Crane down / up</span>
							<kbd>Middle-drag</kbd><span>Pan</span>
							<kbd>Alt + drag</kbd><span>Orbit the selection</span>
							<kbd>Scroll</kbd><span>Dolly</span>
							<kbd>Click</kbd><span>Select · empty clears</span>
							<kbd>W / E / R</kbd><span>Move / rotate / scale</span>
							<kbd>Ctrl</kbd><span>Invert snapping</span>
							<kbd>F</kbd><span>Frame selection</span>
							<kbd>Ctrl+D</kbd><span>Duplicate</span>
							<kbd>Drag puck</kbd><span>Move in plan</span>
						</div>
					)}
					</div>
				</details>
			</header>

			<div className="main" style={workspaceStyle}>
			<div className="workspace">
				<div className="viewport">
					<div className="stage" id="stage" ref={stageRef} data-render-loop={renderActive ? "always" : "demand"}>
						<Canvas frameloop={renderActive ? "always" : "demand"} dpr={[1, 2]} gl={{ preserveDrawingBuffer: true, antialias: true }}>
							<RenderLoopController stageRef={stageRef} />
							<ViewportLayoutInvalidator
								insetX={insetPos?.x ?? null}
								insetY={insetPos?.y ?? null}
								insetWidth={workspaceLayout.insetWidth}
								insetHeight={workspaceLayout.insetHeight}
								sidebarWidth={workspaceLayout.sidebarWidth}
								timelineHeight={workspaceLayout.timelineHeight}
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
								url="/models/y-bot-tpose.fbx"
								position={motion ? [motion.anchorX, 0, motion.anchorZ] : [charA.x, 0, charA.z]}
								rot={motion ? motion.rotationDeg : charA.rot}
								tint={CLAY}
								pose={motion ? null : poseA}
								onRig={setRigA}
							/>
							{showB && (
								<Character
									url="/models/y-bot-tpose.fbx"
									position={[charB.x, 0, charB.z]}
									rot={charB.rot}
									tint={CLAY_B}
									pose={poseB}
									onRig={setRigB}
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
							{/* Camera stays live in IK mode but drives the POSER camera,
							    never the shot camera: the handle layer only consumes
							    pointerdowns that hit a handle, so empty-space drags orbit
							    and the wheel dollies without wrecking the framing. */}
							<FlyControls
								enabled={!posing}
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
								enabled={!!posing && !planIsMain}
								onChange={() => setPoseTick((n) => n + 1)}
							/>
							<IkHandles
								chains={ikChains}
								fkJoints={ikFkJoints}
								ikState={ikStateRef.current}
								enabled={ikMode && !posing}
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
							/>
							{/* Object gizmo: the shot pane's direct manipulation. Off while
							    the plan owns the big pane (the pucks are the handles there)
							    and while posing/IK owns the pointer. */}
							<ObjectGizmo
								object={selectedSceneObject}
								objects={sceneObjects}
								mode={gizmoMode}
								snap={snapEnabled}
								enabled={!planIsMain && !posing && !ikMode}
								paneRef={mainPaneRef}
								camRef={shotCamRef}
								onChange={changeSceneObject}
								onDragStart={beginSceneTransaction}
								onDragEnd={endSceneTransaction}
								onSelect={(id) => selectHierarchy(id ? `object:${id}` : "props")}
							/>
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
							/>
						</Canvas>

						<div ref={mainPaneRef} className={"vp-pane vp-main" + (planIsMain ? " plan" : "")} />
						<div
							ref={insetPaneRef}
							className={"vp-pane vp-inset" + (planIsMain || ikMode ? " shot" : " plan")}
							style={insetPos ? { left: insetPos.x, top: insetPos.y, right: "auto" } : undefined}
						>
							<span
								className="vp-inset-tag"
								title="Drag to move — double-click to snap back"
								onPointerDown={beginInsetDrag}
								onDoubleClick={() => setInsetPos(null)}
							>
								{planIsMain || ikMode ? "Shot view" : "Bird\u2019s-eye"}
							</span>
							<span
								className="vp-inset-resize"
								role="separator"
								aria-label="Resize inset view"
								onPointerDown={beginInsetResize}
							/>
						</div>

						<div className="film-frame">
							<span />
							<span />
							<span />
							<span />
						</div>
						<div className={"caption" + (subjectVisible ? "" : " off")}>
							{subjectVisible ? slateLine(shot) : "SUBJECT OUT OF FRAME"}
						</div>

						{posing && (
							<PoseStudioPanel
								subject={posing === "B" ? 2 : 1}
								poses={allPoses}
								selectedId={studioPick}
								closing={posingClosing}
								onSelect={setStudioPick}
								onApply={() => {
									const pose = allPoses.find((p) => p.id === studioPick);
									if (pose) setPosed(pose);
								}}
								onReset={() => {
									setStudioPick(DEFAULT_POSE.id);
									setPosed(DEFAULT_POSE);
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
					aria-label="Resize hierarchy and inspector panel"
					onPointerDown={(event) => beginWorkspaceResize("sidebar", event)}
				/>
				<aside className="panel hierarchy-sidebar" data-inspector={selectedHierarchyId}>
					<nav className="right-panel-tabs" aria-label="Right panel view">
						<button
							type="button"
							className={rightPanelTab === "hierarchy" ? "active" : ""}
							aria-pressed={rightPanelTab === "hierarchy"}
							onClick={() => setRightPanelTab("hierarchy")}
						>
							Hierarchy
						</button>
						<button
							type="button"
							className={rightPanelTab === "detail" ? "active" : ""}
							aria-pressed={rightPanelTab === "detail"}
							onClick={() => setRightPanelTab("detail")}
						>
							{rightPanelDetailLabel}
						</button>
					</nav>
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
					<div className="right-panel-view">
					<div className="hierarchy-tab-pane" hidden={rightPanelTab !== "hierarchy"}>
					<HierarchyPanel
						selectedId={selectedHierarchyId}
						onSelect={selectHierarchy}
						showB={showB}
						motionFrames={motion?.frames ?? 0}
						promptCount={promptClips.length}
						ikFrames={ikFrames.length}
						ikMode={ikMode}
						waypointCount={waypoints.length}
						sceneObjects={sceneObjects}
						onAddObject={addSceneObject}
						onRenameObject={renameSceneObject}
						onDuplicateObject={duplicateSelectedSceneObject}
						onDeleteObject={deleteSceneObject}
						onFrameObject={frameSelection}
					/>
					</div>
					<section className="inspector-pane" hidden={rightPanelTab !== "detail"}>
					<div className="inspector-heading">
						<span>Inspector</span>
						<strong>{selectedSceneObject?.name ?? HIERARCHY_INSPECTOR_TITLES[selectedHierarchyId] ?? "Selection"}</strong>
					</div>
					<div className="inspector-scroll">
					<section className="card" hidden={selectedHierarchyId !== "shot"}>
						<h3>Shot type</h3>
						<div className="presets">
							{Object.entries(PRESETS).map(([key, p]) => (
								<button key={key} className={preset === key ? "active" : ""} onClick={() => applyPreset(key)}>
									{p.label}
								</button>
							))}
						</div>
					</section>

					<section className="card" hidden={selectedHierarchyId !== "camera"}>
						<h3>Camera</h3>
						<Slider label="Lens (FOV)" min={14} max={90} step={1} value={fovDeg} unit="°" onChange={setFovDeg} />
						<div className="readout">
							<span title="camera to subject">{shot.distance.toFixed(2)} m</span>
							<span title="nearest prime on a full-frame sensor">{shot.focalMm} mm</span>
							<span title="angle relative to the subject's eyes">{shot.elevationDeg.toFixed(0)}°</span>
						</div>
						<button className="btn ghost" onClick={() => setNonce((n) => n + 1)}>
							Recenter on subject
						</button>
					</section>

					<section className="card" hidden={!["characters", "characterA", "characterA.character", "characterB", "characterB.character"].includes(selectedHierarchyId)}>
						<h3>{showB ? "Subjects" : "Subject"}</h3>
						<div className={"subjects-row" + (showB ? "" : " single")}>
							<SubjectBox
								label="Subject 1"
								value={charA}
								onChange={setCharA}
								onPose={() => openStudio("A")}
								posing={posing === "A"}
							/>
							{showB && (
								<SubjectBox
									label="Subject 2"
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
								<span>Add second subject</span>
							</button>
						)}
					</section>

					<section className="card" hidden={!["characters", "characterA", "characterA.character", "characterB", "characterB.character"].includes(selectedHierarchyId)}>
						<h3>Pose</h3>
						<Field label={showB ? "Subject 1 pose" : "Pose"}>
							<Dropdown
								ariaLabel="Subject 1 pose"
								value={poseA?.id}
								options={allPoses.map((p) => ({ value: p.id, label: p.label }))}
								onChange={(id) => setPoseA(allPoses.find((p) => p.id === id))}
							/>
						</Field>
						{showB && (
							<Field label="Subject 2 pose">
								<Dropdown
									ariaLabel="Subject 2 pose"
									value={poseB?.id}
									options={allPoses.map((p) => ({ value: p.id, label: p.label }))}
									onChange={(id) => setPoseB(allPoses.find((p) => p.id === id))}
								/>
							</Field>
						)}
					</section>

					<section className="card" hidden={selectedHierarchyId !== "shot"}>
						<h3>Prompt</h3>
						<div className="segmented" data-active={mode}>
							<button className={mode === "image" ? "active" : ""} onClick={() => setMode("image")}>
								Image
							</button>
							<button className={mode === "video" ? "active" : ""} onClick={() => setMode("video")}>
								Video
							</button>
						</div>
						<Field label="Model">
							<Dropdown
								ariaLabel="Model"
								value={mode === "video" ? videoModel : imageModel}
								options={models.map((m) => ({ value: m.id, label: m.label }))}
								onChange={mode === "video" ? setVideoModel : setImageModel}
							/>
						</Field>

						<div className="sheet-checks">
							<label className="check">
								<input type="checkbox" checked={hasCharSheet} onChange={(e) => setHasCharSheet(e.target.checked)} />
								<span>I have a character sheet</span>
							</label>
							<label className="check">
								<input type="checkbox" checked={hasEnvSheet} onChange={(e) => setHasEnvSheet(e.target.checked)} />
								<span>I have an environment sheet</span>
							</label>
						</div>

						{!hasCharSheet && (
							<Field label={showB ? "Subject 1" : "Subject"}>
								<input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} />
							</Field>
						)}
						{!hasCharSheet && showB && (
							<Field label="Subject 2">
								<input type="text" value={subject2} onChange={(e) => setSubject2(e.target.value)} />
							</Field>
						)}
						{!hasEnvSheet && (
							<Field label="Environment">
								<input type="text" value={environment} onChange={(e) => setEnvironment(e.target.value)} />
							</Field>
						)}
						{mode === "video" && (
							<Field label="Camera move">
								<Dropdown
									ariaLabel="Camera move"
									value={cameraMove}
									options={CAMERA_MOVES.map((m) => ({ value: m, label: m }))}
									onChange={setCameraMove}
								/>
							</Field>
						)}
						{mode === "video" && cameraMove === CUSTOM_MOVE && (
							<Field label="Custom camera move">
								<input
									type="text"
									value={customMove}
									onChange={(e) => setCustomMove(e.target.value)}
									placeholder="describe the camera move"
								/>
							</Field>
						)}
						<Field label="Look / style">
							<input type="text" value={style} onChange={(e) => setStyle(e.target.value)} />
						</Field>

						<button
							className="btn ghost full"
										title="Export the posed character as an ARDY CozyClayPoseV1 JSON"
							onClick={downloadArdyPose}
						>
							Export ARDY pose
						</button>
						<button className="btn primary full generate" onClick={generate}>
							Generate
						</button>
					</section>
				<section className="card" hidden={!["characterA.motion", "characterA.baseMotion"].includes(selectedHierarchyId)}>
					<h3>ARDY motion</h3>
					{bridge === null ? (
						<p className="ardy-hint">Checking for the dev bridge…</p>
					) : bridge.ok ? (
						<>
							<p className="ardy-meta">
								{bridge.host ?? "box"} · {bridge.device ?? "device?"} · encoder{" "}
								{bridge.encoder ?? "?"}
							</p>
							<p className="ardy-hint">Neutral skeleton · block boundaries and IK keys are pinned automatically.</p>
							<Field label="Motion prompt">
								<input
									type="text"
									value={ardyPrompt}
									onChange={(e) => setArdyPrompt(e.target.value)}
									placeholder="what the subject should do"
									maxLength={ARDY_PROMPT_MAX}
								/>
								<span className="ardy-clamp">max {ARDY_PROMPT_MAX} chars · required</span>
							</Field>
							<Field label="Duration (s)">
								<input
									type="number"
									min={ARDY_DURATION_MIN}
									max={ARDY_DURATION_MAX}
									step={1}
									value={ardyDuration}
									onChange={(e) => changeDuration(e.target.value)}
								/>
							</Field>
							<Field label="Seed (optional)">
								<input
									type="text"
									inputMode="numeric"
									value={ardySeed}
									onChange={(e) => changeArdySeed(e.target.value)}
									placeholder="empty = random"
								/>
								<span className="ardy-clamp">RT default 2 · empty = random · 0..{ARDY_SEED_MAX}</span>
							</Field>
							{ardyRunning ? (
								<button type="button" className="btn ghost full" onClick={cancelArdy}>
									Cancel run
								</button>
							) : (
								<button
									type="button"
									className="btn primary full generate"
									onClick={() => runArdy()}
								>
									Generate motion
								</button>
							)}
							{ardyStatus && <p className="ardy-status">{ardyStatus}</p>}
							{ardyReport && (
								<div className="ardy-report">
									<div className="ardy-report-grid">
										<span>shape mean error</span>
										<b>{fmtMeters(ardyReport.shape_mean_error_m)}</b>
										<span>shape max error</span>
										<b>{fmtMeters(ardyReport.shape_max_error_m)}</b>
										<span>max jump</span>
										<b>{fmtMeters(ardyReport.continuity?.max_jump_m)}</b>
									</div>
									<p className="ardy-caveat">
										Shape error proves joint-center placement only —{" "}
										{ardyReport.surface_contact_verified
											? "contact verified"
											: "foot-to-floor contact NOT verified"}{" "}
										· target_space {ardyReport.target_space ?? "unknown"}
									</p>
								</div>
							)}
							{ardyOutcome?.ok && (
								<>
									<p className="ardy-outcome done">
										Output <code>{ardyOutcome.output}</code> ({ardyOutcome.bytes} bytes)
										{ardyOutcome.motionUrl && (
											<>
												{" "}
												· motion <code>{ardyOutcome.motionUrl}</code>
											</>
										)}
									</p>
									{motionBusy ? (
										<p className="ardy-hint">Decoding motion…</p>
									) : motion ? (
										<p className="ardy-outcome done">
											Motion loaded — {motion.frames} frames @ {motion.fps} fps, playing on Subject 1
										</p>
									) : motionError ? (
										<>
											<p className="ardy-outcome error">Motion decode failed: {motionError}</p>
											{ardyOutcome.motionUrl && (
												<button type="button" className="btn ghost full" onClick={() => loadMotion(ardyOutcome.motionUrl)}>
													Retry load
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
								ARDY generation needs the dev bridge — start it with{" "}
								<code>node tools/ardy/bridge.mjs</code> in the repo root, then reload.
							</p>
							{bridge.reason && <p className="ardy-hint">{bridge.reason}</p>}
						</>
					)}
				</section>
					<section className="card" hidden={selectedHierarchyId !== "characterA.promptBlocks"}>
						<h3>Prompt Blocks</h3>
						<p className="inspector-hint">Blocks define what ARDY generates over each frame range. Selecting one also moves editing context to that prompt.</p>
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
									<span>{clip.text || "Untitled motion"}</span>
									<small>{clip.startFrame}–{clip.endFrame}f</small>
								</button>
							))}
						</div>
						{selectedPromptId && (
							<Field label="Selected block prompt">
								<input
									type="text"
									value={promptClips.find((clip) => clip.id === selectedPromptId)?.text ?? ""}
									onChange={(event) => {
										changePromptClip(selectedPromptId, event.target.value);
										setArdyPrompt(event.target.value);
									}}
									placeholder="describe this motion block"
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
								? `Generating ${promptClips.length} blocks…`
								: `Generate all ${promptClips.length} blocks`}
						</button>
						{!bridge?.ok && <p className="ardy-hint">Start the ARDY bridge to enable generation.</p>}
						{ardyStatus && <p className="ardy-status">{ardyStatus}</p>}
						<button type="button" className="btn ghost full" onClick={() => addPromptClip(tlFrame)}>
							Add block at frame {tlFrame}
						</button>
					</section>

					<section className="card" hidden={selectedHierarchyId !== "characterA.ik"}>
						<h3>IK Corrections</h3>
						<div className="inspector-status-grid">
							<span>IK mode</span><b>{ikMode ? "ON" : "OFF"}</b>
							<span>Current frame</span><b>{tlFrame}</b>
							<span>Keys</span><b>{ikFrames.length}</b>
						</div>
						<button type="button" className={"btn full" + (ikMode ? " primary" : "")} onClick={toggleIkMode} disabled={!ikChains}>
							{ikMode ? "Exit IK mode" : "Enter IK mode"}
						</button>
						<label className="check">
							<input type="checkbox" checked={footSnap} onChange={() => setFootSnap((value) => !value)} />
							<span>Keep feet planted during body edits</span>
						</label>
						<button type="button" className="btn ghost full" onClick={ikAddKeyframe} disabled={!ikChains}>
							Add key at frame {tlFrame}
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
									<span>Frame {frame}</span>
									<small>{tlFrame === frame ? "Current" : "right-click removes"}</small>
								</button>
							))}
						</div>
					</section>

					<section className="card" hidden={!(selectedHierarchyId === "characterA.rig" || selectedHierarchyId.startsWith("rig."))}>
						<h3>Rig Control</h3>
						<p className="inspector-hint">
							{selectedHierarchyId.startsWith("rig.")
								? `${HIERARCHY_INSPECTOR_TITLES[selectedHierarchyId]} is the active control group.`
								: "Choose a body group in the hierarchy, then manipulate its handle in the main view."}
						</p>
						<div className="inspector-status-grid">
							<span>Rig</span><b>{ikChains ? "Ready" : "Unavailable"}</b>
							<span>Focus</span><b>{ikFocus ?? "None"}</b>
							<span>Foot lock</span><b>{footSnap ? "ON" : "OFF"}</b>
						</div>
						<button type="button" className={"btn full" + (ikMode ? " primary" : "")} onClick={toggleIkMode} disabled={!ikChains}>
							{ikMode ? "Finish rig editing" : "Edit rig with IK"}
						</button>
					</section>

					<section className="card" hidden={selectedHierarchyId !== "rootPath"}>
						<h3>Root Path</h3>
						<div className="inspector-status-grid">
							<span>Path mode</span><b>{waypointMode ? "ON" : "OFF"}</b>
							<span>Waypoints</span><b>{waypoints.length}</b>
							<span>Current frame</span><b>{tlFrame}</b>
						</div>
						<button type="button" className={"btn full" + (waypointMode ? " primary" : "")} onClick={toggleWaypointMode}>
							{waypointMode ? "Finish path editing" : "Edit root path"}
						</button>
						<button type="button" className="btn ghost full" onClick={() => addRootKeyframe(tlFrame)}>
							Add waypoint at frame {tlFrame}
						</button>
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
									<span>Frame {waypoint.frame}</span>
									<small>{waypoint.x.toFixed(2)}, {waypoint.z.toFixed(2)}</small>
								</button>
							))}
						</div>
					</section>

					<section className="card" hidden={selectedHierarchyId !== "environment"}>
						<h3>Environment</h3>
						<label className="check">
							<input type="checkbox" checked={hasEnvSheet} onChange={(event) => setHasEnvSheet(event.target.checked)} />
							<span>I have an environment sheet</span>
						</label>
						{!hasEnvSheet && (
							<Field label="Environment description">
								<input type="text" value={environment} onChange={(event) => setEnvironment(event.target.value)} />
							</Field>
						)}
						<Field label="Look / style">
							<input type="text" value={style} onChange={(event) => setStyle(event.target.value)} />
						</Field>
					</section>

					<section className="card" hidden={selectedHierarchyId !== "props"}>
						<h3>Props</h3>
						<p className="inspector-hint">Everything you add to the set lives here. Pick one to edit it, or click it in the shot view.</p>
						<AddObjectMenu onAdd={addSceneObject} label="Add object to the set" />
						<div className="inspector-list compact">
							{sceneObjects.map((object) => (
								<button
									type="button"
									key={object.id}
									onClick={() => selectHierarchy(`object:${object.id}`)}
								>
									<span>{object.name}</span>
									<small>{object.renderer}</small>
								</button>
							))}
						</div>
					</section>

					<section className="card" hidden={!selectedSceneObject}>
						<h3>Object Transform</h3>
						{selectedSceneObject && (
							<>
								<p className="inspector-hint">
									Type an exact value and press Enter, or drag the X / Y / Z label
									next to a field to scrub it. Values here and the gizmo write to
									the same record, so the two views can never disagree.
								</p>
								<div className="presets gizmo-modes">
									<button type="button" className={gizmoMode === "move" ? "active" : ""} onClick={() => setGizmoMode("move")}>
										Move <kbd>W</kbd>
									</button>
									<button type="button" className={gizmoMode === "rotate" ? "active" : ""} onClick={() => setGizmoMode("rotate")}>
										Rotate <kbd>E</kbd>
									</button>
									<button type="button" className={gizmoMode === "scale" ? "active" : ""} onClick={() => setGizmoMode("scale")}>
										Scale <kbd>R</kbd>
									</button>
								</div>
								<label className="check snap-toggle">
									<input type="checkbox" checked={snapEnabled} onChange={(event) => setSnapEnabled(event.target.checked)} />
									<span>Snap to grid — hold <kbd>Ctrl</kbd> to invert</span>
								</label>
								<Field label="Name">
									<input
										type="text"
										value={selectedSceneObject.name}
										onChange={(event) => changeSceneObject(selectedSceneObject.id, { name: event.target.value })}
									/>
								</Field>
								<Vector3Row
									label="Position"
									fields={[
										{ axis: "X", value: selectedSceneObject.x, step: 0.05, precision: 2, onChange: (x) => changeSceneObject(selectedSceneObject.id, { x }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Y", value: selectedSceneObject.y ?? 0, step: 0.05, precision: 2, onChange: (y) => changeSceneObject(selectedSceneObject.id, { y }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Z", value: selectedSceneObject.z, step: 0.05, precision: 2, onChange: (z) => changeSceneObject(selectedSceneObject.id, { z }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
									]}
								/>
								<Vector3Row
									label="Rotation"
									fields={[
										{ axis: "X", value: selectedSceneObject.rotX ?? 0, step: 1, precision: 1, onChange: (rotX) => changeSceneObject(selectedSceneObject.id, { rotX }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Y", value: selectedSceneObject.rot, step: 1, precision: 1, onChange: (rot) => changeSceneObject(selectedSceneObject.id, { rot }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Z", value: selectedSceneObject.rotZ ?? 0, step: 1, precision: 1, onChange: (rotZ) => changeSceneObject(selectedSceneObject.id, { rotZ }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
									]}
								/>
								<Vector3Row
									label="Scale"
									fields={[
										{ axis: "X", value: selectedSceneObject.scaleX ?? 1, step: 0.05, precision: 2, onChange: (scaleX) => changeSceneObject(selectedSceneObject.id, { scaleX }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Y", value: selectedSceneObject.scaleY ?? 1, step: 0.05, precision: 2, onChange: (scaleY) => changeSceneObject(selectedSceneObject.id, { scaleY }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Z", value: selectedSceneObject.scaleZ ?? 1, step: 0.05, precision: 2, onChange: (scaleZ) => changeSceneObject(selectedSceneObject.id, { scaleZ }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
									]}
								/>
								<div className="object-colors" role="group" aria-label="Object colour">
									{OBJECT_COLORS.map((color) => (
										<button
											type="button"
											key={color}
											className={"object-color" + (selectedSceneObject.color === color ? " active" : "")}
											style={{ background: color }}
											aria-label={`Colour ${color}`}
											aria-pressed={selectedSceneObject.color === color}
											onClick={() => changeSceneObject(selectedSceneObject.id, { color })}
										/>
									))}
								</div>
								<button
									type="button"
									className="btn ghost full"
									title="You can also press Delete or Backspace"
									onClick={deleteSelectedSceneObject}
								>
									Remove {selectedSceneObject.name}
								</button>
							</>
						)}
					</section>
					</div>
					</section>
					</div>
				</aside>
			</div>

			<div
				className="workspace-splitter timeline-splitter"
				role="separator"
				aria-label="Resize frame monitor"
				onPointerDown={(event) => beginWorkspaceResize("timeline", event)}
			/>
				<Timeline
					frame={tlFrame}
					frameCount={tlFrameCount}
					fps={tlFps}
					playbackSpeed={DEFAULT_PLAYBACK_SPEED}
				playing={tlPlaying}
				waypointMode={waypointMode}
				waypointFrames={waypoints.map((w) => w.frame)}
				pathSpeed={pathSpeed}
				pendingWaypointFrame={activeWaypointFrame}
				promptClips={promptClips}
				selectedPromptId={selectedPromptId}
				badge={stateBadge}
				ikMode={ikMode}
				ikDisabled={!ikChains}
				ikFrames={ikFrames}
				footSnap={footSnap}
				onIkToggle={toggleIkMode}
				onIkKeyframeAdd={ikAddKeyframe}
				onIkKeyframeRemove={ikDeleteKeyframe}
				onFootSnapToggle={() => {
					setFootSnap((v) => {
						setToast(v ? "Foot snap off — the feet follow the body" : "Foot snap on — the feet stay planted while the body moves");
						return !v;
					});
				}}
				onScrub={setTlFrame}
				onAdvance={advanceFrame}
				onStep={stepFrame}
				onPlayToggle={() => setTlPlaying((v) => !v)}
				onWaypointToggle={toggleWaypointMode}
				onMarkerSelect={(f) => { setTlFrame(Math.min(f, tlFrameCount - 1)); setActiveWaypointFrame(f); setWaypointMode(true); setSelectedHierarchyId("rootPath"); }}
				onMarkerRemove={removeWaypoint}
				onRootKeyframeAdd={addRootKeyframe}
				onPromptAdd={addPromptClip}
				onPromptSelect={(id) => {
					setSelectedPromptId(id);
					setArdyPrompt(promptClips.find((clip) => clip.id === id)?.text ?? "");
					setSelectedHierarchyId("characterA.promptBlocks");
					setRightPanelTab("detail");
				}}
				onPromptChange={changePromptClip}
				onPromptResize={resizePromptClip}
				onPromptMove={movePromptClip}
				onPromptRemove={removePromptClip}
				onClearMotion={motion ? clearMotion : null}
			/>
		</div>

			<footer className="brandbar">
				<span className="wordmark">
					Cozy <span>Clay</span>
				</span>
			</footer>

			{result && (
				<div className="modal-overlay" onClick={() => setResult(null)}>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<div className="modal-head">
							<h3>Your shot is ready</h3>
							<button className="x" onClick={() => setResult(null)}>
								✕
							</button>
						</div>
						{result.frame && <img className="preview" src={result.frame} alt="framed shot" />}
						<label className="modal-label">Prompt {copied && <em>· copied</em>}</label>
						<div className="promptbox">{result.prompt}</div>
						<div className="modal-actions">
							<button
								className="btn"
								onClick={() =>
									navigator.clipboard?.writeText(result.prompt).then(() => {
										setCopied(true);
										setToast("Prompt copied to clipboard");
									})
								}
							>
								{copied ? "Copied ✓" : "Copy prompt"}
							</button>
							{result.frame && (
								<button className="btn" onClick={download}>
									Download frame
								</button>
							)}
						</div>
					</div>
				</div>
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
							title={`Pose ${label}`}
							onClick={onPose}
						>
							⌘
						</button>
					)}
					{onRemove && (
						<button type="button" className="sb-remove" title="Remove subject" onClick={onRemove}>
							✕
						</button>
					)}
				</div>
			</div>
			<Slider compact label="Left / right" min={-4} max={4} step={0.1} value={value.x} onChange={set("x")} />
			<Slider compact label="Depth" min={-4} max={4} step={0.1} value={value.z} onChange={set("z")} />
			<Slider compact label="Rotate" min={-180} max={180} step={1} value={value.rot} unit="°" onChange={set("rot")} />
		</div>
	);
}
