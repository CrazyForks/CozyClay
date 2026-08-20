import { spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const PKG_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PACKAGE_VERSION = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(join(PKG_ROOT, "package.json"), "utf8"))).version;
const MCP_RUNTIME_SOURCE = join(PKG_ROOT, "mcp", "runtime");
const MCP_RUNTIME = process.env.COZYCLAY_MCP_RUNTIME_DIR || join(
	process.env.XDG_CACHE_HOME || process.env.LOCALAPPDATA || join(homedir(), ".cache"),
	"cozyclay",
	"mcp-runtime",
	PACKAGE_VERSION,
);

function probeMcpRuntime() {
	const runtimeRequire = createRequire(join(MCP_RUNTIME, "package.json"));
	for (const dependency of ["@modelcontextprotocol/sdk/server/mcp.js", "three", "ws", "zod"]) runtimeRequire.resolve(dependency);
	return join(MCP_RUNTIME, "mcp", "server.mjs");
}

function installMcpRuntime() {
	return new Promise((done) => {
		mkdirSync(MCP_RUNTIME, { recursive: true });
		rmSync(join(MCP_RUNTIME, "mcp"), { recursive: true, force: true });
		rmSync(join(MCP_RUNTIME, "src"), { recursive: true, force: true });
		copyFileSync(join(MCP_RUNTIME_SOURCE, "package.json"), join(MCP_RUNTIME, "package.json"));
		copyFileSync(join(MCP_RUNTIME_SOURCE, "package-lock.json"), join(MCP_RUNTIME, "package-lock.json"));
		cpSync(join(PKG_ROOT, "mcp"), join(MCP_RUNTIME, "mcp"), { recursive: true });
		cpSync(join(PKG_ROOT, "src"), join(MCP_RUNTIME, "src"), { recursive: true });

		const npm = process.platform === "win32" ? "npm.cmd" : "npm";
		const child = spawn(npm, ["ci", "--no-audit", "--no-fund"], {
			cwd: MCP_RUNTIME,
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32",
		});
		child.stdout.pipe(process.stderr);
		child.stderr.pipe(process.stderr);
		child.on("error", (error) => done({ code: 1, error }));
		child.on("exit", (code) => done({ code: code ?? 1 }));
	});
}

export async function runMcp(rest) {
	if (!existsSync(join(PKG_ROOT, "mcp", "server.mjs")) || !existsSync(join(MCP_RUNTIME_SOURCE, "package-lock.json"))) {
		console.error("cozyclay: this build does not include the MCP server runtime.");
		process.exit(1);
	}

	let server;
	try {
		server = probeMcpRuntime();
	} catch {
		console.error("cozyclay: installing MCP server dependencies (one-time per CozyClay version)...");
		const result = await installMcpRuntime();
		if (result.code !== 0) {
			console.error(`cozyclay: npm ci failed${result.error ? `: ${result.error.message}` : ` (exit ${result.code})`}. Check your network connection and retry.`);
			console.error(`cozyclay: the published package was not changed; remove ${JSON.stringify(MCP_RUNTIME)} before retrying a damaged cache.`);
			process.exit(1);
		}
		try {
			server = probeMcpRuntime();
		} catch (error) {
			console.error(`cozyclay: MCP runtime is incomplete after npm ci: ${error.message}`);
			process.exit(1);
		}
	}
	const child = spawn(process.execPath, [server, ...rest], { stdio: "inherit" });
	child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
}
