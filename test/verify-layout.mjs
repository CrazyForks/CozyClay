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
expect("Prompt Block panel exposes one batch generation action", app.includes("prompt-block-generate") && app.includes("Generate all ${promptClips.length} blocks"));
expect("new sessions start without prompt blocks", app.includes("const DEFAULT_PROMPT_CLIPS = [];") && app.includes("useState(null)"));
expect("new sessions start with an empty motion prompt", app.includes('const [ardyPrompt, setArdyPrompt] = useState("");'));
expect("pre-motion timeline initializes to 15 seconds", app.includes("const DEFAULT_DURATION_S = 15"));
expect("motion preview stays at native 1x speed", app.includes("const DEFAULT_PLAYBACK_SPEED = 1") && app.includes("playbackSpeed={DEFAULT_PLAYBACK_SPEED}"));
expect("timeline cadence and readout expose native preview speed", timeline.includes("fps * playbackSpeed") && timeline.includes("playbackSpeed.toFixed(2)"));
expect("legacy greeting demo migration is removed", !app.includes("GREETING_DEMO_MIGRATION_KEY") && !app.includes('id: "demo-rise"'));
expect("batch generation spans through the final block frame", app.includes("Math.max(...clips.map((clip) => clip.endFrame))") && app.includes("Math.ceil(totalFrames / 20)"));
expect("batch generation forwards all prompt clips", app.includes("promptClipsOverride: clips") && app.includes("hasPromptSchedule"));
expect("normal motion generation excludes the prompt block schedule", app.includes("promptClipsOverride = []"));
// ARDY regeneration-request wiring: TRIPWIRES ONLY (pass-4 finding). These
// claims used to be GATED on src/App.jsx string presence, so a rendered App
// that never performed them still passed — the same false-evidence class as
// the orphaned undo store. Each is now OBSERVED in a real browser
// (test/verify-ardy-request.mjs captures the real /ardy/generate request
// body at the network edge and reads the live IK state of the rendered app;
// every claim was demonstrated to FAIL when its wiring was removed). The
// scans below are therefore explicitly NON-GATING tripwires: a PASS is a
// diagnostic that the wiring text still matches, a MISS warns that the
// behavioural gate may be failing for a drifted line — never a capability
// proof. All three files now tell the SAME story: verify-ardy-request.mjs
// OBSERVES this regeneration ground at the real request boundary, and
// verify-app-seam.mjs credits it as the behavioural gate rather than
// deferring it. Only the IK evaluate effect using the SELECTED subject's rig
// and clip is still deferred to U4, and no suite here claims it.
let tripMissed = 0;
function trip(name, condition, gate) {
	console.log(`${condition ? "TRIPWIRE PASS" : "TRIPWIRE MISS"}  ${name}  [non-gating; ${gate}]`);
	if (!condition) tripMissed += 1;
}
trip("unedited batch blocks use one unpinned autoregressive schedule", app.includes("!hasPromptSchedule && Boolean(motion || ikFramesA.length > 0)") && app.includes("else if (hasPromptSchedule) body.segments = segments"), "behavioural gate: verify-ardy-request.mjs S1 (the real request body ships segments with posePin false) and S4 (posePin true + poses)");
trip("IK-edited blocks use the motion edit session", app.includes("const editedSegments") && app.includes("body.motionEdit = {") && app.includes("sourceMotion: motion.url"), "behavioural gate: verify-ardy-request.mjs S5 (the real request body carries motionEdit.sourceMotion = the loaded clip url)");
trip("IK regeneration inherits loaded clip duration", app.includes("motion && ikFramesA.length > 0") && app.includes("motion.frames / motion.fps"), "behavioural gate: verify-ardy-request.mjs S4 (request duration is the clip's 3 s while the form shows 4 s)");
trip("motion edits send only tracked pending joints", app.includes("ikStateA.keys.get(frame)?.keys()") && app.includes("tracks:"), "behavioural gate: verify-ardy-request.mjs S5/S6 (every edit's tracks equal the live key state's joints, exactly)");
trip("successful motion edits commit and clear pending IK", app.includes("setCommittedIkEdits") && app.includes("ikStateA.keys.clear()") && app.includes("ikStateA.tracked.clear()"), "behavioural gate: verify-ardy-request.mjs S5 (committedIkEdits records the edits and the pending IK clears after commit_verified)");
trip("pending IK clears only after exact commit verification", app.includes("editCommitReport?.commit_verified !== true") && app.includes("ARDY returned motion without verified authored IK keys"), "behavioural gate: verify-ardy-request.mjs S6 (commit_verified false surfaces the refusal and commits nothing)");
trip("failed key verification leaves pending IK intact", app.indexOf("ARDY returned motion without verified authored IK keys") < app.indexOf("ikStateA.keys.clear()"), "behavioural gate: verify-ardy-request.mjs S6 (the pending keys and tracked set survive an unverified run)");
trip("individual block generation action is removed", !app.includes("Generate selected block"), "behavioural gate: verify-ardy-request.mjs S1 (the rendered Motion tab has no per-block Generate button)");
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
expect("Top-View root path draws from Subject 1 without a duplicate marker", planview.includes("const pathPoints = [{ x: start.x, z: start.z }, ...waypoints]") && planview.includes("waypoints.map((w, i)"));
expect("resize handles opt out on compact layouts", css.includes(".workspace-splitter,") && css.includes("display: none"));
if (tripMissed) {
	// A missed tripwire is a WARN, never a failure (pass-4 finding): the
	// claim is gated behaviourally in verify-ardy-request.mjs — see above.
	console.log(`\nTRIPWIRE MISSES (non-gating — the behavioural gates in verify-ardy-request.mjs tell the truth): ${tripMissed}`);
}

if (failures) process.exit(1);
console.log("all resizable workspace checks PASS (tripwires are non-gating diagnostics)");
