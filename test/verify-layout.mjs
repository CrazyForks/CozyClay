#!/usr/bin/env node
import { readFileSync } from "node:fs";

let failures = 0;
function expect(name, condition) {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
	if (!condition) failures += 1;
}

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const planview = readFileSync(new URL("../src/planview.jsx", import.meta.url), "utf8");
const timeline = readFileSync(new URL("../src/ardy/timeline.jsx", import.meta.url), "utf8");
const dualview = readFileSync(new URL("../src/dualview.jsx", import.meta.url), "utf8");

expect("workspace layout persists across reloads", app.includes("WORKSPACE_LAYOUT_KEY") && app.includes("localStorage.setItem"));
expect("sidebar width has a pointer resize path", app.includes('beginWorkspaceResize("sidebar"'));
expect("frame monitor height has a pointer resize path", app.includes('beginWorkspaceResize("timeline"'));
expect("inset view has a diagonal resize path", app.includes("beginInsetResize") && app.includes("vp-inset-resize"));
expect("inset view collapses to its tag pill", app.includes("insetCollapsed") && app.includes("vp-inset-caret") && css.includes(".vp-inset.collapsed"));
expect("collapse toggle lives inside the tag strip", !app.includes("vp-inset-collapse\"") && css.includes(".vp-inset-caret"));
expect("the tag drags the inset in both states", app.includes("onPointerDown={beginInsetDrag}"));
expect("inset collapse state persists with the workspace layout", app.includes("insetCollapsed: false") && app.includes("WORKSPACE_LAYOUT_KEY"));
expect("collapsed inset skips its render pass", dualview.includes("insetCollapsed = false") && dualview.includes("if (!insetCollapsed) draw("));
expect("resize handle hides while collapsed", app.includes("{!workspaceLayout.insetCollapsed && ("));
expect("resize grip is visible on the clay viewport", css.includes(".vp-inset-resize:before,") && css.includes("rgba(255, 252, 247, .85)"));
expect("Top-View plan zooms with the wheel over the inset", app.includes('pane.addEventListener("wheel", onWheel, { passive: false })') && app.includes("current.planZoom * Math.pow"));
expect("plan zoom persists with the workspace layout", app.includes("planZoom: 1,") && app.includes("WORKSPACE_LAYOUT_KEY"));
expect("zoom shrinks the ortho extent, not the pane", dualview.includes("planZoom = 1") && dualview.includes("PLAN_EXTENT / Math.max(0.25, planZoom)"));
expect("demand loop wakes on mount and model commit", dualview.includes("requestAnimationFrame(() => requestAnimationFrame(invalidate))") && app.includes("const frame = requestAnimationFrame(invalidate);"));
expect("double-click no longer swaps Scene and Top-View", !app.includes('setViewMode((current) => (current === "plan" ? "shot" : "plan"))'));
expect("Scene toolbar exposes shot preset, aspect, FOV, recenter, and Top-View controls", app.includes("viewport-toolbar-field shot-field") && app.includes("SHOT_ASPECT_PRESETS") && app.includes("viewport-fov-control") && app.includes("Recenter on subject") && app.includes('ko("Top", "탑")'));
expect("Scene and PlayView tools share one horizontal title bar", app.includes('className="viewport-titlebar"') && css.includes(".viewport-titlebar") && css.includes("position: static"));
expect("PlayView toolbar exposes framing readouts, playback, and recording", app.includes("editor-toolbar play-tools") && app.includes("shotOutput.label") && app.includes("toggleShotRecording"));
expect("selected aspect reaches the shot renderer", app.includes("shotAspect={shotOutput.aspect}") && dualview.includes("shotAspect = SHOT_ASPECT") && dualview.includes("fitAspect(mainRect, shotAspect)"));
expect("recording and still capture use the selected output dimensions", app.includes("mirror.width = shotOutput.width") && app.includes("width={shotOutput.width}") && app.includes("canvas.width = shotOutput.width"));
expect("double-clicking the inset body folds it", app.includes('event.target.closest?.(".vp-inset-tag")') && app.includes("insetCollapsed: !current.insetCollapsed"));
expect("the tag strip works like a foldout header", app.includes("if (!moved && ev.detail <= 1) {") && app.includes("insetToggledAtRef"));
expect("one fold per gesture, even on a double-click", app.includes("if (e.detail > 1) return;") && app.includes("ev.detail <= 1"));
expect("body double-click skips tag-started gestures", app.includes("Date.now() - insetToggledAtRef.current < 450"));
expect("workspace has a dedicated left hierarchy window", app.includes('className="panel hierarchy-left"') && app.includes('beginWorkspaceResize("hierarchy"'));
expect("inspector is always visible beside the scene", app.includes("inspector-sidebar") && !app.includes("rightPanelTab"));
expect("legacy hierarchy/inspector splitter is removed", !app.includes("hierarchy-splitter"));
expect("bottom window separates Timeline from the ARDY console", app.includes("bottom-window-tabs") && app.includes("console-pane") && app.includes('hidden={bottomTab !== "timeline"}'));
expect("ARDY status lines accumulate in the console window", app.includes("reportArdyStatus") && app.includes("consoleLines"));
expect("Motion tab owns the ARDY generation form", app.includes('<Foldout hidden={sidebarTab !== "motion"} title={ko("ARDY motion", "ARDY 모션")}>'));
expect("Motion tab exposes the camera animation controls", app.includes('sidebarTab === "shot" || sidebarTab === "motion" || (sidebarTab === "inspector" && selectedHierarchyId === "camera")'));
expect("Prompt Block panel exposes one batch generation action", app.includes("prompt-block-generate") && app.includes("Generate all ${promptClips.length} blocks"));
expect("new sessions start without prompt blocks", app.includes("const DEFAULT_PROMPT_CLIPS = [];") && app.includes("useState(null)"));
expect("new sessions start with an empty motion prompt", app.includes('const [ardyPrompt, setArdyPrompt] = useState("");'));
expect(
	"MP4 recording is repaired before its download URL is created",
	app.includes('import { repairRecordedMp4 } from "./ardy/mp4-duration.js";') &&
	app.indexOf("await repairRecordedMp4(recordedBlob)") < app.indexOf("URL.createObjectURL(downloadBlob)"),
);
expect(
	"MP4 repair failure falls back to the original recording",
	app.includes("catch {") && app.includes("downloadBlob = recordedBlob;"),
);
expect("pre-motion timeline initializes to 15 seconds", app.includes("const DEFAULT_DURATION_S = 15"));
expect("motion preview stays at native 1x speed", app.includes("const DEFAULT_PLAYBACK_SPEED = 1") && app.includes("playbackSpeed={DEFAULT_PLAYBACK_SPEED}"));
expect("timeline cadence and readout expose native preview speed", timeline.includes("fps * playbackSpeed") && timeline.includes("playbackSpeed.toFixed(2)"));
expect("legacy greeting demo migration is removed", !app.includes("GREETING_DEMO_MIGRATION_KEY") && !app.includes('id: "demo-rise"'));
expect("batch generation spans through the final block frame", app.includes("Math.max(...clips.map((clip) => clip.endFrame))") && app.includes("Math.ceil(totalFrames / 20)"));
expect("batch generation forwards all prompt clips", app.includes("promptClipsOverride: clips") && app.includes("hasPromptSchedule"));
expect("normal motion generation excludes the prompt block schedule", app.includes("promptClipsOverride = []"));
expect("unedited batch blocks use one unpinned autoregressive schedule", app.includes("!hasPromptSchedule && Boolean(motion || ikFrames.length > 0)") && app.includes("else if (hasPromptSchedule) body.segments = segments"));
expect("IK-edited blocks use the motion edit session", app.includes("const editedSegments") && app.includes("body.motionEdit = {") && app.includes("sourceMotion: motion.url"));
expect("IK regeneration inherits loaded clip duration", app.includes("motion && ikFrames.length > 0") && app.includes("motion.frames / motion.fps"));
expect("motion edits send only tracked pending joints", app.includes("ikStateRef.current.keys.get(frame)?.keys()") && app.includes("tracks:"));
expect("successful motion edits commit and clear pending IK", app.includes("setCommittedIkEdits") && app.includes("ikStateRef.current.keys.clear()") && app.includes("ikStateRef.current.tracked.clear()"));
expect("pending IK clears only after exact commit verification", app.includes("editCommitReport?.commit_verified !== true") && app.includes("ARDY returned motion without verified authored IK keys"));
expect("failed key verification leaves pending IK intact", app.indexOf("ARDY returned motion without verified authored IK keys") < app.indexOf("ikStateRef.current.keys.clear()"));
expect("individual block generation action is removed", !app.includes("Generate selected block"));
expect("Prompt Block edits stay synced with ARDY input", app.includes("changePromptClip(selectedPromptId") && app.includes("setArdyPrompt(event.target.value)"));
expect("desktop stage fills the remaining viewport", css.includes("aspect-ratio: auto") && css.includes("height: 100%"));
expect("sidebar width is bounded", css.includes("min-width: 280px") && css.includes("max-width: 50vw"));
expect("timeline height is bounded", css.includes("min-height: 110px") && css.includes("max-height: 58vh"));
expect("timeline IK text controls size to their labels", css.includes(".tl-btn.ik {") && css.includes("min-width: 48px") && css.includes("white-space: nowrap"));
// Floor-click authoring: waypoints are placed by clicking the set floor, so
// frame 0 is owned implicitly — the request prepends Subject 1's position and
// authored pins can never claim frame 0 or earlier.
expect("Subject 1 exclusively owns the frame zero root start", app.includes("{ frame: 0, x: charA.x, z: charA.z, heading: null }") && app.includes("waypoint.frame <= 0") && !app.includes("Frame 0 is the start of the root path — it can't be removed"));
expect("root guidance sends the aligned, densified path to ARDY", app.includes("alignArdyPath(rootPath, charA.rot") && app.includes("body.waypoints = ardyWaypoints"));
expect(
	"a root path and a prompt schedule are sent together, judged per block",
	app.includes("if (hasPromptSchedule && !hasBlockEdits) body.segments = segments;") &&
	app.includes("judgeAuthoredPath(rootPath, 20, clipFrames, { chained: hasPromptSchedule })") &&
	app.includes("every prompt block must stay within"),
);
expect("generated motion anchors frame zero at Subject 1", app.includes("anchorX: charA.x") && app.includes("anchorZ: charA.z") && app.includes("anchorFrame: 0"));
expect("returned playback has no CozyClay root coordinate warp", !app.includes("warpMotionRootToPath"));
expect("Top-View root path draws from Subject 1 without a duplicate marker", planview.includes("[{ x: start.x, z: start.z }, ...waypoints]") && planview.includes("waypoints.map((w, i)"));
expect(
	"Top-View characters use their real meshes without covering hex pucks",
	planview.includes('<Puck color={SUBJECT_ONE_COLOR} showBody={false} {...state("a")} />') &&
	planview.includes('<Puck color={SUBJECT_TWO_COLOR} showBody={false} {...state("b")} />') &&
	planview.includes("stem: makes the handle read as attached"),
);
expect(
	"Top-View uses saturated role colors and readable path widths",
	planview.includes('const CAMERA_COLOR = "#007f9e"') &&
	planview.includes('const SUBJECT_ONE_COLOR = "#2457d6"') &&
	planview.includes('const RAIL_COLOR = "#7137c8"') &&
	planview.includes("lineWidth={3}") && planview.includes("lineWidth={live ? 2.5 : 3.5}"),
);
expect(
	"Top-View shows ARDY player endpoints and direction while composing a rail",
	planview.includes("function SubjectMovementGuide") &&
	planview.includes("directionTriangle") &&
	planview.includes('ko("ARDY START", "ARDY 시작")') &&
	planview.includes('ko("ARDY END", "ARDY 끝")') &&
	planview.includes("point.x.toFixed(1)") &&
	planview.includes('ko("PLAYER STILL", "플레이어 정지")') &&
	planview.includes("(railDraw || cameraRailPoints) && <SubjectMovementGuide"),
);
expect(
	"only generated ARDY motion drives the player guide",
	app.includes("subjectTrack={motion ? subjectTrack : null}") &&
	!app.includes("subjectTrackStart=") &&
	!app.includes("subjectTrackEnd="),
);
expect("resize handles opt out on compact layouts", css.includes(".workspace-splitter,") && css.includes("display: none"));

if (failures) process.exit(1);
console.log("all resizable workspace checks PASS");
