import { PROMPT_MAX_CHARS as SHARED_PROMPT_MAX_CHARS } from "../tools/ardy/prompt-limits.mjs";

// Hosted-demo build configuration.
// Production builds use the API origin below and require VITE_TURNSTILE_SITE_KEY
// to be set to the public key paired with the Worker secret. Local builds can
// override both values with the API's development origin and the official
// always-pass site key documented in workers/api/.dev.vars.example.
const configuredApiBase = import.meta.env?.VITE_DEMO_API_BASE;
const configuredTurnstileSiteKey = import.meta.env?.VITE_TURNSTILE_SITE_KEY;
const injectedPromptMaxChars = import.meta.env?.VITE_DEMO_PROMPT_MAX_CHARS;

function promptLimitFromBuild(value) {
  if (value === undefined) return SHARED_PROMPT_MAX_CHARS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed !== SHARED_PROMPT_MAX_CHARS) {
    throw new Error("The demo prompt cap must match the shared API prompt limit");
  }
  return parsed;
}

export const API_BASE = (typeof configuredApiBase === "string" && configuredApiBase.trim()
  ? configuredApiBase.trim()
  : "https://api.cozyclay.org").replace(/\/+$/u, "");
export const TURNSTILE_SITE_KEY = typeof configuredTurnstileSiteKey === "string"
  ? configuredTurnstileSiteKey.trim()
  : "";
export const configuredPromptLimit = promptLimitFromBuild(injectedPromptMaxChars);

// Preview lock: while true, the composer renders but every action (sign-in,
// submit) only shows a "not available yet" notice and no API call is made.
// Flip to false when the hosted demo goes public.
export const DEMO_DISABLED = true;
