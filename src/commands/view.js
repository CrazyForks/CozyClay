// Viewer preferences: transient, like the View menu they mirror.
import { studioActionDeclaration } from "../studio-actions.js";

export const declarations = Object.freeze(["view.setPartColours", "view.setGuideMode", "view.setInset"].map(studioActionDeclaration));

export function register(registry, ports) {
	const viewAction = (id, run) => registry.register({ ...studioActionDeclaration(id), available: () => true,
		run: args => ({ affectedIds: [], summary: run(args) }) });
	viewAction("view.setPartColours", ({ mode }) => { ports.choosePartColours(mode); return `Part colours: ${mode}.`; });
	viewAction("view.setGuideMode", ({ mode }) => { ports.setGuideMode(mode); return `Composition guide: ${mode}.`; });
	viewAction("view.setInset", ({ collapsed }) => { ports.setInsetCollapsed(collapsed); return `Top-View inset ${collapsed ? "folded" : "unfolded"}.`; });
}
