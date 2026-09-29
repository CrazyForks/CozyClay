// Shared set/read machinery. Domain modules supply only their kind, declared
// fields and persistence normalizer; no UI or runtime resources live here.
import { STUDIO_ELEMENTS } from '../studio-elements.js';
import { patchValueSchema, validateStudioSchema, StudioProtocolError, utf8ByteLength } from '../studio-agent-protocol.js';

const object = () => ({ type: 'object', properties: {}, required: [], additionalProperties: false });
export function elementSetSchema(kind) {
  const schema = object();
  for (const element of STUDIO_ELEMENTS.filter(row => row.path.startsWith(`${kind}.`) && row.agentExposure === 'patch')) {
    const keys = (element.documentPath ?? element.path.slice(kind.length + 1)).split('.');
    let parent = schema;
    for (const key of keys.slice(0, -1)) parent = parent.properties[key] ??= object();
    // Validate the wire type here; persistence owns numeric clamps. Empty
    // strings are valid authored text, including intermediate typing states.
    const value = element.type === 'number' ? { type: 'number' }
      : element.type === 'string' ? { oneOf: [{ const: '' }, { type: 'string', maxLength: 240 }] } : patchValueSchema(element);
    parent.properties[keys.at(-1)] = element.nullable ? { oneOf: [value, { type: 'null' }] } : value;
  }
  return schema;
}
export function readElementDocument(projection, { ids, select } = {}, sceneId) {
  const entries = Object.entries(projection).filter(([kind]) => (!select || select.includes(kind)) && (!ids || ids.includes(kind) || ids.includes(sceneId)));
  return { document: structuredClone(Object.fromEntries(entries)), schema: Object.fromEntries(entries.map(([kind]) => [kind, elementSetSchema(kind)])) };
}
export function readElement(document, path) {
  const element = STUDIO_ELEMENTS.find(row => row.path === path);
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
  const target = { ...object(), properties: { kind: { const: kind } }, required: ['kind'] };
  const op = { ...object(), properties: { target, set }, required: ['target', 'set'] };
  const schema = { ...object(), properties: { ops: { type: 'array', items: op, minItems: 1, maxItems: 32 } }, required: ['ops'] };
  const validated = validateStudioSchema(schema, args);
  let patch = {};
  for (const { set } of validated.ops) for (const [key, value] of Object.entries(set)) {
    const element = STUDIO_ELEMENTS.find(row => row.path === `${kind}.${key}` && row.agentExposure === 'patch');
    if (!element) throw new StudioProtocolError('INVALID_ARGUMENT', `Unknown ${kind} path: ${key}`);
    const nested = (element.documentPath ?? key).split('.').reduceRight((value, name) => ({ [name]: value }), value);
    patch = mergeElementSet(patch, nested);
  }
  return patch;
}
export function elementReadback(kind, document) {
  return STUDIO_ELEMENTS.filter(row => row.path.startsWith(`${kind}.`) && row.agentExposure === 'patch').map(element => {
    const value = readElement(document, element.path), path = element.path;
    if (value === null || value === undefined || value === '') return { path, text: null };
    if (element.type === 'image') return { path, bytes: utf8ByteLength(value) };
    return { path, [typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'flag' : 'text']: value };
  });
}
export function registerElementSet(registry, ports, declaration, normalize) {
  const kind = declaration.undoDomain;
  registry.register({ ...declaration, available: () => true, run(args) {
    const domain = ports[kind]();
    domain.write(normalize(mergeElementSet(domain.read(), args)));
    return { affectedIds: [ports.state().activeSceneId], summary: `Updated ${kind}.` };
  } });
}
