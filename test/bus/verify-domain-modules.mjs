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
