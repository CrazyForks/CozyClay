/**
 * Runner selection for the generation bridge.
 *
 * Two independent choices, in order.
 *
 * 1. WHICH MODEL generates:
 *
 *      CCLAY_MOTION_BACKEND=ardy | kimodo   explicit choice
 *      (unset)                              kimodo
 *
 *    Kimodo is the default. ARDY remains available as an explicit legacy
 *    choice. Kimodo always runs on a box (it ships no local mode here), so
 *    CCLAY_ARDY_MODE does not apply to it.
 *
 * 2. WHERE ARDY runs, unchanged:
 *
 *      CCLAY_ARDY_MODE=local | remote   explicit choice
 *      (unset)                          remote when CCLAY_ARDY_HOST is set,
 *                                       local otherwise
 *
 * ARDY operators must opt in explicitly; Kimodo operators configure
 * CCLAY_KIMODO_HOST and use the Kimodo box installer.
 */

import { createKimodoRunner } from "../../kimodo/runner.mjs";
import { createLocalRunner } from "./local.mjs";
import { createRemoteRunner } from "./remote.mjs";

export function createRunner() {
	const backend = (process.env.CCLAY_MOTION_BACKEND || "").trim().toLowerCase();
	if (backend && backend !== "ardy" && backend !== "kimodo") {
		throw new Error(`unknown CCLAY_MOTION_BACKEND "${backend}" (expected "ardy" or "kimodo")`);
	}
	if (!backend) return createKimodoRunner();
	if (backend === "kimodo") return createKimodoRunner();

	const mode = (process.env.CCLAY_ARDY_MODE || "").trim().toLowerCase();
	if (mode === "remote") return createRemoteRunner();
	if (mode === "local") return createLocalRunner();
	if (mode) throw new Error(`unknown CCLAY_ARDY_MODE "${mode}" (expected "local" or "remote")`);
	return process.env.CCLAY_ARDY_HOST?.trim() ? createRemoteRunner() : createLocalRunner();
}
