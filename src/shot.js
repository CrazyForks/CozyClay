// Pure math + string assembly. No three.js, no React.
// This file is the entire "brain" of a blocking tool: it turns 3D geometry
// into film vocabulary, then turns film vocabulary into a prompt.

export const SUBJECT_HEIGHT_M = 1.8;

// Framing distance is measured to the subject's centre of mass, not to the
// midpoint of their bounding box. A camera craned to the floor is still close
// to the body it is pointing at, and only this pivot reports that honestly.
export const FRAMING_PIVOT_Y = 1.3;
const SENSOR_HALF_HEIGHT_MM = 12; // Blender/full-frame default 24mm sensor height

/** vertical FOV (radians) -> focal length in mm on a 24mm-tall sensor */
export function fovToFocalMm(fovRad) {
	return SENSOR_HALF_HEIGHT_MM / Math.tan(fovRad / 2);
}

/** focal length in mm -> vertical FOV in radians */
export function focalMmToFov(mm) {
	return 2 * Math.atan(SENSOR_HALF_HEIGHT_MM / mm);
}

// A crew does not carry a 47 mm lens. Reporting the nearest prime from a real
// set is both more honest and more useful to an image model, which has seen far
// more captions saying "35mm" than "47mm".
export const PRIME_SET = [14, 18, 24, 28, 35, 50, 85, 100, 135];

export function nearestPrime(fovRad) {
	const exact = fovToFocalMm(fovRad);
	return PRIME_SET.reduce((best, mm) => (Math.abs(mm - exact) < Math.abs(best - exact) ? mm : best));
}

// screenFraction = subject height / visible frame height at the subject.
// 1.0 means the figure exactly fills the frame top to bottom.
const SIZE_TABLE = [
	[2.8, "extreme close-up", "ultra-realistic skin texture with visible pores and micro-detail, tack-sharp eyes, shallow depth of field"],
	[1.6, "close-up", "ultra-realistic skin texture and fine facial detail, soft background blur, shallow depth of field"],
	[1.15, "medium close-up", "natural skin and fabric texture, clear facial detail, shallow depth of field"],
	[0.8, "medium shot", "balanced detail on the subject and the surrounding space, moderate depth of field"],
	[0.52, "medium-wide shot", "the full figure with the environment clearly visible, deep focus"],
	[0.3, "wide shot", "full body in a richly detailed environment, deep focus"],
	[0, "extreme wide shot", "a small figure within a vast, highly detailed environment, epic sense of scale, deep focus"],
];

// A crew names the level by where the lens physically sits, not by the angle it
// subtends: "put it at hip level" is an instruction, "-27 degrees" is not.
// Thresholds are camera height above the floor, in metres.
const LEVEL_TABLE = [
	[2.5, "overhead", "a directly overhead bird's-eye view looking down at the subject"],
	[1.8, "high angle", "a high angle looking down at the subject"],
	[1.5, "eye level", "eye level"],
	[1.25, "chest level", "chest level"],
	[0.95, "hip level", "a low hip-level angle"],
	[0.45, "knee level", "a low knee-level angle looking up at the subject"],
	[Number.NEGATIVE_INFINITY, "ground level", "a dramatic ground-level angle looking up at the subject"],
];

const pick = (table, value) => table.find(([threshold]) => value >= threshold) ?? table[table.length - 1];

/**
 * Derive film vocabulary from raw scene geometry.
 * @param {{x:number,y:number,z:number}} cameraPos    camera world position (metres)
 * @param {{x:number,z:number,rot:number}} subject     subject ground position + facing in degrees
 * @param {number} fovRad                              vertical field of view
 * @param {number} height                              subject height in metres
 */
export function deriveShot(cameraPos, subject, fovRad, height = SUBJECT_HEIGHT_M) {
	const dx = cameraPos.x - subject.x;
	const dz = cameraPos.z - subject.z;
	const dy = cameraPos.y - FRAMING_PIVOT_Y;
	const horizontal = Math.hypot(dx, dz);
	const distance = Math.max(Math.hypot(horizontal, dy), 1e-6);

	// how much of the frame height the subject occupies
	const screenFraction = height / (2 * distance * Math.tan(fovRad / 2));
	const [, sizeLabel, sizeContext] = pick(SIZE_TABLE, screenFraction);

	// Level is simply how high off the floor the lens rides.
	const [, levelLabel, levelPhrase] = pick(LEVEL_TABLE, cameraPos.y);
	const elevationDeg = (Math.atan2(cameraPos.y - height * 0.94, Math.max(horizontal, 1e-6)) * 180) / Math.PI;

	// Which side of the subject the camera sits on. The sign of the cross product
	// tells us camera-right from camera-left, which the phrasing needs.
	const facingRad = (subject.rot * Math.PI) / 180;
	const facing = { x: Math.sin(facingRad), z: Math.cos(facingRad) };
	const toCamera = { x: dx / Math.max(horizontal, 1e-6), z: dz / Math.max(horizontal, 1e-6) };
	const alignment = facing.x * toCamera.x + facing.z * toCamera.z;
	const side = facing.x * toCamera.z - facing.z * toCamera.x >= 0 ? "right" : "left";
	const initial = side === "right" ? "R" : "L";

	let viewShort;
	let viewPhrase;
	if (alignment > 0.85) {
		viewShort = "front";
		viewPhrase = "seen from the front, the face toward the camera";
	} else if (alignment < -0.85) {
		viewShort = "back";
		viewPhrase = "seen from directly behind, the back of the head toward the camera";
	} else if (alignment > 0.34) {
		viewShort = `front ¾ ${initial}`;
		viewPhrase = `a three-quarter front view from the ${side}`;
	} else if (alignment < -0.34) {
		viewShort = `rear ¾ ${initial}`;
		viewPhrase = `a three-quarter rear view from the ${side}`;
	} else {
		viewShort = `${side} profile`;
		viewPhrase = `a ${side}-side profile view`;
	}

	return {
		sizeLabel,
		sizeContext,
		levelLabel,
		levelPhrase,
		viewShort,
		viewPhrase,
		focalMm: nearestPrime(fovRad),
		exactFocalMm: fovToFocalMm(fovRad),
		distance,
		screenFraction,
		elevationDeg,
	};
}

