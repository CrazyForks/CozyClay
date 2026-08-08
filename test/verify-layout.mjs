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

expect("workspace layout persists across reloads", app.includes("WORKSPACE_LAYOUT_KEY") && app.includes("localStorage.setItem"));
expect("sidebar width has a pointer resize path", app.includes('beginWorkspaceResize("sidebar"'));
expect("frame monitor height has a pointer resize path", app.includes('beginWorkspaceResize("timeline"'));
expect("inset view has a diagonal resize path", app.includes("beginInsetResize") && app.includes("vp-inset-resize"));
expect("right panel has Hierarchy and contextual detail tabs", app.includes("right-panel-tabs") && app.includes("rightPanelDetailLabel"));
expect("right panel shows only the focused tab", app.includes('hidden={rightPanelTab !== "hierarchy"}') && app.includes('hidden={rightPanelTab !== "detail"}'));
expect("legacy hierarchy/inspector splitter is removed", !app.includes("hierarchy-splitter"));
expect("hierarchy selection focuses the contextual detail tab", app.includes('setRightPanelTab("detail")'));
expect("Motion inspector still owns the ARDY generation form", app.includes('hidden={!["characterA.motion", "characterA.baseMotion"].includes(selectedHierarchyId)}'));
expect("Prompt Block panel exposes one batch generation action", app.includes("prompt-block-generate") && app.includes("Generate all ${promptClips.length} blocks"));
expect("15-second greeting demo loads four ordered prompt blocks", app.includes('id: "demo-rise"') && app.includes("endFrame: 80") && app.includes('id: "demo-step"') && app.includes("endFrame: 140") && app.includes('id: "demo-wave"') && app.includes("endFrame: 240") && app.includes('id: "demo-greet"') && app.includes("endFrame: 300"));
expect("demo prompts describe stand, step, wave, and greeting phases", app.includes("stands up naturally") && app.includes("away from the chair") && app.includes("waves warmly several times") && app.includes("small welcoming nod"));
expect("demo timeline initializes to 15 seconds", app.includes("const DEFAULT_DURATION_S = 15"));
expect("motion preview stays at native 1x speed", app.includes("const DEFAULT_PLAYBACK_SPEED = 1") && app.includes("playbackSpeed={DEFAULT_PLAYBACK_SPEED}"));
expect("timeline cadence and readout expose native preview speed", timeline.includes("fps * playbackSpeed") && timeline.includes("playbackSpeed.toFixed(2)"));
expect("live localhost migrates stale demo state", app.includes('GREETING_DEMO_MIGRATION_KEY = "cozyclay.demo.seated-greeting.v1"') && app.includes("setPromptClips(DEFAULT_PROMPT_CLIPS.map") && app.includes("missing.length > 0 ? [...current, ...missing]"));
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
expect("Subject 1 exclusively owns the frame zero root start", app.includes("Subject 1 already defines the frame 0 root start") && !app.includes("Frame 0 is the start of the root path — it can't be removed"));
expect("root guidance sends only one clip-local frame zero start", app.includes("body.waypoints = [{ frame: 0, x: 0, z: 0, heading: null }]") && !app.includes("body.waypoints = aligned.waypoints"));
expect("generated motion anchors frame zero at Subject 1", app.includes("anchorX: charA.x") && app.includes("anchorZ: charA.z") && app.includes("anchorFrame: 0"));
expect("Bird's-eye root path draws from Subject 1 without a duplicate marker", planview.includes("const pathPoints = [{ x: start.x, z: start.z }, ...waypoints]") && planview.includes("waypoints.map((w, i)"));
expect("resize handles opt out on compact layouts", css.includes(".workspace-splitter,") && css.includes("display: none"));

if (failures) process.exit(1);
console.log("all resizable workspace checks PASS");
