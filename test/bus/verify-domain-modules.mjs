import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseSync } from 'rolldown/experimental';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else walk(value, visit);
  }
}
function parse(path) {
  const result = parseSync(path, read(path));
  assert.deepEqual(result.errors, [], path);
  return result.program;
}
function stateNames(ast) {
  const names = [];
  walk(ast, node => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'ArrayPattern'
      && ['useState', 'useSemanticState'].includes(node.init?.callee?.name)) names.push(node.id.elements[0].name);
  });
  return names;
}
const domains = {
  objects: { states: ['sceneObjects'], panels: ['PropsPanel', 'ObjectTransformPanel'] },
  scenes: { states: ['scenes', 'activeSceneId', 'projectName', 'projectDirty'], panels: ['ProjectPanel'] },
  stage: { states: ['preset', 'shotAspectKey', 'environmentImage', 'cameraPresetId', 'sensorId', 'keyLight', 'hasEnvSheet', 'environment', 'style'], panels: ['LightPanel', 'EnvironmentPanel'] },
};
// Existing source-driven integration fixtures follow the moved implementation,
// not a copy of it. Keep source text intact except for the extra default exports.
export function readStudioSource() {
  const paths = ['src/App.jsx', ...['domains', 'panels'].flatMap(directory =>
    readdirSync(new URL(`src/${directory}/`, root)).filter(name => /\.(js|jsx)$/.test(name)).map(name => `src/${directory}/${name}`))];
  return paths.map(path => read(path).replace(/export default /g, '')).join('\n');
}

export function readStudioFunction(name) {
  const source = readStudioSource();
  let found;
  walk(parseSync('studio.jsx', source).program, node => {
    if (node.type === 'FunctionDeclaration' && node.id.name === name) found = node;
  });
  assert(found, `studio function ${name}`);
  return source.slice(found.start, found.end);
}

// Resolve lexical references rather than treating property names or callback
// parameters as dependencies. Also used when following source-based fixtures.
export function freeReferences(rootNode) {
  const references = [];
  const bindings = (node, names) => {
    if (!node) return;
    if (node.type === 'Identifier') names.add(node.name);
    else if (node.type === 'RestElement') bindings(node.argument, names);
    else if (node.type === 'AssignmentPattern') bindings(node.left, names);
    else if (node.type === 'ArrayPattern') node.elements.forEach(n => bindings(n, names));
    else if (node.type === 'ObjectPattern') node.properties.forEach(n => bindings(n.value ?? n.argument, names));
  };
  const collect = (node, names) => {
    if (!node || typeof node !== 'object') return;
    if (/Function/.test(node.type)) { if (node.id) names.add(node.id.name); return; }
    if (node.type === 'VariableDeclarator') bindings(node.id, names);
    if (node.type === 'ImportDeclaration') node.specifiers.forEach(n => names.add(n.local.name));
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue;
      if (Array.isArray(value)) value.forEach(n => collect(n, names));
      else if (value && typeof value === 'object') collect(value, names);
    }
  };
  function visit(node, scopes = [], parent = null, key = '') {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Program' || /Function/.test(node.type) || node.type === 'CatchClause') {
      const names = new Set();
      if (node.id) bindings(node.id, names);
      (node.params ?? []).forEach(n => bindings(n, names));
      if (node.param) bindings(node.param, names);
      collect(node.body, names);
      scopes = [...scopes, names];
    }
    if (node.type === 'Identifier' || node.type === 'JSXIdentifier') {
      if (node.type === 'JSXIdentifier' && (!/^[A-Z]/.test(node.name) || parent?.type === 'JSXAttribute')) return;
      if ((parent?.type === 'MemberExpression' && key === 'property' && !parent.computed)
        || (parent?.type === 'Property' && key === 'key' && !parent.computed)
        || (parent?.type === 'VariableDeclarator' && key === 'id')
        || (parent?.type?.startsWith('Import')) || key === 'label') return;
      if (!scopes.some(names => names.has(node.name))) references.push({ node, parent, key });
      return;
    }
    for (const [childKey, value] of Object.entries(node)) {
      if (childKey === 'parent' || childKey === 'id' || childKey === 'params' || childKey === 'param') continue;
      if (Array.isArray(value)) value.forEach(n => visit(n, scopes, node, childKey));
      else visit(value, scopes, node, childKey);
    }
    // Defaults execute in the function scope, while binding identifiers do not.
    for (const param of node.params ?? []) if (param.type === 'AssignmentPattern') visit(param.right, scopes, param, 'right');
  }
  visit(rootNode);
  return references;
}

