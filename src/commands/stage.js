import { createSceneStage } from '../scenes.js';
import { elementSetSchema, registerElementSet } from './elements.js';

export const STAGE_FIELDS = ['environmentImage', 'environment', 'style', 'hasEnvSheet', 'shotAspect', 'cameraPresetId', 'sensorId', 'keyLight'];
export function normalizeStage(source) {
  const normalized = createSceneStage(source);
  return Object.fromEntries(STAGE_FIELDS.map(key => [key, normalized[key]]));
}
const input = elementSetSchema('stage');
const declaration = (id, properties = input.properties) => ({ id, label: 'Set stage', kind: 'mutation', undoDomain: 'stage',
  description: 'Update authored stage fields, normalized by scene persistence.',
  input: { ...input, properties } });
export const declarations = Object.freeze([
  declaration('stage.set'),
  declaration('stage.setKeyLight', { keyLight: input.properties.keyLight }),
  declaration('stage.setEnvironment', Object.fromEntries(['environment', 'environmentImage', 'hasEnvSheet'].map(key => [key, input.properties[key]]))),
  declaration('stage.setStyle', { style: input.properties.style }),
  declaration('stage.setFilmback', Object.fromEntries(['shotAspect', 'cameraPresetId', 'sensorId'].filter(key => input.properties[key]).map(key => [key, input.properties[key]]))),
]);
export function register(registry, ports) {
  for (const declaration of declarations) registerElementSet(registry, ports, declaration, normalizeStage);
}
