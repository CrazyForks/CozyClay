// Motion commands: generating the active character's take.
import { studioActionDeclaration } from "../studio-actions.js";

export const declarations = Object.freeze(["motion.generateAllBlocks", "motion.generateFromVideo"].map(studioActionDeclaration));
