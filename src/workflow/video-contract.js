export const COMFY_VIDEO_ASPECTS = Object.freeze(["16:9", "9:16", "1:1", "21:9", "12:7"]);
export const FAL_VIDEO_ASPECTS = Object.freeze(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);

export function videoFormContract(provider = "comfy") {
	if (provider === "fal") return { aspects: FAL_VIDEO_ASPECTS, minDuration: 2, maxDuration: 12, defaultAspect: "16:9", defaultDuration: 5 };
	return { aspects: COMFY_VIDEO_ASPECTS, minDuration: 1, maxDuration: 15, defaultAspect: "16:9", defaultDuration: 5 };
}

export function normalizeVideoForm(provider, values = {}) {
	const contract = videoFormContract(provider);
	const duration = Number(values.duration_seconds);
	const aspect = typeof values.aspect === "string" && contract.aspects.includes(values.aspect) ? values.aspect : contract.defaultAspect;
	return {
		...values,
		aspect,
		duration_seconds: Number.isFinite(duration) ? Math.min(contract.maxDuration, Math.max(contract.minDuration, duration)) : contract.defaultDuration,
	};
}
