// Viewer preferences: transient, like the View menu they mirror.
import { studioActionDeclaration } from "../studio-actions.js";

export const declarations = Object.freeze(["view.setPartColours", "view.setGuideMode", "view.setInset"].map(studioActionDeclaration));
