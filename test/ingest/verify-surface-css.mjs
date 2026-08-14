#!/usr/bin/env node
/**
 * The scoped-stylesheet gate for the ingest surface (plan §13 commit U2).
 *
 * WHY this test exists: the surface is a document embedded in an iframe the
 * parent controls, and the stylesheet must stay a citizen of its own realm —
 * an unscoped selector is a collision waiting to happen the moment anything
 * else shares the document (or the sheet is hoisted into a shared bundle).
 * The rule is mechanical and unforgiving: every selector must be scoped to
 * the surface root class, so the gate PARSES the stylesheet and fails on any
 * selector that is not. The negative control proves the parse actually
 * catches a bare class — a checker that passes everything would hand the
 * gate a green receipt for an unrun check.
 *
 * What counts as scoped: the selector list of every rule must begin with
 * the root class `.cclay-surface` (followed by end-of-string or one of
 * ` ` `:` `>` `+` `~` `.` `#` `[` — so `.cclay-surfacex` is NOT a scope).
 * Pseudo-selectors like `:root` and element selectors like `html`/`body`
 * are refused too: the surface root div is the only styling root the sheet
 * may name. @media/@supports/@layer/@container/@scope blocks are entered
 * and their inner rules checked; @keyframes/@font-face/@import/@charset
 * hold no selectors and are skipped.
 *
 * Canonical RED: U2 "selector .panel not scoped".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SURFACE_CSS = join(REPO_ROOT, "src", "ingest", "surface.css");
const ROOT_CLASS = "cclay-surface";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

// Strip comments without touching strings: a `/*` inside a quoted string is
// data, not a comment opener.
function stripComments(css) {
	let out = "";
	let quote = null;
	for (let i = 0; i < css.length; i += 1) {
		const ch = css[i];
		if (quote !== null) {
			out += ch;
			if (ch === "\\") {
				out += css[i + 1] ?? "";
				i += 1;
			} else if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			out += ch;
			continue;
		}
		if (ch === "/" && css[i + 1] === "*") {
			const end = css.indexOf("*/", i + 2);
			i = end === -1 ? css.length : end + 1;
			out += " ";
			continue;
		}
		out += ch;
	}
	return out;
}

