#!/usr/bin/env node
import assert from "node:assert/strict";
import { exportOffscreenVideo, normalizeFrameRange } from "../src/offscreen-export.js";

class FakeVideoFrame {
	constructor(pixels, init) {
		this.pixels = pixels;
		this.timestamp = init.timestamp;
		this.duration = init.duration;
	}
	close() {}
}

class FakeVideoEncoder {
	static async isConfigSupported(config) {
		return { supported: config.codec.startsWith("vp09"), config };
	}

	constructor({ output, error }) {
		this.output = output;
		this.error = error;
		this.encodeQueueSize = 0;
		this.state = "unconfigured";
	}

	configure(config) {
		this.config = config;
		this.state = "configured";
	}

	encode(frame, options) {
		const byte = Math.round(frame.timestamp / frame.duration) & 0xff;
		this.output({
			byteLength: 1,
			timestamp: frame.timestamp,
			type: options.keyFrame ? "key" : "delta",
			copyTo(destination) { destination[0] = byte; },
		});
	}

	async flush() {}

	close() {
		this.state = "closed";
	}
}

const range = normalizeFrameRange(10, 153);
assert.deepEqual(range, { startFrame: 10, endFrame: 153, frameCount: 144 });
assert.throws(() => normalizeFrameRange(5, 4), /inclusive non-negative range/);

async function run() {
	const addressed = [];
	const result = await exportOffscreenVideo({
		startFrame: 10,
		endFrame: 153,
		fps: 24,
		width: 2,
		height: 2,
		capture(frame) {
			addressed.push(frame);
			return Uint8Array.from({ length: 16 }, (_, index) => (frame * 17 + index * 3) & 0xff);
		},
		VideoEncoderClass: FakeVideoEncoder,
		VideoFrameClass: FakeVideoFrame,
	});
	return { addressed, result };
}

const first = await run();
const second = await run();
assert.equal(first.result.frameCount, 144);
assert.equal(first.result.encodedFrameCount, 144);
assert.equal(first.addressed.length, 144);
assert.equal(first.addressed[0], 10);
assert.equal(first.addressed.at(-1), 153);
assert.deepEqual(first.result.hashes, second.result.hashes);
assert.equal(first.result.blob.type, "video/webm");
assert.ok(first.result.blob.size > 144, "muxed WebM should contain the encoded frames and headers");

const bytes = new Uint8Array(await first.result.blob.arrayBuffer());
assert.deepEqual([...bytes.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
assert.ok(new TextDecoder().decode(bytes).includes("V_VP9"));

console.log("PASS 6-second range addresses and encodes exactly 144 frames");
console.log("PASS two exports have identical per-frame SHA-256 pixel hashes");
console.log("PASS WebCodecs chunks are muxed into a WebM container");
