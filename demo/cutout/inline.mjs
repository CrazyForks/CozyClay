#!/usr/bin/env node
/**
 * Fold the built bench into one file: the bundle and the stylesheet go inline,
 * the Google Fonts link stays (the only host a published artifact may reach).
 * Output: dist-demo/cutout-bench.html
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const out = new URL("../../dist-demo/cutout/", import.meta.url).pathname;
const assets = join(out, "assets");
const files = readdirSync(assets);
const js = files.find((name) => name.endsWith(".js"));
const css = files.find((name) => name.endsWith(".css"));
if (!js) throw new Error("no bundle in dist-demo/cutout/assets");

let html = readFileSync(join(out, "index.html"), "utf8");
const script = readFileSync(join(assets, js), "utf8").replaceAll("</script", "<\\/script");
const styles = css ? readFileSync(join(assets, css), "utf8") : "";

// Replacer FUNCTIONS, not strings: a bundle is full of `$` sequences, and
// `$\`` in a replacement string means "everything before the match" — which
// silently injects the whole page header into the middle of the script.
html = html.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/, () => `<script type="module">\n${script}\n</script>`);
html = html.replace(/<link[^>]*rel="stylesheet"[^>]*href="\.[^"]*"[^>]*\/?>/, () => (styles ? `<style>\n${styles}\n</style>` : ""));

const target = new URL("../../dist-demo/cutout-bench.html", import.meta.url).pathname;
writeFileSync(target, html);
console.log(`wrote ${target} (${(html.length / 1024).toFixed(0)} KB)`);
