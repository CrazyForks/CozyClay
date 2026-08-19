import { defineConfig } from "vite";

/** The bench builds to a single self-contained page: one HTML file with the
 * bundle and the styles inlined, so it can be published or opened from disk
 * without a server. `npm run demo:cutout:build` runs this, then inline.mjs. */
export default defineConfig({
	root: new URL(".", import.meta.url).pathname,
	base: "./",
	build: {
		outDir: new URL("../../dist-demo/cutout/", import.meta.url).pathname,
		emptyOutDir: true,
		cssCodeSplit: false,
		assetsInlineLimit: 1024 * 1024,
		rollupOptions: { output: { inlineDynamicImports: true } },
	},
});
