// Scene object commands: attachment, duplication and asset import.
import { studioActionDeclaration } from "../studio-actions.js";

export const declarations = Object.freeze(["object.attach", "object.detach", "object.duplicate", "asset.import"].map(studioActionDeclaration));
