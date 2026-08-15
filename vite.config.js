import { defineConfig } from "vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

export default defineConfig({
	// Root-absolute on purpose: the site has its own apex domain, and the studio
	// is served from "/app/" while its public assets stay at the root. A relative
	// base would resolve those to "/app/models/..." and 404.
	base: "/",
	build: {
		rollupOptions: {
			input: {
				// The crawlable landing page: static HTML, no bundle.
				landing: resolve(import.meta.dirname, "index.html"),
				// The studio itself.
				app: resolve(import.meta.dirname, "app/index.html"),
				// Search-facing article on camera control for AI video.
				aiCameraControl: resolve(import.meta.dirname, "ai-camera-control/index.html"),
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
