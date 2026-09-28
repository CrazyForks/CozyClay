// The Studio command runner. The registry owns declarations/implementations;
// the editor ports own native state/history, and the existing journal owns
// idempotency. Synchronous UI actions stay synchronous (including user gestures).
import { StudioProtocolError, StudioSchemas, validateStudioSchema, validateReceipt, validateStudioIdentity } from './studio-agent-protocol.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code, message) => { throw new StudioProtocolError(code, message); };
const mapResult = (value, success, failure) => value?.then ? value.then(success, failure) : success(value);

export function createCommandBus({ registry, ports }) {
  const pending = new Map(), transactions = new Map(), listeners = new Set();
  const emit = event => { for (const listener of listeners) listener(event); ports.emit?.(event); };
  const identifier = StudioSchemas.TargetGuard.properties.targetId;
  const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  const argsSchema = { type: 'object', properties: {}, required: [], additionalProperties: true };
  const controls = {
    'run.begin': object({ id: identifier, args: argsSchema }),
    'run.update': object({ txId: identifier, args: argsSchema }),
    'run.commit': object({ txId: identifier }),
    'run.cancel': object({ txId: identifier }),
  };
  const clear = timer => (ports.clearTimeout ?? clearTimeout)(timer);
  function cancelTransaction(tx, expired = false) {
    transactions.delete(tx.txId); clear(tx.timer); tx.session.cancel();
    emit({ type: 'transaction.cancelled', txId: tx.txId, expired });
  }
  function renew(tx) {
    if (tx.timer !== undefined) clear(tx.timer);
    tx.timer = (ports.setTimeout ?? setTimeout)(() => cancelTransaction(tx, true), ports.transactionIdleMs ?? 30_000);
  }
  function control(id, args, request, before) {
    let tx;
    if (id === 'run.begin') {
      if (transactions.size) fail('TARGET_BUSY', 'Finish or cancel the open command transaction first.');
      const prepared = registry.prepare(args.id, args.args);
      if (prepared.entry.kind !== 'mutation') fail('INVALID_ARGUMENT', 'Only mutations can open a transaction.');
      tx = { txId: crypto.randomUUID(), entry: prepared.entry, before, origin: request.origin,
        session: ports.beginAction(prepared.entry.undoDomain, prepared.args.characterId ?? null), affectedIds: new Set() };
      transactions.set(tx.txId, tx); renew(tx);
    } else {
      tx = transactions.get(args.txId);
      if (!tx || !same(tx.before.host, before.host)) fail('STALE_TARGET', 'Transaction is no longer open in this document.');
      if (request.origin !== tx.origin) fail('TARGET_BUSY', 'This transaction belongs to another origin.');
      if (id === 'run.update') {
        const prepared = registry.prepare(tx.entry.id, args.args);
        const updated = tx.session.run(() => registry.invoke(tx.entry, prepared.args, { origin: request.origin }));
        const finish = result => { for (const target of result.affectedIds) tx.affectedIds.add(target); renew(tx); return transactionReceipt(id, tx, request, before); };
        return updated?.then ? updated.then(finish, error => { cancelTransaction(tx); throw error; }) : finish(updated);
      }
      if (id === 'run.cancel') cancelTransaction(tx);
      if (id === 'run.commit') { transactions.delete(tx.txId); clear(tx.timer); tx.historyEntryId = tx.session.commit().historyEntryId; }
    }
    return transactionReceipt(id, tx, request, id === 'run.commit' ? tx.before : before);
  }
  function transactionReceipt(id, tx, request, before) {
    const after = ports.read();
    return validateReceipt({ ok: true, status: 'completed', kind: 'transaction', commandId: request.commandId, receiptId: crypto.randomUUID(), host: before.host,
      action: id, txId: tx.txId, authored: Boolean(tx.historyEntryId), revision: { before: before.revision, after: after.revision },
      affectedIds: [...tx.affectedIds], delta: [], checks: { coverage: 'wire-transaction' }, warnings: [],
      undo: tx.historyEntryId ? { historyEntryId: tx.historyEntryId, entries: 1, canUndoDirect: true } : null });
  }
  function refusal(request, before, error) {
    const changed = ports.read().revision !== before.revision;
    return validateReceipt({ ok: false, commandId: request.commandId, host: before.host,
      code: error.code ?? 'INVALID_ARGUMENT', phase: changed ? 'commit' : 'admission', affectedIds: [], expectedTargets: [], currentTargets: [],
      mutated: changed, preserved: { authoredState: changed ? 'changed' : 'unchanged' }, recovery: { action: 'inspect', retryAllowed: false },
      message: [...String(error.message || error)].slice(0, 500).join('') });
  }
  function receipt(entry, request, before, result, historyEntryId, toasts = []) {
    const after = ports.read(), changed = after.revision !== before.revision;
    if (entry.kind === 'mutation' && changed && !historyEntryId) fail('UNCERTAIN_APPLY', `${entry.id} changed the scene without one undoable entry.`);
    const completed = entry.kind === 'job' || entry.kind === 'document';
    const ids = completed || changed ? result.affectedIds : entry.kind === 'transient' ? [before.host.sceneId] : [];
    return validateReceipt({ ok: true, commandId: request.commandId, receiptId: crypto.randomUUID(), host: before.host,
      action: entry.id, summary: result.summary, status: completed ? 'completed' : entry.kind === 'transient' ? 'transient' : changed ? 'applied' : 'noop',
      authored: changed, ...(completed ? { kind: entry.kind, ...(result.output === undefined ? {} : { output: result.output }), ...(same(before.host, after.host) ? {} : { nextHost: after.host }) } : entry.kind === 'transient' ? { view: { before: before.viewRevision ?? 0, after: after.viewRevision ?? 0 } } : { mutated: changed }),
      revision: { before: before.revision, after: after.revision }, affectedIds: ids,
      delta: ids.slice(0, 8).map(id => ({ id, after: ports.readback?.(id, after) ?? { removed: true } })),
      checks: { coverage: `studio-action:${entry.id}` }, warnings: toasts.slice(-12).map(toast => ({ code: 'STUDIO_TOAST', message: [...toast.message].slice(0, 120).join('') })),
      undo: historyEntryId ? { historyEntryId, entries: 1, canUndoDirect: true } : null });
  }
  function run(id, args = {}, options = {}) {
    const request = { origin: 'ui', commandId: crypto.randomUUID(), ...options };
    const before = ports.read(), journal = ports.journal();
    let begun = false, releaseToasts, timer;
    const controller = new AbortController();
    const clearTimer = () => { if (timer !== undefined) (ports.clearTimeout ?? clearTimeout)(timer); };
    const toasts = [];
    const toastRefusal = () => toasts.length && ports.read().revision === before.revision ? new StudioProtocolError('TARGET_NOT_READY', toasts.at(-1).message) : null;
    const remember = value => { const recorded = journal.record(value); ports.remember?.(recorded); return recorded; };
    const rejected = error => {
      clearTimer();
      releaseToasts?.(); releaseToasts = null;
      if (!(error instanceof StudioProtocolError)) error = toastRefusal() ?? error;
      if (request.origin === 'ui' && error.uiMessage) ports.showRefusal?.(error.uiMessage);
      const value = refusal(request, before, error);
      return begun ? remember(value) : value;
    };
    try {
      if (request.origin !== 'ui' && !same(validateStudioIdentity(request.host), before.host)) fail('STALE_SCENE', 'The live document changed.');
      const signature = JSON.stringify({ id, args, ...request });
      if (!journal.begin(request.commandId, signature)) return journal.get(request.commandId) ?? pending.get(request.commandId) ?? refusal(request, before, new StudioProtocolError('UNCERTAIN_APPLY', 'Command is still executing.'));
      begun = true;
      const prepared = controls[id] ? { args: validateStudioSchema(controls[id], args) } : registry.prepare(id, args);
      const { entry, args: validated } = prepared;
      if (request.origin !== 'ui') {
        if (request.expectedRevision !== before.revision) fail('STALE_SCENE', 'Authored state changed; obtain fresh intent.');
        if (before.busy) fail('TARGET_BUSY', 'Finish the current editor gesture first.');
      }
      if (controls[id]) return mapResult(control(id, validated, request, before), remember, rejected);
      if (transactions.size) fail('TARGET_BUSY', 'Finish or cancel the open command transaction first.');
      releaseToasts = ports.captureToasts?.(toast => toasts.push(typeof toast === 'string' ? { message: toast } : toast));
      const context = { origin: request.origin, signal: controller.signal };
      let timeout;
      const deadline = new Promise((_, reject) => { timeout = reject; });
      timer = (ports.setTimeout ?? setTimeout)(() => {
        const error = new StudioProtocolError('TIMEOUT', `${entry.id} exceeded its deadline.`);
        controller.abort(error); timeout(error);
      }, entry.timeoutMs ?? 30_000);
      // The race observes expiry even if a backend ignores cancellation.
      const invoke = () => { const value = registry.invoke(entry, validated, context); return value?.then ? Promise.race([value, deadline]) : value; };
      const value = entry.kind === 'mutation' ? ports.recordAction(entry.undoDomain, invoke, validated.characterId ?? null) : { result: invoke(), historyEntryId: null };
      const finish = ({ result, historyEntryId }) => mapResult(result, output => {
        clearTimer();
        releaseToasts?.(); releaseToasts = null;
        const refused = toastRefusal();
        if (refused) throw refused;
        return remember(receipt(entry, request, before, output, historyEntryId, toasts));
      });
      const finished = value?.then ? value.then(finish) : finish(value);
      const answer = finished?.then ? finished.catch(rejected) : finished;
      if (answer?.then) { const settled = answer.finally(() => pending.delete(request.commandId)); pending.set(request.commandId, settled); return settled; }
      return answer;
    } catch (error) { return rejected(error); }
  }
  return { run, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { for (const tx of transactions.values()) cancelTransaction(tx); listeners.clear(); } };
}
