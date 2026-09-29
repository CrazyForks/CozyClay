import { createContext, useContext } from 'react';
import { HISTORY_LIMIT } from './history.js';
import { StudioProtocolError } from './studio-agent-protocol.js';

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
  const storeDomains = new Map(), historyStamps = new WeakMap(), domainBegins = new WeakMap();
  const composites = new Map(), memberGroups = new WeakMap();
  let activeComposition = null, readObjects;
  const storeDomain = domain => storeDomains.get(domain);
  const storeDomainForReceipt = receipt => {
    const id = receipt?.undo?.historyEntryId, group = composites.get(id);
    if (group) return group.retained() ? group.handle : undefined;
    return [...storeDomains.values()].find(domain => domain.documentStore.isRetained(id));
  };
  const registeredDomains = () => [...storeDomains.values()];
  const ports = { storeDomain, storeDomains: registeredDomains }, actionPorts = { storeDomain, storeDomains: registeredDomains };
  let currentPorts = {};
  const nextTick = () => ++opClockRef.current;
  function record(snapshot) {
    charHistoryRef.current.past.push({ tick: nextTick(), snapshot });
    charHistoryRef.current.past = charHistoryRef.current.past.slice(-HISTORY_LIMIT);
    charHistoryRef.current.future = [];
  }
  const anchor = () => ({ cast: charHistoryRef.current.past.at(-1)?.tick ?? 0,
    objects: readObjects?.() ?? currentPorts.read?.().objects });
  const atAnchor = (saved, objects) => saved.cast === (charHistoryRef.current.past.at(-1)?.tick ?? 0) && saved.objects === objects;
  const fail = (code, message) => { throw new StudioProtocolError(code, message); };

  // Stores still own their snapshots. The facade owns only the session and
  // history relationship between them, so one receipt cannot restore half of
  // an edit. A native bridge is supplied by App, never selected by domain name.
  function rememberComposition(members, native, before, after) {
    const historyEntryId = crypto.randomUUID(), tick = nextTick();
    const retained = () => members.every(row => storeDomains.get(row.name) === row.handle && row.store.isRetained(row.id))
      && (!native || native.port.isRetained(native.id));
    let undone = false;
    const ready = (redo, objects) => undone === redo && retained() && atAnchor(redo ? before : after, objects)
      && members.every(row => redo ? row.store.canRedo() && row.store.history().future[0]?.historyEntryId === row.id : row.store.canUndo(row.id));
    const handle = {
      documentStore: { isRetained: id => id === historyEntryId && retained() },
      canUndo: id => (id === undefined || id === historyEntryId) && ready(false, anchor().objects),
      stepHistory(redo) {
        if (!ready(redo, anchor().objects)) return false;
        // Native snapshots retain their object boundary. Undo them before the
        // owned objects move; on redo put those objects back before the native
        // snapshot is visited. Store-local anchor gates must not split a group.
        const objects = anchor().objects, revision = ports.revision?.current;
        if (!redo && native && !native.port.stepHistory(false, native.id)) fail('UNDO_CONFLICT', 'The native member is not at the composite history boundary.');
        for (const row of redo ? members : [...members].reverse()) (redo ? row.store.redo : row.store.undo)();
        if (redo && native && !native.port.stepHistory(true, native.id)) fail('UNDO_CONFLICT', 'The native member is not at the composite history boundary.');
        undone = !redo;
        if (objects !== anchor().objects) lastObjectOpRef.current = nextTick();
        // Several owners publish, but traversal is one authored transition at
        // the binding boundary, including native owners that advance the clock.
        if (revision !== undefined) ports.revision.current = revision + 1;
        return true;
      },
    };
    const group = { handle, tick, retained, ready, members, native };
    composites.set(historyEntryId, group);
    for (const row of members) {
      if (!memberGroups.has(row.store)) memberGroups.set(row.store, new Map());
      memberGroups.get(row.store).set(row.id, historyEntryId);
    }
    // Keep a partially expired group as a boundary: its surviving member must
    // not turn back into an independently undoable, partial edit.
    for (const [id, entry] of composites) if (!entry.members.some(row => storeDomains.get(row.name) === row.handle && row.store.isRetained(row.id))) {
      composites.delete(id);
      for (const row of entry.members) memberGroups.get(row.store).delete(row.id);
    }
    return { historyEntryId };
  }

  function beginAction(domain, targetId = null, nativePort, nested = false) {
    if (activeComposition) {
      if (!activeComposition.running && !nested) fail('TARGET_BUSY', 'A composed document transaction is already open.');
      const parent = activeComposition;
      parent.touch(domain, targetId, nativePort);
      return { run: parent.run, commit: () => ({ historyEntryId: null }), cancel: parent.cancel };
    }
    const before = anchor(), members = new Map();
    let native = null, closed = false;
    const check = () => { if (closed) fail('STALE_TARGET', 'The composed document transaction is closed.'); };
    const session = {
      running: 0,
      touches: handle => members.has(handle),
      touch(name, targetId, bridge = nativePort) {
        check();
        const handle = storeDomain(name);
        if (handle) {
          if (!members.has(handle)) members.set(handle, { name, handle, store: handle.documentStore,
            session: domainBegins.get(handle)(targetId) });
        } else if (native) native.session.touch(name, targetId);
        else {
          if (!bridge) fail('CAPABILITY_MISSING', 'Native session composition requires the App history bridge.');
          native = { port: bridge, session: bridge.beginAction(name, targetId) };
        }
      },
      run(fn) {
        check(); session.running++;
        const sessions = [...members.values()].map(row => row.session);
        if (native) sessions.push(native.session);
        try { return sessions.reduceRight((next, member) => () => member.run(next), fn)(); }
        finally { session.running--; }
      },
      commit() {
        check();
        const nativeResult = native?.session.commit();
        const changed = [...members.values()].flatMap(row => {
          const result = row.session.commit();
          return result.historyEntryId ? [{ ...row, id: result.historyEntryId }] : [];
        });
        closed = true; activeComposition = null;
        const nativeEntry = nativeResult?.historyEntryId ? { ...native, id: nativeResult.historyEntryId } : null;
        if (changed.length + Number(Boolean(nativeEntry)) <= 1) return { historyEntryId: changed[0]?.id ?? nativeEntry?.id ?? null };
        return rememberComposition(changed, nativeEntry, before, anchor());
      },
      cancel(options) {
        if (closed) return false;
        closed = true; activeComposition = null;
        native?.session.cancel(options);
        for (const row of [...members.values()].reverse()) row.session.cancel(options);
        return true;
      },
    };
    activeComposition = session;
    try { session.touch(domain, targetId); }
    catch (error) { session.cancel(); throw error; }
    return session;
  }
  function recordAction(domain, run, targetId = null, nested = false, nativePort) {
    const session = beginAction(domain, targetId, nativePort, nested);
    const done = result => ({ result, ...session.commit() });
    const failed = error => { session.cancel(); throw error; };
    try { const result = session.run(run); return result?.then ? result.then(done, failed) : done(result); }
    catch (error) { return failed(error); }
  }

  return {
    beginAction,
    recordAction,
    // The notifier is an App-owned stable callback, shared by every domain.
    notify,
    storeDomain,
    storeDomainForReceipt,
    storeDomains: registeredDomains,
    // Registration is per editor, never global. Render projections share it;
    // identity-checked disposal cannot remove a newer owner of the same slice.
    registerStoreDomain(undoDomain, handle) {
      readObjects ??= () => this.shared?.objects ?? this.shared?.storeRef?.current.objects ?? currentPorts.read?.().objects;
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
      if (handle.beginAction && !domainBegins.has(handle)) {
        domainBegins.set(handle, handle.beginAction.bind(handle));
        handle.beginAction = targetId => beginAction(undoDomain, targetId);
        if (handle.load) {
          const load = handle.load.bind(handle);
          handle.load = (...args) => { if (activeComposition?.touches(handle)) activeComposition.cancel(); return load(...args); };
        }
      }
      storeDomains.set(undoDomain, handle);
      return () => {
        if (activeComposition?.touches(handle)) activeComposition.cancel();
        if (storeDomains.get(undoDomain) === handle) storeDomains.delete(undoDomain);
      };
    },
    nextStoreHistory(redo, objects) {
      const cast = charHistoryRef.current.past.at(-1)?.tick ?? 0;
      const nativeRedo = charHistoryRef.current.future.at(-1)?.tick ?? Infinity;
      const candidates = registeredDomains().flatMap(domain => {
        const store = domain.documentStore;
        if (!store || !(redo ? store.canRedo() : store.canUndo())) return [];
        const entry = redo ? store.history().future[0] : store.history().present;
        if (memberGroups.get(store)?.has(entry.historyEntryId)) return [];
        const stamp = historyStamps.get(store)?.get(entry.historyEntryId);
        // Object traversal advances objectClock. Retained native boundaries,
        // not that traversal tick, say when an older commit is reachable.
        if (!stamp || stamp.objects !== objects || stamp.cast !== cast || (redo && nativeRedo < stamp.tick)) return [];
        return [{ domain, tick: stamp.tick }];
      });
      for (const group of composites.values()) if (group.ready(redo, objects) && (!redo || group.native || nativeRedo >= group.tick)) candidates.push({ domain: group.handle, tick: group.tick });
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
