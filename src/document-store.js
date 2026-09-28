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
  let active = null, running = 0;
  const listeners = new Set();
  const owns = domain => Object.hasOwn(slices, domain);
  const releaseLegacy = legacy?.subscribe(domain => { if (!owns(domain)) publish(slices, [domain]); });
  const releaseGuard = legacy?.guardWrites(domain => {
    if (owns(domain)) throw new TypeError(`Domain ${domain} is store-owned; write through the document store inside a bus run.`);
  });
  function publish(next, changed = Object.keys(slices).filter(domain => slices[domain] !== next[domain])) {
    if (!changed.length) return;
    const domainRevisions = { ...snapshot.domainRevisions };
    for (const domain of changed) domainRevisions[domain] = (domainRevisions[domain] ?? 0) + 1;
    slices = freeze(next);
    snapshot = freeze({ revision: snapshot.revision + 1, domainRevisions, slices });
    for (const listener of listeners) listener();
  }
  function beginAction(domain, targetId) {
    if (!owns(domain)) return legacy.beginAction(domain, targetId);
    if (active) fail('TARGET_BUSY', 'A document transaction is already open.');
    const before = slices;
    const check = () => { if (active !== session) fail('STALE_TARGET', 'Document transaction is no longer current.'); };
    const session = {
      // Permission ends at the synchronous publication boundary, not when an
      // async preparation finishes. Jobs publish through context.commit; a
      // retained session can explicitly re-enter with update after an await.
      run(fn) { check(); running++; try { return fn(); } finally { running--; } },
      update(domain, update) { return session.run(() => write(domain, update)); },
      cancel({ restore = true } = {}) {
        if (active !== session) return false;
        active = null;
        if (restore) publish(before);
        return true;
      },
      commit() {
        check(); active = null;
        if (Object.keys(slices).every(key => slices[key] === before[key])) return { historyEntryId: null };
        const historyEntryId = crypto.randomUUID();
        history = pushHistory(history, { historyEntryId, snapshot: slices });
        return { historyEntryId };
      },
    };
    active = session;
    return session;
  }
  function recordAction(domain, fn, targetId = null, nested = false) {
    if (nested && active) {
      const result = active.run(fn);
      return result?.then ? result.then(result => ({ result, historyEntryId: null })) : { result, historyEntryId: null };
    }
    if (!owns(domain)) return legacy.recordAction(domain, fn, targetId);
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
  function step(redo) {
    if (active) fail('TARGET_BUSY', 'Finish the document transaction before traversing history.');
    const entry = redo ? history.future[0] : history.present;
    const next = (redo ? redoHistory : undoHistory)(history);
    if (!next) return null;
    history = next;
    publish(history.present.snapshot);
    return entry;
  }
  return {
    owns, read: domain => owns(domain) ? slices[domain] : legacy.read(domain), write, beginAction, recordAction,
    dispose() { active?.cancel(); releaseLegacy?.(); releaseGuard?.(); listeners.clear(); },
    undo: () => step(false), redo: () => step(true),
    canUndo: id => !active && history.past.length > 0 && (id === undefined || history.present.historyEntryId === id),
    canRedo: () => !active && history.future.length > 0,
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    isRetained: id => Boolean(id && retainedEntries().some(entry => entry.historyEntryId === id)),
    history: () => freeze(history),
    depths: () => ({ past: history.past.length, future: history.future.length }),
  };
}
