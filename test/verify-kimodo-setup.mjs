import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const setup = readFileSync(new URL("../tools/kimodo/setup-on-box.sh", import.meta.url), "utf8");
const wrapper = readFileSync(new URL("../tools/kimodo/setup-local.mjs", import.meta.url), "utf8");
const runner = readFileSync(new URL("../tools/ardy/runners/index.mjs", import.meta.url), "utf8");
const edit = readFileSync(new URL("../tools/kimodo/run-edit-on-box.mjs", import.meta.url), "utf8");

assert.match(setup, /set -euo pipefail/);
assert.match(setup, /--dry-run/);
assert.match(setup, /git clone --depth 1 https:\/\/github\.com\/nv-tlabs\/kimodo\.git/);
assert.match(setup, /if \[ ! -e "\$KIMODO_DIR\/.git" \]/);
assert.match(setup, /snapshot_download\(repo_id=f\\?"nvidia\/\{model\}"\)/);
assert.match(setup, /McGill-NLP\/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised/);
assert.doesNotMatch(setup, /CCLAY_ARDY|\/ardy|ARDY/);
assert.match(wrapper, /CCLAY_KIMODO_HOST/);
assert.match(wrapper, /ssh/);
assert.match(runner, /return createKimodoRunner\(\);/);
assert.match(runner, /backend !== "kimodo"/);
assert.match(runner, /unknown CCLAY_MOTION_BACKEND/);
assert.doesNotMatch(runner, /createLocalRunner|createRemoteRunner|CCLAY_ARDY_MODE/);
assert.match(edit, /committed_keys:/);
assert.match(edit, /commit_verified: true/);
// The bridge only forwards a motion-edit report shaped like ARDY's: it must
// carry edit_range + history_range + future_range or tryParseReport drops it
// and the App refuses to install the regenerated take.
assert.match(edit, /edit_range: \[plan\.startFrame, plan\.endFrame\]/);
assert.match(edit, /history_range:/);
assert.match(edit, /future_range:/);
assert.doesNotMatch(edit, /edited_range/);
console.log("OK verify-kimodo-setup");
