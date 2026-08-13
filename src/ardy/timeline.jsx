import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { frameFromClientX, promptMoveStartFrame, shotBlockGeometry } from "./timeline-coordinates.js";
import { promptResizeFrame } from "./timeline-resize.js";
import { ko, isKo } from "../locale.js";

/**
 * ARDY Viser-style animation timeline — the live motion workspace.
 *
 * Frame, playback, waypoints and the motion badge are owned by App: this
 * component is controlled and reports every interaction through callbacks,
 * so the scene (character rig, root path) can react to playhead moves.
 * The 2D Root lane authors temporal keyframes directly: left-clicking an empty
 * track cell creates/selects a numbered waypoint, then Top-View owns its
 * spatial position through direct marker dragging.
 * The Camera lane authors shot-camera keyframings directly: left-clicking an
 * empty track cell keys the CURRENT camera framing at that frame, dots jump
 * the playhead on click, drag to re-time, right-click to remove. Playback
 * and PlayView ride the keys segment by segment.
 */

const DEFAULT_FRAME_COUNT = 300; // 15 s @ 20 fps, the ARDY Core cadence
const DEFAULT_FPS = 20;
// Trackpad/wheel zoom over the FRAME ruler: the gesture changes only the
// horizontal visual scale of the time surface — never frameCount, fps,
// duration, waypoints or the generation request.
const ZOOM_MIN = 1 / 3; // show up to 3× more frames than the 1× viewport
const ZOOM_DEFAULT = 1;
const ZOOM_MAX = 8;
const ZOOM_STEP = 0.25; // one wheel notch = one zoom step
// Wheel deltas are accumulated in pixels; LINE/PAGE deltas are normalized
// (a line-mode notch is ~3 lines). A step fires every 50 px, capped at 3
// steps per event so a violent flick cannot jump the whole range.
const WHEEL_STEP_PX = 50;
const MAX_WHEEL_STEPS = 3;

const TRACKS = [
	"Prompts",
	"Full-Body",
	"2D Root",
	"Shots",
	"Camera",
];
const TRACK_LABELS_KO = {
	Prompts: ko("Prompts", "프롬프트"),
	"Full-Body": ko("Full-Body", "전신"),
	"2D Root": ko("2D Root", "2D 루트"),
	Shots: ko("Shots", "샷"),
	Camera: ko("Camera", "카메라"),
};

/** IK keys live on the Full-Body lane: one marker per keyed frame, holding
 * a sparse set of the limbs the user has moved (never every joint). */
const IK_LANE = "Full-Body";
const CAMERA_LANE = "Camera";
const SHOTS_LANE = "Shots";
// Ruler labels and lane gridlines share one 10-frame cadence, so authored
// elements (40-frame prompt blocks, camera key dots) always land on visible
// lines. Label density adapts to zoom in 10-based steps.
const GRID_STEP_FRAMES = 10;
const LABEL_STEPS = [10, 20, 50, 100, 200, 500, 1000];
const MAX_LABELS = 30;

const framePct = (f, count) => (count > 1 ? f / (count - 1) : 0);

