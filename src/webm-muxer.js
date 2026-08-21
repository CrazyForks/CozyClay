const textEncoder = new TextEncoder();

const IDS = Object.freeze({
	EBML: 0x1a45dfa3,
	EBML_VERSION: 0x4286,
	EBML_READ_VERSION: 0x42f7,
	EBML_MAX_ID_LENGTH: 0x42f2,
	EBML_MAX_SIZE_LENGTH: 0x42f3,
	DOC_TYPE: 0x4282,
	DOC_TYPE_VERSION: 0x4287,
	DOC_TYPE_READ_VERSION: 0x4285,
	SEGMENT: 0x18538067,
	INFO: 0x1549a966,
	TIMECODE_SCALE: 0x2ad7b1,
	DURATION: 0x4489,
	MUXING_APP: 0x4d80,
	WRITING_APP: 0x5741,
	TRACKS: 0x1654ae6b,
	TRACK_ENTRY: 0xae,
	TRACK_NUMBER: 0xd7,
	TRACK_UID: 0x73c5,
	TRACK_TYPE: 0x83,
	FLAG_LACING: 0x9c,
	CODEC_ID: 0x86,
	DEFAULT_DURATION: 0x23e383,
	VIDEO: 0xe0,
	PIXEL_WIDTH: 0xb0,
	PIXEL_HEIGHT: 0xba,
	CLUSTER: 0x1f43b675,
	TIMECODE: 0xe7,
	SIMPLE_BLOCK: 0xa3,
});

function concat(parts) {
	const length = parts.reduce((total, part) => total + part.length, 0);
	const output = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.length;
	}
	return output;
}

function idBytes(id) {
	let bytes = 1;
	while (id >= 2 ** (bytes * 8) && bytes < 4) bytes += 1;
	const output = new Uint8Array(bytes);
	for (let index = bytes - 1, value = id; index >= 0; index -= 1) {
		output[index] = value & 0xff;
		value = Math.floor(value / 256);
	}
	return output;
}

function sizeBytes(value) {
	if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("invalid EBML element size");
	for (let length = 1; length <= 8; length += 1) {
		const maximum = 2 ** (7 * length) - 2;
		if (value > maximum) continue;
		const output = new Uint8Array(length);
		let remaining = value;
		for (let index = length - 1; index >= 0; index -= 1) {
			output[index] = remaining & 0xff;
			remaining = Math.floor(remaining / 256);
		}
		output[0] |= 1 << (8 - length);
		return output;
	}
	throw new RangeError("EBML element is too large");
}

function uint(value) {
	if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("invalid EBML unsigned integer");
	let length = 1;
	while (value >= 2 ** (length * 8) && length < 8) length += 1;
	const output = new Uint8Array(length);
	let remaining = value;
	for (let index = length - 1; index >= 0; index -= 1) {
		output[index] = remaining & 0xff;
		remaining = Math.floor(remaining / 256);
	}
	return output;
}

function float64(value) {
	const output = new Uint8Array(8);
	new DataView(output.buffer).setFloat64(0, value, false);
	return output;
}

function element(id, data) {
	const body = data instanceof Uint8Array ? data : concat(data);
	return concat([idBytes(id), sizeBytes(body.length), body]);
}

function simpleBlock(chunk, clusterTimecodeMs) {
	const relative = Math.round(chunk.timestamp / 1000) - clusterTimecodeMs;
	if (relative < -32768 || relative > 32767) throw new RangeError("WebM cluster timecode overflow");
	const header = new Uint8Array(4);
	header[0] = 0x81;
	new DataView(header.buffer).setInt16(1, relative, false);
	header[3] = chunk.type === "key" ? 0x80 : 0;
	return element(IDS.SIMPLE_BLOCK, [header, chunk.data]);
}

function clusters(chunks) {
	const output = [];
	let body = [];
	let clusterTimecodeMs = 0;
	const flush = () => {
		if (!body.length) return;
		output.push(element(IDS.CLUSTER, [element(IDS.TIMECODE, uint(clusterTimecodeMs)), ...body]));
		body = [];
	};
	for (const chunk of chunks) {
		const timestampMs = Math.round(chunk.timestamp / 1000);
		if (!body.length) clusterTimecodeMs = timestampMs;
		if (timestampMs - clusterTimecodeMs > 30_000) {
			flush();
			clusterTimecodeMs = timestampMs;
		}
		body.push(simpleBlock(chunk, clusterTimecodeMs));
	}
	flush();
	return output;
}

/** Package ordered VP8/VP9 WebCodecs chunks into a seekable-duration WebM. */
export function muxWebM({ chunks, width, height, fps, codec }) {
	if (!Array.isArray(chunks) || chunks.length < 1) throw new RangeError("WebM needs at least one encoded frame");
	if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) throw new RangeError("invalid WebM dimensions");
	if (!Number.isFinite(fps) || fps <= 0) throw new RangeError("invalid WebM frame rate");
	const codecId = codec.startsWith("vp09") ? "V_VP9" : codec.startsWith("vp8") ? "V_VP8" : null;
	if (!codecId) throw new RangeError(`unsupported WebM codec: ${codec}`);
	const ordered = [...chunks].sort((a, b) => a.timestamp - b.timestamp);
	const durationMs = (ordered.length * 1000) / fps;
	const app = textEncoder.encode("CozyClay offscreen export");
	const header = element(IDS.EBML, [
		element(IDS.EBML_VERSION, uint(1)),
		element(IDS.EBML_READ_VERSION, uint(1)),
		element(IDS.EBML_MAX_ID_LENGTH, uint(4)),
		element(IDS.EBML_MAX_SIZE_LENGTH, uint(8)),
		element(IDS.DOC_TYPE, textEncoder.encode("webm")),
		element(IDS.DOC_TYPE_VERSION, uint(4)),
		element(IDS.DOC_TYPE_READ_VERSION, uint(2)),
	]);
	const info = element(IDS.INFO, [
		element(IDS.TIMECODE_SCALE, uint(1_000_000)),
		element(IDS.DURATION, float64(durationMs)),
		element(IDS.MUXING_APP, app),
		element(IDS.WRITING_APP, app),
	]);
	const video = element(IDS.VIDEO, [
		element(IDS.PIXEL_WIDTH, uint(width)),
		element(IDS.PIXEL_HEIGHT, uint(height)),
	]);
	const tracks = element(IDS.TRACKS, element(IDS.TRACK_ENTRY, [
		element(IDS.TRACK_NUMBER, uint(1)),
		element(IDS.TRACK_UID, uint(1)),
		element(IDS.TRACK_TYPE, uint(1)),
		element(IDS.FLAG_LACING, uint(0)),
		element(IDS.CODEC_ID, textEncoder.encode(codecId)),
		element(IDS.DEFAULT_DURATION, uint(Math.round(1_000_000_000 / fps))),
		video,
	]));
	const unknownSegmentSize = new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
	return new Blob([
		header,
		idBytes(IDS.SEGMENT),
		unknownSegmentSize,
		info,
		tracks,
		...clusters(ordered),
	], { type: "video/webm" });
}
