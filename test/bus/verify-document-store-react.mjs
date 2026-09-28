import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'vite';
import { useDocumentStore, useDocumentDomain } from '../../src/store/use-document-store.js';
import { createLegacyAdapter } from '../../src/store/legacy-adapter.js';
import { documentFixture } from './document-store-fixture.mjs';

let legacyValue = 1;
const legacy = createLegacyAdapter({ cast: { read: () => legacyValue } });
const { store, bus, run } = documentFixture({ legacy });
function Read() {
  const snapshot = useDocumentStore(store);
  const stage = useDocumentDomain(store, 'stage');
  const cast = useDocumentDomain(store, 'cast');
  return createElement('output', { 'data-revision': snapshot.revision, 'data-stage': stage.intensity, 'data-cast': cast });
}
try {
  const render = () => Object.fromEntries([...renderToStaticMarkup(createElement(Read)).matchAll(/data-(\w+)="(\d+)"/g)].map(([, name, value]) => [name, Number(value)]));
  assert.deepEqual(render(), { revision: 0, stage: 1, cast: 1 });
  run('stage.set', { value: 4 }); legacyValue = 7;
  assert.deepEqual(render(), { revision: 1, stage: 4, cast: 7 });
  assert.deepEqual(store.getSnapshot().slices, { stage: { intensity: 4 }, shot: { frame: 0 } });
  const entries = {
    store: new URL('../../src/document-store.js', import.meta.url).pathname,
    legacy: new URL('../../src/store/legacy-adapter.js', import.meta.url).pathname,
    runtime: new URL('../../src/store/runtime-adapters.js', import.meta.url).pathname,
    react: new URL('../../src/store/use-document-store.js', import.meta.url).pathname,
  };
  // App deliberately imports none of these yet. Bundle the future integration
  // surface explicitly, so an otherwise-green App build cannot conceal errors.
  const bundle = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false,
    lib: { entry: entries, formats: ['es'] }, rollupOptions: { external: ['react', 'three'] } } });
  const output = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(result => result.output);
  for (const [name, entry] of Object.entries(entries)) {
    assert.ok(output.some(chunk => chunk.type === 'chunk' && chunk.facadeModuleId === entry && chunk.exports.length > 0), `bundled ${name} entry exports its API`);
  }
} finally { bus.dispose(); store.dispose(); legacy.dispose(); }
console.log('PASS document store 8: React external-store reads and all new public modules bundle for the browser');
