import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { frameFromClientX, promptMoveStartFrame } from "./timeline-coordinates.js";
import { promptResizeFrame } from "./timeline-resize.js";

/**
 * ARDY Viser-style animation timeline — the live motion workspace.
 *
 * Frame, playback, waypoints and the motion badge are owned by App: this
 * component is controlled and reports every interaction through callbacks,
 * so the scene (character rig, root path) can react to playhead moves.
 * The 2D Root lane authors temporal keyframes directly: left-clicking an empty
 * track cell creates/selects a numbered waypoint, then Bird's-eye owns its
 * spatial position through direct marker dragging.
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
];

/** IK keys live on the Full-Body lane: one marker per keyed frame, holding
 * a sparse set of the limbs the user has moved (never every joint). */
const IK_LANE = "Full-Body";

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
}) {
	const [expanded, setExpanded] = useState(true);
	const [zoom, setZoom] = useState(ZOOM_DEFAULT);
	const [movingPromptId, setMovingPromptId] = useState(null);
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
	handlers.current = { onScrub, onAdvance, onStep, onPlayToggle, onWaypointToggle, onMarkerSelect, onMarkerRemove, onRootKeyframeAdd, onPromptAdd, onPromptSelect, onPromptChange, onPromptResize, onPromptMove, onPromptRemove, onIkToggle, onIkKeyframeAdd, onIkKeyframeRemove, onFootSnapToggle };

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
	const labels = useMemo(() => {
		const step = Math.max(1, Math.ceil((displayFrameCount - 1) / 24));
		const out = [];
		for (let f = 0; f < displayFrameCount; f += step) out.push(f);
		return out;
	}, [displayFrameCount]);
	const promptFramePct = (value) => Math.max(0, Math.min(1, value / Math.max(1, displayFrameCount)));
	const moveRef = useRef(null);
	const suppressPromptClickRef = useRef(false);
	const resizeRef = useRef(null);

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
		<section className={"timeline" + (expanded ? "" : " collapsed")} aria-label="Animation timeline">
			{expanded ? (
				<>
					<div className="tl-head">
						<div className="tl-transport" aria-label="Playback transport">
							<button
								type="button"
								className="tl-btn"
								aria-label="Previous frame"
								title="Previous frame (k)"
								onClick={() => handlers.current.onStep?.(-1)}
							>
								‹
							</button>
							<button
								type="button"
								className={"tl-btn play" + (playing ? " on" : "")}
								aria-label={playing ? "Pause playback" : "Play playback"}
								title="Play / pause (Space)"
								onClick={() => handlers.current.onPlayToggle?.()}
							>
								{playing ? "❚❚" : "▶"}
							</button>
							<button
								type="button"
								className="tl-btn"
								aria-label="Next frame"
								title="Next frame (j)"
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
							title="Two-finger up/down over FRAME ruler to zoom — click to reset to 1×"
							onClick={resetZoom}
						>
							{zoom.toFixed(2)}×
						</button>
						<button
							type="button"
							className={"tl-btn wp" + (waypointMode ? " on" : "")}
							aria-pressed={waypointMode}
							title="Enable or disable 2D Root path constraints (P)"
							onClick={() => handlers.current.onWaypointToggle?.()}
						>
							Waypoint {waypointMode ? "on" : "off"}
						</button>
						<button
							type="button"
							className={"tl-btn ik" + (ikMode ? " on" : "")}
							aria-pressed={ikMode}
							disabled={ikDisabled && !ikMode}
							title={ikDisabled && !ikMode ? "IK needs Subject 1's rig loaded" : "IK mode — drag a wrist / ankle handle; keys land on the Full-Body lane. With a motion loaded, keys correct it layer-style"}
							onClick={() => handlers.current.onIkToggle?.()}
						>
							IK {ikMode ? "on" : "off"}
						</button>
						<button
							type="button"
							className={"tl-btn ik snap" + (footSnap ? " on" : "")}
							aria-pressed={footSnap}
							title="Foot snap — keep the feet planted while you move the body (hips); the knees bend instead of the feet sinking through the floor"
							onClick={() => handlers.current.onFootSnapToggle?.()}
						>
							Snap {footSnap ? "on" : "off"}
						</button>
						{waypointMode && (
							<span className={"tl-wp-hint" + (waypointFrames.length < 2 || pathSpeed?.warn ? " warn" : "")}>
								{waypointFrames.length < 2
									? "Click the set floor in the Shot view to drop waypoints"
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
								title="Clear motion and restore the blocking pose"
								onClick={onClearMotion}
							>
								✕ Motion
							</button>
						)}
						<button
							type="button"
							className="tl-toggle"
							aria-expanded="true"
							aria-label="Collapse timeline"
							title="Collapse timeline"
							onClick={() => setExpanded(false)}
						>
							▾
						</button>
					</div>

					<div className="tl-body" ref={bodyRef}>
						<div className="tl-surface" style={{ "--tl-zoom": surfaceZoom }}>
						<div className="tl-ruler">
							<span className="tl-ruler-label">Frame</span>
							<div
								className="tl-ruler-lane"
								ref={rulerRef}
								role="slider"
								aria-label="Scrub timeline"
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
							<div className={"tl-track" + (name === "Prompts" ? " prompts" : "") + (name === IK_LANE ? " ik" : "")} key={name}>
								<span className="tl-track-label">
									{name}
									{name === "Prompts" && <button className="tl-track-add" type="button" title="Add 2 second prompt clip" onClick={() => handlers.current.onPromptAdd?.(frame)}>+</button>}
									{name === IK_LANE && ikMode && (
										<button
											className="tl-track-add ik"
											type="button"
											title={`Key the current pose at frame ${frame}`}
											onClick={() => handlers.current.onIkKeyframeAdd?.()}
										>
											+
										</button>
									)}
								</span>
								<div
									className={"tl-lane" + (name === "2D Root" ? " root" : "")}
									onPointerDown={
										name === "2D Root"
											? (e) => {
												if (e.button !== 0 || e.target !== e.currentTarget) return;
												handlers.current.onRootKeyframeAdd?.(rootFrameFromEvent(e));
											}
											: undefined
									}
								>
									{name === "Prompts" && promptClips.map((clip) => {
										const duration = ((clip.endFrame - clip.startFrame) / Math.max(1, fps)).toFixed(1);
										return (
											<div key={clip.id} className={"tl-chip" + (selectedPromptId === clip.id ? " selected" : "") + (movingPromptId === clip.id ? " moving" : "")} style={{ "--tl-f-start": promptFramePct(clip.startFrame), "--tl-f-end": promptFramePct(clip.endFrame) }} title="Drag to move · edge handles resize · right-click removes" onPointerDown={(e) => beginPromptMove(e, clip)} onPointerMove={movePrompt} onPointerUp={endPromptMove} onPointerCancel={endPromptMove} onClick={blockPromptClick} onContextMenu={(e) => { e.preventDefault(); handlers.current.onPromptRemove?.(clip.id); }}>
												<button className="tl-chip-handle start" type="button" aria-label="Resize prompt start" onPointerDown={(e) => beginPromptResize(e, clip, "start")} onPointerMove={movePromptResize} onPointerUp={endPromptResize} onPointerCancel={endPromptResize} />
												<input className="tl-chip-input" value={clip.text} placeholder={`${duration}s · motion prompt`} maxLength={500} onChange={(e) => handlers.current.onPromptChange?.(clip.id, e.target.value)} />
												<button className="tl-chip-handle end" type="button" aria-label="Resize prompt end" onPointerDown={(e) => beginPromptResize(e, clip, "end")} onPointerMove={movePromptResize} onPointerUp={endPromptResize} onPointerCancel={endPromptResize} />
											</div>
										);
									})}
									{name === IK_LANE &&
										ikFrames.map((f) => (
											<span
												key={f}
												className="tl-marker ik"
												style={{ "--tl-f": framePct(f, displayFrameCount) }}
												title={`Full-body IK key at frame ${f} — click to jump, right-click to remove`}
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
												title={`Root waypoint at frame ${f} — click to select, right-click to remove; drag marker ${waypointFrames.indexOf(f) + 1} in Bird's-eye to move`}
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
								? "Click the set floor in the Shot view to add waypoints"
								: `${waypointFrames.length} root waypoints · click the set floor to add more`}
						</span>
					)}
					<button
						type="button"
						className="tl-toggle"
						aria-expanded="false"
						aria-label="Expand timeline"
						title="Expand timeline"
						onClick={() => setExpanded(true)}
					>
						▸
					</button>
				</div>
			)}
		</section>
	);
}
