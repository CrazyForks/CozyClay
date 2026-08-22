import { useCallback, useEffect, useRef, useState } from "react";
import { checkGenerationBridge, listGenerationJobs, listGenerationModels } from "./client.js";
import { generationRequestForResult } from "./generation-request.js";
import { runGeneration } from "./session.js";
import { compileShotSpec } from "./shot-spec.js";

const IDLE = { status: "idle", job: null, validation: null, error: null };

export function useGeneration() {
  const [models, setModels] = useState([]);
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState(IDLE);
  const [history, setHistory] = useState([]);
  const abortRef = useRef(null);

  useEffect(() => {
    let live = true;
    Promise.all([checkGenerationBridge(), listGenerationModels(), listGenerationJobs()]).then(([health, found, jobs]) => {
      if (!live) return;
      setAvailable(Boolean(health.ok && found.some((model) => model.available)));
      setModels(found.filter((model) => model.available));
      setHistory(jobs);
    }).catch(() => { if (live) setAvailable(false); });
    return () => { live = false; abortRef.current?.abort(); };
  }, []);

  const start = useCallback(async (input) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const spec = compileShotSpec(input);
    try { return await runGeneration(spec, { signal: controller.signal, onUpdate: setState }); }
    finally {
      listGenerationJobs().then(setHistory).catch(() => {});
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  const startResult = useCallback((result, model) => start(generationRequestForResult(result, model)), [start]);

  const cancel = useCallback(() => abortRef.current?.abort(new Error("generation canceled")), []);
  const reset = useCallback(() => setState(IDLE), []);
  return { available, models, history, state, start, startResult, cancel, reset };
}
