/**
 * Runner selection for the ARDY bridge.
 *
 * Exactly one backend drives generation for the bridge's lifetime:
 *
 *   CCLAY_ARDY_MODE=local | remote   explicit choice
 *   (unset)                          remote when CCLAY_ARDY_HOST is set,
 *                                    local otherwise
 *
 * so an operator with a configured box keeps today's behavior untouched, and
 * everyone else gets local generation with zero configuration.
 */

import { createLocalRunner } from "./local.mjs";
import { createRemoteRunner } from "./remote.mjs";

export function createRunner() {
	const mode = (process.env.CCLAY_ARDY_MODE || "").trim().toLowerCase();
	if (mode === "remote") return createRemoteRunner();
	if (mode === "local") return createLocalRunner();
	if (mode) throw new Error(`unknown CCLAY_ARDY_MODE "${mode}" (expected "local" or "remote")`);
	return process.env.CCLAY_ARDY_HOST?.trim() ? createRemoteRunner() : createLocalRunner();
}
