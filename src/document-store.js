// Incremental document ownership: only explicitly supplied `owned` slices live
// here. Bus ports bind beginAction/recordAction; no Studio domain opts in here.
import { createHistory, pushHistory, undoHistory, redoHistory } from './history.js';
import { StudioProtocolError } from './studio-agent-protocol.js';
import { copyAuthoredIntent, deepFreeze } from './store/authored-intent.js';

const fail = (code, message) => { throw new StudioProtocolError(code, message); };

export function createDocumentStore({ owned = {}, legacy, dev = import.meta.env?.DEV ?? true } = {}) {
  const freeze = value => dev ? deepFreeze(value) : value;
  const copy = value => freeze(copyAuthoredIntent(value));
  let slices = copy(owned);
  let snapshot = freeze({ revision: 0, domainRevisions: Object.fromEntries(Object.keys(owned).map(domain => [domain, 0])), slices });
  let history = createHistory({ historyEntryId: null, snapshot: slices });
  let active = null, running = 0, batching = false;
  const pendingDomains = new Set();
  const listeners = new Set();
  const owns = domain => Object.hasOwn(slices, domain);
  const releaseLegacy = legacy?.subscribe(domain => { if (!owns(domain)) publish(slices, [domain]); });
  const releaseGuard = legacy?.guardWrites(domain => {
    if (owns(domain)) throw new TypeError(`Domain ${domain} is store-owned; write through the document store inside a bus run.`);
    if (active) {
      if (!running) fail('TARGET_BUSY', 'A document transaction owns native history.');
      active.touch(domain);
    }
  });
  const releaseHistory = legacy?.subscribeHistory(handle => append([handle], handle.historyEntryId));
  function append(handles = [], historyEntryId = crypto.randomUUID()) {
    history = pushHistory(history, { historyEntryId, snapshot: slices, handles });
    return { historyEntryId };
  }
  function publish(next, changed = Object.keys(slices).filter(domain => slices[domain] !== next[domain])) {
    if (!changed.length) return;
    if (batching) {
      slices = freeze(next);
      for (const domain of changed) pendingDomains.add(domain);
      return;
    }
    const domainRevisions = { ...snapshot.domainRevisions };
    for (const domain of changed) domainRevisions[domain] = (domainRevisions[domain] ?? 0) + 1;
    slices = freeze(next);
    snapshot = freeze({ revision: snapshot.revision + 1, domainRevisions, slices });
    for (const listener of listeners) listener();
  }
  // History restoration is one bus revision even when several native owners
  // and owned slices participate. Domain fences still advance independently.
  function restoreTogether(fn) {
    batching = true;
    try { return fn(); }
    finally {
      batching = false;
      const changed = [...pendingDomains]; pendingDomains.clear();
      publish(slices, changed);
    }
  }
  function beginAction(domain, targetId) {
    if (active) fail('TARGET_BUSY', 'A document transaction is already open.');
    const before = slices, nativeSessions = new Map();
    const check = () => { if (active !== session) fail('STALE_TARGET', 'Document transaction is no longer current.'); };
    const session = {
      // Permission ends at the synchronous publication boundary, not when an
      // async preparation finishes. Jobs publish through context.commit; a
      // retained session can explicitly re-enter with update after an await.
      run(fn) {
        check(); running++;
        try { return [...nativeSessions.values()].reduceRight((run, native) => () => native.run(run), fn)(); }
        finally { running--; }
      },
      touch(domain, targetId) {
        check();
        if (!owns(domain) && !nativeSessions.has(domain)) nativeSessions.set(domain, legacy.beginAction(domain, targetId, { notify: false }));
      },
      update(domain, update) { return session.run(() => write(domain, update)); },
      cancel({ restore = true } = {}) {
        if (active !== session) return false;
        active = null;
        restoreTogether(() => {
          for (const native of [...nativeSessions.values()].reverse()) native.cancel({ restore });
          if (restore) publish(before);
        });
        return true;
      },
      commit() {
        check();
        const handles = [...nativeSessions.values()].map(native => native.commit().handle).filter(Boolean);
        active = null;
        const changed = Object.keys(slices).some(key => slices[key] !== before[key]);
        if (!changed && !handles.length) return { historyEntryId: null };
        return append(handles, !changed && handles.length === 1 ? handles[0].historyEntryId : undefined);
      },
    };
    active = session;
    try { session.touch(domain, targetId); } catch (error) { session.cancel(); throw error; }
    return session;
  }
  function recordAction(domain, fn, targetId = null, nested = false) {
    if (nested && active) {
      active.touch(domain, targetId);
      const result = active.run(fn);
      return result?.then ? result.then(result => ({ result, historyEntryId: null })) : { result, historyEntryId: null };
    }
    const session = beginAction(domain, targetId);
    const done = result => ({ result, ...session.commit() });
    const failed = error => { session.cancel(); throw error; };
    try {
      const result = session.run(fn);
      return result?.then ? result.then(done, failed) : done(result);
    } catch (error) { return failed(error); }
  }
  function write(domain, update) {
    if (!owns(domain)) return legacy.write(domain, update);
    if (dev && !running) throw new TypeError(`A store-owned ${domain} write requires a bus run.`);
    if (!active) return recordAction(domain, () => write(domain, update)).result;
    if (!running) fail('TARGET_BUSY', 'A document transaction owns this write.');
    const next = typeof update === 'function' ? update(slices[domain]) : update;
    if (next !== slices[domain]) publish({ ...slices, [domain]: copy(next) });
    return slices[domain];
  }
  // An id labels a transition INTO a snapshot. The oldest snapshot has no
  // retained pre-image, so merely finding its id is not enough to promise Undo.
  const retainedEntries = () => [...(history.past.length ? [...history.past.slice(1), history.present] : []), ...history.future];
  const retained = entry => (entry.handles ?? []).every(handle => handle.isRetained());
  function nativeReady(entry, redo) {
    const seen = new Set(), handles = entry.handles ?? [];
    return (redo ? handles : [...handles].reverse()).every(handle => {
      if (seen.has(handle.owner)) return true;
      seen.add(handle.owner);
      return redo ? handle.canRedo() : handle.canUndo();
    });
  }
  function step(redo) {
    if (active) fail('TARGET_BUSY', 'Finish the document transaction before traversing history.');
    const entry = redo ? history.future[0] : history.present;
    const next = (redo ? redoHistory : undoHistory)(history);
    if (!next) return null;
    if (!retained(entry)) fail('UNDO_EXPIRED', 'Native history no longer retains this entry.');
    if (!nativeReady(entry, redo)) fail('UNDO_CONFLICT', 'A newer native edit owns history.');
    const handles = entry.handles ?? [];
    restoreTogether(() => {
      for (const handle of redo ? handles : [...handles].reverse()) (redo ? handle.redo : handle.undo)();
      history = next;
      publish(history.present.snapshot);
    });
    return entry;
  }
  return {
    owns, read: domain => owns(domain) ? slices[domain] : legacy.read(domain), write, beginAction, recordAction,
    dispose() { active?.cancel(); releaseLegacy?.(); releaseGuard?.(); releaseHistory?.(); listeners.clear(); },
    undo: () => step(false), redo: () => step(true),
    canUndo: id => !active && history.past.length > 0 && (id === undefined || history.present.historyEntryId === id) && retained(history.present) && nativeReady(history.present, false),
    canRedo: () => !active && history.future.length > 0 && retained(history.future[0]) && nativeReady(history.future[0], true),
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    isRetained: id => Boolean(id && retainedEntries().some(entry => entry.historyEntryId === id && retained(entry))),
    history: () => freeze(history),
    depths: () => ({ past: history.past.length, future: history.future.length }),
  };
}
