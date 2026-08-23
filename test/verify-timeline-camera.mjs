#!/usr/bin/env node
// Unified Shot block contract: shot-camera keyframings render as dots on
// the Shot lane, each block's key strip authors framing on click, dots re-time
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

expect("timeline has one combined Shot/Camera track", timeline.includes('const SHOTS_LANE = "Shots";') && !timeline.includes('const CAMERA_LANE = "Camera";') && !timeline.includes('"Camera",'));
expect("ruler labels step in 10-frame units", timeline.includes("const LABEL_STEPS = [10, 20, 50, 100, 200, 500, 1000];"));
expect("lane gridlines ride one 10-frame cadence", timeline.includes("const GRID_STEP_FRAMES = 10;") && timeline.includes("f += GRID_STEP_FRAMES"));
expect("gridlines render from the ruler's framePct", timeline.includes('className="tl-grid"') && timeline.includes('style={{ "--tl-f": framePct(f, displayFrameCount) }}'));
expect("chips and markers share one frame scale", !timeline.includes("promptFramePct") && timeline.includes("clipPct(clip.startFrame)"));

expect("camera keys render as dots, not a chip", timeline.includes('className="tl-marker cam"') && !timeline.includes("tl-chip camera"));
expect("block key strip keys the current framing", timeline.includes("handlers.current.onCameraKeyframeAdd?.(target, shots[index]?.id)") && timeline.includes('className="tl-shot-key-surface"') && app.includes("onCameraKeyframeAdd={addCameraKeyframe}"));
expect("key strip is a crosshair affordance", css.includes(".tl-shot-key-surface") && css.includes("cursor: crosshair"));
expect("dot click jumps the playhead and selects the camera", timeline.includes("handlers.current.onScrub?.(key.frame)") && timeline.includes("handlers.current.onCameraMoveSelect?.();"));
expect("dot right-click removes the key", timeline.includes("handlers.current.onCameraKeyframeRemove?.(shot.id, key.id)") && app.includes("removeCameraKey(shot.cameraKeys, keyId)"));
expect("dot drag re-times the key", timeline.includes("handlers.current.onCameraKeyframeMove?.(active.shotId, active.keyId, from, next)") && app.includes("onCameraKeyframeMove={moveCameraKeyframe}"));
expect("keys stay frame-unique on re-time", app.includes("moveCameraKey(entry.cameraKeys, keyId, target)"));
expect("re-keying a frame overwrites its framing", app.includes("shot.cameraKeys.filter((key) => key.frame !== target)") && app.includes('createStableItemId("camera-key")'));

expect("the move model is per-shot N keys, not A/B", app.includes("const [shots, setShots] = useState") && app.includes("const cameraKeys = activeShot?.cameraKeys ?? []") && !app.includes("setMoveA") && !app.includes("setMoveB"));
expect("interpolation samples keys segment by segment", camMove.includes("export function cameraMoveAt") && camMove.includes("interpolateFraming(a.framing, b.framing, anchor"));
expect("MoveRig plays and follows keys through the pure frame sampler", app.includes("keys={cameraKeys}") && app.includes("sampleAt(scene, sampledShot, frame).camera"));
expect("sequence slate and phrase derive per segment", app.includes("moveSequenceSlate(segs)") && app.includes("moveSequencePhrase(segs)"));
expect("generation exports first/last key conditioning frames", app.includes("captureFramingPng(cameraKeys[0].framing)") && app.includes("captureFramingPng(cameraKeys[cameraKeys.length - 1].framing)"));
expect("the duration slider is gone — dots own timing", !app.includes("moveDurationS"));

expect("PlayView restarts the piece from frame 0", app.includes('if (centerTab === "play") setTlFrame(0);'));
expect("PlayView always rides the camera move", app.includes('centerTab === "play" || (moveFollow && !ikMode && !waypointMode && !posing)'));
expect("Scene tab keeps the authoring gates on Follow mode", app.includes("moveFollow && !ikMode && !waypointMode && !posing"));
expect(
	"Draw Rail row owns the distance Follow On Off toggle",
	timeline.includes('aria-pressed={mode === "follow"}') &&
	timeline.includes('mode === "follow" ? ko("Follow On", "팔로우 켜짐") : ko("Follow Off", "팔로우 꺼짐")') &&
	timeline.includes('patchCamera({ mode: mode === "follow" ? "keys" : "follow" })') &&
	!app.includes('ko("Follow On", "팔로우 켜짐")') &&
	app.includes('if (patch.mode === "follow") syncActiveCameraFraming()'),
);

