import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { frameFromClientX, motionTrimRange, promptMoveStartFrame, shotBlockGeometry } from "./timeline-coordinates.js";
import { motionSegmentSpeedForFrames } from "./motion-edit.js";
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
 * The unified Shot lane authors shot-camera keyframings directly: left-clicking
 * a block's lower strip keys the CURRENT camera framing there, dots jump
 * the playhead on click, drag to re-time, right-click to remove. Playback
 * and PlayView ride the keys segment by segment.
 */

const DEFAULT_FRAME_COUNT = 360; // 15 s @ 24 fps, the production clock the app timeline runs on
const DEFAULT_FPS = 24;
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
];
const TRACK_LABELS_KO = {
	Prompts: ko("Prompts", "프롬프트"),
	"Full-Body": ko("Full-Body", "전신"),
	"2D Root": ko("2D Root", "2D 루트"),
	Shots: ko("Shots", "샷"),
};

/** IK keys live on the Full-Body lane: one marker per keyed frame, holding
 * a sparse set of the limbs the user has moved (never every joint). */
const IK_LANE = "Full-Body";
const SHOTS_LANE = "Shots";
// Ruler labels and lane gridlines share one 10-frame cadence, so authored
// elements (40-frame prompt blocks, camera key dots) always land on visible
// lines. Label density adapts to zoom in 10-based steps.
const GRID_STEP_FRAMES = 10;
const LABEL_STEPS = [10, 20, 50, 100, 200, 500, 1000];
const MAX_LABELS = 30;

const framePct = (f, count) => (count > 1 ? f / (count - 1) : 0);

const CAMERA_BLOCK_DEFAULTS = {
	distance: 3,
	height: 1.6,
	response: 0.7,
	lead: 0.25,
	railStartMode: "head",
	maxDollySpeed: 4,
	pitchOffsetDeg: 0,
	orbitOffsetDeg: 0,
};

function cameraBlockMode(shot) {
	const mode = shot?.camera?.mode;
	if (mode === "keys" || mode === "follow" || mode === "rail") return mode;
	if (shot?.camera?.cameraRail) return "rail";
	if (shot?.camera?.followCam?.enabled) return "follow";
	return "keys";
}

function cameraBlockFollow(shot) {
	return { ...CAMERA_BLOCK_DEFAULTS, ...(shot?.camera?.followCam ?? {}) };
}

function signedDegrees(value) {
	const rounded = Math.round(Number(value) || 0);
	return `${rounded >= 0 ? "+" : ""}${rounded}\u00b0`;
}

function signedValue(value) {
	const rounded = Math.round((Number(value) || 0) * 10) / 10;
	return `${rounded >= 0 ? "+" : ""}${rounded}`;
}

function CameraBlockEditor({ shot, blocked, previewing, railDraw, railLength, onChange, onPreview, onRailDrawToggle, onRailDelete }) {
	if (!shot) return null;
	const mode = cameraBlockMode(shot);
	const follow = cameraBlockFollow(shot);
	const patchCamera = (patch) => onChange?.(patch);
	const patchFollow = (patch) => onChange?.({ followCam: { ...follow, ...patch } });
	const numberValue = (event) => Number(event.currentTarget.value);
	const metric = (value, places = 1) => Number(value).toFixed(places);
	return (
		<section className="tl-camera-editor" aria-label={ko(`Camera controls for ${shot.name}`, `${shot.name} 카메라 컨트롤`)}>
			<strong className="tl-camera-editor-title">{shot.name}</strong>
			{blocked ? (
				<span className="tl-camera-blocked">{ko("Turn Waypoint off to edit or preview this camera.", "카메라를 편집하거나 미리 보려면 Waypoint를 꺼주세요.")}</span>
			) : (
				<>
					<button type="button" className={"tl-camera-tool" + (previewing ? " active" : "")} onClick={() => onPreview?.()}>
						{previewing ? ko("Stop", "정지") : ko("Preview", "미리보기")}
					</button>
					<button type="button" className={"tl-camera-tool" + (railDraw ? " active" : "")} onClick={() => onRailDrawToggle?.()}>
						{railDraw ? ko("Drawing…", "그리는 중…") : ko("Draw rail", "레일 그리기")}
					</button>
					<button
						type="button"
						className={"tl-camera-tool" + (mode === "follow" ? " active" : "")}
						aria-pressed={mode === "follow"}
						title={ko("Keep the camera at the captured distance from the subject", "카메라와 피사체 사이의 현재 거리를 유지합니다")}
						onClick={() => patchCamera({ mode: mode === "follow" ? "keys" : "follow" })}
					>
						{mode === "follow" ? ko("Follow On", "팔로우 켜짐") : ko("Follow Off", "팔로우 꺼짐")}
					</button>
					{railLength != null && (
						<button
							type="button"
							className="tl-camera-tool danger"
							title={ko("Delete this Shot's rail geometry and return to Follow", "이 샷의 레일 경로를 삭제하고 팔로우로 돌아갑니다")}
							onClick={() => onRailDelete?.()}
						>
							{ko("Delete rail", "레일 삭제")}
						</button>
					)}
					<button
						type="button"
						className={"tl-camera-head" + (follow.railStartMode === "head" ? " active" : "")}
						aria-pressed={follow.railStartMode === "head"}
						title={ko("Choose whether the dolly starts at the rail head or the nearest useful point", "돌리가 레일 시작점 또는 가까운 지점에서 출발하도록 정합니다")}
						onClick={() => patchFollow({ railStartMode: follow.railStartMode === "head" ? "nearest" : "head" })}
					>
						{follow.railStartMode === "head" ? ko("Head start", "시작점 출발") : ko("Nearest", "가까운 지점")}
					</button>
					<label title={ko("Read automatically from the camera position", "현재 카메라 위치에서 자동으로 읽습니다")}>
						<span>{ko("Distance", "거리")}</span>
						<output className="tl-camera-metric">{metric(follow.distance, 2)}</output>
						<small>m</small>
					</label>
					<label title={ko("Cap dolly travel speed", "돌리의 최고 이동 속도를 제한합니다")}>
						<span>{ko("Speed", "속도")}</span>
						<input type="number" min="0.2" max="8" step="0.1" value={follow.maxDollySpeed} onChange={(event) => patchFollow({ maxDollySpeed: numberValue(event) })} />
						<small>m/s</small>
					</label>
					<label title={ko("Read automatically from the camera position", "현재 카메라 위치에서 자동으로 읽습니다")}>
						<span>{ko("Height", "높이")}</span>
						<output className="tl-camera-metric">{metric(follow.height, 2)}</output>
						<small>m</small>
					</label>
					<label title={ko("Read automatically from the camera tilt", "현재 카메라 틸트에서 자동으로 읽습니다")}>
						<span>{ko("Pitch", "피치")}</span>
						<output className="tl-camera-metric">{signedValue(follow.pitchOffsetDeg)}</output>
						<small>°</small>
					</label>
					<details className="tl-camera-advanced">
						<summary>{ko("Advanced", "고급")}</summary>
						<label title={ko("Set how softly the rig catches up", "카메라가 얼마나 부드럽게 따라붙는지 정합니다")}>
							<span>{ko("Damping", "댐핑")}</span>
							<input type="number" min="0.1" max="3" step="0.05" value={follow.response} onChange={(event) => patchFollow({ response: numberValue(event) })} />
							<small>s</small>
						</label>
						<label title={ko("Aim ahead of subject travel", "피사체 진행 방향을 미리 조준합니다")}>
							<span>{ko("Look-ahead", "조준 선행")}</span>
							<input type="number" min="0" max="1" step="0.05" value={follow.lead} onChange={(event) => patchFollow({ lead: numberValue(event) })} />
							<small>s</small>
						</label>
					</details>
					<span className="tl-camera-slate">
						{mode === "rail" ? `${ko("Dolly on rail", "레일 돌리")}${railLength == null ? "" : ` · ${railLength.toFixed(1)} m`}` : ko("Camera preview", "카메라 미리보기")}
					</span>
				</>
			)}
		</section>
	);
}

