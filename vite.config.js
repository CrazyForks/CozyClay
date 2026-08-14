import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import os from "node:os";
import { readFileSync } from "node:fs";

let ingest = null;
try { ingest = JSON.parse(readFileSync((process.env.XDG_CONFIG_HOME || os.homedir() + "/.config") + "/cozyclay/ingest.json", "utf8")); } catch {}
export default defineConfig({
	base: "./",
	plugins: [react()],
	server: {
		port: 5180,
		headers: { "content-security-policy": "frame-src http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'self'" },
		// Dev-only: the ARDY sidecar (tools/ardy/bridge.mjs) is an optional
		// companion on 127.0.0.1:5181. The production build stays fully static
		// (`base: "./"`, no build-time coupling), so this proxy must never be
		// promoted into a server-side requirement.
		proxy: {
			"/ardy": "http://127.0.0.1:5181",
			...(ingest?.origin ? { "/ingest": ingest.origin } : {}),
		},
	},
});
