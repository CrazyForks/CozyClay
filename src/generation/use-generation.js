import { useCallback, useEffect, useRef, useState } from "react";
import { checkGenerationBridge, listGenerationModels } from "./client.js";
import { runGeneration } from "./session.js";
import { compileShotSpec } from "./shot-spec.js";

const IDLE = { status: "idle", job: null, validation: null, error: null };

export function useGeneration() {
  const [models, setModels] = useState([]);
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState(IDLE);
  const abortRef = useRef(null);

  useEffect(() => {
    let live = true;
    Promise.all([checkGenerationBridge(), listGenerationModels()]).then(([health, found]) => {
      if (!live) return;
      setAvailable(Boolean(health.ok && found.some((model) => model.available)));
      setModels(found.filter((model) => model.available));
    }).catch(() => { if (live) setAvailable(false); });
    return () => { live = false; abortRef.current?.abort(); };
  }, []);

  const start = useCallback(async (input) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const spec = compileShotSpec(input);
    try { return await runGeneration(spec, { signal: controller.signal, onUpdate: setState }); }
    finally { if (abortRef.current === controller) abortRef.current = null; }
  }, []);

  const cancel = useCallback(() => abortRef.current?.abort(new Error("generation canceled")), []);
  const reset = useCallback(() => setState(IDLE), []);
  return { available, models, state, start, cancel, reset };
}
