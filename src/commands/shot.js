// Shot commands: the timeline's shot controls and the Top-View camera rail.
import { studioActionDeclaration } from "../studio-actions.js";

export const declarations = Object.freeze(["shot.create", "shot.split", "shot.duplicate", "shot.remove", "shot.setRange", "shot.setCameraRail", "shot.clearCameraRail", "shot.reorder"].map(studioActionDeclaration));
