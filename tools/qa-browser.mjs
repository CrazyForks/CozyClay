#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	installSignalCleanup,
	spawnOwned,
	terminateOwned,
	waitForExit,
} from "./process-supervisor.mjs";

const separator = process.argv.indexOf("--");
const command = separator >= 0 ? process.argv[separator + 1] : null;
const commandArgs = separator >= 0 ? process.argv.slice(separator + 2) : [];
if (!command) {
	console.error("usage: node tools/qa-browser.mjs -- <command> [...args]");
	process.exit(2);
}

const chromeCandidates = [
	process.env.CHROME_PATH,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
].filter(Boolean);
const chromePath = chromeCandidates.find(existsSync);
if (!chromePath) throw new Error("Google Chrome/Chromium not found; set CHROME_PATH");

const port = Number(process.env.CDP_PORT || 9222);
const pageUrl = process.env.QA_URL || "http://127.0.0.1:5180/";
const cdpUrl = `http://127.0.0.1:${port}/json/version`;
try {
	await fetch(cdpUrl);
	throw new Error(`CDP port ${port} is already in use; stop the existing QA browser first`);
} catch (error) {
	if (!String(error?.message).includes("fetch failed")) throw error;
}

	const profileDir = mkdtempSync(join(tmpdir(), "cozyclay-qa-"));
const children = [];
let removeSignalCleanup = () => {};
const cleanupProfile = () => rmSync(profileDir, { recursive: true, force: true });

try {
	const chrome = spawnOwned(chromePath, [
		"--headless=new",
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profileDir}`,
		"--window-size=1600,1000",
		pageUrl,
	]);
	children.push(chrome);
	removeSignalCleanup = installSignalCleanup(() => children, cleanupProfile);

	const deadline = Date.now() + 10000;
	while (true) {
		if (chrome.exitCode !== null || chrome.signalCode !== null) {
			throw new Error("QA browser exited before CDP became ready");
		}
		try {
			const response = await fetch(cdpUrl);
			if (response.ok) break;
		} catch {
			// Browser startup is asynchronous; retry within the bounded deadline.
		}
		if (Date.now() >= deadline) throw new Error("QA browser CDP startup timed out");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	const runner = spawnOwned(command, commandArgs, {
		env: { ...process.env, CDP_PORT: String(port) },
	});
	children.push(runner);
	const first = await Promise.race([
		waitForExit(runner).then((result) => ({ owner: "runner", ...result })),
		waitForExit(chrome).then((result) => ({ owner: "chrome", ...result })),
	]);
	if (first.owner === "chrome") await terminateOwned(runner);
	process.exitCode = first.owner === "runner" ? (first.code ?? 1) : 1;
} finally {
	removeSignalCleanup();
	await Promise.allSettled(children.map((child) => terminateOwned(child)));
	cleanupProfile();
}
