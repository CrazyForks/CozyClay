#!/usr/bin/env node
/**
 * verify.mjs — drive the MCP server the way a client does.
 *
 * Speaks real MCP over stdio against `server.mjs`, so this exercises the
 * transport, the schemas and the tool handlers together rather than importing
 * the handlers directly and hoping the wiring matches.
 *
 * The framing matrix is the important part: every size/view/level/side the
 * schema accepts must come back labelled the way it was asked for, because
 * `frame_shot` inverts geometry that `shot.js` owns. If shot.js retunes a band,
 * this fails loudly instead of quietly mis-framing.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("./server.mjs", import.meta.url));

const client = new Client({ name: "cozyclay-mcp-verify", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: [SERVER] }));

let failures = 0;
const check = (label, ok, detail = "") => {
	if (!ok) {
		failures += 1;
		console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
	}
};

const call = async (name, args = {}) => {
	const result = await client.callTool({ name, arguments: args });
	return result.content[0].text;
};

const slateOf = (body) => body.split("\n").find((line) => line.includes("·")) ?? "";

/* ------------------------------ tool surface ----------------------------- */

const { tools } = await client.listTools();
check("every tool has a description", tools.every((t) => t.description?.length > 20));
console.log(`${tools.length} tools registered`);

/* ---------------------------- framing matrix ----------------------------- */

const SIZES = [
	"extreme close-up",
	"close-up",
	"medium close-up",
	"medium shot",
	"medium-wide shot",
	"wide shot",
	"extreme wide shot",
];
const VIEWS = ["front", "front three-quarter", "profile", "rear three-quarter", "back"];
const LEVELS = ["ground", "low", "hip", "eye", "high", "overhead"];
const LEVEL_WORD = {
	ground: "ground level",
	low: "knee level",
	hip: "hip level",
	eye: "eye level",
	high: "high angle",
	overhead: "overhead",
};

let combinations = 0;
for (const size of SIZES) {
	for (const view of VIEWS) {
		for (const level of LEVELS) {
			for (const side of ["left", "right"]) {
				combinations += 1;
				const slate = slateOf(await call("frame_shot", { size, view, level, side, focal_mm: 35 }));
				const initial = side === "left" ? "L" : "R";
				const viewOk =
					view === "front"
						? slate.includes("· FRONT ·")
						: view === "back"
							? slate.includes("· BACK ·")
							: view === "profile"
								? slate.includes(`${side.toUpperCase()} PROFILE`)
								: slate.includes(view === "front three-quarter" ? "FRONT ¾" : "REAR ¾") &&
									slate.includes(initial);
				check(`${size} / ${view} / ${level} / ${side}`, slate.toLowerCase().includes(size) && slate.toLowerCase().includes(LEVEL_WORD[level]) && viewOk, slate);
			}
		}
	}
}
console.log(`${combinations} framing combinations checked`);

/* -------------------------------- the cast ------------------------------- */

await call("place_character", { character: "A", subject: "a detective in a wet trench coat" });
await call("add_character", { subject: "a courier holding a package", x: 1.6, z: 0.4, facing: -150 });
await call("add_character", { subject: "a street vendor", x: -2.2, z: 1.1, facing: 70 });

const cast = await call("describe_scene");
check("cast holds three characters", cast.includes("CAST (3)"), cast);
check("third character is labelled C", /^\s+C /m.test(cast), cast);

const focused = await call("focus_character", { character: "B" });
check("focus follows the named character", focused.startsWith("Framing B"), focused.split("\n")[0]);

const byId = await call("place_character", { character: "char-c", facing: 12 });
check("character resolves by id", byId.startsWith("Character C updated"), byId.split("\n")[0]);

const bySlot = await call("place_character", { character: "3", facing: 15 });
check("character resolves by slot", bySlot.startsWith("Character C updated"), bySlot.split("\n")[0]);

check("unknown character is reported", (await call("place_character", { character: "Z" })).startsWith("No character"));

const removed = await call("remove_character", { character: "C" });
check("character removal works", removed.startsWith("Removed C"), removed.split("\n")[0]);
check("cast shrinks after removal", removed.includes("CAST (2)"), removed);

// Down to one character, the scene must refuse to empty its cast.
await call("remove_character", { character: "B" });
const lastOne = await call("remove_character", { character: "A" });
check("last character is protected", lastOne.includes("at least one character"), lastOne);

// Re-cast the pair the prompt checks below rely on.
await call("place_character", { character: "A", subject: "a detective in a wet trench coat" });
await call("add_character", { subject: "a courier holding a package", x: 1.6, z: 0.4, facing: -150 });

/* --------------------------------- the set ------------------------------- */

const placed = await call("place_object", { kind: "chair", x: -1.2, z: 0.6, facing: 30 });
const objectId = placed.match(/as (\S+)\./)?.[1];
check("place_object returns an id", Boolean(objectId), placed.split("\n")[0]);
check("update_object accepts the id", (await call("update_object", { id: objectId, scale: 1.4 })).startsWith("Updated"));
check("unknown object is reported", (await call("update_object", { id: "nope" })).startsWith("No object"));

/* ------------------------------ camera moves ----------------------------- */

check("move needs a mark", (await call("describe_camera_move")).startsWith("No A position"));
await call("frame_shot", { size: "medium close-up", view: "front", level: "eye", focal_mm: 85 });
await call("mark_camera_move");
await call("frame_shot", { size: "wide shot", view: "profile", level: "low", focal_mm: 24 });
const move = await call("describe_camera_move", { duration_s: 4 });
check("move is named", move.split("\n")[0].length > 0, move.split("\n")[0]);

/* --------------------------------- prompts ------------------------------- */

const prompt = await call("render_prompt", {
	mode: "video",
	model: "seedance_2",
	environment: "a rain-slicked Seoul alley at night",
	style: "shot on 35mm film",
	camera_move: "Dolly in",
});
check("prompt carries the framing", prompt.includes("wide shot") && prompt.includes("24mm"), prompt.slice(0, 120));
check("prompt carries both subjects", prompt.includes("detective") && prompt.includes("courier"));

/* ------------------------------- round-trip ------------------------------ */

const file = new URL("./.verify-project.cclayproject", import.meta.url).pathname;
await call("save_project", { path: file, name: "Verify" });
const reopened = await call("open_project", { path: file });
check("project round-trips the cast", reopened.includes("detective") && reopened.includes("courier"), reopened);
check("project round-trips the set", reopened.includes("Chair"), reopened);
await import("node:fs/promises").then((fs) => fs.unlink(file).catch(() => {}));

check("missing file is reported", (await call("open_project", { path: "/tmp/nope.cclayproject" })).startsWith("Could not read"));

/* --------------------------------- result -------------------------------- */

await client.close();
if (failures > 0) {
	console.log(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
