// The editor's Studio actions: ONE registry whose entries call the same
// handlers the UI controls call, so a timeline button and the agent's
// run_action share one code path. Each command module registers its own
// actions over `ports`, the one generic port object App refreshes on every
// render; `ports.state()` reads the synchronously published document, so an
// action sees its own edit at once.
import { createStudioActionRegistry } from "../studio-actions.js";
import * as shot from "./shot.js";
import * as cast from "./cast.js";
import * as motion from "./motion.js";
import * as objects from "./objects.js";
import * as view from "./view.js";
import * as scene from "./scene.js";
import * as project from "./project.js";
import * as exporting from "./export.js";
import * as ai from "./ai.js";
import * as stage from "./stage.js";

export const COMMAND_MODULES = Object.freeze({ shot, cast, motion, objects, view, scene, project, export: exporting, ai, stage });

export function createStudioAppActions(ports) {
	const registry = createStudioActionRegistry({ readState: () => ports.state() });
	const aliases = new Map();
	registry.registerToolAlias = (tool, action, args = value => value) => {
		if (aliases.has(tool)) throw new Error(`Tool alias already registered: ${tool}`);
		aliases.set(tool, { action, args });
	};
	registry.toolAlias = tool => aliases.get(tool);
	for (const module of Object.values(COMMAND_MODULES)) module.register(registry, ports);
	return registry;
}