export default function Timeline({
	frame,
	frameCount = DEFAULT_FRAME_COUNT,
	fps = DEFAULT_FPS,
	playbackSpeed = 1,
	playing,
	// Which cast member's animation layer these tracks edit ("S2", …).
	trackOwner = null,
	// Read-only previews of the OTHER cast members' layers: their prompt
	// blocks and root pins render dimmed with an owner chip, so the whole
	// cast's schedule is visible while only the active layer is editable.
	ghostLayers = [], // [{ owner, promptClips: [], waypointFrames: [] }]
	waypointMode,
	waypoints = [],
	pathSpeed = null, // { min, max, warn } in m/s, shown on the 2D Root label
	badge,
	promptClips = [],
	selectedPromptId,
	pendingWaypointFrame = null,
	ikMode = false,
	ikDisabled = false, // a loaded motion owns the rig
	// The ACTIVE cast member's loaded take, drawn as a passive strip on the
	// Full-Body lane. Frames are already on the timeline's 24 fps clock.
	motion = null, // { frames, label } | null
	ikFrames = [], // sorted full-body key frames
	footSnap = true, // feet stay planted while the body moves
	shots = [],
	activeShotIdx = 0,
	selectedCameraBlockIdx,
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
	onCameraBlockSelect,
	onCameraBlockChange,
	onCameraPreview,
	railDraw = false,
	cameraRailLength = null,
	onCameraRailDrawToggle,
	onCameraRailDelete,
	onRailSelect,
	onRailMove,
	onRailRangeChange,
	onRailRemove,
	onShotSelect,
	onShotBoundaryMove,
	onShotRename,
	onShotRemove,
	onShotDuplicate,
	onShotCut,
	onShotSplit,
	onShotMove,
	onMotionTrim,
	onMotionTrimReset,
	onMotionCut,
	onMotionSpeedChange,
	onMotionSegmentRemove,
	// One undo entry per editing GESTURE. Fired once when a continuous drag
	// (or a keyboard nudge, or a text-editing session) begins, BEFORE the
	// first mutation lands, so App can snapshot the pre-gesture state exactly
	// once instead of once per pointermove tick.
	onEditGestureStart,
}) {
	const [expanded, setExpanded] = useState(true);
	const [zoom, setZoom] = useState(ZOOM_DEFAULT);
	const [movingPromptId, setMovingPromptId] = useState(null);
	const [renamingShotId, setRenamingShotId] = useState(null);
	const [movingShotId, setMovingShotId] = useState(null);
	const [localCameraBlockIdx, setLocalCameraBlockIdx] = useState(null);
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
	handlers.current = { onScrub, onAdvance, onStep, onPlayToggle, onWaypointToggle, onMarkerSelect, onMarkerRemove, onRootKeyframeAdd, onPromptAdd, onPromptSelect, onPromptChange, onPromptResize, onPromptMove, onPromptRemove, onIkToggle, onIkKeyframeAdd, onIkKeyframeRemove, onFootSnapToggle, onCameraMoveSelect, onCameraKeyframeAdd, onCameraKeyframeMove, onCameraKeyframeRemove, onCameraBlockSelect, onCameraBlockChange, onCameraPreview, onCameraRailDrawToggle, onCameraRailDelete, onRailSelect, onRailMove, onRailRangeChange, onRailRemove, onShotSelect, onShotBoundaryMove, onShotRename, onShotRemove, onShotDuplicate, onShotCut, onShotSplit, onShotMove, onMotionTrim, onMotionTrimReset, onMotionCut, onMotionSpeedChange, onMotionSegmentRemove, onEditGestureStart };

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
	const waypointFrames = waypoints.map((waypoint) => waypoint.frame);
	const moveRef = useRef(null);
	const suppressPromptClickRef = useRef(false);
	const resizeRef = useRef(null);
	const camDragRef = useRef(null);
	const camSuppressClickRef = useRef(false);
	const shotBoundaryRef = useRef(null);
	const shotMoveRef = useRef(null);
	const shotSuppressClickRef = useRef(false);
	const railDragRef = useRef(null);
	const railResizeRef = useRef(null);
	const railSuppressClickRef = useRef(false);

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
		handlers.current.onEditGestureStart?.("prompt-move");
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
		handlers.current.onEditGestureStart?.("prompt-resize");
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

	// Motion trim: frame-accurate drag of the loaded take's in/out point on
	// the Full-Body strip. No block snapping — a cut lands on the exact frame
	// the hand releases. The preview lives here; the CUT itself is App's.
	const motionTrimRef = useRef(null);
	const [trimPreview, setTrimPreview] = useState(null);

	function beginMotionTrim(e, edge) {
		if (e.button !== 0 || !motion) return;
		e.preventDefault();
		e.stopPropagation();
		e.currentTarget.setPointerCapture?.(e.pointerId);
		const rect = e.currentTarget.closest(".tl-lane")?.getBoundingClientRect();
		if (!rect || rect.width < 2) return;
		const max = Math.min(motion.frames, displayFrameCount) - 1;
		// The preview always restarts from the FULL take: App composes the cut
		// as trimOffset + start, so an end-only drag must still report start 0.
		motionTrimRef.current = { edge, rect, max, displayFrameCount, preview: { start: 0, end: max } };
		setTrimPreview({ start: 0, end: max });
	}

	function moveMotionTrim(e) {
		const active = motionTrimRef.current;
		if (!active) return;
		// Same pixel→frame transform as every other lane, off the pointer-down
		// geometry, so the handle stays under the cursor at any zoom.
		const frame = Math.min(active.max, frameFromClientX(e.clientX, active.rect.left, active.rect.width, active.displayFrameCount, frameCount));
		const next = motionTrimRange(active.edge, frame, active.preview, active.max);
		active.preview = next;
		setTrimPreview(next);
	}

	function endMotionTrim(e) {
		const active = motionTrimRef.current;
		motionTrimRef.current = null;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
		setTrimPreview(null);
		if (active && (active.preview.start > 0 || active.preview.end < active.max)) {
			handlers.current.onMotionTrim?.(active.preview.start, active.preview.end);
		}
	}

	// Segment speed by stretch: dragging a segment's right-edge grip resizes it
	// on the strip, and the width IS the playback rate — wider is slower. The
	// preview lives here; the retime itself is App's, committed once on release.
	const motionSpeedRef = useRef(null);
	const [speedPreview, setSpeedPreview] = useState(null);

	function beginMotionSpeed(e, segment) {
		if (e.button !== 0 || !motion) return;
		e.preventDefault();
		e.stopPropagation();
		e.currentTarget.setPointerCapture?.(e.pointerId);
		const rect = e.currentTarget.closest(".tl-lane")?.getBoundingClientRect();
		if (!rect || rect.width < 2) return;
		motionSpeedRef.current = { segment, rect, displayFrameCount, preview: null };
	}

	function moveMotionSpeed(e) {
		const active = motionSpeedRef.current;
		if (!active) return;
		const pointerFrame = frameFromClientX(e.clientX, active.rect.left, active.rect.width, active.displayFrameCount, frameCount);
		const frames = Math.max(1, Math.round(pointerFrame) - active.segment.timelineStart + 1);
		const speed = motionSegmentSpeedForFrames(active.segment, frames);
		const sourceFrames = active.segment.sourceEnd - active.segment.sourceStart + 1;
		const next = { id: active.segment.id, timelineFrames: Math.max(1, Math.round(sourceFrames / speed)), speed };
		if (active.preview?.speed === next.speed && active.preview?.timelineFrames === next.timelineFrames) return;
		active.preview = next;
		setSpeedPreview(next);
	}

	function endMotionSpeed(e) {
		const active = motionSpeedRef.current;
		motionSpeedRef.current = null;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
		setSpeedPreview(null);
		if (active?.preview && active.preview.speed !== active.segment.speed) {
			handlers.current.onMotionSpeedChange?.(active.segment.id, active.preview.speed);
		}
	}

	// Camera key dots re-time by dragging, like prompt clips move: the frame
	// delta comes from the pointer-down geometry so a growing timeline cannot
	// feed back into the next pointermove.
	function beginCameraKeyDrag(e, key, shotIndex) {
		if (e.button !== 0) return;
		e.stopPropagation();
		selectUnifiedShotBlock(shotIndex);
		// A 10px dot loses the pointer almost immediately without capture —
		// grab it on pointerdown so the drag survives past the marker's edge.
		e.currentTarget.setPointerCapture?.(e.pointerId);
		const lane = e.currentTarget.closest(".tl-lane");
		const rect = lane?.getBoundingClientRect();
		camDragRef.current = {
			pointerId: e.pointerId,
			startClientX: e.clientX,
			keyId: key.id,
			fromFrame: key.frame,
			shotId: shots[shotIndex]?.id,
			currentFrame: key.frame,
			laneWidth: rect?.width ?? 1,
			displayFrameCount,
			moved: false,
		};
		handlers.current.onEditGestureStart?.("camera-key");
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
		handlers.current.onCameraKeyframeMove?.(active.shotId, active.keyId, from, next);
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

	function onCameraKeyClick(e, key, shotIndex) {
		if (camSuppressClickRef.current) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		e.stopPropagation();
		selectUnifiedShotBlock(shotIndex);
		handlers.current.onScrub?.(key.frame);
	}

	function beginRailMove(e, shot, range, duration) {
		if (e.button !== 0) return;
		e.stopPropagation();
		handlers.current.onEditGestureStart?.("rail");
		handlers.current.onRailSelect?.(shot.id);
		const lane = e.currentTarget.closest(".tl-lane");
		const rect = lane?.getBoundingClientRect();
		railDragRef.current = { shotId: shot.id, pointerId: e.pointerId, startClientX: e.clientX, startFrame: range.start, length: range.end - range.start + 1, duration, laneWidth: rect?.width ?? 1, moved: false };
	}

	function moveRail(e) {
		const active = railDragRef.current;
		if (!active || e.pointerId !== active.pointerId) return;
		if (!active.moved && Math.abs(e.clientX - active.startClientX) < 4) return;
		active.moved = true;
		e.preventDefault();
		e.stopPropagation();
		e.currentTarget.setPointerCapture?.(e.pointerId);
		const delta = Math.round((e.clientX - active.startClientX) * Math.max(0, displayFrameCount - 1) / Math.max(1, active.laneWidth));
		const next = Math.max(0, Math.min(active.duration - active.length, active.startFrame + delta));
		handlers.current.onRailMove?.(active.shotId, next);
	}

	function endRailMove(e) {
		const active = railDragRef.current;
		if (!active || e.pointerId !== active.pointerId) return;
		if (active.moved) {
			e.preventDefault();
			e.stopPropagation();
			railSuppressClickRef.current = true;
			queueMicrotask(() => { railSuppressClickRef.current = false; });
		}
		railDragRef.current = null;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
	}

	function beginRailResize(e, shot, edge, range, duration) {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		e.currentTarget.setPointerCapture?.(e.pointerId);
		handlers.current.onEditGestureStart?.("rail");
		handlers.current.onRailSelect?.(shot.id);
		const lane = e.currentTarget.closest(".tl-lane");
		const rect = lane?.getBoundingClientRect();
		railResizeRef.current = { shotId: shot.id, edge, pointerId: e.pointerId, startClientX: e.clientX, startFrame: edge === "start" ? range.start : range.end, duration, laneWidth: rect?.width ?? 1 };
	}

	function moveRailResize(e) {
		const active = railResizeRef.current;
		if (!active || e.pointerId !== active.pointerId) return;
		e.preventDefault();
		e.stopPropagation();
		const delta = Math.round((e.clientX - active.startClientX) * Math.max(0, displayFrameCount - 1) / Math.max(1, active.laneWidth));
		const next = Math.max(0, Math.min(active.duration - 1, active.startFrame + delta));
		handlers.current.onRailRangeChange?.(active.shotId, active.edge, next);
	}

	function endRailResize(e) {
		if (!railResizeRef.current || e.pointerId !== railResizeRef.current.pointerId) return;
		railResizeRef.current = null;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
	}

	function onRailKeyDown(e, shotId, range, duration) {
		const edge = e.currentTarget.dataset.railEdge;
		if (e.key === "Delete" || e.key === "Backspace") {
			e.preventDefault();
			e.stopPropagation();
			handlers.current.onRailRemove?.(shotId);
			return;
		}
		if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
		e.preventDefault();
		e.stopPropagation();
		const delta = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 10 : 1);
		// A nudge is a complete gesture on its own: one keydown, one entry.
		handlers.current.onEditGestureStart?.("rail");
		if (edge === "body") handlers.current.onRailMove?.(shotId, Math.max(0, Math.min(duration - (range.end - range.start + 1), range.start + delta)));
		else handlers.current.onRailRangeChange?.(shotId, edge, Math.max(0, Math.min(duration - 1, (edge === "start" ? range.start : range.end) + delta)));
	}

	function beginShotBoundaryDrag(e, shotIndex, edge) {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		e.currentTarget.setPointerCapture?.(e.pointerId);
		const lane = e.currentTarget.closest(".tl-lane");
		const rect = lane?.getBoundingClientRect();
		shotBoundaryRef.current = { shotId: shots[shotIndex]?.id, edge, pointerId: e.pointerId, left: rect?.left ?? 0, width: rect?.width ?? 1, displayFrameCount };
		handlers.current.onEditGestureStart?.("shot-boundary");
	}

	function moveShotBoundary(e) {
		const active = shotBoundaryRef.current;
		if (!active || e.pointerId !== active.pointerId) return;
		e.preventDefault();
		e.stopPropagation();
		const ratio = (e.clientX - active.left) / Math.max(1, active.width);
		const rawFrame = Math.round(ratio * Math.max(0, active.displayFrameCount - 1));
		handlers.current.onShotBoundaryMove?.(active.shotId, active.edge, Math.max(0, Math.min(frameCount - 1, rawFrame)));
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
		shotMoveRef.current = { id: shot.id, pointerId: e.pointerId, startClientX: e.clientX, left: rect?.left ?? 0, width: rect?.width ?? 1, targetFrame: shot.startFrame, moved: false };
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
			handlers.current.onShotMove?.(active.id, active.targetFrame);
			queueMicrotask(() => { shotSuppressClickRef.current = false; });
		}
		shotMoveRef.current = null;
		setMovingShotId(null);
		e.currentTarget.releasePointerCapture?.(e.pointerId);
	}

	function selectUnifiedShotBlock(index) {
		if (shotSuppressClickRef.current) return;
		const shot = shots[index];
		if (!shot) return;
		setLocalCameraBlockIdx(index);
		handlers.current.onCameraBlockSelect?.(shot.id);
		handlers.current.onShotSelect?.(shot.id);
		if (!handlers.current.onShotSelect) handlers.current.onScrub?.(shot.startFrame);
		handlers.current.onCameraMoveSelect?.();
	}

	function addCameraKeyFromBlock(e, index) {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		const lane = e.currentTarget.closest(".tl-lane");
		const rect = lane?.getBoundingClientRect();
		if (!rect) return;
		const target = frameFromClientX(e.clientX, rect.left, rect.width, displayFrameCount, frameCount);
		selectUnifiedShotBlock(index);
		handlers.current.onCameraKeyframeAdd?.(target, shots[index]?.id);
	}

	function finishShotRename(shot, index, value) {
		const name = value.trim();
		if (name && name !== shot.name) handlers.current.onShotRename?.(shot.id, name);
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

	const cameraBlockIdx = selectedCameraBlockIdx === undefined ? localCameraBlockIdx : selectedCameraBlockIdx;
	const selectedCameraShot = cameraBlockIdx == null ? null : shots[cameraBlockIdx] ?? null;
	const motionSegments = motion?.segments ?? [];
	const selectedMotionSegment = motionSegments.find((segment) => frame >= segment.timelineStart && frame <= segment.timelineEnd) ?? motionSegments[0] ?? null;
	const visibleMotionSegments = trimPreview
		? [{
			id: "motion-trim-preview",
			timelineStart: trimPreview.start,
			timelineEnd: trimPreview.end,
			speed: null,
			preview: true,
		}]
		: motionSegments;
	// While a speed grip is held, the dragged segment shows its would-be width
	// and everything after it slides by the delta — the same reflow the commit
	// will produce, so the release is never a surprise.
	const displayMotionSegments = (() => {
		if (!speedPreview || trimPreview) return visibleMotionSegments;
		let shift = 0;
		return visibleMotionSegments.map((segment) => {
			if (segment.id === speedPreview.id) {
				const shown = {
					...segment,
					timelineStart: segment.timelineStart + shift,
					timelineEnd: segment.timelineStart + shift + speedPreview.timelineFrames - 1,
					previewSpeed: speedPreview.speed,
				};
				shift += speedPreview.timelineFrames - (segment.timelineEnd - segment.timelineStart + 1);
				return shown;
			}
			return shift === 0 ? segment : { ...segment, timelineStart: segment.timelineStart + shift, timelineEnd: segment.timelineEnd + shift };
		});
	})();
	const changeSelectedMotionSpeed = (speed) => {
		if (!selectedMotionSegment || !Number.isFinite(speed)) return;
		handlers.current.onMotionSpeedChange?.(selectedMotionSegment.id, Math.max(0.1, Math.min(4, speed)));
	};

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
						{selectedMotionSegment && (
							<label className="tl-motion-speed-editor">
								<span>{ko(`Segment ${motionSegments.indexOf(selectedMotionSegment) + 1} speed`, `구간 ${motionSegments.indexOf(selectedMotionSegment) + 1} 배율`)}</span>
								<input
									type="range"
									min="0.1"
									max="4"
									step="0.1"
									value={selectedMotionSegment.speed}
									aria-label={ko("Selected Full-Body segment speed", "선택한 전신 구간 배율")}
									onChange={(event) => changeSelectedMotionSpeed(event.currentTarget.valueAsNumber)}
								/>
								<input
									type="number"
									min="0.1"
									max="4"
									step="0.1"
									value={selectedMotionSegment.speed}
									aria-label={ko("Selected Full-Body segment speed value", "선택한 전신 구간 배율 값")}
									onChange={(event) => changeSelectedMotionSpeed(event.currentTarget.valueAsNumber)}
								/>
								<small>×</small>
							</label>
						)}
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
					{selectedCameraShot && (
						<CameraBlockEditor
							shot={selectedCameraShot}
							blocked={waypointMode}
							previewing={playing}
							railDraw={railDraw}
							railLength={cameraRailLength}
							onChange={(patch) => handlers.current.onCameraBlockChange?.(patch)}
							onPreview={() => handlers.current.onCameraPreview?.(selectedCameraShot.id)}
							onRailDrawToggle={() => handlers.current.onCameraRailDrawToggle?.()}
							onRailDelete={() => handlers.current.onCameraRailDelete?.()}
						/>
					)}

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
									{trackOwner && (name === "Prompts" || name === "2D Root") && <em className="tl-track-owner">{trackOwner}</em>}
									{name === "2D Root" && pathSpeed && (
										<em
											className={"tl-path-speed" + (pathSpeed.warn ? " warn" : "")}
											title={isKo ? `핀 구간 속도 ${pathSpeed.min.toFixed(1)}~${pathSpeed.max.toFixed(1)} m/s — 자연 보행은 0.8~1.2 m/s` : `Leg speeds ${pathSpeed.min.toFixed(1)}–${pathSpeed.max.toFixed(1)} m/s — natural gait is 0.8–1.2 m/s`}
										>
											{pathSpeed.min === pathSpeed.max
												? `${pathSpeed.min.toFixed(1)} m/s`
												: `${pathSpeed.min.toFixed(1)}–${pathSpeed.max.toFixed(1)} m/s`}
										</em>
									)}
									{name === "Prompts" && <button className="tl-track-add" type="button" title={ko("Add 2 second prompt clip", "2초 프롬프트 클립 추가")} onClick={() => handlers.current.onPromptAdd?.(frame)}>+</button>}
									{name === SHOTS_LANE && (
										<button
											type="button"
											className="tl-track-add cut"
											disabled={shotCutDisabled}
											title={ko("Add a 2 second shot without changing existing shots", "기존 샷을 바꾸지 않고 2초 샷 추가")}
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
									{name === IK_LANE && motion && (
										<button
											className="tl-track-add motion-cut"
											type="button"
											disabled={frame <= 0 || frame >= motion.frames}
											title={ko("Cut the Full-Body clip at the playhead", "재생 헤드에서 전신 클립 컷")}
											onClick={() => handlers.current.onMotionCut?.()}
										>
											{ko("Cut", "컷")}
										</button>
									)}
								</span>
								<div
									className={"tl-lane" + (name === "2D Root" ? " root" : "") + (name === SHOTS_LANE ? " shots" : "")}
									onPointerDown={
										name === "2D Root"
											? (e) => {
												if (e.button !== 0 || e.target !== e.currentTarget) return;
												handlers.current.onRootKeyframeAdd?.(rootFrameFromEvent(e));
											}
											: undefined
									}
								>
									{gridFrames.map((f) => (
										<i key={f} className="tl-grid" style={{ "--tl-f": framePct(f, displayFrameCount) }} aria-hidden="true" />
									))}
									{name === SHOTS_LANE && shots.length === 0 && (
										<p className="tl-shot-empty">{ko("No shots — free camera owns the timeline. Add one at the playhead.", "샷 없음 — 자유 카메라 구간입니다. 재생 헤드에 샷을 추가하세요.")}</p>
									)}
									{name === SHOTS_LANE && shots.map((shot, index) => {
										const geometry = shotBlockGeometry(shots, index, frameCount, displayFrameCount);
										if (!geometry) return null;
										const mode = cameraBlockMode(shot);
										const follow = cameraBlockFollow(shot);
										const keyCount = shot.cameraKeys?.length ?? 0;
										const lastFrame = shot.endFrame;
										const durationS = (lastFrame - shot.startFrame + 1) / Math.max(1, fps);
										const stateLabel = mode === "keys" && keyCount === 0 ? "FREE" : "LOCKED";
										const modeLabel = mode === "rail" ? "RAIL" : mode === "follow" ? "FOLLOW" : `KEYS ${keyCount}`;
										const detailLabel = mode === "rail"
											? `${follow.railStartMode === "head" ? "HEAD" : "NEAREST"} · ${Number(follow.maxDollySpeed).toFixed(1)} m/s · PITCH ${signedDegrees(follow.pitchOffsetDeg)}`
											: mode === "follow"
												? `${Number(follow.distance).toFixed(1)} m · PITCH ${signedDegrees(follow.pitchOffsetDeg)}`
												: null;
										const durationFrames = lastFrame - shot.startFrame + 1;
										const railAvailable = Array.isArray(shot.camera?.cameraRail) && shot.camera.cameraRail.length >= 2 && durationFrames >= 10;
										const storedRail = shot.camera?.railFollow;
										const railRange = railAvailable
											? storedRail?.mode === "range"
												? { start: Math.max(0, Math.min(durationFrames - 1, storedRail.startFrame)), end: Math.max(0, Math.min(durationFrames - 1, storedRail.endFrame)) }
												: { start: 0, end: durationFrames - 1 }
											: null;
										const railOff = storedRail?.mode === "off" || mode !== "rail";
										const localProgress = frame - shot.startFrame;
										const railProgress = !railOff && railRange && localProgress >= railRange.start && localProgress <= railRange.end
											? (localProgress - railRange.start) / Math.max(1, railRange.end - railRange.start)
											: null;
										return (
											<div
												key={shot.id}
												className={"tl-shot-block" + (index === cameraBlockIdx ? " selected" : "") + (index === activeShotIdx ? " active" : "") + (movingShotId === shot.id ? " moving" : "")}
												style={{ "--tl-f-start": geometry.startPct, "--tl-f-end": geometry.endPct }}
												title={isKo ? `${shot.name} · ${shot.startFrame}–${lastFrame}프레임 · 드래그해 순서 이동, 양끝으로 컷 조절, 아래 빈 줄을 클릭해 카메라 키 추가` : `${shot.name} · frames ${shot.startFrame}–${lastFrame} · drag to reorder, trim cuts at either edge, click the empty lower strip to add a camera key`}
												onPointerDown={(e) => beginShotMove(e, shot, index)}
												onPointerMove={moveShot}
												onPointerUp={endShotMove}
												onPointerCancel={endShotMove}
												onClick={() => selectUnifiedShotBlock(index)}
												onDoubleClick={(e) => { e.stopPropagation(); setRenamingShotId(shot.id); }}
											>
												<button
														type="button"
														className="tl-shot-edge start"
														aria-label={ko(`Resize start of ${shot.name}`, `${shot.name} 시작점 조절`)}
														onPointerDown={(e) => beginShotBoundaryDrag(e, index, "start")}
														onPointerMove={moveShotBoundary}
														onPointerUp={endShotBoundaryDrag}
														onPointerCancel={endShotBoundaryDrag}
													>
														⋮
													</button>
												<button
													type="button"
													className="tl-shot-edge end"
													aria-label={ko(`Resize end of ${shot.name}`, `${shot.name} 끝 길이 조절`)}
													onPointerDown={(e) => beginShotBoundaryDrag(e, index, "end")}
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
												<button type="button" title={ko("Split at the playhead", "재생 헤드에서 분할")} disabled={frame <= shot.startFrame || frame > shot.endFrame} onClick={(e) => { e.stopPropagation(); handlers.current.onShotSplit?.(shot.id); }}>{ko("Split", "분할")}</button>
												<button type="button" title={ko("Duplicate shot", "샷 복제")} onClick={(e) => { e.stopPropagation(); handlers.current.onShotDuplicate?.(shot.id); }}>{ko("Duplicate", "복제")}</button>
													<button type="button" title={ko("Delete shot and leave free-camera time", "샷을 지우고 자유 카메라 구간으로 비우기")} onClick={(e) => { e.stopPropagation(); handlers.current.onShotRemove?.(shot.id); }}>{ko("Delete", "삭제")}</button>
												</span>
												<span className="tl-shot-camera-summary">
													<span className="tl-camera-block-state">{stateLabel}</span>
													<b>{modeLabel}</b>
													{detailLabel && <small>{detailLabel}</small>}
												</span>
												{railRange && (
													<div
														role="group"
														aria-label={ko(`Rail follow range for ${shot.name}`, `${shot.name} 레일 팔로우 구간`)}
														className={"tl-rail" + (index === cameraBlockIdx ? " selected" : "") + (railOff ? " off" : "")}
														style={{ "--tl-f-start": railRange.start / Math.max(1, durationFrames - 1), "--tl-f-end": railRange.end / Math.max(1, durationFrames - 1) }}
														onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handlers.current.onRailRemove?.(shot.id); }}
													>
														<button type="button" tabIndex={0} data-rail-edge="start" className="tl-rail-handle start" aria-label={ko("Resize rail follow start", "레일 팔로우 시작점 조절")} onKeyDown={(e) => onRailKeyDown(e, shot.id, railRange, durationFrames)} onPointerDown={(e) => beginRailResize(e, shot, "start", railRange, durationFrames)} onPointerMove={moveRailResize} onPointerUp={endRailResize} onPointerCancel={endRailResize} />
														<button type="button" tabIndex={0} data-rail-edge="body" className="tl-rail-body" aria-label={ko("Rail follow — drag to move, right-click to remove", "레일 팔로우 — 드래그로 이동, 오른쪽 클릭으로 삭제")} onKeyDown={(e) => onRailKeyDown(e, shot.id, railRange, durationFrames)} onPointerDown={(e) => beginRailMove(e, shot, railRange, durationFrames)} onPointerMove={moveRail} onPointerUp={endRailMove} onPointerCancel={endRailMove} onClick={(e) => { e.stopPropagation(); if (!railSuppressClickRef.current) handlers.current.onRailSelect?.(shot.id); }}>
															<span className="tl-rail-label">{ko("Rail Follow", "레일 팔로우")}</span>
															{railOff && <span className="tl-rail-off">{ko("OFF", "꺼짐")}</span>}
														</button>
														<button type="button" tabIndex={0} data-rail-edge="end" className="tl-rail-handle end" aria-label={ko("Resize rail follow end", "레일 팔로우 끝점 조절")} onKeyDown={(e) => onRailKeyDown(e, shot.id, railRange, durationFrames)} onPointerDown={(e) => beginRailResize(e, shot, "end", railRange, durationFrames)} onPointerMove={moveRailResize} onPointerUp={endRailResize} onPointerCancel={endRailResize} />
														{railProgress != null && <i className="tl-rail-progress" style={{ "--tl-rail-p": railProgress }} aria-hidden="true" />}
													</div>
												)}
												{/* The card body owns selection/reorder; this narrow empty strip
												    owns keying. Keeping it a button excludes it from beginShotMove,
												    so one gesture cannot both reorder a shot and author a key. */}
												<button
													type="button"
													className="tl-shot-key-surface"
													aria-label={ko(`Add camera key in ${shot.name}`, `${shot.name}에 카메라 키 추가`)}
													title={ko("Click at a frame to store the current camera framing", "프레임 위치를 클릭해 현재 카메라 프레이밍을 저장합니다")}
													onClick={(event) => addCameraKeyFromBlock(event, index)}
													onDoubleClick={(event) => event.stopPropagation()}
												/>
											</div>
										);
									})}
									{name === "Prompts" && ghostLayers.map((layer) => layer.promptClips.map((clip) => (
										<div
											key={`${layer.owner}:${clip.id}`}
											className="tl-chip ghost"
											style={{ "--tl-f-start": clipPct(clip.startFrame), "--tl-f-end": clipPct(clip.endFrame) }}
											title={`${layer.owner} · ${clip.text}`}
										>
											<span className="tl-chip-ghost-label">{layer.owner} · {clip.text || "…"}</span>
										</div>
									)))}
									{name === "Prompts" && promptClips.map((clip) => {
										const duration = ((clip.endFrame - clip.startFrame) / Math.max(1, fps)).toFixed(1);
										return (
											<div key={clip.id} className={"tl-chip" + (selectedPromptId === clip.id ? " selected" : "") + (movingPromptId === clip.id ? " moving" : "")} style={{ "--tl-f-start": clipPct(clip.startFrame), "--tl-f-end": clipPct(clip.endFrame) }} title={ko("Drag to move · edge handles resize · right-click removes", "드래그로 이동 · 가장자리 핸들로 길이 조절 · 오른쪽 클릭으로 삭제")} onPointerDown={(e) => beginPromptMove(e, clip)} onPointerMove={movePrompt} onPointerUp={endPromptMove} onPointerCancel={endPromptMove} onClick={blockPromptClick} onContextMenu={(e) => { e.preventDefault(); handlers.current.onPromptRemove?.(clip.id); }}>
												<button className="tl-chip-handle start" type="button" aria-label={ko("Resize prompt start", "프롬프트 시작점 조절")} onPointerDown={(e) => beginPromptResize(e, clip, "start")} onPointerMove={movePromptResize} onPointerUp={endPromptResize} onPointerCancel={endPromptResize} />
												<input className="tl-chip-input" value={clip.text} placeholder={isKo ? `${duration}초 · 모션 프롬프트` : `${duration}s · motion prompt`} maxLength={500} onFocus={() => handlers.current.onEditGestureStart?.("prompt-text", clip.id)} onChange={(e) => handlers.current.onPromptChange?.(clip.id, e.target.value)} />
												<button className="tl-chip-handle end" type="button" aria-label={ko("Resize prompt end", "프롬프트 끝점 조절")} onPointerDown={(e) => beginPromptResize(e, clip, "end")} onPointerMove={movePromptResize} onPointerUp={endPromptResize} onPointerCancel={endPromptResize} />
											</div>
										);
									})}
									{name === IK_LANE && displayMotionSegments.map((segment, index) => (
										<div
											key={segment.id}
											className={"tl-motion-clip" + (trimPreview ? " trimming" : "") + (segment.previewSpeed !== undefined ? " retiming" : "") + (selectedMotionSegment?.id === segment.id ? " selected" : "")}
											style={{
												"--tl-f-start": clipPct(trimPreview ? trimPreview.start : Math.min(segment.timelineStart, displayFrameCount)),
												"--tl-f-end": clipPct(trimPreview ? trimPreview.end + 1 : Math.min(segment.timelineEnd + 1, displayFrameCount)),
											}}
											title={segment.preview ? undefined : isKo
												? `전신 구간 ${index + 1} — ${segment.speed}×. 컷은 재생 헤드에서 · 오른쪽 그립을 끌어 배속 조절 · 우클릭으로 구간 삭제`
												: `Full-Body segment ${index + 1} — ${segment.speed}×. Cut at the playhead; drag the right grip to retime; right-click to delete`}
											onContextMenu={segment.preview ? undefined : (e) => {
												e.preventDefault();
												e.stopPropagation();
												handlers.current.onMotionSegmentRemove?.(segment.id);
											}}
										>
											{index === 0 && <button
												className="tl-motion-clip-handle start"
												type="button"
												aria-label={ko("Trim take start", "테이크 시작점 자르기")}
												onPointerDown={(e) => beginMotionTrim(e, "start")}
												onPointerMove={moveMotionTrim}
												onPointerUp={endMotionTrim}
												onPointerCancel={endMotionTrim}
												onContextMenu={(e) => { e.preventDefault(); handlers.current.onMotionTrimReset?.(); }}
											/>}
											<span className="tl-motion-clip-label">
												{segment.preview
													? `${trimPreview.start}–${trimPreview.end} (${trimPreview.end - trimPreview.start + 1}f)`
													: `${index + 1} · ${segment.previewSpeed ?? segment.speed}×`}
											</span>
											{!segment.preview && <button
												className="tl-motion-clip-handle speed"
												type="button"
												aria-label={ko("Retime segment by stretch", "드래그로 구간 배속 조절")}
												title={ko("Drag — wider is slower, narrower is faster", "드래그 — 늘리면 느리게, 줄이면 빠르게")}
												onPointerDown={(e) => beginMotionSpeed(e, segment)}
												onPointerMove={moveMotionSpeed}
												onPointerUp={endMotionSpeed}
												onPointerCancel={endMotionSpeed}
											/>}
											{index === displayMotionSegments.length - 1 && <button
												className="tl-motion-clip-handle end"
												type="button"
												aria-label={ko("Trim take end", "테이크 끝점 자르기")}
												onPointerDown={(e) => beginMotionTrim(e, "end")}
												onPointerMove={moveMotionTrim}
												onPointerUp={endMotionTrim}
												onPointerCancel={endMotionTrim}
												onContextMenu={(e) => { e.preventDefault(); handlers.current.onMotionTrimReset?.(); }}
											/>}
										</div>
									))}

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
									{name === "2D Root" && ghostLayers.map((layer) => layer.waypointFrames.map((f) => (
										<span
											key={`${layer.owner}:${f}`}
											className="tl-marker wp ghost"
											style={{ "--tl-f": framePct(f, displayFrameCount) }}
											title={`${layer.owner} · frame ${f}`}
										/>
									)))}
									{name === "2D Root" &&
										[...waypoints.map((waypoint) => waypoint.frame), ...(pendingWaypointFrame == null || waypoints.some((waypoint) => waypoint.frame === pendingWaypointFrame) ? [] : [pendingWaypointFrame])].map((f) => (
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
													waypoints.find((waypoint) => waypoint.frame === f) ? handlers.current.onMarkerSelect?.(waypoints.find((waypoint) => waypoint.frame === f).id) : handlers.current.onRootKeyframeAdd?.(f);
												}}
												onContextMenu={(e) => {
													e.preventDefault();
													e.stopPropagation();
													const waypoint = waypoints.find((entry) => entry.frame === f);
											if (waypoint) handlers.current.onMarkerRemove?.(waypoint.id);
												}}
											/>
										))}
									{name === SHOTS_LANE && shots.flatMap((shot, index) => (shot.cameraKeys ?? []).map((key) => (
										<span
											key={`${shot.id}:${key.frame}`}
											className="tl-marker cam"
											style={{ "--tl-f": framePct(key.frame, displayFrameCount) }}
											title={isKo ? `${key.frame}프레임의 카메라 키 — 클릭해 이동, 드래그로 시간 변경, 오른쪽 클릭으로 삭제` : `Camera key at frame ${key.frame} — click to jump, drag to re-time, right-click to remove`}
											onPointerDown={(e) => beginCameraKeyDrag(e, key, index)}
											onPointerMove={moveCameraKeyDrag}
											onPointerUp={endCameraKeyDrag}
											onPointerCancel={endCameraKeyDrag}
											onClick={(e) => onCameraKeyClick(e, key, index)}
											onContextMenu={(e) => {
												e.preventDefault();
												e.stopPropagation();
												handlers.current.onCameraKeyframeRemove?.(shot.id, key.id);
											}}
										/>
									)))}
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
