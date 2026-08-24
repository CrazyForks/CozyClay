#!/usr/bin/env node
import assert from "node:assert/strict";
import {
	bucketMs,
	isOriginAllowed,
	normalizeOrigin,
	parseAllowlist,
	sanitizeProps,
} from "../src/analytics.js";

assert.equal(normalizeOrigin("HTTPS://CozyClay.Org/"), "https://cozyclay.org");
assert.equal(normalizeOrigin("https://www.cozyclay.org.../"), "https://www.cozyclay.org");
assert.equal(normalizeOrigin("https://COZYCLAY.ORG:8443/"), "https://cozyclay.org:8443");

assert.deepEqual(parseAllowlist(), ["https://cozyclay.org", "https://www.cozyclay.org"]);
assert.deepEqual(
	parseAllowlist(" HTTPS://Preview.CozyClay.Org/ ,https://cozyclay.org... "),
	["https://preview.cozyclay.org", "https://cozyclay.org"],
);

const allowlist = parseAllowlist();
assert.equal(isOriginAllowed("https://cozyclay.org", allowlist), true);
assert.equal(isOriginAllowed("https://www.cozyclay.org", allowlist), true);
assert.equal(isOriginAllowed("https://evilcozyclay.org", allowlist), false);
assert.equal(isOriginAllowed("https://preview.cozyclay.org", allowlist), false);
assert.equal(isOriginAllowed("https://cozyclay.org.evil.example", allowlist), false);

assert.deepEqual(
	sanitizeProps("motion:job_succeeded", {
		latency_bucket: "1-3s",
		input_mode: "pose",
		prompt: "secret prompt",
		name: "private name",
		unknown: "discarded",
	}),
	{ latency_bucket: "1-3s", input_mode: "pose" },
);
assert.deepEqual(
	sanitizeProps("scene:created", {
		scene_source: "quick start",
		path: "private",
		url: "https://private.example",
		file: "private.blend",
	}),
	{},
	"free text and hard-denied keys are never captured",
);
assert.deepEqual(
	sanitizeProps("motion:job_failed", {
		latency_bucket: "gte30s",
		input_mode: true,
		error_code: 503,
	}),
	{ latency_bucket: "gte30s", input_mode: true, error_code: 503 },
);
assert.deepEqual(sanitizeProps("motion:job_failed", { error_code: Number.POSITIVE_INFINITY }), {});

assert.equal(bucketMs(0), "lt1s");
assert.equal(bucketMs(999), "lt1s");
assert.equal(bucketMs(1000), "1-3s");
assert.equal(bucketMs(2999), "1-3s");
assert.equal(bucketMs(3000), "3-10s");
assert.equal(bucketMs(9999), "3-10s");
assert.equal(bucketMs(10000), "10-30s");
assert.equal(bucketMs(29999), "10-30s");
assert.equal(bucketMs(30000), "gte30s");

console.log("all analytics checks PASS");
