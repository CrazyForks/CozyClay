import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { appFixture } from './app-fixture.mjs';

// Mount the shipped hook, then use the shipped App native functions, registry
// and binding. Only React rendering and renderer hardware are supplied here.
const defaults = readFileSync(new URL('../../src/app-stage.jsx', import.meta.url), 'utf8').match(/export const DEFAULT_ENVIRONMENT = .*;/)[0];
const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom',
  plugins: [{ name: 'stage-default-without-renderer', enforce: 'pre',
    load(id) { if (id.endsWith('/src/app-stage.jsx')) return defaults; } }],
});
let useStage;
try { ({ useStage } = await server.ssrLoadModule('/src/domains/stage.js')); }
finally { await server.close(); }
export function stageFixture() {
  const f = appFixture();
  let stage;
  function Mount() {
    stage = useStage(f.scope.appContext.forRender({
      startupStage: f.live.current.stage,
      get actorStageRef() { return f.scope.actorStageRef; },
    }));
    return null;
  }
  f.scope.actorStageRef = { current: structuredClone(f.live.current.stage) };
  renderToStaticMarkup(createElement(Mount));
  Object.assign(f.scope, stage);
  f.ports.stage = () => stage;
  f.actionHandlers.current.stage = () => stage;
  const canUndo = f.ports.canUndo;
  f.ports.canUndo = receipt => stage.canUndo?.(receipt.undo?.historyEntryId) ?? canUndo(receipt);
  const run = (id, args = {}, origin = 'ui', options = {}) => f.binding.bus.run(id, args, {
    origin, host: f.host(), expectedRevision: f.binding.refresh().revision, ...options,
  });
  return { ...f, stage, run, dispose() { f.dispose(); stage.dispose?.(); } };
}
