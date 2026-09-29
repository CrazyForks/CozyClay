import { createContext, useContext } from 'react';
import { HISTORY_LIMIT } from './history.js';

export const AppContext = createContext(null);
export function useBus() { return useContext(AppContext).bus; }

const ref = current => ({ current });

// Access to App-owned state, not another document store. The optional refs let
// an owner supply its existing cells; the facade never owns React setters.
export function createAppContext({
  clock: opClockRef = ref(0), history: charHistoryRef = ref({ past: [], future: [] }),
  objectClock: lastObjectOpRef = ref(0), suppressObjectClock: suppressObjectClockRef = ref(false),
  characters: charactersRef = ref(null), scenes: scenesRef = ref(null),
  motion: motionRef = ref(null), state: liveStateRef = ref(null), getBus, notify,
} = {}) {
  const storeDomains = new Map(), historyStamps = new WeakMap();
  const storeDomain = domain => storeDomains.get(domain);
  const storeDomainForReceipt = receipt => [...storeDomains.values()].find(domain => domain.documentStore.isRetained(receipt?.undo?.historyEntryId));
  const registeredDomains = () => [...storeDomains.values()];
  const ports = { storeDomain, storeDomains: registeredDomains }, actionPorts = { storeDomain, storeDomains: registeredDomains };
  let currentPorts = {};
  const nextTick = () => ++opClockRef.current;
  function record(snapshot) {
    charHistoryRef.current.past.push({ tick: nextTick(), snapshot });
    charHistoryRef.current.past = charHistoryRef.current.past.slice(-HISTORY_LIMIT);
    charHistoryRef.current.future = [];
  }
  return {
    // The notifier is an App-owned stable callback, shared by every domain.
    notify,
    storeDomain,
    storeDomainForReceipt,
    storeDomains: registeredDomains,
    // Registration is per editor, never global. Render projections share it;
    // identity-checked disposal cannot remove a newer owner of the same slice.
    registerStoreDomain(undoDomain, handle) {
      const store = handle.documentStore;
      if (store && !historyStamps.has(store)) {
        const stamps = new Map();
        historyStamps.set(store, stamps);
        const stamp = result => {
          const id = result.historyEntryId;
          if (id && !stamps.has(id)) stamps.set(id, { tick: nextTick(), cast: charHistoryRef.current.past.at(-1)?.tick ?? 0,
            objects: this.shared?.objects ?? this.shared?.storeRef?.current.objects ?? currentPorts.read?.().objects });
          for (const id of stamps.keys()) if (!store.isRetained(id)) stamps.delete(id);
          return result;
        };
        // Stamp the actual commit, not transaction previews, cancellation, load
        // or traversal. Keep the store/handle identities and native anchors.
        const begin = store.beginAction, record = store.recordAction;
        store.beginAction = (...args) => {
          const session = begin(...args);
          return { ...session, commit: () => stamp(session.commit()) };
        };
        store.recordAction = (...args) => {
          const result = record(...args);
          return result?.then ? result.then(stamp) : stamp(result);
        };
      }
      storeDomains.set(undoDomain, handle);
      return () => { if (storeDomains.get(undoDomain) === handle) storeDomains.delete(undoDomain); };
    },
    nextStoreHistory(redo, objects) {
      const cast = charHistoryRef.current.past.at(-1)?.tick ?? 0;
      const nativeRedo = charHistoryRef.current.future.at(-1)?.tick ?? Infinity;
      const candidates = registeredDomains().flatMap(domain => {
        const store = domain.documentStore;
        if (!store || !(redo ? store.canRedo() : store.canUndo())) return [];
        const entry = redo ? store.history().future[0] : store.history().present;
        const stamp = historyStamps.get(store)?.get(entry.historyEntryId);
        // Object traversal advances objectClock. Retained native boundaries,
        // not that traversal tick, say when an older commit is reachable.
        if (!stamp || stamp.objects !== objects || stamp.cast !== cast || (redo && nativeRedo < stamp.tick)) return [];
        return [{ domain, tick: stamp.tick }];
      });
      candidates.sort((a, b) => redo ? a.tick - b.tick : b.tick - a.tick);
      return candidates[0]?.domain;
    },
    // Scene slices are keyed by the registered undo domain. A module whose
    // persistence shape differs can select its slice without changing App.
    loadStoreDomains(slices) {
      const loaded = new Set();
      for (const [name, domain] of storeDomains) if (domain.load) {
        domain.load(domain.sceneSlice ? domain.sceneSlice(slices) : slices[name]);
        loaded.add(name);
      }
      return loaded;
    },
    // A hook keeps the same render closure that its code had inside App.
    // Lazy projections permit handlers to refer to cells declared later in
    // that render, without rebinding an in-flight callback to a newer render.
    forRender(shared) {
      return Object.create(this, { shared: { value: shared } });
    },
    get undoClock() { return opClockRef.current; },
    nextTick,
    get objectClock() { return lastObjectOpRef.current; },
    get suppressObjectClock() { return suppressObjectClockRef.current; },
    set suppressObjectClock(value) { suppressObjectClockRef.current = value; },
    objectChanged() {
      if (!suppressObjectClockRef.current) lastObjectOpRef.current = nextTick();
    },
    advanceObjectClock() { lastObjectOpRef.current = nextTick(); },
    get castHistory() { return charHistoryRef.current; },
    resetCastHistory() { charHistoryRef.current = { past: [], future: [] }; },
    recordCharacterUndo: record,
    recordShotUndo: record,
    // Getter-only projections retain identity (including renderer buffers).
    // Publications are explicit; no copies or second source of truth.
    live: Object.freeze({
      get state() { return liveStateRef.current; },
      get characters() { return charactersRef.current; },
      get scenes() { return scenesRef.current; },
      get motion() { return motionRef.current; },
    }),
    publishLive(value) { liveStateRef.current = value; },
    patchLive(patch) { Object.assign(liveStateRef.current, patch); },
    patchTimeline(patch) { Object.assign(liveStateRef.current.timeline, patch); },
    publishCharacters(value) { charactersRef.current = value; },
    publishScenes(value) { scenesRef.current = value; },
    publishMotion(value) { motionRef.current = value; },
    get bus() { return getBus(); },
    ports,
    actionPorts,
    updatePorts(next) {
      currentPorts = next;
      for (const key of Object.keys(next)) {
        if (key === 'revision') ports[key] = next[key];
        else if (!ports[key]) ports[key] = (...args) => currentPorts[key](...args);
      }
    },
    updateActionPorts(next) { Object.assign(actionPorts, next); },
  };
}
