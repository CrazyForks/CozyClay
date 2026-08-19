import { defineConfig } from "vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

const ardyBridgeUrl =
	process.env.CCLAY_ARDY_BRIDGE_URL || "http://127.0.0.1:5181";

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
			// Only the routes the bridge actually owns. /ardy/ is ALSO a public
			// asset directory (cskel27-rest.json), and a blanket proxy would
			// hand those static files to the bridge, which 404s them.
			"/ardy": {
				target: ardyBridgeUrl,
				bypass(req) {
					const path = (req.url || "").split("?")[0];
					if (/^\/ardy\/(health|bases|generate|footage|extract|motions)(\/|$)/.test(path)) return undefined;
					return req.url; // not a bridge route: serve the static asset
				},
			},
			"/generation": "http://127.0.0.1:5182",
		},
	},
});
