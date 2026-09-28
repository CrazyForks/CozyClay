// Cast commands: a named character's root waypoints and IK key layer.
import { studioActionDeclaration } from "../studio-actions.js";

export const declarations = Object.freeze(["character.addWaypoint", "character.moveWaypoint", "character.removeWaypoint", "character.clearWaypoints", "character.setIkKey", "character.removeIkKey", "character.clearIkKeys"].map(studioActionDeclaration));
