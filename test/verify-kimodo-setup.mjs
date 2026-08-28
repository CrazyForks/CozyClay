import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const setup = readFileSync(new URL("../tools/kimodo/setup-on-box.sh", import.meta.url), "utf8");
const wrapper = readFileSync(new URL("../tools/kimodo/setup-local.mjs", import.meta.url), "utf8");
const runner = readFileSync(new URL("../tools/ardy/runners/index.mjs", import.meta.url), "utf8");

assert.match(setup, /set -euo pipefail/);
assert.match(setup, /--dry-run/);
assert.match(setup, /git clone --depth 1 https:\/\/github\.com\/nv-tlabs\/kimodo\.git/);
assert.match(setup, /if \[ ! -e "\$KIMODO_DIR\/.git" \]/);
assert.match(setup, /snapshot_download\(repo_id=f\\?"nvidia\/\{model\}"\)/);
assert.match(setup, /McGill-NLP\/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised/);
assert.doesNotMatch(setup, /CCLAY_ARDY|\/ardy|ARDY/);
assert.match(wrapper, /CCLAY_KIMODO_HOST/);
assert.match(wrapper, /ssh/);
assert.match(runner, /if \(!backend\) return createKimodoRunner\(\);/);
assert.match(runner, /backend !== "ardy"/);
console.log("OK verify-kimodo-setup");