expect("surface lays out four tracks after removing duplicate Camera row", css.includes("grid-template-rows: 28px repeat(3, minmax(20px, 1fr)) minmax(68px, 1.7fr);"));
expect("lane gridlines are frame-based, not width-based", css.includes(".tl-grid {") && !css.includes("100% / 23"));
expect("camera dots have a distinct violet identity", css.includes(".tl-marker.cam {") && css.includes("#a78bfa"));
expect("Rail Follow lives inside each unified Shot block", timeline.includes("shot.camera?.railFollow") && timeline.includes('className={"tl-rail"') && !timeline.includes("name === CAMERA_LANE"));
expect("Rail Follow keeps move, resize, keyboard and remove editing", ["beginRailMove", "beginRailResize", "onRailKeyDown", "onRailRemove"].every((name) => timeline.includes(name)));
expect("Rail Follow callbacks target the owning shot", timeline.includes("onRailMove?.(active.shotId, next)") && app.includes("editRailSchedule(shotId"));
expect("Rail range playback is resolved per shot", app.includes("resolveRailSchedule({ railFollow: camera.railFollow") && app.includes("subjectSlice.slice(schedule.startFrame, schedule.endFrame + 1)"));
expect("disabled Rail Follow stays visible as OFF", timeline.includes('ko("Rail Follow", "레일 팔로우")') && timeline.includes('ko("OFF", "꺼짐")') && timeline.includes('mode !== "rail"'));

