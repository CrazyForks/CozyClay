import { PROMPT_MAX_CHARS } from "../../../tools/ardy/prompt-limits.mjs";

const TRAILING_PUNCTUATION = /[.!?,;:。！？，、；：]+$/u;

/** Normalize only for deduplication; the original prompt is retained for display. */
export function normalizePrompt(value) {
  if (typeof value !== "string") return "";
  let normalized = value.trim().toLocaleLowerCase();
  normalized = normalized.replace(/\s+/gu, " ");
  while (TRAILING_PUNCTUATION.test(normalized)) {
    normalized = normalized.replace(TRAILING_PUNCTUATION, "").trim();
  }
  return normalized;
}

export async function promptHash(value) {
  const normalized = normalizePrompt(value);
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Return null for a valid prompt, otherwise a stable human-readable error. */
export function validatePrompt(value) {
  if (typeof value !== "string") return "field 'prompt' must be a non-empty string";
  if (value.trim().length === 0) return "field 'prompt' must be a non-empty string";
  if (value.length > PROMPT_MAX_CHARS) {
    return `field 'prompt' is ${value.length} chars; the cap is ${PROMPT_MAX_CHARS}`;
  }
  return null;
}

export { PROMPT_MAX_CHARS };
