import { randomUUID } from "node:crypto";

import { WebSocket, WebSocketServer } from "ws";

export const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
export const LOAD_MOTION_TIMEOUT_MS = 30_000;

const mutationCommands = new Set([
	"set_camera",
	"add_character",
	"update_character",
	"remove_character",
	"place_object",
	"update_object",
	"remove_object",
	"group_objects",
	"ungroup_objects",
	"apply_batch",
	"set_prompt_blocks",
	"load_motion",
	"load_scenes",
]);

export class LiveMutationUncertainError extends Error {}

/**
 * Transport-only implementation of LIVE-PROTOCOL.md. Scene semantics remain
 * with the editor and the server's existing CozyClay imports.
 */
export class LiveHub {
	constructor(server = null) {
		this.server = server;
		this.editors = new Map();
		this.pending = new Map();
	}

	get connected() {
		return this.editors.size > 0;
	}

	get workspaceHandles() {
		return [...this.editors.keys()];
	}

	resolveWorkspace(name, workspaceHandle) {
		if (workspaceHandle !== undefined) {
			const socket = this.editors.get(workspaceHandle);
			if (socket?.readyState === WebSocket.OPEN) return workspaceHandle;
			throw new Error(`Unknown or stale live workspace handle "${workspaceHandle}".`);
		}
		const handles = this.workspaceHandles;
		if (handles.length === 0) throw new Error("No live editor is connected.");
		if (handles.length === 1) return handles[0];
		throw new Error(`Live command ${name} requires workspace_handle; connected workspaces: ${handles.join(", ")}.`);
	}

	static commandTimeoutMs(name) {
		return name === "load_motion" ? LOAD_MOTION_TIMEOUT_MS : DEFAULT_COMMAND_TIMEOUT_MS;
	}

	static commandMayMutate(name) {
		return mutationCommands.has(name);
	}

	async command(name, args, workspaceHandle) {
		const handle = this.resolveWorkspace(name, workspaceHandle);
		const socket = this.editors.get(handle);
		if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error(`Unknown or stale live workspace handle "${handle}".`);

		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				const message = `Live editor timed out running ${name}.`;
				reject(
					LiveHub.commandMayMutate(name)
						? new LiveMutationUncertainError(`${message} The mutation may have been applied. Do not retry it; describe the scene before choosing a recovery action.`)
						: new Error(message),
				);
			}, LiveHub.commandTimeoutMs(name));
			this.pending.set(id, { name, socket, resolve, reject, timer });
			try {
				socket.send(JSON.stringify({ type: "cmd", id, name, args }));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new Error(`Could not send ${name} to the live editor: ${error.message}`));
			}
		});
	}

	accept(socket) {
		let greeted = false;
		socket.on("message", (message, isBinary) => {
			if (isBinary) return;
			let frame;
			try {
				frame = JSON.parse(message.toString());
			} catch {
				return;
			}
			if (!greeted) {
				if (frame?.type !== "hello" || frame.role !== "editor" || frame.version !== 1) {
					socket.close(1002, "Expected editor hello version 1");
					return;
				}
				greeted = true;
				const workspaceHandle = randomUUID();
				this.editors.set(workspaceHandle, socket);
				socket.send(JSON.stringify({ type: "workspace", handle: workspaceHandle }));
				return;
			}
			if (frame?.type !== "result" || typeof frame.id !== "string") return;
			const pending = this.pending.get(frame.id);
			if (!pending || pending.socket !== socket) return;
			clearTimeout(pending.timer);
			this.pending.delete(frame.id);
			if (frame.ok === true) pending.resolve(frame.value);
			else pending.reject(new Error(typeof frame.error === "string" ? frame.error : "Live editor rejected the command."));
		});
		socket.on("close", () => this.disconnect(socket));
		socket.on("error", () => this.disconnect(socket));
	}

	disconnect(socket) {
		for (const [handle, editor] of this.editors) {
			if (editor === socket) this.editors.delete(handle);
		}
		for (const [id, pending] of this.pending) {
			if (pending.socket !== socket) continue;
			clearTimeout(pending.timer);
			this.pending.delete(id);
			const message = "Live editor disconnected while a command was running.";
			pending.reject(
				LiveHub.commandMayMutate(pending.name)
					? new LiveMutationUncertainError(`${message} The mutation may have been applied. Do not retry it; describe the scene before choosing a recovery action.`)
					: new Error(message),
			);
		}
	}
}

/** Bind only to loopback. A taken port is an intentional memory-only mode. */
export async function startLiveHub(port) {
	let server;
	try {
		server = new WebSocketServer({ host: "127.0.0.1", port, path: "/live" });
		await new Promise((resolve, reject) => {
			server.once("listening", resolve);
			server.once("error", reject);
		});
	} catch (error) {
		if (server) server.close();
		if (error?.code === "EADDRINUSE") return null;
		throw error;
	}
	const hub = new LiveHub(server);
	server.on("connection", (socket) => hub.accept(socket));
	return hub;
}
