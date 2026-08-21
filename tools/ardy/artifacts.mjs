import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Creates a mode-0700 request directory beneath a mode-0700 artifact root.
 * The atomic mkdtemp allocation makes artifact names unguessable; exclusive
 * ownership prevents a local peer from planting a symlink for a later write.
 */
export function createPrivateArtifactDir(parentDir, label) {
	mkdirSync(parentDir, { recursive: true, mode: 0o700 });
	if (lstatSync(parentDir).isSymbolicLink()) {
		throw new Error(`artifact root must not be a symlink: ${parentDir}`);
	}
	chmodSync(parentDir, 0o700);
	const requestDir = mkdtempSync(join(parentDir, `${label}-`));
	chmodSync(requestDir, 0o700);
	return requestDir;
}

/** Removes a failed request's private artifacts without following contents. */
export function removePrivateArtifactDir(path) {
	rmSync(path, { recursive: true, force: true, maxRetries: 3 });
}
