import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Second build entry for the ingest surface (plan 6, I1): the default build
// (vite.config.js) must stay free of src/ingest modules, so the surface gets its
// own config and its own outDir. The real surface is Phase 4; this config only
// needs to keep the scaffold buildable until then.
export default defineConfig({
	base: "./",
	build: {
		outDir: "dist-ingest",
		emptyOutDir: true,
		// The app's public/ assets belong to dist/; the surface artifact carries
		// only its own entry until Phase 4 decides what else it needs.
		copyPublicDir: false,
		rollupOptions: {
			input: fileURLToPath(new URL("./src/ingest/index.html", import.meta.url)),
		},
	},
});