/** the burned-in slate line, e.g. "MEDIUM SHOT · FRONT · EYE LEVEL · 45MM" */
export function slateLine(shot) {
	return [shot.sizeLabel, shot.viewShort, shot.levelLabel, `${shot.focalMm}mm`]
		.map((part) => part.toUpperCase())
		.join(" · ");
}

// `numericLens` models respond to an explicit aperture; `audio` models accept a
// sound instruction that would be dead weight in a silent image prompt.
export const IMAGE_MODELS = [
	{ id: "nano_banana_pro", label: "Nano Banana Pro" },
	{ id: "nano_banana_2", label: "Nano Banana 2" },
	{ id: "gpt_image_2", label: "GPT Image 2" },
	{ id: "seedream_5", label: "Seedream 5.0" },
	{ id: "flux_2", label: "Flux 2", numericLens: true, flavor: "fine film grain, high micro-detail" },
];

export const VIDEO_MODELS = [
	{ id: "seedance_2", label: "Seedance 2.0", flavor: "one continuous shot", bridge: { provider: "runway", model: "seedance2" } },
	{ id: "kling_3", label: "Kling 3.0", flavor: "one continuous shot", bridge: null },
	{ id: "veo_3_1", label: "Veo 3.1", audio: true, bridge: { provider: "runway", model: "veo3.1" } },
	{ id: "wan_2_7", label: "Wan 2.7" },
	{ id: "hailuo", label: "Minimax Hailuo", flavor: "natural physics and subtle facial emotion" },
	{ id: "grok_1_5", label: "Grok Imagine 1.5" },
];

export function bridgeModelForUiId(id) {
	return VIDEO_MODELS.find((model) => model.id === id)?.bridge ?? null;
}

export const CUSTOM_MOVE = "Custom…";

export const CAMERA_MOVES = [
	"Static / locked-off",
	"Push-in (dolly in)",
	"Pull-out (dolly out)",
	"Pan left",
	"Pan right",
	"Tilt up",
	"Tilt down",
	"Tracking / follow",
	"Orbit / arc",
	"Crane up",
	"Crane down",
	"Handheld",
	"Crash zoom in",
	"Dolly-zoom (vertigo)",
	"Whip pan",
	"Aerial / drone",
	CUSTOM_MOVE,
];

/**
 * Assemble the final prompt.
 *
 * The whole trick of a blocking tool is this paragraph. The attached frame is
 * geometrically correct but visually worthless — grey clay in a grey box — so
 * the prompt has to claim the geometry and disown the appearance in the same
 * breath. Anything vaguer and the model paints grey mannequins.
 */
export function composePrompt({
	mode = "image",
	model,
	shot,
	subject,
	subject2 = null,
	posePhrase = "",
	pose2Phrase = "",
	environment,
	style,
	cameraMove = CAMERA_MOVES[0],
	customMove = "",
	hasCharSheet = false,
	hasEnvSheet = false,
}) {
	// a numeric-lens model wants glass it can reason about; the rest want the word
	const lens = model?.numericLens ? `${shot.focalMm}mm lens at f/2.2` : `${shot.focalMm}mm lens`;

	const opening =
		mode === "video"
			? `Cinematic ${shot.sizeLabel} at ${lens}, ${shot.levelPhrase}, ${shot.viewPhrase}.`
			: `Photorealistic cinematic film still, ${shot.sizeLabel} at ${lens}, ${shot.levelPhrase}, ${shot.viewPhrase}.`;

	const withPose = (who, phrase) => (phrase ? `${who}, ${phrase}` : who);

	let cast;
	if (hasCharSheet) {
		cast = subject2
			? "Both subjects are the characters from the attached character sheet. Each one exactly matches their own body pose and placement shown in the blocking frame."
			: "The subject is the character from the attached character sheet, exactly matching the body pose and placement shown in the blocking frame.";
	} else if (subject2) {
		cast = `Two subjects. Subject 1: ${withPose(subject, posePhrase)}. Subject 2: ${withPose(subject2, pose2Phrase)}. Each subject exactly matches their own body pose and placement shown in the blocking frame.`;
	} else {
		cast = `Subject: ${withPose(subject, posePhrase)}, exactly matching the body pose and placement shown in the blocking frame.`;
	}

	const place = hasEnvSheet
		? "The setting is the location from the attached environment sheet."
		: `Environment: ${environment}.`;

	const move = cameraMove === CUSTOM_MOVE ? customMove.trim() || "static, locked-off shot" : cameraMove.toLowerCase();

	const guide =
		"Use the attached blocking frame ONLY as a camera and staging guide — it fixes the exact framing, this camera angle, the lens, and the subject placement. Replace the entire setting with the described environment and render real people; do NOT reproduce its grey mannequins, grey box set, or flat lighting.";

	const parts = [
		opening,
		cast,
		place,
		`${style}, ${shot.sizeContext}.`,
		mode === "video" ? `Camera move: ${move}.` : null,
		guide,
		model?.flavor ?? null,
		mode === "video" && (model?.audio || model?.capabilities?.audio) ? "Include natural ambient sound." : null,
		"16:9.",
	];

	return parts.filter(Boolean).join(" ");
}
