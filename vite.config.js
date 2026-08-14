import { defineConfig } from "vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

export default defineConfig({
	// Root-absolute on purpose: the site is served from its own apex domain
	// (cozyclay.org), so emitted assets and public files resolve from "/"
	// regardless of which page loads them — the landing at "/" or the studio
	// at "/app/".
	base: "/",
	build: {
		rollupOptions: {
			input: {
				// The crawlable landing page: static HTML, no bundle.
				landing: resolve(__dirname, "index.html"),
				// The studio itself.
				app: resolve(__dirname, "app/index.html"),
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
		},
	},
});