expect(
	"unified lane renders exactly one block from each shot geometry",
	timeline.includes("name === SHOTS_LANE && shots.map((shot, index)") &&
	timeline.includes("shotBlockGeometry(shots, index, frameCount, displayFrameCount)"),
);
expect("unified blocks preserve the violet camera identity", css.includes(".tl-shot-block {") && css.includes("border: 1px solid #735ba0"));
expect(
	"camera blocks summarize authored state",
	timeline.includes('"FREE" : "LOCKED"') &&
	timeline.includes("`KEYS ${keyCount}`") &&
	timeline.includes('? "RAIL" : mode === "follow" ? "FOLLOW"') &&
	timeline.includes('"HEAD" : "NEAREST"') &&
	timeline.includes("m/s") && timeline.includes("PITCH"),
);
expect(
	"camera block selection also selects its owning shot",
	timeline.includes("handlers.current.onCameraBlockSelect?.(shot.id)") &&
	timeline.includes("handlers.current.onShotSelect?.(shot.id)") &&
	timeline.includes("handlers.current.onCameraMoveSelect?.()"),
);
expect(
	"one add button creates a separate shared shot-camera card",
	!timeline.includes('className="tl-track-add cut camera"') &&
	timeline.includes('ko("+ Add shot", "+ 샷 추가")') &&
	timeline.includes("handlers.current.onShotCut?.()"),
);
expect(
	"one edge set owns shot and camera boundaries",
	!timeline.includes('className="tl-camera-edge') &&
	timeline.includes('className="tl-shot-edge start"') &&
	timeline.includes('className="tl-shot-edge end"') &&
	timeline.includes('beginShotBoundaryDrag(e, index, "start")') &&
	timeline.includes('beginShotBoundaryDrag(e, index, "end")'),
);
expect(
	"selected camera mini editor sits above the lane body",
	timeline.indexOf("<CameraBlockEditor") > 0 &&
	timeline.indexOf("<CameraBlockEditor") < timeline.indexOf('<div className="tl-body"'),
);
expect(
	"mini editor exposes preview, rail drawing and director controls",
	!timeline.includes('["keys", ko("Keys", "키")]') &&
	!timeline.includes('["follow", ko("Follow", "팔로우")]') &&
	!timeline.includes('["rail", ko("Rail", "레일")]') &&
	timeline.includes('ko("Preview", "미리보기")') &&
	timeline.includes('ko("Draw rail", "레일 그리기")') &&
	timeline.includes('ko("Follow On", "팔로우 켜짐")') &&
	timeline.includes('ko("Speed", "속도")') &&
	timeline.includes('ko("Pitch", "피치")') &&
	timeline.includes('ko("Distance", "거리")') &&
	timeline.includes('ko("Height", "높이")'),
);
expect(
	"height and pitch are adjacent in the camera bar",
	timeline.indexOf('ko("Height", "높이")') < timeline.indexOf('ko("Pitch", "피치")') &&
	(timeline.slice(timeline.indexOf('ko("Height", "높이")'), timeline.indexOf('ko("Pitch", "피치")')).match(/<label/g) ?? []).length === 1,
);
expect(
	"distance, height and pitch are measured from viewport manipulation instead of typed",
	timeline.includes('className="tl-camera-metric"') &&
	(timeline.match(/className="tl-camera-metric"/g) ?? []).length === 3 &&
	app.includes("followFramingFromCamera(") &&
	app.includes("cam.position,") &&
	app.includes("look.current.pitch,") &&
	app.includes("onCameraChange={commitManualCameraFraming}"),
);
expect(
	"manual viewport framing stays put until preview or playback",
	app.includes("manualCameraOverrideRef.current = true") &&
	// flying only interrupts playback while look-through hands the fly
	// controls the shot camera itself; editor-camera flights never touch it
	(app.match(/\(lookThroughShot && flyingRef\.current\) \|\| manualCameraOverrideRef\.current/g) ?? []).length === 2 &&
	app.includes("manualCameraOverrideRef.current = false"),
);
expect(
	"waypoint mode replaces camera controls with one clear message",
	timeline.includes("blocked={waypointMode}") &&
	timeline.includes('className="tl-camera-blocked"') &&
	timeline.includes('ko("Turn Waypoint off to edit or preview this camera.'),
);
expect(
	"damping and look-ahead stay behind advanced disclosure",
	timeline.includes('className="tl-camera-advanced"') &&
	timeline.includes('ko("Damping", "댐핑")') &&
	timeline.includes('ko("Look-ahead", "조준 선행")'),
);
expect(
	"timeline editor is the single follow-camera settings surface",
	!app.includes('<Slider label={ko("Distance", "거리")}') &&
	!app.includes('<Slider label={ko("Dolly speed", "돌리 속도")}') &&
	app.includes('className="camera-editor-pointer"') &&
	timeline.includes('ko("Draw rail", "레일 그리기")') &&
	!timeline.includes('ko("Clear rail", "레일 지우기")'),
);
expect(
	"Draw Rail exposes an explicit delete action",
	timeline.includes('ko("Delete rail", "레일 삭제")') &&
	timeline.includes("onRailDelete") &&
	app.includes("removeCameraRail(activeCamera)"),
);
expect(
	"preview starts at the selected shot and stops at its end",
	app.includes("function previewCameraShot(shotId)") &&
	app.includes("cameraPreviewEndRef.current = selected.endFrame") &&
	app.includes("setTlFrame(selected.startFrame)") &&
	app.includes("tlFrameRef.current >= previewEnd - 1") &&
	app.includes("setTlFrame(previewEnd)"),
);
expect(
	"rail ribbon cannot cover the shot frame range",
	css.includes(".tl-shot-label {") && css.includes("z-index: 5") &&
	css.includes(".tl-shot-label small {") && css.includes("background: rgba(68, 54, 93, .86)") &&
	css.includes("minmax(68px, 1.7fr)"),
);
expect(
	"advanced camera controls grow the bottom window instead of clipping Shots",
	css.includes(".timeline:not(.collapsed):has(.tl-camera-advanced[open])") &&
	css.includes("height: max(calc(var(--timeline-height) + 48px), 270px)") &&
	css.includes("min-height: 156px"),
);
expect(
	"camera editor emits shot-camera patches without owning global state",
	timeline.includes("handlers.current.onCameraBlockChange?.(patch)") &&
	!timeline.includes("localStorage") && !timeline.includes("setFollowCam"),
);
expect(
	"key dots remain overlaid above unified blocks and draggable",
	css.includes(".tl-marker.cam {") && css.includes("z-index: 5") &&
	timeline.includes("onPointerMove={moveCameraKeyDrag}"),
);

if (failures) process.exit(1);
console.log("all timeline camera checks PASS");
