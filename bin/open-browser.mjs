import { spawn } from "node:child_process";

export function openBrowser(url) {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	const child = spawn(command, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
	child.on("error", () => {
		/* headless box, no browser: the URL is printed anyway */
	});
	child.unref();
}
