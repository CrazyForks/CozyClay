// Shared set/read machinery. Domain modules supply only their kind, declared
// fields and persistence normalizer; no UI or runtime resources live here.
import { patchValueSchema, validateStudioSchema, StudioProtocolError, StudioSchemas, utf8ByteLength } from '../studio-agent-protocol.js';

const kinds = new Map();
// Each kind registers its declared elements and persistence normalizer once.
// Its command port supplies read()/write(); all schemas and path aliases use
// this same spec so a migration adds a module, not another generic switch.
export function registerElementKind(kind, spec) {
  if (kinds.has(kind)) throw new Error(`Element kind already registered: ${kind}`);
  kinds.set(kind, spec);
}
const patchElements = kind => kinds.get(kind).elements.filter(row => row.agentExposure === 'patch');
const object = () => ({ type: 'object', properties: {}, required: [], additionalProperties: false });
export function elementSetSchema(kind) {
  const schema = object();
  for (const element of patchElements(kind)) {
    const keys = (element.documentPath ?? element.path.slice(kind.length + 1)).split('.');
    let parent = schema;
    for (const key of keys.slice(0, -1)) parent = parent.properties[key] ??= object();
    // Validate the wire type here; persistence owns numeric clamps. Empty
    // strings are valid authored text, including intermediate typing states.
    const value = element.type === 'number' ? { type: 'number' }
      : element.type === 'string' ? { oneOf: [{ const: '' }, { type: 'string', maxLength: 240 }] } : patchValueSchema(element);
    parent.properties[keys.at(-1)] = element.nullable ? { oneOf: [value, { type: 'null' }] } : value;
  }
  if (!kinds.get(kind).collection) return schema;
  // A single item is { id, set }; a batch is { ops: [{ id, set }] }.
  // Both forms publish once and therefore own exactly one history entry.
  const item = { ...object(), properties: { id: StudioSchemas.TargetGuard.properties.targetId, set: schema }, required: ['id', 'set'] };
  const batch = { ...object(), properties: { ops: { type: 'array', items: item, minItems: 1, maxItems: 32 } }, required: ['ops'] };
  return { ...object(), properties: { ...item.properties, ...batch.properties }, oneOf: [item, batch] };
}
export function elementTarget(kind, value, id, sceneId) {
  return kinds.get(kind).collection ? value.find(row => row.id === id) : id === sceneId ? value : undefined;
}
export function readElementDocument(projection, { ids, select } = {}, sceneId) {
  const entries = Object.entries(projection).filter(([kind]) => !select || select.includes(kind)).flatMap(([kind, value]) => {
    if (!ids || ids.includes(kind) || ids.includes(sceneId)) return [[kind, value]];
    const selected = kinds.get(kind).collection ? value.filter(row => ids.includes(row.id)) : [];
    return selected.length ? [[kind, selected]] : [];
  });
  return { document: structuredClone(Object.fromEntries(entries)), schema: Object.fromEntries(entries.map(([kind]) => [kind, elementSetSchema(kind)])) };
}
export function readElement(document, path) {
  const element = kinds.get(path.slice(0, path.indexOf('.'))).elements.find(row => row.path === path);
  return (element.documentPath ?? path.slice(path.indexOf('.') + 1)).split('.').reduce((value, key) => value?.[key], document);
}
export function mergeElementSet(document = {}, patch) {
  const next = { ...document };
  for (const [key, value] of Object.entries(patch)) next[key] = value && typeof value === 'object' && !Array.isArray(value)
    ? mergeElementSet(document[key], value) : value;
  return next;
}
export function elementPatchArgs(kind, args) {
  const set = { ...object(), additionalProperties: true };
  const collection = kinds.get(kind).collection;
  const target = { ...object(), properties: { kind: { const: kind }, ...(collection ? { id: StudioSchemas.TargetGuard.properties.targetId } : {}) }, required: collection ? ['kind', 'id'] : ['kind'] };
  const op = { ...object(), properties: { target, set }, required: ['target', 'set'] };
  const schema = { ...object(), properties: { ops: { type: 'array', items: op, minItems: 1, maxItems: 32 } }, required: ['ops'] };
  const validated = validateStudioSchema(schema, args);
  const ops = validated.ops.map(({ target, set }) => {
    let patch = {};
    for (const [key, value] of Object.entries(set)) {
      const element = patchElements(kind).find(row => row.path === `${kind}.${key}`);
      if (!element) throw new StudioProtocolError('INVALID_ARGUMENT', `Unknown ${kind} path: ${key}`);
      const nested = (element.documentPath ?? key).split('.').reduceRight((value, name) => ({ [name]: value }), value);
      patch = mergeElementSet(patch, nested);
    }
    return { id: target.id, set: patch };
  });
  return collection ? ops.length === 1 ? ops[0] : { ops } : ops.reduce((patch, op) => mergeElementSet(patch, op.set), {});
}
export function elementReadback(kind, document) {
  return patchElements(kind).map(element => {
    const value = readElement(document, element.path), path = element.path;
    if (value === null || value === undefined || value === '') return { path, text: null };
    if (element.type === 'image') return { path, bytes: utf8ByteLength(value) };
    return { path, [typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'flag' : 'text']: value };
  });
}
export function registerElementSet(registry, ports, declaration) {
  const kind = declaration.id.slice(0, declaration.id.indexOf('.'));
  const { normalize, collection } = kinds.get(kind);
  registry.register({ ...declaration, available: () => true, run(args) {
    const domain = ports.storeDomain(declaration.undoDomain ?? kind);
    let next = domain.read();
    const ops = collection ? args.ops ?? [args] : [{ id: ports.state().activeSceneId, set: args }];
    for (const { id, set } of ops) {
      const before = collection ? next.find(row => row.id === id) : next;
      if (!before) throw new StudioProtocolError('TARGET_NOT_READY', `Unknown ${kind} id: ${id}`);
      const after = normalize(mergeElementSet(before, set));
      next = collection ? next.map(row => row.id === id ? { ...after, id } : row) : after;
    }
    if (JSON.stringify(next) !== JSON.stringify(domain.read())) domain.write(next);
    return { affectedIds: [...new Set(ops.map(op => op.id))], summary: `Updated ${kind}.` };
  } });
}
