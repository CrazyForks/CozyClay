// Shared set/read machinery. Domain modules supply only their kind, declared
// fields and persistence normalizer; no UI or runtime resources live here.
import { STUDIO_ELEMENTS } from '../studio-elements.js';
import { patchValueSchema } from '../studio-agent-protocol.js';

const object = () => ({ type: 'object', properties: {}, required: [], additionalProperties: false });
export function elementSetSchema(kind) {
  const schema = object();
  for (const element of STUDIO_ELEMENTS.filter(row => row.path.startsWith(`${kind}.`) && row.agentExposure === 'patch')) {
    const keys = (element.documentPath ?? element.path.slice(kind.length + 1)).split('.');
    let parent = schema;
    for (const key of keys.slice(0, -1)) parent = parent.properties[key] ??= object();
    parent.properties[keys.at(-1)] = patchValueSchema(element);
  }
  return schema;
}
export function readElement(document, path) {
  const element = STUDIO_ELEMENTS.find(row => row.path === path);
  return (element.documentPath ?? path.slice(path.indexOf('.') + 1)).split('.').reduce((value, key) => value?.[key], document);
}
export function mergeElementSet(document, patch) {
  const next = { ...document };
  for (const [key, value] of Object.entries(patch)) next[key] = value && typeof value === 'object' && !Array.isArray(value)
    ? mergeElementSet(document[key], value) : value;
  return next;
}
export function registerElementSet(registry, ports, declaration, normalize) {
  const kind = declaration.undoDomain;
  registry.register({ ...declaration, available: () => true, run(args) {
    const domain = ports[kind]();
    domain.write(normalize(mergeElementSet(domain.read(), args)));
    return { affectedIds: [ports.state().activeSceneId], summary: `Updated ${kind}.` };
  } });
}
