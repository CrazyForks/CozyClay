// Incremental document ownership: only explicitly supplied `owned` slices live
// here. Bus ports bind beginAction/recordAction; no Studio domain opts in here.
import { createHistory, pushHistory, undoHistory, redoHistory } from './history.js';
import { StudioProtocolError } from './studio-agent-protocol.js';

const fail = (code, message) => { throw new StudioProtocolError(code, message); };

export function createDocumentStore({ owned = {} } = {}) {
  let slices = structuredClone(owned);
  let snapshot = { revision: 0, domainRevisions: Object.fromEntries(Object.keys(owned).map(domain => [domain, 0])), slices };
  let history = createHistory({ historyEntryId: null, snapshot: slices });
  let active = null;
  const listeners = new Set();
  const owns = domain => Object.hasOwn(slices, domain);
  function publish(next) {
    const changed = Object.keys(slices).filter(domain => slices[domain] !== next[domain]);
    if (!changed.length) return;
    const domainRevisions = { ...snapshot.domainRevisions };
    for (const domain of changed) domainRevisions[domain]++;
    slices = next;
    snapshot = { revision: snapshot.revision + 1, domainRevisions, slices };
    for (const listener of listeners) listener();
  }
  function beginAction(domain) {
    if (!owns(domain)) fail('INVALID_ARGUMENT', `Unknown document domain: ${domain}`);
    if (active) fail('TARGET_BUSY', 'A document transaction is already open.');
    const before = slices;
    const check = () => { if (active !== session) fail('STALE_TARGET', 'Document transaction is no longer current.'); };
    const session = {
      run(fn) { check(); return fn(); },
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
    const session = beginAction(domain, targetId);
    const done = result => ({ result, ...session.commit() });
    const failed = error => { session.cancel(); throw error; };
    try {
      const result = session.run(fn);
      return result?.then ? result.then(done, failed) : done(result);
    } catch (error) { return failed(error); }
  }
  function write(domain, update) {
    if (!owns(domain)) fail('INVALID_ARGUMENT', `Unknown document domain: ${domain}`);
    if (!active) return recordAction(domain, () => write(domain, update)).result;
    const next = typeof update === 'function' ? update(slices[domain]) : update;
    if (next !== slices[domain]) publish({ ...slices, [domain]: structuredClone(next) });
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
    owns, read: domain => slices[domain], write, beginAction, recordAction,
    undo: () => step(false), redo: () => step(true),
    canUndo: id => !active && history.past.length > 0 && (id === undefined || history.present.historyEntryId === id),
    canRedo: () => !active && history.future.length > 0,
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    isRetained: id => Boolean(id && retainedEntries().some(entry => entry.historyEntryId === id)),
    history: () => history,
    depths: () => ({ past: history.past.length, future: history.future.length }),
  };
}
