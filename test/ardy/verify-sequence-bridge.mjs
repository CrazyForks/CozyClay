#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { replaceMotionSegment } from "../../tools/ardy/npz.mjs";

let failures = 0;
function expect(name, condition) {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
	if (!condition) failures += 1;
}

const bridge = readFileSync(new URL("../../tools/ardy/bridge.mjs", import.meta.url), "utf8");
const runner = readFileSync(new URL("../../tools/ardy/run-sequence-on-box.sh", import.meta.url), "utf8");
const constrainedRunner = readFileSync(new URL("../../tools/ardy/run-on-box.sh", import.meta.url), "utf8");
const editRunner = readFileSync(new URL("../../tools/ardy/run-edit-on-box.sh", import.meta.url), "utf8");
const editGenerator = readFileSync(new URL("../../tools/ardy/cclay_motion_edit.py", import.meta.url), "utf8");

expect(
	"multi-block requests use the sequence runner once",
	bridge.includes("const box = spawnTracked(\"bash\", args") &&
	bridge.includes("generating ${segments.length} blocks in one autoregressive ARDY session")
);
expect(
	"sequence runner forwards every prompt block to one remote command",
	runner.includes("scripts/cclay_sequence_generate.py") &&
	runner.includes('cmd+=\" --segment')
);
expect(
	"sequence reports retain boundary continuity metrics",
	bridge.includes("Array.isArray(parsed.segments)") &&
	bridge.includes("parsed.continuity")
);
expect(
	"undersized implicit pose bases fall back to exact-duration generation",
	constrainedRunner.includes('if [[ "$BASE_FRAMES" -lt "$CLIP_FRAMES" ]]') &&
	constrainedRunner.includes('TWO_PASS=1')
);
expect(
	"legacy npz stitching is no longer imported by the bridge",
	!bridge.includes('stitchMotionSegments, writeNpz')
);
expect(
	"IK-edited blocks replace only their source ranges",
	bridge.includes("body.regenerateSegments") &&
	bridge.includes("replaceMotionSegment(result, generated, segment.startFrame)")
);
expect(
	"motion edits combine ARDY history with sparse observed constraints",
	editGenerator.includes("init_history_sequence=history") &&
	editGenerator.includes("SparseJointConstraint") &&
	editGenerator.includes("motion_mask=motion_mask") &&
	editGenerator.includes("observed_motion=observed_motion")
);
expect(
	"history-prefixed ARDY output commits only generated edit frames",
	editGenerator.includes("model_frames = history_frames + generation_frames") &&
	editGenerator.includes("motion[:, history_frames:history_frames + generation_frames]")
);
expect(
	"authored sparse keys are exact commits rather than soft conditions",
	editGenerator.includes("TRACK_COMMIT_CHAINS") &&
	editGenerator.includes("committed_local[frame, joint] = key[\"local_rotations\"][joint]") &&
	editGenerator.includes("authored IK key commit verification failed")
);
expect(
	"exact keys retain generated in-betweens instead of creating one-frame snaps",
	editGenerator.includes("correction_axis_angle") &&
	editGenerator.includes("radius = 6") &&
	editGenerator.includes("committed_root[:edit_frames] = root_positions[:edit_frames]")
);
expect(
	"root edits are separated from body constraints",
	editGenerator.includes("class RootTrackConstraint") &&
	editGenerator.includes('if "hips" in edit["tracks"]') &&
	editGenerator.includes("body edits never move root")
);
expect(
	"motion edits include both previous and future context",
	editGenerator.includes("history_start = max(0, start - args.context_before)") &&
	editGenerator.includes("future_end = min(total_frames, end + args.context_after)") &&
	editGenerator.includes("FullBodyConstraintSet")
);
expect(
	"edit runner uploads source, manifest, sparse poses, and generator together",
	editRunner.includes('"$SOURCE" "$HOST:${REMOTE_TMP}/source.npz"') &&
	editRunner.includes('"$MANIFEST" "$HOST:${REMOTE_TMP}/manifest.json"') &&
	editRunner.includes('"${POSES[$i]}" "$HOST:${REMOTE_TMP}/pose-${i}.npz"')
);

const makeMotion = (frames, fill) => ({
	frames,
	fps: 20,
	rotMats: Float32Array.from({ length: frames * 27 * 9 }, (_, index) => fill + index),
	rootPos: Float32Array.from({ length: frames * 3 }, (_, index) => fill + index),
	posedJoints: Float32Array.from({ length: frames * 27 * 3 }, (_, index) => fill + index),
});
const base = makeMotion(8, 0);
const replacement = makeMotion(3, 10000);
const replaced = replaceMotionSegment(base, replacement, 2);
expect(
	"block replacement preserves every value outside the edited range",
	replaced.rotMats.slice(0, 2 * 27 * 9).every((value, index) => value === base.rotMats[index]) &&
	replaced.rotMats.slice(5 * 27 * 9).every((value, index) => value === base.rotMats[5 * 27 * 9 + index]) &&
	replaced.rootPos.slice(0, 2 * 3).every((value, index) => value === base.rootPos[index]) &&
	replaced.posedJoints.slice(5 * 27 * 3).every((value, index) => value === base.posedJoints[5 * 27 * 3 + index])
);
expect(
	"block replacement writes the generated range at its global frame offset",
	replaced.rotMats.slice(2 * 27 * 9, 5 * 27 * 9).every((value, index) => value === replacement.rotMats[index]) &&
	replaced.rootPos.slice(2 * 3, 5 * 3).every((value, index) => value === replacement.rootPos[index]) &&
	replaced.posedJoints.slice(2 * 27 * 3, 5 * 27 * 3).every((value, index) => value === replacement.posedJoints[index])
);

if (failures) process.exit(1);
console.log("all ARDY sequence bridge checks PASS");
