// Phase-4 placeholder entry for the ingest surface (plan 6, I1). Deliberately
// plain DOM: the real React surface replaces this whole file in Phase 4, so the
// scaffold must not pre-commit to a plugin or component structure.
import { SURFACE_STAGE } from "./state.js";

document.getElementById("root").textContent = `ingest surface ${SURFACE_STAGE}`;
