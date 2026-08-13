#!/usr/bin/env node
// Camera timeline lane contract: shot-camera keyframings render as dots on
// the Camera lane, the lane keys the current framing on click, dots re-time
// by dragging, playback rides the keys segment by segment, and PlayView
// always plays the move with the motion. The lane's top band hosts the Rail
// Follow ribbon: a non-focusable group of three sibling controls (start
// handle, body, end handle) over the resolved schedule, with keyboard
// nudge/resize/remove. Ruler labels and lane gridlines share one 10-frame
// cadence.
import { readFileSync } from "node:fs";

let failures = 0;
function expect(name, condition) {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
	if (!condition) failures += 1;
}

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const timeline = readFileSync(new URL("../src/ardy/timeline.jsx", import.meta.url), "utf8");
const camMove = readFileSync(new URL("../src/camera-move.js", import.meta.url), "utf8");

expect("timeline exposes a Camera track", timeline.includes('"Camera",') && timeline.includes('const CAMERA_LANE = "Camera";'));
expect("ruler labels step in 10-frame units", timeline.includes("const LABEL_STEPS = [10, 20, 50, 100, 200, 500, 1000];"));
expect("lane gridlines ride one 10-frame cadence", timeline.includes("const GRID_STEP_FRAMES = 10;") && timeline.includes("f += GRID_STEP_FRAMES"));
expect("gridlines render from the ruler's framePct", timeline.includes('className="tl-grid"') && timeline.includes('style={{ "--tl-f": framePct(f, displayFrameCount) }}'));
expect("chips and markers share one frame scale", !timeline.includes("promptFramePct") && timeline.includes("clipPct(clip.startFrame)"));

expect("camera keys render as dots, not a chip", timeline.includes('className="tl-marker cam"') && !timeline.includes("tl-chip camera"));
expect("lane click keys the current framing", timeline.includes("handlers.current.onCameraKeyframeAdd?.(rootFrameFromEvent(e))") && app.includes("onCameraKeyframeAdd={addCameraKeyframe}"));
expect("lane click is a crosshair affordance", timeline.includes('name === CAMERA_LANE ? " cam" : ""') && css.includes(".tl-lane.cam"));
expect("dot click jumps the playhead and selects the camera", timeline.includes("handlers.current.onScrub?.(keyFrame)") && timeline.includes("handlers.current.onCameraMoveSelect?.();"));
expect("dot right-click removes the key", timeline.includes("handlers.current.onCameraKeyframeRemove?.(f)") && app.includes("keys.filter((k) => k.frame !== frame)"));
expect("dot drag re-times the key", timeline.includes("handlers.current.onCameraKeyframeMove?.(from, next)") && app.includes("onCameraKeyframeMove={moveCameraKeyframe}"));
expect("keys stay frame-unique on re-time", app.includes("if (keys.some((k) => k.frame === target)) return keys;"));
expect("re-keying a frame overwrites its framing", app.includes("keys.filter((k) => k.frame !== target).concat({ frame: target, framing })"));

expect("the move model is N keys, not A/B", app.includes("const [cameraKeys, setCameraKeys] = useState(shotStartup?.cameraKeys ?? []);") && !app.includes("setMoveA") && !app.includes("setMoveB"));
expect("interpolation samples keys segment by segment", camMove.includes("export function cameraMoveAt") && camMove.includes("interpolateFraming(a.framing, b.framing, anchor"));
expect("MoveRig plays and follows the keys", app.includes("keys={cameraKeys}") && app.includes("cameraMoveAt(keys, anchor, frame)"));
expect("sequence slate and phrase derive per segment", app.includes("moveSequenceSlate(segs)") && app.includes("moveSequencePhrase(segs)"));
expect("generation exports first/last key conditioning frames", app.includes("captureFramingPng(cameraKeys[0].framing)") && app.includes("captureFramingPng(cameraKeys[cameraKeys.length - 1].framing)"));
expect("the duration slider is gone — dots own timing", !app.includes("moveDurationS"));

