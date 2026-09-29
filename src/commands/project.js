// Project commands: the Project menu's Save Project. Only a user's click opens
// the browser's file picker or re-grants a stored file, so without one (the
// agent) a save that would need either is refused before anything is
// attempted. The save path itself shows its own dialog and failures, so
// refusals stay silent.
import { studioActionDeclaration } from "../studio-actions.js";
import { fail } from "./shared.js";

const rename = { id: "project.rename", label: "Rename project", description: "Rename the project in one retained undo entry.", kind: "mutation", undoDomain: "scenes",
	input: { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 240 } }, required: ["name"], additionalProperties: false } };
export const declarations = Object.freeze([rename, ...["project.save"].map(studioActionDeclaration)]);

export function register(registry, ports) {
	registry.register({ ...rename, available: () => Boolean(ports.storeDomain?.("scenes")), run: ({ name }) => {
		if (!name.trim()) fail("INVALID_ARGUMENT", "A project name cannot be blank.");
		const owner = ports.storeDomain("scenes"); owner.renameProject(name);
		return { affectedIds: [owner.metadata().activeSceneId], summary: "Renamed project." };
	} });
	registry.register({ ...studioActionDeclaration("project.save"), available: () => true,
		requiresConfirmation: state => state.project.hasFile || state.project.fileAccess,
		run: async () => {
			const { project } = ports.state();
			if (!project.gesture && project.name !== null && project.fileAccess) {
				if (!project.hasFile) fail("TARGET_NOT_READY", "Not saved: this project has no file this session, and only the user's click can open the file picker to choose one.");
				if (!(await ports.projectFileGranted())) fail("TARGET_NOT_READY", "Not saved: the browser needs the user's click to re-grant access to the project file. Ask them to press Save Project.");
			}
			const saved = await ports.saveProject(false);
			if (saved?.naming) fail("TARGET_NOT_READY", "Not saved: the project has no name yet. The Save dialog is open for the user to name it and pick its file.");
			if (saved?.cancelled) fail("TARGET_NOT_READY", "Not saved: the user closed the file picker.");
			if (!saved?.saved) fail("TARGET_NOT_READY", saved?.failure === "missing-resources" ? "Not saved: some of the project's assets or motions are missing; the editor's save panel lists them."
				: saved?.failure === "resources-too-large" ? "Not saved: the project's embedded resources are too large; the editor's save panel explains."
					: "Not saved: writing the project file failed; the editor showed the error.");
			return { affectedIds: [], output: { fileName: saved.fileName }, summary: saved.downloaded
				? `This browser has no file access, so the project ${saved.name} was downloaded as ${saved.fileName}.`
				: `Saved the project ${saved.name} to ${saved.fileName}.` };
		} });
}
