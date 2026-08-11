#!/usr/bin/env node
// Camera timeline lane contract: shot-camera keyframings render as dots on
// the Camera lane, the lane keys the current framing on click, dots re-time
// by dragging, playback rides the keys segment by segment, and PlayView
// always plays the move with the motion. Ruler labels and lane gridlines
// share one 10-frame cadence.
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

if (failures) process.exit(1);
console.log("all timeline camera checks PASS");
