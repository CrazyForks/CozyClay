import { useState } from "react";
import { DEFAULT_SENSOR_FORMAT } from "../shot.js";
import { DEFAULT_ENVIRONMENT } from "../app-stage.jsx";
import { createKeyLight } from "../scenes.js";

export function useStage(appContext) {
	const [preset, setPreset] = useState("medium");

	const [shotAspectKey, setShotAspectKey] = useState(appContext.shared.startupStage.shotAspect);

	const [environmentImage, setEnvironmentImage] = useState(appContext.shared.startupStage.environmentImage ?? null);

	const [cameraPresetId, setCameraPresetId] = useState(appContext.shared.startupStage.cameraPresetId ?? null);

	const [sensorId, setSensorFormat] = useState(appContext.shared.startupStage.sensorId ?? DEFAULT_SENSOR_FORMAT);

	const [keyLight, setKeyLight] = useState(appContext.shared.startupStage.keyLight);

	function changeKeyLight(gesture, patch) {
			appContext.shared.beginGestureUndo(`light:${gesture}`);
			setKeyLight((current) => createKeyLight(typeof patch === "function" ? patch(current) : { ...current, ...patch }));
		}

	function resetKeyLight() {
			appContext.shared.recordCharacterUndo();
			appContext.shared.endGestureUndo();
			setKeyLight(createKeyLight(null));
		}

	function changeEnvironmentImage(dataUrl) {
			appContext.shared.recordCharacterUndo();
			appContext.shared.endGestureUndo();
			setEnvironmentImage(dataUrl);
		}

	const [hasEnvSheet, setHasEnvSheet] = useState(appContext.shared.startupStage.hasEnvSheet);

	const [environment, setEnvironment] = useState(appContext.shared.startupStage.environment ?? DEFAULT_ENVIRONMENT);

	const [style, setStyle] = useState(appContext.shared.startupStage.style ?? "moody cinematic lighting, 35mm film look");
	return { preset, setPreset, shotAspectKey, setShotAspectKey, environmentImage, setEnvironmentImage, cameraPresetId, setCameraPresetId, sensorId, setSensorFormat, keyLight, setKeyLight, changeKeyLight, resetKeyLight, changeEnvironmentImage, hasEnvSheet, setHasEnvSheet, environment, setEnvironment, style, setStyle };
}