// Split a selector list on top-level commas: parens (for :is()/:not() and
// attribute selectors) and quoted strings keep their commas.
function splitTopLevel(list) {
	const parts = [];
	let depth = 0;
	let quote = null;
	let start = 0;
	for (let i = 0; i < list.length; i += 1) {
		const ch = list[i];
		if (quote !== null) {
			if (ch === "\\") i += 1;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "(" || ch === "[") depth += 1;
		else if (ch === ")" || ch === "]") depth -= 1;
		else if (ch === "," && depth === 0) {
			parts.push(list.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(list.slice(start));
	return parts;
}

// True when the selector is scoped to the root class: the selector STARTS
// with `.cclay-surface` and the class name ends at a real boundary.
function isScoped(selector, rootClass) {
	const token = "." + rootClass;
	if (!selector.startsWith(token)) return false;
	const rest = selector.slice(token.length);
	if (rest.length === 0) return true;
	return /^[\s:>+~.#\[]/.test(rest);
}

// Returns the list of unscoped selectors (trimmed) found anywhere in the
// stylesheet, including inside @media/@supports/@layer/@container/@scope
// blocks. Rules with an empty prelude (a stray `{}`) contribute nothing.
export function findUnscopedSelectors(css, rootClass) {
	const violations = [];
	const walk = (text) => {
		const body = stripComments(text);
		let i = 0;
		while (i < body.length) {
			const open = body.indexOf("{", i);
			if (open === -1) return;
			// The prelude may itself contain braces inside strings or
			// parens (attribute selectors, :is()): scan forward with the
			// same depth machinery as splitTopLevel, but for `{`/`}`.
			let depth = 0;
			let quote = null;
			let blockStart = -1;
			for (let j = i; j < body.length; j += 1) {
				const ch = body[j];
				if (quote !== null) {
					if (ch === "\\") j += 1;
					else if (ch === quote) quote = null;
					continue;
				}
				if (ch === '"' || ch === "'") {
					quote = ch;
					continue;
				}
				if (ch === "(" || ch === "[") depth += 1;
				else if (ch === ")" || ch === "]") depth -= 1;
				else if (ch === "{") {
					if (depth === 0) {
						blockStart = j;
						break;
					}
				}
			}
			if (blockStart === -1) return;
			const prelude = body.slice(i, blockStart).trim();
			// The matching close brace: track nested braces (nesting of
			// normal rules is legal in modern CSS).
			let close = -1;
			let nest = 0;
			let q = null;
			for (let j = blockStart; j < body.length; j += 1) {
				const ch = body[j];
				if (q !== null) {
					if (ch === "\\") j += 1;
					else if (ch === q) q = null;
					continue;
				}
				if (ch === '"' || ch === "'") {
					q = ch;
					continue;
				}
				if (ch === "{") nest += 1;
				else if (ch === "}") {
					nest -= 1;
					if (nest === 0) {
						close = j;
						break;
					}
				}
			}
			if (close === -1) return;
			const block = body.slice(blockStart + 1, close);
			if (prelude.startsWith("@")) {
				// @media/@supports/@layer/@container/@scope hold rules:
				// recurse. @keyframes/@font-face/@import/@charset hold no
				// selectors: skip.
				if (/(^@(media|supports|layer|container|scope)(\s|$))/.test(prelude)) walk(block);
			} else {
				for (const raw of splitTopLevel(prelude)) {
					const selector = raw.trim();
					if (selector.length > 0 && !isScoped(selector, rootClass)) violations.push(selector);
				}
			}
			i = close + 1;
		}
	};
	walk(css);
	return violations;
}

// --- negative controls: the check must be able to fail ----------------------

const barePanel = findUnscopedSelectors(".panel { color: red; }", ROOT_CLASS);
ok("the checker catches a bare .panel (the U2 RED)", barePanel.length === 1 && barePanel[0] === ".panel", JSON.stringify(barePanel));

const elementAndId = findUnscopedSelectors("body { margin: 0 } #root { height: 100% }", ROOT_CLASS);
ok(
	"the checker catches element and id selectors",
	elementAndId.length === 2 && elementAndId.includes("body") && elementAndId.includes("#root"),
	JSON.stringify(elementAndId),
);

const boundaryCase = findUnscopedSelectors(".cclay-surfacex { color: red }", ROOT_CLASS);
ok("a lookalike class name is not a scope", boundaryCase.length === 1, JSON.stringify(boundaryCase));

const scopedSample = findUnscopedSelectors(
	[
		".cclay-surface { color: black }",
		".cclay-surface > .cclay-panel { color: red }",
		".cclay-surface .cclay-log::before { content: \"\" }",
		".cclay-surface[data-x=\"a,b\"] :is(.cclay-a, .cclay-b) { color: blue }",
		".cclay-surface:hover .cclay-stage { color: green }",
		'@media (max-width: 600px) { .cclay-surface .cclay-header { display: none } }',
		"@supports (display: grid) { .cclay-surface .cclay-stages { display: grid } }",
		"@keyframes cclaySurfaceSpin { from { opacity: 0 } to { opacity: 1 } }",
	].join("\n"),
	ROOT_CLASS,
);
ok("fully scoped rules (incl. nested blocks) pass clean", scopedSample.length === 0, JSON.stringify(scopedSample));

// --- the shipped stylesheet --------------------------------------------------

const css = readFileSync(SURFACE_CSS, "utf8");
const violations = findUnscopedSelectors(css, ROOT_CLASS);
ok(
	"every stylesheet selector is scoped to the surface root",
	violations.length === 0,
	violations.map((selector) => `selector ${selector} not scoped`).join(" | "),
);

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