expect("PlayView restarts the piece from frame 0", app.includes('if (centerTab === "play") setTlFrame(0);'));
expect("PlayView always rides the camera move", app.includes('centerTab === "play" || (moveFollow && !ikMode && !waypointMode && !posing)'));
expect("Scene tab keeps the authoring gates on follow", app.includes("moveFollow && !ikMode && !waypointMode && !posing"));

expect("surface lays out four tracks", css.includes("grid-template-rows: 28px repeat(4, minmax(0, 1fr));"));
expect("lane gridlines are frame-based, not width-based", css.includes(".tl-grid {") && !css.includes("100% / 23"));
expect("camera dots have a distinct violet identity", css.includes(".tl-marker.cam {") && css.includes("#a78bfa"));

/* ------------------------------------------- Rail Follow ribbon ---------- */

expect("ribbon props carry resolved range/status/selection/progress", timeline.includes("railAvailable = false") && timeline.includes("railSchedule = null") && timeline.includes("railSelected = false") && timeline.includes("railProgress = null"));
expect("ribbon callbacks cover select/move/resize/remove", ["onRailSelect", "onRailMove", "onRailRangeChange", "onRailRangeEnd", "onRailRemove"].every((p) => timeline.includes(p)));
expect("ribbon renders only with a rail and a clip that fits", timeline.includes("!railAvailable || frameCount < 10"));
expect("off/default schedules render the full-length default clip", timeline.includes("{ start: 0, end: frameCount - 1 }"));
expect("edits clamp to the clip only — the schedule module owns the 10-frame minimum", timeline.includes("Math.min(frameCount - 1, Math.round(active.startFrame"));
expect("ribbon is a non-focusable group, no positive tabindex anywhere", timeline.includes('role="group"') && !/tabIndex=\{[1-9]/.test(timeline));
const railStart = timeline.indexOf('className={"tl-rail"');
const railMarkup = railStart > -1 ? timeline.slice(railStart) : "";
expect("three sibling tabIndex=0 controls in DOM order start, body, end", railMarkup.indexOf('data-rail-edge="start"') > -1 && railMarkup.indexOf('data-rail-edge="start"') < railMarkup.indexOf('data-rail-edge="body"') && railMarkup.indexOf('data-rail-edge="body"') < railMarkup.indexOf('data-rail-edge="end"') && (railMarkup.match(/tabIndex=\{0\}/g) ?? []).length === 3);
expect("handles resize 1 frame, Shift+Arrow 10", timeline.includes("e.shiftKey ? 10 : 1"));
expect("body arrow keys move a fixed-length range", timeline.includes("frameCount - (railRange.end - railRange.start + 1)"));
expect("Delete/Backspace removes the schedule", timeline.includes('e.key === "Delete" || e.key === "Backspace"'));
expect("Space/J/K stay gated while a ribbon button is focused", timeline.includes('el.tagName === "BUTTON"'));
expect("disabled follow stays visible and labeled OFF in both languages", timeline.includes('className="tl-rail-off"') && timeline.includes('"OFF"') && timeline.includes('"꺼짐"'));
expect("visual OFF is persisted off OR follow-cam disabled", timeline.includes('const railOff = railSchedule?.mode === "off" || !railFollowEnabled;'));
expect("App passes the follow-cam master switch to the ribbon", app.includes("railFollowEnabled={followCam.enabled}"));
expect("English default and Korean labels", timeline.includes('"Rail Follow"') && timeline.includes('"레일 팔로우"'));
expect("progress fill rides the playhead inside the range", timeline.includes("tl-rail-progress") && timeline.includes("railProgress >= railRange.start"));
expect("camera keys still render as dots below the ribbon", timeline.includes('className="tl-marker cam"') && css.includes(".tl-rail {") && css.includes(".tl-rail-body {") && css.includes(".tl-rail-handle") && css.includes(".tl-rail.off"));
expect("ribbon styling keeps four tracks", css.includes("grid-template-rows: 28px repeat(4, minmax(0, 1fr));"));

if (failures) process.exit(1);
console.log("all timeline camera checks PASS");
