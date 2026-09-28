// The Studio command runner. The registry owns declarations/implementations;
// the editor ports own native state/history, and the existing journal owns
// idempotency. Synchronous UI actions stay synchronous (including user gestures).
import { StudioProtocolError, validateReceipt, validateStudioIdentity } from './studio-agent-protocol.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code, message) => { throw new StudioProtocolError(code, message); };
const mapResult = (value, success, failure) => value?.then ? value.then(success, failure) : success(value);

export function createCommandBus({ registry, ports }) {
  const pending = new Map();
  function refusal(request, before, error) {
    const changed = ports.read().revision !== before.revision;
    return validateReceipt({ ok: false, commandId: request.commandId, host: before.host,
      code: error.code ?? 'INVALID_ARGUMENT', phase: changed ? 'commit' : 'admission', affectedIds: [], expectedTargets: [], currentTargets: [],
      mutated: changed, preserved: { authoredState: changed ? 'changed' : 'unchanged' }, recovery: { action: 'inspect', retryAllowed: false },
      message: [...String(error.message || error)].slice(0, 500).join('') });
  }
  function receipt(entry, request, before, result, historyEntryId) {
    const after = ports.read(), changed = after.revision !== before.revision;
    if (entry.kind === 'mutation' && changed && !historyEntryId) fail('UNCERTAIN_APPLY', `${entry.id} changed the scene without one undoable entry.`);
    const ids = changed ? result.affectedIds : [];
    return validateReceipt({ ok: true, commandId: request.commandId, receiptId: crypto.randomUUID(), host: before.host,
      action: entry.id, summary: result.summary, status: entry.kind === 'transient' ? 'transient' : changed ? 'applied' : 'noop',
      authored: changed, ...(entry.kind === 'transient' ? { view: { before: before.viewRevision ?? 0, after: after.viewRevision ?? 0 } } : { mutated: changed }),
      revision: { before: before.revision, after: after.revision }, affectedIds: ids,
      delta: ids.slice(0, 8).map(id => ({ id, after: ports.readback?.(id, after) ?? { removed: true } })),
      checks: { coverage: `studio-action:${entry.id}` }, warnings: [],
      undo: historyEntryId ? { historyEntryId, entries: 1, canUndoDirect: true } : null });
  }
  function run(id, args = {}, options = {}) {
    const request = { origin: 'ui', commandId: crypto.randomUUID(), ...options };
    const before = ports.read(), journal = ports.journal();
    let begun = false;
    const remember = value => { const recorded = journal.record(value); ports.remember?.(recorded); return recorded; };
    const rejected = error => {
      if (request.origin === 'ui' && error.uiMessage) ports.showRefusal?.(error.uiMessage);
      const value = refusal(request, before, error);
      return begun ? remember(value) : value;
    };
    try {
      if (request.origin !== 'ui' && !same(validateStudioIdentity(request.host), before.host)) fail('STALE_SCENE', 'The live document changed.');
      const signature = JSON.stringify({ id, args, ...request });
      if (!journal.begin(request.commandId, signature)) return journal.get(request.commandId) ?? pending.get(request.commandId) ?? refusal(request, before, new StudioProtocolError('UNCERTAIN_APPLY', 'Command is still executing.'));
      begun = true;
      const { entry, args: validated } = registry.prepare(id, args);
      if (request.origin !== 'ui') {
        if (request.expectedRevision !== before.revision) fail('STALE_SCENE', 'Authored state changed; obtain fresh intent.');
        if (before.busy) fail('TARGET_BUSY', 'Finish the current editor gesture first.');
      }
      const invoke = () => registry.invoke(entry, validated, { origin: request.origin });
      const value = entry.kind === 'mutation' ? ports.recordAction(entry.undoDomain, invoke, validated.characterId ?? null) : { result: invoke(), historyEntryId: null };
      const finish = ({ result, historyEntryId }) => mapResult(result, output => remember(receipt(entry, request, before, output, historyEntryId)));
      const answer = value?.then ? value.then(finish).catch(rejected) : finish(value);
      if (answer?.then) { const settled = answer.finally(() => pending.delete(request.commandId)); pending.set(request.commandId, settled); return settled; }
      return answer;
    } catch (error) { return rejected(error); }
  }
  return { run };
}