export default function Timeline({
	frame,
	frameCount = DEFAULT_FRAME_COUNT,
	fps = DEFAULT_FPS,
	playbackSpeed = 1,
	playing,
	waypointMode,
	waypointFrames = [],
	pathSpeed = null,
	badge,
	promptClips = [],
	selectedPromptId,
	pendingWaypointFrame = null,
	ikMode = false,
	ikDisabled = false, // a loaded motion owns the rig
	ikFrames = [], // sorted full-body key frames
	footSnap = true, // feet stay planted while the body moves
	cameraKeyFrames = [], // sorted camera key frames — dots on the Camera lane
	shots = [],
	activeShotIdx = 0,
	shotCutDisabled = false,
	onScrub,
	onAdvance,
	onStep,
	onPlayToggle,
	onWaypointToggle,
	onMarkerSelect,
	onMarkerRemove,
	onRootKeyframeAdd,
	onPromptAdd,
	onPromptSelect,
	onPromptChange,
	onPromptResize,
	onPromptMove,
	onPromptRemove,
	onClearMotion,
	onIkToggle,
	onIkKeyframeAdd,
	onIkKeyframeRemove,
	onFootSnapToggle,
	onCameraMoveSelect,
	onCameraKeyframeAdd,
	onCameraKeyframeMove,
	onCameraKeyframeRemove,
	onShotSelect,
	onShotBoundaryMove,
	onShotRename,
	onShotRemove,
	onShotDuplicate,
	onShotCut,
	onShotEndResize,
	onShotMove,
}) {
	const [expanded, setExpanded] = useState(true);
	const [zoom, setZoom] = useState(ZOOM_DEFAULT);
	const [movingPromptId, setMovingPromptId] = useState(null);
	const [renamingShotId, setRenamingShotId] = useState(null);
	const [movingShotId, setMovingShotId] = useState(null);
	const rulerRef = useRef(null);
	const bodyRef = useRef(null);
	const scrubbing = useRef(false);
	// Wheel zoom is driven by the pointer's live gesture: zoomRef tracks the
	// intended zoom synchronously between renders, renderedRef the zoom that
	// is actually in the DOM, and pendingScrollRef the scrollLeft to apply
	// right after the next render so the frame under the pointer stays put.
	const zoomRef = useRef(ZOOM_DEFAULT);
	const renderedRef = useRef(ZOOM_DEFAULT);
	const pendingScrollRef = useRef(null);
	// The window key/interval handlers register once; the latest callbacks
	// are read through a ref so they never go stale mid-playback.
	const handlers = useRef({});
	handlers.current = { onScrub, onAdvance, onStep, onPlayToggle, onWaypointToggle, onMarkerSelect, onMarkerRemove, onRootKeyframeAdd, onPromptAdd, onPromptSelect, onPromptChange, onPromptResize, onPromptMove, onPromptRemove, onIkToggle, onIkKeyframeAdd, onIkKeyframeRemove, onFootSnapToggle, onCameraMoveSelect, onCameraKeyframeAdd, onCameraKeyframeMove, onCameraKeyframeRemove, onShotSelect, onShotBoundaryMove, onShotRename, onShotRemove, onShotDuplicate, onShotCut, onShotEndResize, onShotMove };

	// Trackpad/wheel zoom over the FRAME ruler lane only. React registers
	// onWheel as passive, so a synthetic onWheel could never preventDefault —
	// attach a real non-passive listener instead, so a vertical gesture over
	// the ruler zooms the timeline instead of scrolling the page. Under Mac
	// natural scrolling the signed delta follows the physical gesture: two
	// fingers up (deltaY > 0) zooms IN, two fingers down (deltaY < 0) zooms
	// OUT. Horizontal swipes (deltaY === 0) are left alone so they scroll the
	// zoomed surface natively within .tl-body.
	useEffect(() => {
		const el = rulerRef.current;
		if (!el) return;
		let acc = 0;
		const onWheel = (e) => {
			if (e.deltaY === 0) return;
			e.preventDefault();
			const dy =
				e.deltaMode === 1 ? (e.deltaY * WHEEL_STEP_PX) / 3 : e.deltaMode === 2 ? e.deltaY * WHEEL_STEP_PX * 8 : e.deltaY;
			acc += dy;
			let steps = Math.trunc(acc / WHEEL_STEP_PX);
			steps = Math.max(-MAX_WHEEL_STEPS, Math.min(MAX_WHEEL_STEPS, steps));
			acc -= steps * WHEEL_STEP_PX;
			if (steps === 0) return;
			const zR = renderedRef.current;
			const z1 = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomRef.current + steps * ZOOM_STEP));
			if (z1 === zR) return;
			zoomRef.current = z1;
			setZoom(z1);
			// Keep the frame under the pointer anchored. `dx` already includes
			// the sticky label offset and the body's current horizontal scroll,
			// so only add the extra scaled distance.
			const body = bodyRef.current;
			const lane = rulerRef.current;
			if (!body || !lane) return;
			const rect = lane.getBoundingClientRect();
			if (rect.width <= 0) return;
			const dx = e.clientX - rect.left;
			const labelW = parseFloat(getComputedStyle(body).getPropertyValue("--tl-label-w")) || 148;
			const surfaceR = Math.max(ZOOM_DEFAULT, zR);
			const surface1 = Math.max(ZOOM_DEFAULT, z1);
			const maxScroll = Math.max(0, labelW + (rect.width / surfaceR) * surface1 - body.clientWidth);
			const target = body.scrollLeft + dx * (surface1 / surfaceR - 1);
			pendingScrollRef.current = Math.max(0, Math.min(target, maxScroll));
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
		// The ruler lane unmounts when the timeline collapses, so re-attach
		// whenever it comes back; zoom state itself lives on in the component.
	}, [expanded]);

	// Commit the gesture's scroll anchor right after the zoomed layout lands,
	// before paint — otherwise the surface would snap back to frame 0.
	useLayoutEffect(() => {
		renderedRef.current = zoom;
		if (pendingScrollRef.current == null) return;
		const body = bodyRef.current;
		if (body) {
			const max = Math.max(0, body.scrollWidth - body.clientWidth);
			body.scrollLeft = Math.max(0, Math.min(pendingScrollRef.current, max));
		}
		pendingScrollRef.current = null;
	}, [zoom]);

	function resetZoom() {
		if (renderedRef.current === ZOOM_DEFAULT && zoomRef.current === ZOOM_DEFAULT) return;
		zoomRef.current = ZOOM_DEFAULT;
		setZoom(ZOOM_DEFAULT);
		pendingScrollRef.current = 0; // at 1× the surface fits exactly: no scroll
	}

	// Playhead advance at the loaded clip's fps multiplied by preview speed;
	// wraps at the end without resampling the underlying motion.
	useEffect(() => {
		if (!playing) return;
		const id = window.setInterval(
			() => handlers.current.onAdvance?.(),
			1000 / Math.max(1, fps * playbackSpeed),
		);
		return () => window.clearInterval(id);
	}, [playing, fps, playbackSpeed]);

	// Space toggles playback, j/k step the playhead, p toggles waypoint mode —
	// but only when focus is outside interactive native controls: a focused
	// input/select owns its keys, and Space on a focused button would trigger
	// the button's native activation on top of the global toggle. Focus on
	// the body or canvas keeps the shortcuts live.
	useEffect(() => {
		function onKey(e) {
			const el = document.activeElement;
			const interactive =
				el &&
				(el.tagName === "INPUT" ||
					el.tagName === "TEXTAREA" ||
					el.tagName === "SELECT" ||
					el.tagName === "BUTTON" ||
					el.isContentEditable);
			if (interactive) return;
			// Physical key codes, not characters — Hangul IME turns j/k/p into
			// ㅓ/ㅔ/ㅔ and the shortcuts would go dead (same fix as FlyControls).
			// Space and P are toggles — ignore OS key-repeat so a held key
			// cannot flap playback or waypoint mode; j/k keep stepping.
			if (e.repeat && (e.code === "Space" || e.code === "KeyP")) return;
			const h = handlers.current;
			if (e.code === "Space") {
				e.preventDefault();
				h.onPlayToggle?.();
			} else if (e.code === "KeyJ") {
				h.onStep?.(1);
			} else if (e.code === "KeyK") {
				h.onStep?.(-1);
			} else if (e.code === "KeyP") {
				h.onWaypointToggle?.();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// Below 1× the surface still fills the viewport; the ruler exposes a wider
	// virtual frame range instead of physically shrinking into the left edge.
	const displayFrameCount = zoom < ZOOM_DEFAULT ? Math.ceil(frameCount / zoom) : frameCount;
	const surfaceZoom = Math.max(ZOOM_DEFAULT, zoom);
	const labelStep = LABEL_STEPS.find((s) => (displayFrameCount - 1) / s <= MAX_LABELS) ?? LABEL_STEPS[LABEL_STEPS.length - 1];
	const labels = useMemo(() => {
		const out = [];
		for (let f = 0; f < displayFrameCount; f += labelStep) out.push(f);
		return out;
	}, [displayFrameCount, labelStep]);
	// Lane gridlines ride the same 10-frame cadence and the same framePct as
	// the ruler ticks, so lines and labels can never drift apart at any zoom.
	const gridFrames = useMemo(() => {
		const out = [];
		for (let f = 0; f < displayFrameCount; f += GRID_STEP_FRAMES) out.push(f);
		return out;
	}, [displayFrameCount]);
	// Chips clamp into the surface; markers use framePct directly. One scale
	// for everything — the old /count chip scale drifted off the gridlines.
	const clipPct = (value) => Math.max(0, Math.min(1, framePct(value, displayFrameCount)));
	const moveRef = useRef(null);
	const suppressPromptClickRef = useRef(false);
	const resizeRef = useRef(null);
	const camDragRef = useRef(null);
	const camSuppressClickRef = useRef(false);
	const shotBoundaryRef = useRef(null);
	const shotMoveRef = useRef(null);
	const shotSuppressClickRef = useRef(false);

	function beginPromptMove(e, clip) {
		if (e.button !== 0 || e.target.closest(".tl-chip-handle")) return;
		const lane = e.currentTarget.closest(".tl-lane");
		if (!lane) return;
		const rect = lane.getBoundingClientRect();
		moveRef.current = {
			id: clip.id,
			pointerId: e.pointerId,
			startClientX: e.clientX,
			startFrame: clip.startFrame,
			laneWidth: rect.width,
			displayFrameCount,
			moving: false,
		};
		handlers.current.onPromptSelect?.(clip.id);
	}

	function movePrompt(e) {
		const active = moveRef.current;
		if (!active || e.pointerId !== active.pointerId) return;
		if (!active.moving) {
			if (Math.abs(e.clientX - active.startClientX) < 4) return;
			active.moving = true;
			e.currentTarget.setPointerCapture(e.pointerId);
			setMovingPromptId(active.id);
			document.activeElement?.blur();
		}
		e.preventDefault();
		e.stopPropagation();
		const rawStart = promptMoveStartFrame(
			active.startFrame,
			active.startClientX,
			e.clientX,
			active.laneWidth,
			active.displayFrameCount
		);
		handlers.current.onPromptMove?.(active.id, rawStart);
	}

	function endPromptMove(e) {
		const active = moveRef.current;
		if (!active || e.pointerId !== active.pointerId) return;
		if (active.moving) {
			e.preventDefault();
			e.stopPropagation();
			suppressPromptClickRef.current = true;
			if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
			queueMicrotask(() => { suppressPromptClickRef.current = false; });
		}
		moveRef.current = null;
		setMovingPromptId(null);
	}

	function blockPromptClick(e) {
		if (!suppressPromptClickRef.current) return;
		e.preventDefault();
		e.stopPropagation();
	}

	function beginPromptResize(e, clip, edge) {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		e.currentTarget.setPointerCapture?.(e.pointerId);
		resizeRef.current = {
			id: clip.id,
			edge,
			startClientX: e.clientX,
			startFrame: edge === "start" ? clip.startFrame : clip.endFrame,
			lastFrame: edge === "start" ? clip.startFrame : clip.endFrame,
		};
		handlers.current.onPromptSelect?.(clip.id);
	}

	function movePromptResize(e) {
		const active = resizeRef.current;
		if (!active) return;
		const nextFrame = promptResizeFrame(active.startFrame, active.startClientX, e.clientX);
		if (nextFrame === active.lastFrame) return;
		active.lastFrame = nextFrame;
		handlers.current.onPromptResize?.(active.id, active.edge, nextFrame);
	}

	function endPromptResize(e) {
		if (!resizeRef.current) return;
		resizeRef.current = null;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
	}

	// Camera key dots re-time by dragging, like prompt clips move: the frame
	// delta comes from the pointer-down geometry so a growing timeline cannot
	// feed back into the next pointermove.
	function beginCameraKeyDrag(e, keyFrame) {
		if (e.button !== 0) return;
		e.stopPropagation();
		// A 10px dot loses the pointer almost immediately without capture —
		// grab it on pointerdown so the drag survives past the marker's edge.
		e.currentTarget.setPointerCapture?.(e.pointerId);
		const lane = e.currentTarget.closest(".tl-lane");
		const rect = lane?.getBoundingClientRect();
		camDragRef.current = {
			pointerId: e.pointerId,
			startClientX: e.clientX,
			fromFrame: keyFrame,
			currentFrame: keyFrame,
			laneWidth: rect?.width ?? 1,
			displayFrameCount,
			moved: false,
		};
	}

	function moveCameraKeyDrag(e) {
		const active = camDragRef.current;
		if (!active || e.pointerId !== active.pointerId) return;
		if (!active.moved) {
			if (Math.abs(e.clientX - active.startClientX) < 4) return;
			active.moved = true;
		}
		e.preventDefault();
		e.stopPropagation();
		const framesPerPixel = Math.max(0, active.displayFrameCount - 1) / Math.max(1, active.laneWidth);
		const raw = active.fromFrame + (e.clientX - active.startClientX) * framesPerPixel;
		const next = Math.max(0, Math.min(frameCount - 1, Math.round(raw)));
		if (next === active.currentFrame) return;
		const from = active.currentFrame;
		active.currentFrame = next;
		handlers.current.onCameraKeyframeMove?.(from, next);
	}

	function endCameraKeyDrag(e) {
		const active = camDragRef.current;
		if (!active || e.pointerId !== active.pointerId) return;
		if (active.moved) {
			e.preventDefault();
			e.stopPropagation();
			camSuppressClickRef.current = true;
			if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
			queueMicrotask(() => { camSuppressClickRef.current = false; });
		}
		camDragRef.current = null;
	}

	function onCameraKeyClick(e, keyFrame) {
		if (camSuppressClickRef.current) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		e.stopPropagation();
		handlers.current.onScrub?.(keyFrame);
		handlers.current.onCameraMoveSelect?.();
	}

	function beginShotBoundaryDrag(e, boundaryIndex, timelineEnd = false) {
		if (e.button !== 0 || (!timelineEnd && boundaryIndex <= 0)) return;
		e.preventDefault();
		e.stopPropagation();
		e.currentTarget.setPointerCapture?.(e.pointerId);
		const lane = e.currentTarget.closest(".tl-lane");
		const rect = lane?.getBoundingClientRect();
		shotBoundaryRef.current = { boundaryIndex, timelineEnd, pointerId: e.pointerId, left: rect?.left ?? 0, width: rect?.width ?? 1, displayFrameCount };
	}

	function moveShotBoundary(e) {
		const active = shotBoundaryRef.current;
		if (!active || e.pointerId !== active.pointerId) return;
		e.preventDefault();
		e.stopPropagation();
		const ratio = (e.clientX - active.left) / Math.max(1, active.width);
		const rawFrame = Math.round(ratio * Math.max(0, active.displayFrameCount - 1));
		if (active.timelineEnd) handlers.current.onShotEndResize?.(Math.max(0, rawFrame));
		else handlers.current.onShotBoundaryMove?.(active.boundaryIndex, Math.max(0, Math.min(frameCount - 1, rawFrame)));
	}

	function endShotBoundaryDrag(e) {
		const active = shotBoundaryRef.current;
		if (!active || e.pointerId !== active.pointerId) return;
		shotBoundaryRef.current = null;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
	}

	function beginShotMove(e, shot, index) {
		if (e.button !== 0 || e.target.closest("button, input")) return;
		const lane = e.currentTarget.closest(".tl-lane");
		const rect = lane?.getBoundingClientRect();
		shotMoveRef.current = { id: shot.id, index, pointerId: e.pointerId, startClientX: e.clientX, left: rect?.left ?? 0, width: rect?.width ?? 1, targetFrame: shot.startFrame, moved: false };
		e.currentTarget.setPointerCapture?.(e.pointerId);
	}

	function moveShot(e) {
		const active = shotMoveRef.current;
		if (!active || e.pointerId !== active.pointerId) return;
		if (!active.moved && Math.abs(e.clientX - active.startClientX) < 4) return;
		active.moved = true;
		active.targetFrame = frameFromClientX(e.clientX, active.left, active.width, displayFrameCount, frameCount);
		setMovingShotId(active.id);
		e.preventDefault();
		e.stopPropagation();
	}

	function endShotMove(e) {
		const active = shotMoveRef.current;
		if (!active || e.pointerId !== active.pointerId) return;
		if (active.moved) {
			e.preventDefault();
			e.stopPropagation();
			shotSuppressClickRef.current = true;
			handlers.current.onShotMove?.(active.index, active.targetFrame);
			queueMicrotask(() => { shotSuppressClickRef.current = false; });
		}
		shotMoveRef.current = null;
		setMovingShotId(null);
		e.currentTarget.releasePointerCapture?.(e.pointerId);
	}

	function selectShotBlock(index) {
		if (!shotSuppressClickRef.current) handlers.current.onShotSelect?.(index);
	}

	function finishShotRename(shot, index, value) {
		const name = value.trim();
		if (name && name !== shot.name) handlers.current.onShotRename?.(index, name);
		setRenamingShotId(null);
	}

	function frameFromEvent(e) {
		const el = rulerRef.current;
		if (!el) return frame;
		const rect = el.getBoundingClientRect();
		return frameFromClientX(e.clientX, rect.left, rect.width, displayFrameCount, frameCount);
	}

	function rootFrameFromEvent(e) {
		const rect = e.currentTarget.getBoundingClientRect();
		return frameFromClientX(e.clientX, rect.left, rect.width, displayFrameCount, frameCount);
	}

	function onRulerDown(e) {
		if (e.button !== 0) return;
		scrubbing.current = true;
		rulerRef.current?.setPointerCapture?.(e.pointerId);
		handlers.current.onScrub?.(frameFromEvent(e));
	}

	function onRulerMove(e) {
		if (!scrubbing.current) return;
		handlers.current.onScrub?.(frameFromEvent(e));
	}

	function onRulerUp(e) {
		if (!scrubbing.current) return;
		scrubbing.current = false;
		rulerRef.current?.releasePointerCapture?.(e.pointerId);
	}

	return (
		<section className={"timeline" + (expanded ? "" : " collapsed")} aria-label={ko("Animation timeline", "애니메이션 타임라인")}>
			{expanded ? (
				<>
					<div className="tl-head">
						<div className="tl-transport" aria-label={ko("Playback transport", "재생 컨트롤")}>
							<button
								type="button"
								className="tl-btn"
								aria-label={ko("Previous frame", "이전 프레임")}
								title={ko("Previous frame (k)", "이전 프레임 (k)")}
								onClick={() => handlers.current.onStep?.(-1)}
							>
								‹
							</button>
							<button
								type="button"
								className={"tl-btn play" + (playing ? " on" : "")}
								aria-label={playing ? ko("Pause playback", "재생 일시중지") : ko("Play playback", "재생 시작")}
								title={ko("Play / pause (Space)", "재생/일시중지 (Space)")}
								onClick={() => handlers.current.onPlayToggle?.()}
							>
								{playing ? "❚❚" : "▶"}
							</button>
							<button
								type="button"
								className="tl-btn"
								aria-label={ko("Next frame", "다음 프레임")}
								title={ko("Next frame (j)", "다음 프레임 (j)")}
								onClick={() => handlers.current.onStep?.(1)}
							>
								›
							</button>
							<span className="tl-readout" aria-live="polite">
								<b>{frame}</b> / {frameCount - 1} · {fps} fps · {playbackSpeed.toFixed(2)}×
							</span>
						</div>
						<button
							type="button"
							className={"tl-btn zoom" + (zoom !== ZOOM_DEFAULT ? " on" : "")}
							title={ko("Two-finger up/down over FRAME ruler to zoom — click to reset to 1×", "프레임 눈금 위에서 두 손가락으로 위아래 스크롤해 확대/축소 · 클릭하면 1×로 초기화")}
							onClick={resetZoom}
						>
							{zoom.toFixed(2)}×
						</button>
						<button
							type="button"
							className={"tl-btn wp" + (waypointMode ? " on" : "")}
							aria-pressed={waypointMode}
							title={ko("Enable or disable 2D Root path constraints (P)", "2D 루트 경로 제약 켜기/끄기 (P)")}
							onClick={() => handlers.current.onWaypointToggle?.()}
						>
							{isKo ? `웨이포인트 ${waypointMode ? "켜짐" : "꺼짐"}` : `Waypoint ${waypointMode ? "on" : "off"}`}
						</button>
						<button
							type="button"
							className={"tl-btn ik" + (ikMode ? " on" : "")}
							aria-pressed={ikMode}
							disabled={ikDisabled && !ikMode}
							title={ikDisabled && !ikMode ? ko("IK needs Subject 1's rig loaded", "IK를 사용하려면 인물 1의 리그를 먼저 불러와야 해요") : ko("IK mode — drag a wrist / ankle handle; keys land on the Full-Body lane. With a motion loaded, keys correct it layer-style", "IK 모드 — 손목이나 발목 핸들을 드래그하세요. 키는 전신 레인에 찍히며, 모션을 불러온 뒤에는 레이어 방식으로 보정합니다")}
							onClick={() => handlers.current.onIkToggle?.()}
						>
							{isKo ? `IK ${ikMode ? "켜짐" : "꺼짐"}` : `IK ${ikMode ? "on" : "off"}`}
						</button>
						<button
							type="button"
							className={"tl-btn ik snap" + (footSnap ? " on" : "")}
							aria-pressed={footSnap}
							title={ko("Foot snap — keep the feet planted while you move the body (hips); the knees bend instead of the feet sinking through the floor", "발 스냅 — 몸(엉덩이)을 움직여도 발을 바닥에 고정합니다. 발이 바닥으로 가라앉는 대신 무릎이 구부러집니다")}
							onClick={() => handlers.current.onFootSnapToggle?.()}
						>
							{isKo ? `스냅 ${footSnap ? "켜짐" : "꺼짐"}` : `Snap ${footSnap ? "on" : "off"}`}
						</button>
						{waypointMode && (
							<span className={"tl-wp-hint" + (waypointFrames.length < 2 || pathSpeed?.warn ? " warn" : "")}>
								{waypointFrames.length < 2
									? ko("Click the set floor in the Shot view to drop waypoints", "샷 뷰의 세트 바닥을 클릭해 웨이포인트를 놓으세요")
									: isKo
										? `루트 웨이포인트 ${waypointFrames.length}개` +
											(pathSpeed
												? ` · ${pathSpeed.min.toFixed(1)}–${pathSpeed.max.toFixed(1)} m/s${pathSpeed.warn ? " — 자연스러운 이동 속도 0.5–3 m/s 범위를 벗어남" : ""}`
												: "") +
											" · 세트 바닥을 클릭해 더 추가"
										: `${waypointFrames.length} root waypoints` +
											(pathSpeed
												? ` · ${pathSpeed.min.toFixed(1)}–${pathSpeed.max.toFixed(1)} m/s${pathSpeed.warn ? " — outside the natural 0.5–3 m/s locomotion band" : ""}`
												: "") +
											" · click the set floor to add more"}
							</span>
						)}
						{badge && <span className={"tl-badge " + badge.kind}>{badge.label}</span>}
						{onClearMotion && (
							<button
								type="button"
								className="tl-btn clear"
								title={ko("Clear motion and restore the blocking pose", "모션을 지우고 블로킹 포즈로 되돌리기")}
								onClick={onClearMotion}
							>
								✕ {ko("Motion", "모션")}
							</button>
						)}
						<button
							type="button"
							className="tl-toggle"
							aria-expanded="true"
							aria-label={ko("Collapse timeline", "타임라인 접기")}
							title={ko("Collapse timeline", "타임라인 접기")}
							onClick={() => setExpanded(false)}
						>
							▾
						</button>
					</div>

					<div className="tl-body" ref={bodyRef}>
						<div className="tl-surface" style={{ "--tl-zoom": surfaceZoom }}>
						<div className="tl-ruler">
							<span className="tl-ruler-label">{ko("Frame", "프레임")}</span>
							<div
								className="tl-ruler-lane"
								ref={rulerRef}
								role="slider"
								aria-label={ko("Scrub timeline", "타임라인 탐색")}
								aria-valuemin={0}
								aria-valuemax={frameCount - 1}
								aria-valuenow={frame}
								tabIndex={0}
								onPointerDown={onRulerDown}
								onPointerMove={onRulerMove}
								onPointerUp={onRulerUp}
								onPointerCancel={onRulerUp}
								onKeyDown={(e) => {
									if (e.key === "ArrowRight") {
										e.preventDefault();
										handlers.current.onStep?.(1);
									} else if (e.key === "ArrowLeft") {
										e.preventDefault();
										handlers.current.onStep?.(-1);
									}
								}}
							>
								<span className="tl-frame-box" style={{ "--tl-f": framePct(frame, displayFrameCount) }} aria-hidden="true">
									{frame}
								</span>
								{labels.map((f) => (
									<span key={f} className="tl-tick" style={{ "--tl-f": framePct(f, displayFrameCount) }}>
										<i />
										{f}
									</span>
								))}
							</div>
						</div>

						{TRACKS.map((name) => (
							<div className={"tl-track" + (name === "Prompts" ? " prompts" : "") + (name === IK_LANE ? " ik" : "") + (name === SHOTS_LANE ? " shots" : "")} key={name}>
								<span className="tl-track-label">
									{TRACK_LABELS_KO[name]}
									{name === "Prompts" && <button className="tl-track-add" type="button" title={ko("Add 2 second prompt clip", "2초 프롬프트 클립 추가")} onClick={() => handlers.current.onPromptAdd?.(frame)}>+</button>}
									{name === SHOTS_LANE && (
										<button
											type="button"
											className="tl-track-add cut"
											disabled={shotCutDisabled}
											title={shotCutDisabled ? ko("This shot is too short to divide", "이 샷은 더 나눌 수 없어요") : isKo ? `샷 추가 · 재생 헤드가 경계면 현재 샷의 가운데에 추가` : "Add shot · at a boundary, split the current shot in the middle"}
											onClick={() => handlers.current.onShotCut?.()}
										>
											{ko("+ Add shot", "+ 샷 추가")}
										</button>
									)}
									{name === IK_LANE && ikMode && (
										<button
											className="tl-track-add ik"
											type="button"
											title={isKo ? `현재 포즈를 ${frame}프레임에 키로 저장` : `Key the current pose at frame ${frame}`}
											onClick={() => handlers.current.onIkKeyframeAdd?.()}
										>
											+
										</button>
									)}
								</span>
								<div
									className={"tl-lane" + (name === "2D Root" ? " root" : "") + (name === CAMERA_LANE ? " cam" : "") + (name === SHOTS_LANE ? " shots" : "")}
									onPointerDown={
										name === "2D Root"
											? (e) => {
												if (e.button !== 0 || e.target !== e.currentTarget) return;
												handlers.current.onRootKeyframeAdd?.(rootFrameFromEvent(e));
											}
											: name === CAMERA_LANE
												? (e) => {
													if (e.button !== 0 || e.target !== e.currentTarget) return;
													handlers.current.onCameraKeyframeAdd?.(rootFrameFromEvent(e));
												}
												: undefined
									}
									title={name === CAMERA_LANE ? ko("Click to key the current camera framing at this frame", "클릭하면 현재 카메라 프레이밍을 이 프레임에 키로 저장합니다") : undefined}
								>
									{gridFrames.map((f) => (
										<i key={f} className="tl-grid" style={{ "--tl-f": framePct(f, displayFrameCount) }} aria-hidden="true" />
									))}
									{name === SHOTS_LANE && shots.map((shot, index) => {
										const geometry = shotBlockGeometry(shots, index, frameCount, displayFrameCount);
										if (!geometry) return null;
										const lastFrame = (shots[index + 1]?.startFrame ?? frameCount) - 1;
										const durationS = (lastFrame - shot.startFrame + 1) / Math.max(1, fps);
										return (
											<div
												key={shot.id}
												className={"tl-shot-block" + (index === activeShotIdx ? " active" : "") + (movingShotId === shot.id ? " moving" : "")}
												style={{ "--tl-f-start": geometry.startPct, "--tl-f-end": geometry.endPct }}
												title={isKo ? `${shot.name} · ${shot.startFrame}–${lastFrame}프레임 · ${durationS.toFixed(1)}초 · 드래그해 순서 이동, 양쪽 끝으로 길이 조절` : `${shot.name} · frames ${shot.startFrame}–${lastFrame} · ${durationS.toFixed(1)}s · drag to reorder, resize from either edge`}
												onPointerDown={(e) => beginShotMove(e, shot, index)}
												onPointerMove={moveShot}
												onPointerUp={endShotMove}
												onPointerCancel={endShotMove}
												onClick={() => selectShotBlock(index)}
												onDoubleClick={(e) => { e.stopPropagation(); setRenamingShotId(shot.id); }}
											>
												{index > 0 && (
													<button
														type="button"
														className="tl-shot-edge start"
														aria-label={ko(`Move cut before ${shot.name}`, `${shot.name} 앞 컷 이동`)}
														onPointerDown={(e) => beginShotBoundaryDrag(e, index)}
														onPointerMove={moveShotBoundary}
														onPointerUp={endShotBoundaryDrag}
														onPointerCancel={endShotBoundaryDrag}
													>
														⋮
													</button>
												)}
												<button
													type="button"
													className="tl-shot-edge end"
													aria-label={index === shots.length - 1 ? ko(`Resize end of ${shot.name}`, `${shot.name} 끝 길이 조절`) : ko(`Move cut after ${shot.name}`, `${shot.name} 뒤 컷 이동`)}
													onPointerDown={(e) => beginShotBoundaryDrag(e, index + 1, index === shots.length - 1)}
													onPointerMove={moveShotBoundary}
													onPointerUp={endShotBoundaryDrag}
													onPointerCancel={endShotBoundaryDrag}
												>
													⋮
												</button>
												{renamingShotId === shot.id ? (
													<input
														className="tl-shot-name-input"
														defaultValue={shot.name}
														autoFocus
														onClick={(e) => e.stopPropagation()}
														onBlur={(e) => finishShotRename(shot, index, e.target.value)}
														onKeyDown={(e) => {
															if (e.key === "Enter") e.currentTarget.blur();
															if (e.key === "Escape") setRenamingShotId(null);
														}}
													/>
												) : (
													<span className="tl-shot-label">
														<b>{shot.name}</b>
														<small>{shot.startFrame}–{lastFrame} · {durationS.toFixed(1)}{ko("s", "초")}</small>
													</span>
												)}
												<span className="tl-shot-actions">
													<button type="button" title={ko("Duplicate shot", "샷 복제")} onClick={(e) => { e.stopPropagation(); handlers.current.onShotDuplicate?.(index); }}>{ko("Duplicate", "복제")}</button>
													<button type="button" disabled={shots.length <= 1} title={ko("Delete shot and merge its time", "샷을 지우고 구간 합치기")} onClick={(e) => { e.stopPropagation(); handlers.current.onShotRemove?.(index); }}>{ko("Delete", "삭제")}</button>
												</span>
											</div>
										);
									})}
									{name === "Prompts" && promptClips.map((clip) => {
										const duration = ((clip.endFrame - clip.startFrame) / Math.max(1, fps)).toFixed(1);
										return (
											<div key={clip.id} className={"tl-chip" + (selectedPromptId === clip.id ? " selected" : "") + (movingPromptId === clip.id ? " moving" : "")} style={{ "--tl-f-start": clipPct(clip.startFrame), "--tl-f-end": clipPct(clip.endFrame) }} title={ko("Drag to move · edge handles resize · right-click removes", "드래그로 이동 · 가장자리 핸들로 길이 조절 · 오른쪽 클릭으로 삭제")} onPointerDown={(e) => beginPromptMove(e, clip)} onPointerMove={movePrompt} onPointerUp={endPromptMove} onPointerCancel={endPromptMove} onClick={blockPromptClick} onContextMenu={(e) => { e.preventDefault(); handlers.current.onPromptRemove?.(clip.id); }}>
												<button className="tl-chip-handle start" type="button" aria-label={ko("Resize prompt start", "프롬프트 시작점 조절")} onPointerDown={(e) => beginPromptResize(e, clip, "start")} onPointerMove={movePromptResize} onPointerUp={endPromptResize} onPointerCancel={endPromptResize} />
												<input className="tl-chip-input" value={clip.text} placeholder={isKo ? `${duration}초 · 모션 프롬프트` : `${duration}s · motion prompt`} maxLength={500} onChange={(e) => handlers.current.onPromptChange?.(clip.id, e.target.value)} />
												<button className="tl-chip-handle end" type="button" aria-label={ko("Resize prompt end", "프롬프트 끝점 조절")} onPointerDown={(e) => beginPromptResize(e, clip, "end")} onPointerMove={movePromptResize} onPointerUp={endPromptResize} onPointerCancel={endPromptResize} />
											</div>
										);
									})}
									{name === IK_LANE &&
										ikFrames.map((f) => (
											<span
												key={f}
												className="tl-marker ik"
												style={{ "--tl-f": framePct(f, displayFrameCount) }}
												title={isKo ? `${f}프레임의 전신 IK 키 — 클릭해 이동, 오른쪽 클릭으로 삭제` : `Full-body IK key at frame ${f} — click to jump, right-click to remove`}
												onPointerDown={(e) => {
													if (e.button !== 0) return;
													e.stopPropagation();
													handlers.current.onScrub?.(f);
												}}
												onContextMenu={(e) => {
													e.preventDefault();
													e.stopPropagation();
													handlers.current.onIkKeyframeRemove?.(f);
												}}
											/>
										))}
									{name === "2D Root" &&
										[...waypointFrames, ...(pendingWaypointFrame == null || waypointFrames.includes(pendingWaypointFrame) ? [] : [pendingWaypointFrame])].map((f) => (
											<span
												key={f}
												className={"tl-marker wp" + (f === pendingWaypointFrame ? " pending" : "")}
												style={{ "--tl-f": framePct(f, displayFrameCount) }}
												title={isKo ? `${f}프레임의 루트 웨이포인트 — 클릭해 선택, 오른쪽 클릭으로 삭제. 탑뷰에서 ${waypointFrames.indexOf(f) + 1}번 마커를 드래그해 이동` : `Root waypoint at frame ${f} — click to select, right-click to remove; drag marker ${waypointFrames.indexOf(f) + 1} in Top-View to move`}
												onPointerDown={(e) => {
													// Select only on the primary button — a right click
													// must reach contextmenu so it removes without scrubbing.
													if (e.button !== 0) return;
													e.stopPropagation();
													handlers.current.onMarkerSelect?.(f);
												}}
												onContextMenu={(e) => {
													e.preventDefault();
													e.stopPropagation();
													handlers.current.onMarkerRemove?.(f);
												}}
											/>
										))}
									{name === CAMERA_LANE && cameraKeyFrames.map((f) => (
										<span
											key={f}
											className="tl-marker cam"
											style={{ "--tl-f": framePct(f, displayFrameCount) }}
											title={isKo ? `${f}프레임의 카메라 키 — 클릭해 이동, 드래그로 시간 변경, 오른쪽 클릭으로 삭제` : `Camera key at frame ${f} — click to jump, drag to re-time, right-click to remove`}
											onPointerDown={(e) => beginCameraKeyDrag(e, f)}
											onPointerMove={moveCameraKeyDrag}
											onPointerUp={endCameraKeyDrag}
											onPointerCancel={endCameraKeyDrag}
											onClick={(e) => onCameraKeyClick(e, f)}
											onContextMenu={(e) => {
												e.preventDefault();
												e.stopPropagation();
												handlers.current.onCameraKeyframeRemove?.(f);
											}}
										/>
									))}
								</div>
							</div>
						))}

						<div className="tl-playhead" style={{ "--tl-f": framePct(frame, displayFrameCount) }} aria-hidden="true" />
						</div>
					</div>
				</>
			) : (
				<div className="tl-collapsed">
					{badge && <span className={"tl-badge " + badge.kind}>{badge.label}</span>}
					{waypointMode && (
						<span className={"tl-wp-hint" + (waypointFrames.length < 2 ? " warn" : "")}>
							{waypointFrames.length < 2
								? ko("Click the set floor in the Shot view to add waypoints", "샷 뷰의 세트 바닥을 클릭해 웨이포인트를 추가하세요")
								: isKo
									? `루트 웨이포인트 ${waypointFrames.length}개 · 세트 바닥을 클릭해 더 추가`
									: `${waypointFrames.length} root waypoints · click the set floor to add more`}
						</span>
					)}
					<button
						type="button"
						className="tl-toggle"
						aria-expanded="false"
						aria-label={ko("Expand timeline", "타임라인 펼치기")}
						title={ko("Expand timeline", "타임라인 펼치기")}
						onClick={() => setExpanded(true)}
					>
						▸
					</button>
				</div>
			)}
		</section>
	);
}
