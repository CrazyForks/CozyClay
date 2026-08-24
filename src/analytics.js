const OPT_OUT_KEY = "cozyclay.analyticsOptOut";
const ACTIVATION_KEY = "cozyclay.analyticsActivation";
const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
	"https://cozyclay.org",
	"https://www.cozyclay.org",
]);
const EVENT_PROPERTIES = Object.freeze({
	"scene:created": ["scene_source"],
	"scene:loaded": ["scene_source"],
	"craft:first_action": ["action_kind"],
	"motion:job_started": ["input_mode"],
	"motion:job_succeeded": ["latency_bucket", "input_mode"],
	"motion:job_failed": ["latency_bucket", "input_mode", "error_code"],
	"export:blocking_frame_succeeded": ["format"],
	"activation:completed": ["activation_path"],
});
const DENIED_PROPERTY_KEYS = new Set(["prompt", "text", "name", "url", "path", "file"]);

let posthog = null;
let initialized = false;
let enabled = false;
let initPromise = null;
let activationFired = false;
let disabledLogged = false;

function storage() {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

function readStorage(key) {
	try {
		return storage()?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

function writeStorage(key, value) {
	try {
		storage()?.setItem(key, value);
	} catch {
		// Analytics persistence is best effort and must never affect the app.
	}
}

export function normalizeOrigin(value) {
	if (typeof value !== "string") return "";
	return value.trim().toLowerCase().replace(/[/.]+$/g, "");
}

export function parseAllowlist(value) {
	if (value === undefined) return [...DEFAULT_ALLOWED_ORIGINS];
	return value
		.split(",")
		.map(normalizeOrigin)
		.filter(Boolean);
}

export function isOriginAllowed(origin, allowlist) {
	const normalizedOrigin = normalizeOrigin(origin);
	return Array.isArray(allowlist)
		&& allowlist.some((allowed) => normalizedOrigin === normalizeOrigin(allowed));
}

const isSafePropertyValue = (value) => {
	if (typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	return typeof value === "string" && value.length <= 32 && !/\s/.test(value);
};

export function sanitizeProps(event, props) {
	const allowedKeys = EVENT_PROPERTIES[event] ?? [];
	if (!props || typeof props !== "object" || Array.isArray(props)) return {};
	const sanitized = {};
	for (const key of allowedKeys) {
		if (DENIED_PROPERTY_KEYS.has(key) || !Object.hasOwn(props, key)) continue;
		if (isSafePropertyValue(props[key])) sanitized[key] = props[key];
	}
	return sanitized;
}

export function bucketMs(ms) {
	if (!Number.isFinite(ms) || ms < 1000) return "lt1s";
	if (ms < 3000) return "1-3s";
	if (ms < 10000) return "3-10s";
	if (ms < 30000) return "10-30s";
	return "gte30s";
}

export function shouldFireActivation(state) {
	return state?.activationTracked !== true;
}

export function getAnalyticsOptOut() {
	return readStorage(OPT_OUT_KEY) === "1";
}

export function setAnalyticsOptOut(optOut) {
	const value = optOut === true;
	writeStorage(OPT_OUT_KEY, value ? "1" : "0");
	if (!posthog) return;
	try {
		if (value) {
			enabled = false;
			posthog.opt_out_capturing();
		} else {
			posthog.opt_in_capturing();
			enabled = initialized;
		}
	} catch {
		enabled = false;
		// SDK opt-in/out is best effort.
	}
}

function environment() {
	return import.meta.env ?? {};
}

function disabledReason(env) {
	if (!env.PROD) return "not production";
	if (!env.VITE_POSTHOG_KEY) return "no key";
	const origin = normalizeOrigin(globalThis.location?.origin);
	if (!isOriginAllowed(origin, parseAllowlist(env.VITE_POSTHOG_ALLOWED_ORIGINS))) {
		return "unapproved origin";
	}
	if (getAnalyticsOptOut()) return "opted out";
	return null;
}

export async function initAnalytics() {
	if (initialized || initPromise) return initPromise;
	const env = environment();
	const reason = disabledReason(env);
	if (reason) {
		if (!disabledLogged) {
			console.info("[analytics] disabled: " + reason);
			disabledLogged = true;
		}
		return undefined;
	}

	initPromise = (async () => {
		try {
			const module = await import("posthog-js");
			if (getAnalyticsOptOut()) return;
			posthog = module.default ?? module;
			posthog.init(env.VITE_POSTHOG_KEY, {
				api_host: env.VITE_POSTHOG_HOST || "https://us.i.posthog.com",
				defaults: "2025-05-24",
				autocapture: false,
				capture_pageview: true,
				// Keep the wire contract at the nine disclosed events: no $pageleave.
				capture_pageleave: false,
				person_profiles: "never",
				persistence: "memory",
				respect_dnt: true,
				disable_session_recording: true,
			});
			initialized = true;
			enabled = true;
			// Test hook, mirroring the window.__cozyclay convention: lets QA
			// drivers inspect the live SDK without shipping a real global API.
			globalThis.__cozyclayAnalytics = { instance: posthog };
		} catch {
			console.info("[analytics] initialization failed");
		}
	})();
	await initPromise;
}

export function track(event, props = {}) {
	if (!initialized || !enabled || !posthog) return;
	try {
		posthog.capture(event, sanitizeProps(event, props));
	} catch {
		// Analytics must never affect app behavior.
	}
}

export function trackActivation(path) {
	if (!initialized || !enabled || activationFired) return;
	const tracked = readStorage(ACTIVATION_KEY) === "1";
	if (!shouldFireActivation({ activationTracked: tracked })) {
		activationFired = true;
		return;
	}
	activationFired = true;
	writeStorage(ACTIVATION_KEY, "1");
	track("activation:completed", { activation_path: path });
}
