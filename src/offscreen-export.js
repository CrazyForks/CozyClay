import { muxWebM } from "./webm-muxer.js";

const CODECS = Object.freeze(["vp09.00.10.08", "vp8"]);

export function normalizeFrameRange(startFrame, endFrame) {
	const start = Math.round(startFrame);
	const end = Math.round(endFrame);
	if (!Number.isFinite(startFrame) || !Number.isFinite(endFrame) || start < 0 || end < start) {
		throw new RangeError("export frame range must be an inclusive non-negative range");
	}
	return { startFrame: start, endFrame: end, frameCount: end - start + 1 };
}

export async function pixelHash(pixels, subtle = globalThis.crypto?.subtle) {
	if (!subtle) throw new Error("Web Crypto is unavailable; pixel hashes cannot be computed");
	const digest = new Uint8Array(await subtle.digest("SHA-256", pixels));
	return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function flipRows(source, destination, width, height) {
	const stride = width * 4;
	for (let row = 0; row < height; row += 1) {
		const from = (height - 1 - row) * stride;
		destination.set(source.subarray(from, from + stride), row * stride);
	}
}

async function supportedEncoderConfig(width, height, fps, VideoEncoderClass) {
	for (const codec of CODECS) {
		const config = {
			codec,
			width,
			height,
			framerate: fps,
			bitrate: Math.max(2_000_000, Math.round(width * height * fps * 0.24)),
			latencyMode: "quality",
		};
		try {
			const support = await VideoEncoderClass.isConfigSupported(config);
			if (support.supported) return support.config;
		} catch {
			// Try the next WebM codec. A browser can expose WebCodecs while a
			// particular hardware/software encoder is unavailable.
		}
	}
	throw new Error("This browser has no VP9/VP8 WebCodecs encoder");
}

function abortError() {
	return new DOMException("Offscreen export was cancelled", "AbortError");
}

/**
 * Address and encode every frame in an inclusive range. `capture(frame)` must
 * synchronously apply that absolute frame and return bottom-up RGBA bytes from
 * the offscreen WebGL render target. No playback or animation clock is used.
 */
export async function exportOffscreenVideo({
	startFrame,
	endFrame,
	fps,
	width,
	height,
	capture,
	signal,
	onFrame,
	VideoEncoderClass = globalThis.VideoEncoder,
	VideoFrameClass = globalThis.VideoFrame,
}) {
	const range = normalizeFrameRange(startFrame, endFrame);
	if (!Number.isFinite(fps) || fps <= 0) throw new RangeError("export fps must be positive");
	if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) throw new RangeError("invalid export dimensions");
	if (typeof capture !== "function") throw new TypeError("export capture must be a function");
	if (!VideoEncoderClass || !VideoFrameClass) throw new Error("This browser does not support WebCodecs video export");

	const config = await supportedEncoderConfig(width, height, fps, VideoEncoderClass);
	const chunks = [];
	const hashes = [];
	let encoderError = null;
	const encoder = new VideoEncoderClass({
		output(chunk) {
			const data = new Uint8Array(chunk.byteLength);
			chunk.copyTo(data);
			chunks.push({ timestamp: chunk.timestamp, type: chunk.type, data });
		},
		error(error) {
			encoderError = error;
		},
	});
	const topDown = new Uint8ClampedArray(width * height * 4);
	const frameDurationUs = 1_000_000 / fps;
	const keyInterval = Math.max(1, Math.round(fps * 2));

	try {
		encoder.configure(config);
		for (let index = 0; index < range.frameCount; index += 1) {
			if (signal?.aborted) throw abortError();
			const frame = range.startFrame + index;
			const pixels = capture(frame);
			if (!(pixels instanceof Uint8Array) || pixels.byteLength !== topDown.byteLength) {
				throw new Error(`frame ${frame} returned ${pixels?.byteLength ?? 0} RGBA bytes; expected ${topDown.byteLength}`);
			}
			const hash = await pixelHash(pixels);
			hashes.push(hash);
			flipRows(pixels, topDown, width, height);
			const videoFrame = new VideoFrameClass(topDown, {
				format: "RGBA",
				codedWidth: width,
				codedHeight: height,
				timestamp: Math.round(index * frameDurationUs),
				duration: Math.round(frameDurationUs),
			});
			try {
				encoder.encode(videoFrame, { keyFrame: index % keyInterval === 0 });
			} finally {
				videoFrame.close();
			}
			if (encoderError) throw encoderError;
			if (encoder.encodeQueueSize > 4) await encoder.flush();
			onFrame?.({ frame, index, frameCount: range.frameCount, hash });
		}
		await encoder.flush();
		if (encoderError) throw encoderError;
	} catch (error) {
		if (encoder.state !== "closed") encoder.close();
		throw error;
	}
	encoder.close();

	if (chunks.length !== range.frameCount) {
		throw new Error(`WebCodecs emitted ${chunks.length} frames for ${range.frameCount} inputs`);
	}
	const blob = muxWebM({ chunks, width, height, fps, codec: config.codec });
	return {
		...range,
		fps,
		width,
		height,
		codec: config.codec,
		mimeType: blob.type,
		encodedFrameCount: chunks.length,
		hashes,
		blob,
	};
}
