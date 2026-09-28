// Scene commands: the scene pill's and the Hierarchy scene menu's actions.
import { studioActionDeclaration } from "../studio-actions.js";

export const declarations = Object.freeze(["scene.create", "scene.duplicate", "scene.rename", "scene.delete", "scene.switch"].map(studioActionDeclaration));
