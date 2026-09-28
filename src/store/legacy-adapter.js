// Ports keep React/live refs and native history authoritative. `write` must
// publish the live ref synchronously as well as scheduling the React setter.
// Cast/stage use recordCharacterUndo; shots use recordShotUndo. A native owner
// may instead supply beginAction (the B1 session contract) and isRetained.
import { StudioProtocolError } from '../studio-agent-protocol.js';

const fail = (code, message) => { throw new StudioProtocolError(code, message); };

function stateSession(port) {
  const before = port.read();
  const past = [...port.historyRef.current.past], future = [...port.historyRef.current.future];
  let historyEntryId = null;
  return {
    run: fn => fn(),
    write(next) {
      if (!historyEntryId) {
        port.recordUndo();
        historyEntryId = crypto.randomUUID();
        port.historyRef.current.past.at(-1).historyEntryId = historyEntryId;
      }
      port.write(next);
    },
    commit: () => ({ historyEntryId }),
    cancel({ restore = true } = {}) {
      if (!restore) return;
      port.historyRef.current.past = past; port.historyRef.current.future = future;
      port.write(before);
    },
  };
}

export function createLegacyAdapter(domains) {
  const sessions = new Map(), listeners = new Set(), historyListeners = new Set();
  const portFor = domain => {
    if (!Object.hasOwn(domains, domain)) fail('INVALID_ARGUMENT', `Unknown legacy domain: ${domain}`);
    return domains[domain];
  };
  const emit = domain => { for (const listener of listeners) listener(domain); };
  const subscriptions = Object.entries(domains).map(([domain, port]) => port.subscribe?.(() => emit(domain)));
  function beginAction(domain, targetId, { notify = true } = {}) {
    const port = portFor(domain);
    if (sessions.has(domain)) fail('TARGET_BUSY', 'A legacy transaction is already open.');
    const native = port.beginAction ? port.beginAction(targetId) : stateSession(port);
    const check = () => { if (sessions.get(domain) !== session) fail('STALE_TARGET', 'Legacy transaction is no longer current.'); };
    const session = {
      run(fn) { check(); return native.run(fn); },
      write(next) { check(); (native.write ?? port.write)(next); emit(domain); },
      commit() {
        check();
        const { historyEntryId } = native.commit();
        sessions.delete(domain);
        const handle = historyEntryId ? {
          historyEntryId,
          isRetained: () => port.isRetained ? port.isRetained(historyEntryId) : [...port.historyRef.current.past, ...port.historyRef.current.future].some(row => row.historyEntryId === historyEntryId),
          undo() { port.undo(); emit(domain); },
          redo() { port.redo(); emit(domain); },
        } : null;
        if (handle && notify) for (const listener of historyListeners) listener(handle);
        return { historyEntryId, handle };
      },
      cancel(options) {
        if (sessions.get(domain) !== session) return false;
        sessions.delete(domain); native.cancel(options); emit(domain); return true;
      },
    };
    sessions.set(domain, session);
    return session;
  }
  function recordAction(domain, fn, targetId = null) {
    const session = beginAction(domain, targetId);
    const done = result => ({ result, ...session.commit() });
    const failed = error => { session.cancel(); throw error; };
    try { const result = session.run(fn); return result?.then ? result.then(done, failed) : done(result); }
    catch (error) { return failed(error); }
  }
  function write(domain, update) {
    const port = portFor(domain), before = port.read();
    const next = typeof update === 'function' ? update(before) : update;
    if (next === before) return before;
    const session = sessions.get(domain);
    if (!session) return recordAction(domain, () => write(domain, next)).result;
    session.write(next);
    return port.read();
  }
  return {
    read: domain => portFor(domain).read(), write, beginAction, recordAction,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeHistory(listener) { historyListeners.add(listener); return () => historyListeners.delete(listener); },
    dispose() { for (const session of sessions.values()) session.cancel(); for (const release of subscriptions) release?.(); listeners.clear(); historyListeners.clear(); },
  };
}
