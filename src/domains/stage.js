import { useState } from 'react';
import { createDocumentStore } from '../document-store.js';
import { useDocumentDomain } from '../store/use-document-store.js';
import { createKeyLight } from '../scenes.js';
import { normalizeStage } from '../commands/stage.js';

// Stage is the first owned slice. Native cast/object histories remain native;
// their retained boundaries decide when this slice is next in editor Undo.
export function createStageDomain(appContext) {
  const documentStore = createDocumentStore({ owned: { stage: normalizeStage(appContext.shared.startupStage) }, dev: false });
  const anchors = new Map();
  const anchor = () => [appContext.castHistory.past.at(-1), appContext.live.state?.objects];
  const current = saved => saved?.every((value, index) => value === anchor()[index]);
  const read = () => documentStore.read('stage');
  const publish = () => {
    if (appContext.live.state) appContext.patchLive({ stage: { ...appContext.live.state.stage, ...read() } });
    const persisted = appContext.shared.actorStageRef;
    if (persisted?.current) persisted.current = { ...persisted.current, ...read() };
  };
  const release = documentStore.subscribe(publish);
  function beginAction() {
    const session = documentStore.beginAction('stage');
    return { ...session, commit() {
      const result = session.commit();
      if (result.historyEntryId) anchors.set(result.historyEntryId, anchor());
      for (const id of anchors.keys()) if (!documentStore.isRetained(id)) anchors.delete(id);
      return result;
    } };
  }
  function recordAction(fn) {
    const session = beginAction();
    try { const result = session.run(fn); return { result, ...session.commit() }; }
    catch (error) { session.cancel(); throw error; }
  }
  function write(value) {
    return documentStore.write('stage', before => {
      const next = normalizeStage(typeof value === 'function' ? value(before) : value);
      return JSON.stringify(before) === JSON.stringify(next) ? before : next;
    });
  }
  const canUndo = id => documentStore.canUndo(id) && current(anchors.get(documentStore.history().present.historyEntryId));
  function stepHistory(redo) {
    const entry = redo ? documentStore.history().future[0] : documentStore.history().present;
    if (!(redo ? documentStore.canRedo() : canUndo()) || !current(anchors.get(entry?.historyEntryId))) return false;
    (redo ? documentStore.redo : documentStore.undo)();
    return true;
  }
  const setters = Object.fromEntries(Object.entries({ 'setKeyLight': 'keyLight', 'setEnvironmentImage': 'environmentImage', 'setEnvironment': 'environment',
    'setStyle': 'style', 'setHasEnvSheet': 'hasEnvSheet', 'setShotAspectKey': 'shotAspect', 'setCameraPresetId': 'cameraPresetId', 'setSensorFormat': 'sensorId' })
    .map(([name, key]) => [name, value => write(before => ({ ...before, [key]: typeof value === 'function' ? value(before[key]) : value }))]));
  const document = () => ({ stage: { ...appContext.shared.actorStageRef.current, ...read() } });
  return { documentStore, document, read, write, beginAction, recordAction, canUndo, stepHistory, ...setters,
    dispose() { release(); documentStore.dispose(); },
  };
}

export function useStage(appContext) {
  const [domain] = useState(() => createStageDomain(appContext));
  const stage = useDocumentDomain(domain.documentStore, 'stage');
  const [preset, setPreset] = useState('medium');
  function changeKeyLight(_gesture, patch) {
    const keyLight = domain.read().keyLight;
    return appContext.bus.run('stage.setKeyLight', { keyLight: typeof patch === 'function' ? patch(keyLight) : patch });
  }
  function resetKeyLight() { return appContext.bus.run('stage.setKeyLight', { keyLight: createKeyLight(null) }); }
  function changeEnvironmentImage(environmentImage) { return appContext.bus.run('stage.setEnvironment', { environmentImage }); }
  return { ...domain, ...stage, shotAspectKey: stage.shotAspect, preset, setPreset, changeKeyLight, resetKeyLight, changeEnvironmentImage };
}