function verify() {
const app = parse('src/App.jsx');
for (const [domain, { states, panels }] of Object.entries(domains)) {
  const path = `src/domains/${domain}.js`;
  assert(existsSync(new URL(path, root)), `acceptance 1: ${path} owns its domain state`);
  const ast = parse(path);
  for (const name of states) {
    assert(!stateNames(app).includes(name), `acceptance 1: ${name} must leave App.jsx`);
    assert(stateNames(ast).includes(name), `acceptance 1: ${name} must live in ${path}`);
  }
  if (domain === 'objects') {
    let owner = false, remaining = false;
    walk(ast, node => { if (node.type === 'VariableDeclarator' && node.id.name === 'storeRef') owner = true; });
    walk(app, node => { if (node.type === 'VariableDeclarator' && node.id.name === 'storeRef') remaining = true; });
    assert(owner && !remaining, 'acceptance 1: the scene-history storeRef belongs to useObjects');
  }
  const globals = new Set(['window', 'document', 'localStorage', 'globalThis', 'console', 'fetch', 'navigator', 'crypto', 'URL', 'URLSearchParams', 'File', 'FileReader', 'Blob', 'Image', 'HTMLElement', 'Element', 'CustomEvent', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'AbortController', 'performance', 'createImageBitmap', 'undefined', 'NaN', 'Infinity', ...Object.getOwnPropertyNames(globalThis)]);
  assert.deepEqual([...new Set(freeReferences(ast).map(ref => ref.node.name))].filter(name => !globals.has(name)), [], `acceptance 2: all shared dependencies in ${path} resolve through the facade`);
  const hooks = [];
  walk(ast, node => {
    if (node.type === 'ImportDeclaration') assert(!/(?:^|\/)domains\/|^\.\/(?:stage|scenes|objects|shots|cast|motion)\.js$/.test(node.source.value), `acceptance 2: no cross-domain import in ${path}`);
    if (node.type === 'Identifier') assert(!['opClockRef', 'charHistoryRef'].includes(node.name), `acceptance 2: ${node.name} bypasses the facade`);
    if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration') hooks.push(node.declaration.id.name);
  });
  assert(hooks.includes(`use${domain[0].toUpperCase()}${domain.slice(1)}`), `acceptance 2: exported ${domain} hook`);
  for (const panel of panels) {
    const panelPath = `src/panels/${panel}.jsx`;
    assert(existsSync(new URL(panelPath, root)), `acceptance 3: ${panel} has its own panel file`);
    const panelAst = parse(panelPath);
    const elements = [];
    walk(panelAst, node => { if (node.type === 'JSXOpeningElement') elements.push(node.name.name); });
    assert(elements.includes(panel === 'ProjectPanel' ? 'ResourceStatus' : 'Foldout'), `acceptance 3: ${panel} owns its section, not a children passthrough`);
    let rendered = false;
    walk(app, node => { if (node.type === 'JSXOpeningElement' && node.name.name === panel) rendered = true; });
    assert(rendered, `acceptance 3: App renders ${panel}`);
  }
  console.log(`PASS domain ${domain}: state ownership, facade isolation, Inspector panels`);
}
const lines = read('src/App.jsx').split('\n').length - 1;
assert(lines <= 15613 - 50 * Object.keys(domains).length, `acceptance 4: App.jsx shrinks with each domain (${lines} lines)`);
console.log(`PASS domain metric: App.jsx 15613 -> ${lines} lines`);
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) verify();
