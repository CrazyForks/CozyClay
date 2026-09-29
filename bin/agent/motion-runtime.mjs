// Stream decoding retained for the legacy MCP bridge client. Studio motion
// jobs run exclusively in the editor command bus; this module owns no jobs.
import { StudioProtocolError } from "../../src/studio-agent-protocol.js";

const motionUrlPattern = /^\/(ardy\/motions\/[0-9]+-[0-9a-f]{6}|ardy\/assembled\/[A-Za-z0-9._-]+\.npz)$/;
const error = (code, message) => new StudioProtocolError(code, message);
const MAX_RECORD_BYTES = 64 * 1024;

/** EOF is a record boundary, not a success signal. */
export function extractNdjsonRecords(buffer, { final = false } = {}) {
	if (typeof buffer !== "string") throw new TypeError("NDJSON buffer must be a string");
	const lines = buffer.split("\n");
	const remainder = final ? "" : lines.pop();
	const records = [];
	for (const line of lines) {
		if (Buffer.byteLength(line) > MAX_RECORD_BYTES) throw error("BACKEND_UNAVAILABLE", "Bridge record exceeds limit");
		if (line.trim()) {
			try { records.push(JSON.parse(line)); }
			catch { throw error("BACKEND_UNAVAILABLE", final ? "Malformed final NDJSON record" : "Malformed NDJSON record"); }
		}
	}
	if (Buffer.byteLength(remainder) > MAX_RECORD_BYTES) throw error("BACKEND_UNAVAILABLE", "Bridge record exceeds limit");
	return { records, remainder };
}
async function refusalReason(response) {
	if (!response.body) return null;
	let body = "";
	try {
		const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0;
		try {
			while (bytes < 64 * 1024) {
				const chunk = await reader.read(); if (chunk.done) break;
				const part = chunk.value.subarray(0, 64 * 1024 - bytes); bytes += part.byteLength; body += decoder.decode(part, { stream: bytes < 64 * 1024 });
				if (part.byteLength < chunk.value.byteLength) break;
			}
		} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
	} catch { return null; }
	try {
		const value = JSON.parse(body);
		for (const key of ["reason", "error", "message"]) if (typeof value?.[key] === "string" && value[key].trim()) return value[key].trim();
	} catch {}
	return null;
}
export async function readMotionStream(response, { onProgress = () => {} } = {}) {
	if (!response.ok || !response.body) {
		const reason = response.ok ? null : await refusalReason(response);
		if (response.status === 400) throw error("INVALID_ARGUMENT", `Bridge refused the request${reason ? `: ${reason}` : ""}`);
		throw error("BACKEND_UNAVAILABLE", `Generation refused (HTTP ${response.status})${reason ? `: ${reason}` : ""}`);
	}
	const reader = response.body.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true });
	let buffer = "", motionUrl = null, finished = false;
	try {
		for (;;) {
			const chunk = await reader.read();
			buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
			const parsed = extractNdjsonRecords(buffer, { final: chunk.done }); buffer = parsed.remainder;
			for (const record of parsed.records) {
				if (!record || typeof record !== "object" || typeof record.event !== "string") throw error("BACKEND_UNAVAILABLE", "Invalid bridge record");
				if (record.event === "error") {
					const detail = [record.message, record.reason, record.error].find(value => typeof value === "string" && value.trim());
					throw error("BACKEND_UNAVAILABLE", `Generator reported an error${detail ? `: ${detail.trim()}` : ""}`);
				}
				if (record.event === "done") {
					if (typeof record.motionUrl !== "string" || !motionUrlPattern.test(record.motionUrl)) throw error("BACKEND_UNAVAILABLE", "Generator returned an invalid motion URL");
					if (motionUrl && motionUrl !== record.motionUrl) throw error("BACKEND_UNAVAILABLE", "Conflicting final artifacts");
					motionUrl = record.motionUrl;
				} else if (Number.isFinite(record.progress)) onProgress(record.progress);
			}
			if (chunk.done) { finished = true; break; }
		}
		if (!motionUrl) throw error("BACKEND_UNAVAILABLE", "Generation ended without a motion");
		return motionUrl;
	} finally {
		try { if (!finished) await reader.cancel(); } finally { reader.releaseLock(); }
	}
}
