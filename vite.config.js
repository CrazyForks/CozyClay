import { defineConfig } from "vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

export default defineConfig({
	// Keep emitted URLs portable when the static build is hosted below a path.
	base: "./",
	build: {
		rollupOptions: {
			input: {
				studio: resolve(import.meta.dirname, "index.html"),
				legacyAppRedirect: resolve(import.meta.dirname, "app/index.html"),
			},
		},
	},
	plugins: [react()],
	server: {
		port: 5180,
		// Dev-only: the ARDY sidecar (tools/ardy/bridge.mjs) is an optional
		// companion on 127.0.0.1:5181. The production build stays fully static
		// (`base: "./"`, no build-time coupling), so this proxy must never be
		// promoted into a server-side requirement.
		proxy: {
			"/ardy": "http://127.0.0.1:5181",
			"/generation": "http://127.0.0.1:5182",
		},
	},
});
