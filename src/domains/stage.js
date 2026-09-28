import { useState } from "react";
import { DEFAULT_SENSOR_FORMAT } from "../shot.js";
import { DEFAULT_ENVIRONMENT } from "../app-stage.jsx";
import { createKeyLight } from "../scenes.js";

export function useStage(appContext) {
	const [preset, setPreset] = useState("medium");

	const [shotAspectKey, setShotAspectKey] = useState(appContext.shared.startupStage.shotAspect);

	// The set's look reference (#167): one picture that says what this location
	// is made of. Persisted on the stage envelope exactly like shotAspect, and
	// attached to every framing capture so the generator sees it.
	const [environmentImage, setEnvironmentImage] = useState(appContext.shared.startupStage.environmentImage ?? null);

	// Which named camera framing the shot camera currently stands in, or null
	// after any manual placement. Recorded on the scene so a take says how it
	// was framed; it is a label, not a constraint — nothing re-applies it.
	const [cameraPresetId, setCameraPresetId] = useState(appContext.shared.startupStage.cameraPresetId ?? null);

	const [sensorId, setSensorFormat] = useState(appContext.shared.startupStage.sensorId ?? DEFAULT_SENSOR_FORMAT);

	// App calls this hook before its keyboard effect reads the light in the
	// dependency array; a later declaration would be a temporal-dead-zone crash.
	const [keyLight, setKeyLight] = useState(appContext.shared.startupStage.keyLight);

	/** Every key-light writer goes through here: the light rides the cast
	 * snapshot (restoreCast puts it back), so an unrecorded light edit would be
	 * silently reverted by an unrelated Ctrl+Z. `patch` is a partial or a
	 * function of the current light. */
	function changeKeyLight(gesture, patch) {
		appContext.shared.beginGestureUndo(`light:${gesture}`);
		setKeyLight((current) => createKeyLight(typeof patch === "function" ? patch(current) : { ...current, ...patch }));
	}

	/** Reset is a whole gesture in one click. */
	function resetKeyLight() {
		appContext.shared.recordCharacterUndo();
		appContext.shared.endGestureUndo();
		setKeyLight(createKeyLight(null));
	}

	/** The set's look reference. One click, one entry — and the image is part
	 * of the cast snapshot, so undo puts the previous picture back. */
	function changeEnvironmentImage(dataUrl) {
		appContext.shared.recordCharacterUndo();
		appContext.shared.endGestureUndo();
		setEnvironmentImage(dataUrl);
	}

	const [hasEnvSheet, setHasEnvSheet] = useState(appContext.shared.startupStage.hasEnvSheet);

	const [environment, setEnvironment] = useState(appContext.shared.startupStage.environment ?? DEFAULT_ENVIRONMENT);

	const [style, setStyle] = useState(appContext.shared.startupStage.style ?? "moody cinematic lighting, 35mm film look");
	return {
		preset, setPreset, shotAspectKey, setShotAspectKey, environmentImage, setEnvironmentImage,
		cameraPresetId, setCameraPresetId, sensorId, setSensorFormat, keyLight, setKeyLight, changeKeyLight,
		resetKeyLight, changeEnvironmentImage, hasEnvSheet, setHasEnvSheet, environment, setEnvironment, style,
		setStyle,
	};
}
