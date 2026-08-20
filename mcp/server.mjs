#!/usr/bin/env node
/**
 * cozyclay-mcp — an MCP surface over CozyClay's authoring core.
 *
 * This server owns NO geometry, NO film vocabulary and NO prompt text. Every
 * answer it gives is computed by the same modules the studio renders with,
 * imported straight from the published `cozyclay` package:
 *
 *   shot.js          geometry -> film vocabulary -> prompt
 *   scenes.js        the scene document + its stage envelope
 *   scene-objects.js the set: create/update/remove/normalise
 *   cuts.js          shots on a timeline
 *   camera-move.js   two framings -> a named camera move
 *   project.js       the .cclayproject envelope
 *
 * Running inside the repo, those imports are relative: this server always
 * speaks the working tree's own vocabulary, so a change to shot.js is visible
 * here on the next start with nothing to publish or reinstall.
 *
 * Keeping the maths on the other side of that import is the whole design: the
 * studio and this server can never disagree about what a 35mm medium shot is,
 * because there is only one implementation of it.
 *
 * State is one in-memory scene document plus one camera. `save_project` writes
 * the real `.cclayproject` envelope, so anything authored here opens in the
 * studio, and anything authored in the studio opens here.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

import { startLiveHub } from "./live-hub.mjs";
import { BLOCK_MAX_SECONDS, PROMPT_GUIDE, normalizePhases, splitLongBeat } from "./ardy-prompts.mjs";

import {
	CAMERA_MOVES,
	IMAGE_MODELS,
	VIDEO_MODELS,
	composePrompt,
	deriveShot,
	focalMmToFov,
	fovToFocalMm,
	nearestPrime,
	slateLine,
} from "../src/shot.js";
import {
	CHARACTER_MODEL_IDS,
	activeScene,
	addScene,
	createCharacterEntry,
	createSceneDocument,
	readSceneDocument,
	serializeSceneDocument,
} from "../src/scenes.js";
import {
	OBJECT_LIBRARY,
	createSceneObject,
	objectSize,
	removeSceneObject,
	setSceneObjectParent,
	updateSceneObject,
} from "../src/scene-objects.js";
import { classifyMove, captureFraming, moveSlate } from "../src/camera-move.js";
import { createProjectDocument, readProjectDocument } from "../src/project.js";

/* ------------------------------- state ---------------------------------- */

/** The authoring state. One scene document, one camera, one project name. */
const state = {
	doc: createSceneDocument(),
	name: "Untitled",
	camera: { x: 0, y: 1.6, z: 4.5, focalMm: 35 },
	/** which character the camera frames against; null means the first of the cast */
	focus: null,
	/** framing snapshot taken by `mark_camera_move`, consumed by `describe_camera_move` */
	markedFraming: null,
};

let liveHub = null;

const scene = () => activeScene(state.doc.scenes, state.doc.activeSceneId);
const stage = () => scene().stage;

/** The cast of the active scene. A v3 stage carries an unbounded `characters`
 * list, so "character A/B" is simply index 0/1 of this array. */
const cast = () => stage().characters;

/** Resolve a character by id, by the A/B/C letter the studio labels them with,
 * or by 1-based slot. Returns null when nothing matches. */
const findCharacter = (ref) => {
	const list = cast();
	if (ref === undefined || ref === null || ref === "") return list[0] ?? null;
	const key = String(ref).trim();
	const byId = list.find((c) => c.id === key);
	if (byId) return byId;
	if (/^[A-Za-z]$/.test(key)) return list[key.toUpperCase().charCodeAt(0) - 65] ?? null;
	const n = Number(key);
	if (Number.isInteger(n) && n >= 1) return list[n - 1] ?? null;
	return null;
};

/** The studio labels the cast A, B, C… by position. */
const letterFor = (character) => String.fromCharCode(65 + cast().indexOf(character));

/** What to say when a character reference does not resolve. */
const castHint = () =>
	`Cast: ${cast()
		.map((c, i) => `${String.fromCharCode(65 + i)}=${c.id}`)
		.join(", ")}`;

/** The camera's vertical FOV, derived from the focal length the user set. */
const fov = () => focalMmToFov(state.camera.focalMm);

/** The subject `deriveShot` frames against: the framed character, which is the
 * first of the cast unless `focus_character` moved it. */
const subject = () => {
	const a = findCharacter(state.focus) ?? cast()[0];
	return { x: a.x, z: a.z, rot: a.rot };
};

/** Yaw/pitch that aim the camera at the framing pivot — what captureFraming wants. */
const aimAtSubject = () => {
	const s = subject();
	const dx = state.camera.x - s.x;
	const dz = state.camera.z - s.z;
	const dy = state.camera.y - 1.3; // FRAMING_PIVOT_Y
	const horizontal = Math.hypot(dx, dz);
	return {
		yaw: (Math.atan2(dx, dz) * 180) / Math.PI,
		pitch: (-Math.atan2(dy, Math.max(horizontal, 1e-6)) * 180) / Math.PI,
	};
};

const framing = () => {
	const { yaw, pitch } = aimAtSubject();
	return captureFraming({
		pos: { x: state.camera.x, y: state.camera.y, z: state.camera.z },
		yaw,
		pitch,
		fovDeg: (fov() * 180) / Math.PI,
	});
};

const currentShot = () => deriveShot(state.camera, subject(), fov());

const modelById = (id) =>
	[...VIDEO_MODELS, ...IMAGE_MODELS].find((m) => m.id === id) ?? null;

/** Copy the protocol's deliberately small live description into the existing
 * scene shape. Formatting and film vocabulary below then remain exactly the
 * same code paths as memory-only mode. */
const applyLiveDescription = (description) => {
	if (!description || typeof description !== "object") throw new Error("Live editor returned an invalid scene description.");
	const sc = scene();
	if (typeof description.sceneName === "string" && description.sceneName) sc.name = description.sceneName;
	if (description.camera && typeof description.camera === "object") {
		for (const key of ["x", "y", "z", "focalMm"]) {
			if (Number.isFinite(description.camera[key])) state.camera[key] = description.camera[key];
		}
	}
	if (Array.isArray(description.characters) && description.characters.length) {
		const prior = new Map(stage().characters.map((character) => [character.id, character]));
		stage().characters = description.characters.map((character, index) =>
			createCharacterEntry({ ...prior.get(character.id), ...character }, index),
		);
		if (state.focus && !stage().characters.some((character) => character.id === state.focus)) state.focus = null;
	}
	if (Array.isArray(description.objects)) {
		const prior = new Map(sc.objects.map((object) => [object.id, object]));
		sc.objects = description.objects.map((object) => {
			const previous = prior.get(object.id);
			// The reported renderer is the truth; the name match is only a rescue
			// for older editors that did not send one. A renamed object ("Building
			// A") defeats the name match, and a record without a renderer survives
			// the save but cannot be drawn after the load.
			const kind =
				(typeof object.renderer === "string" && OBJECT_LIBRARY.some((entry) => entry.kind === object.renderer)
					? object.renderer
					: null) ??
				OBJECT_LIBRARY.find(({ label }) => object.name === label || object.name?.startsWith(`${label} `))?.kind;
			const defaults = previous ?? (kind ? createSceneObject(kind, sc.objects, object) : null);
			// The editor is the source of truth for anything it reports; the
			// library defaults only fill what the frame omits. Defaulting AFTER
			// the spread would reset a reported scale back to 1 and make every
			// prop measure 1x1x1 no matter how it was actually built.
			return {
				...defaults,
				footprint: defaults?.footprint ?? { width: 1, depth: 1 },
				height: defaults?.height ?? 1,
				scaleX: defaults?.scaleX ?? 1,
				scaleY: defaults?.scaleY ?? 1,
				scaleZ: defaults?.scaleZ ?? 1,
				...object,
			};
		});
	}
};

const refreshLiveDescription = async () => {
	if (!liveHub?.connected) return false;
	applyLiveDescription(await liveHub.command("describe", {}));
	return true;
};

const liveError = (error) => text(`Live editor error: ${error.message}`);

/* ------------------------------ formatting ------------------------------- */

const round = (n, places = 2) => Number(n.toFixed(places));
const metres = (n) => `${round(n)}m`;

const text = (body) => ({ content: [{ type: "text", text: body }] });

/** A scene rendered the way a crew would read it, not as JSON. */
function sceneReport() {
	const sc = scene();
	const st = sc.stage;
	const shot = currentShot();
	const lines = [
		`Project: ${state.name}`,
		`Scene: ${sc.name}  (${state.doc.scenes.length} scene${state.doc.scenes.length === 1 ? "" : "s"} in project)`,
		"",
		"CAMERA",
		`  position   x ${round(state.camera.x)}  y ${round(state.camera.y)}  z ${round(state.camera.z)}`,
		`  lens       ${state.camera.focalMm}mm  (nearest prime ${nearestPrime(fov())}mm)`,
		`  framing    ${slateLine(shot)}`,
		`  distance   ${metres(shot.distance)} to the subject's centre of mass`,
		"",
		`CAST (${st.characters.length})`,
	];
	const framed = findCharacter(state.focus) ?? st.characters[0];
	for (const [index, c] of st.characters.entries()) {
		const letter = String.fromCharCode(65 + index);
		lines.push(
			`  ${letter} ${c.id}  "${c.subject}"  at x ${round(c.x)}, z ${round(c.z)}, ` +
				`facing ${round(c.rot, 1)}deg  [${c.model}]` +
				`${c.pose ? " posed" : ""}${c.hidden ? " hidden" : ""}` +
				`${c === framed ? "  <- framed" : ""}`,
		);
	}

	lines.push("", `SET (${sc.objects.length} object${sc.objects.length === 1 ? "" : "s"})`);
	if (sc.objects.length === 0) {
		lines.push("  empty — add with place_object");
	} else {
		// The set reads back as the tree it is: a child is indented under the
		// object that carries it — the same structure the studio's Hierarchy
		// shows and the one group_objects (or place_object's parent arg) built.
		// The seen-set keeps this total even if stored data were hand-edited
		// into a loop, matching descendantsOf's own discipline.
		const ids = new Set(sc.objects.map((o) => o.id));
		const seen = new Set();
		const describeLine = (o, depth) => {
			if (seen.has(o.id)) return;
			seen.add(o.id);
			const size = objectSize(o);
			lines.push(
				`${"  ".repeat(depth + 1)}${o.id}  ${o.name}  at x ${round(o.x)}, y ${round(o.y)}, z ${round(o.z)}` +
					`  yaw ${round(o.rot, 1)}deg  size ${round(size.width)}x${round(size.height)}x${round(size.depth)}m`,
			);
			for (const child of sc.objects.filter((c) => c.parent === o.id)) describeLine(child, depth + 1);
		};
		for (const o of sc.objects.filter((o) => (o.parent ?? null) === null || !ids.has(o.parent))) describeLine(o, 0);
		for (const o of sc.objects) describeLine(o, 0);
	}
	return lines.join("\n");
}

/** The shot, described in the vocabulary a director and an image model share. */
function shotReport() {
	const shot = currentShot();
	return [
		slateLine(shot),
		"",
		`size      ${shot.sizeLabel} — the subject fills ${Math.round(shot.screenFraction * 100)}% of frame height`,
		`view      ${shot.viewPhrase}`,
		`level     ${shot.levelPhrase}`,
		`lens      ${shot.focalMm}mm (exact ${round(shot.exactFocalMm, 1)}mm)`,
		`distance  ${metres(shot.distance)}`,
		`elevation ${round(shot.elevationDeg, 1)}deg`,
		"",
		`texture guidance: ${shot.sizeContext}`,
	].join("\n");
}

/* ------------------------------- server ---------------------------------- */

/** Tool registrations are counted as they happen so the HTTP status page can
 * report the real number without reaching into SDK internals. */
let registeredTools = 0;

const server = new McpServer(
	{ name: "cozyclay-mcp", version: "0.1.0" },
	{
		instructions:
			"CozyClay previs. Block a 3D scene, place the camera, then read the shot back as film " +
			"vocabulary (shot size, angle, lens) and render it into an AI image/video prompt. " +
			"Call describe_scene first to see the current state. Coordinates are metres: x is right, " +
			"z is toward the camera's default position, y is height above the floor. Rotations are " +
			"degrees of yaw. Save with save_project to a .cclayproject file the CozyClay studio opens.",
	},
);

const registerTool = (name, config, handler) => {
	registeredTools += 1;
	return server.registerTool(name, config, handler);
};

registerTool(
	"describe_scene",
	{
		title: "Describe the scene",
		description:
			"Read the whole authoring state: camera, lens, current framing, cast positions and every " +
			"object in the set. Call this before changing anything, and after, to confirm the result.",
		inputSchema: {},
	},
	async () => {
		try {
			await refreshLiveDescription();
			return text(sceneReport());
		} catch (error) {
			return liveError(error);
		}
	},
);

registerTool(
	"live_status",
	{
		title: "Live editor status",
		description: "Report whether a CozyClay editor is connected to live mode.",
		inputSchema: {},
	},
	async () => text(liveHub?.connected ? "Live editor connected." : "No live editor connected; using in-memory state."),
);

registerTool(
	"describe_shot",
	{
		title: "Describe the current shot",
		description:
			"Turn the current camera geometry into film vocabulary — shot size, angle on the subject, " +
			"camera level, and the nearest real prime lens. This is what the camera is actually seeing.",
		inputSchema: {},
	},
	async () => {
		try {
			await refreshLiveDescription();
			return text(shotReport());
		} catch (error) {
			return liveError(error);
		}
	},
);

registerTool(
	"set_camera",
	{
		title: "Set the camera",
		description:
			"Move the camera and/or change the lens. Every field is optional — omitted fields keep " +
			"their current value. The camera always aims at the subject. Use focal_mm to change " +
			"framing without moving (longer = tighter), or move x/y/z to change the angle.",
		inputSchema: {
			x: z.number().optional().describe("world x in metres (right)"),
			y: z.number().optional().describe("lens height above the floor in metres"),
			z: z.number().optional().describe("world z in metres (toward default camera side)"),
			focal_mm: z
				.number()
				.min(8)
				.max(300)
				.optional()
				.describe("focal length on a full-frame 24mm-tall sensor, e.g. 24, 35, 50, 85"),
		},
	},
	async ({ x, y, z: zPos, focal_mm }) => {
		if (liveHub?.connected) {
			try {
				await liveHub.command("set_camera", { x, y, z: zPos, focalMm: focal_mm });
				await refreshLiveDescription();
				return text(`Camera set.\n\n${shotReport()}`);
			} catch (error) {
				return liveError(error);
			}
		}
		if (x !== undefined) state.camera.x = x;
		if (y !== undefined) state.camera.y = y;
		if (zPos !== undefined) state.camera.z = zPos;
		if (focal_mm !== undefined) state.camera.focalMm = focal_mm;
		return text(`Camera set.\n\n${shotReport()}`);
	},
);

registerTool(
	"frame_shot",
	{
		title: "Frame a shot by intent",
		description:
			"Place the camera by describing the shot you want instead of doing the trigonometry. " +
			"Chooses a distance and height that actually produce the requested size and level, " +
			"orbiting to the requested side of the subject.",
		inputSchema: {
			size: z
				.enum([
					"extreme close-up",
					"close-up",
					"medium close-up",
					"medium shot",
					"medium-wide shot",
					"wide shot",
					"extreme wide shot",
				])
				.describe("how much of the frame the subject fills"),
			view: z
				.enum(["front", "front three-quarter", "profile", "rear three-quarter", "back"])
				.default("front three-quarter")
				.describe("which side of the subject the camera sits on"),
			level: z
				.enum(["ground", "low", "hip", "eye", "high", "overhead"])
				.default("eye")
				.describe("how high the lens rides"),
			side: z.enum(["left", "right"]).default("right").describe("camera left or camera right"),
			focal_mm: z.number().min(8).max(300).default(35).describe("lens to frame with"),
		},
	},
	async ({ size, view, level, side, focal_mm }) => {
		if (liveHub?.connected) {
			try {
				await refreshLiveDescription();
			} catch (error) {
				return liveError(error);
			}
		}
		// Midpoints of shot.js's SIZE_TABLE bands, so the label that comes back is
		// the label that was asked for rather than whatever sits on a boundary.
		const FRACTION = {
			"extreme close-up": 3.4,
			"close-up": 2.2,
			"medium close-up": 1.375,
			"medium shot": 0.975,
			"medium-wide shot": 0.66,
			"wide shot": 0.41,
			"extreme wide shot": 0.2,
		};
		// Heights that land mid-band in shot.js's LEVEL_TABLE.
		const HEIGHT = { ground: 0.3, low: 0.7, hip: 1.1, eye: 1.65, high: 2.1, overhead: 2.8 };
		// Angle off the subject's facing direction, in degrees.
		const ANGLE = { front: 0, "front three-quarter": 40, profile: 90, "rear three-quarter": 140, back: 180 };

		const s = subject();
		let lensMm = focal_mm;
		// Invert deriveShot's screenFraction: distance that yields the target size.
		const distanceFor = (mm) => 1.8 / (2 * FRACTION[size] * Math.tan(focalMmToFov(mm) / 2));

		// Size and level can physically conflict: an extreme close-up on a wide
		// lens sits half a metre from the pivot, which no overhead rig can also
		// satisfy. Size is the stronger request (it is the shot), so the lens is
		// lengthened until the requested level fits, exactly as a crew would swap
		// glass rather than abandon the close-up.
		const neededDy = Math.abs(HEIGHT[level] - 1.3);
		const MIN_HORIZONTAL = 0.25;
		const needed = Math.hypot(neededDy, MIN_HORIZONTAL);
		if (distanceFor(lensMm) < needed) {
			for (const mm of [50, 85, 100, 135, 180, 240, 300]) {
				if (mm <= lensMm) continue;
				lensMm = mm;
				if (distanceFor(mm) >= needed) break;
			}
		}
		const distance = distanceFor(lensMm);
		let camY = HEIGHT[level];
		// deriveShot measures distance in 3D to the framing pivot, so the height
		// offset has to come out of the requested distance. A very tight shot from
		// a very high or low lens can ask for more vertical offset than the whole
		// distance allows; when that happens the size is what was actually asked
		// for, so the lens is pulled toward the pivot rather than the shot widened.
		let dy = camY - 1.3;
		const maxDy = Math.sqrt(Math.max(distance * distance - MIN_HORIZONTAL * MIN_HORIZONTAL, 0));
		if (Math.abs(dy) > maxDy) {
			dy = Math.sign(dy) * maxDy;
			camY = 1.3 + dy;
		}
		const horizontal = Math.sqrt(Math.max(distance * distance - dy * dy, MIN_HORIZONTAL * MIN_HORIZONTAL));

		// deriveShot calls it camera-right when cross(facing, toCamera) >= 0, which
		// is the negative yaw direction here — so camera-left orbits by +angle.
		const sign = side === "right" ? -1 : 1;
		const theta = ((s.rot + sign * ANGLE[view]) * Math.PI) / 180;

		const nextCamera = {
			x: s.x + Math.sin(theta) * horizontal,
			z: s.z + Math.cos(theta) * horizontal,
			y: camY,
			focalMm: lensMm,
		};
		if (liveHub?.connected) {
			try {
				await liveHub.command("set_camera", nextCamera);
				await refreshLiveDescription();
			} catch (error) {
				return liveError(error);
			}
		} else {
			Object.assign(state.camera, nextCamera);
		}

		const note =
			lensMm !== focal_mm
				? `Note: ${focal_mm}mm could not hold a ${size} from ${level} level — the lens would have to be ` +
					`inside the subject. Went to ${lensMm}mm to keep the size and the angle.\n\n`
				: "";
		return text(`${note}Framed.\n\n${shotReport()}`);
	},
);

registerTool(
	"add_character",
	{
		title: "Add a character to the cast",
		description:
			"Put another character in the scene. The cast is unbounded — each one gets its own " +
			"letter (A, B, C…), position and prompt description.",
		inputSchema: {
			subject: z.string().describe('prompt description, e.g. "a courier holding a package"'),
			x: z.number().default(0).describe("floor position x in metres"),
			z: z.number().default(0).describe("floor position z in metres"),
			facing: z.number().default(0).describe("yaw in degrees; 0 faces the default camera"),
			model: z
				.enum(CHARACTER_MODEL_IDS)
				.optional()
				.describe("which mannequin to use"),
		},
	},
	async ({ subject: desc, x, z: zPos, facing, model }) => {
		if (liveHub?.connected) {
			try {
				const result = await liveHub.command("add_character", { subject: desc, x, z: zPos, rot: facing });
				await refreshLiveDescription();
				return text(`Added ${result?.id ?? "character"}.\n\n${sceneReport()}`);
			} catch (error) {
				return liveError(error);
			}
		}
		const st = stage();
		const index = st.characters.length;
		// The default scene already owns "char-a", and createCharacterEntry only
		// falls back to `char-<n>` when no id is supplied, so pick the first id
		// the cast is not already using instead of assuming a naming scheme.
		const taken = new Set(st.characters.map((c) => c.id));
		let id = `char-${String.fromCharCode(97 + index)}`;
		for (let n = index + 1; taken.has(id); n += 1) id = `char-${n}`;
		const entry = createCharacterEntry({ id, subject: desc, x, z: zPos, rot: facing, model }, index);
		st.characters = [...st.characters, entry];
		return text(`Added ${String.fromCharCode(65 + index)} (${entry.id}).\n\n${sceneReport()}`);
	},
);

registerTool(
	"place_character",
	{
		title: "Move or re-describe a character",
		description:
			"Change a character already in the cast. Every field is optional; omitted fields keep " +
			"their value. Use add_character to introduce a new one.",
		inputSchema: {
			character: z
				.string()
				.default("A")
				.describe('which character — a letter ("A"), a slot number ("2") or an id ("char-a")'),
			x: z.number().optional().describe("floor position x in metres"),
			z: z.number().optional().describe("floor position z in metres"),
			facing: z.number().optional().describe("yaw in degrees; 0 faces the default camera"),
			subject: z.string().optional().describe("prompt description"),
			hidden: z.boolean().optional().describe("hide without removing from the cast"),
		},
	},
	async ({ character, x, z: zPos, facing, subject: desc, hidden }) => {
		if (liveHub?.connected) {
			try {
				await liveHub.command("update_character", { ref: character, x, z: zPos, rot: facing, subject: desc, hidden });
				await refreshLiveDescription();
				return text(`Character updated.\n\n${sceneReport()}`);
			} catch (error) {
				return liveError(error);
			}
		}
		const target = findCharacter(character);
		if (!target) return text(`No character "${character}". ${castHint()}`);
		if (x !== undefined) target.x = x;
		if (zPos !== undefined) target.z = zPos;
		if (facing !== undefined) target.rot = facing;
		if (desc !== undefined) target.subject = desc;
		if (hidden !== undefined) target.hidden = hidden;
		return text(`Character ${letterFor(target)} updated.\n\n${sceneReport()}`);
	},
);

registerTool(
	"remove_character",
	{
		title: "Remove a character",
		description: "Take a character out of the cast. The last remaining character cannot be removed.",
		inputSchema: {
			character: z.string().describe('which character — letter, slot number or id'),
		},
	},
	async ({ character }) => {
		if (liveHub?.connected) {
			try {
				await liveHub.command("remove_character", { ref: character });
				await refreshLiveDescription();
				return text(`Character removed.\n\n${sceneReport()}`);
			} catch (error) {
				return liveError(error);
			}
		}
		const st = stage();
		const target = findCharacter(character);
		if (!target) return text(`No character "${character}". ${castHint()}`);
		if (st.characters.length === 1) return text("The scene needs at least one character.");
		const letter = letterFor(target);
		st.characters = st.characters.filter((c) => c !== target);
		if (state.focus && !findCharacter(state.focus)) state.focus = null;
		return text(`Removed ${letter}.\n\n${sceneReport()}`);
	},
);

registerTool(
	"focus_character",
	{
		title: "Choose who the camera frames",
		description:
			"Pick which character the shot is measured against. describe_shot, frame_shot and " +
			"render_prompt all frame this character. Defaults to the first of the cast.",
		inputSchema: {
			character: z.string().describe('which character — letter, slot number or id'),
		},
	},
	async ({ character }) => {
		try {
			await refreshLiveDescription();
		} catch (error) {
			return liveError(error);
		}
		const target = findCharacter(character);
		if (!target) return text(`No character "${character}". ${castHint()}`);
		state.focus = target.id;
		return text(`Framing ${letterFor(target)} "${target.subject}".\n\n${shotReport()}`);
	},
);

registerTool(
	"place_object",
	{
		title: "Place an object in the set",
		description:
			`Add a prop to the set. Available kinds: ${OBJECT_LIBRARY.map((o) => o.kind).join(", ")}. ` +
			"Returns the object id, which update_object and remove_object take.",
		inputSchema: {
			kind: z
				.enum(OBJECT_LIBRARY.map((o) => o.kind))
				.describe("what to place"),
			x: z.number().default(0).describe("floor position x in metres"),
			z: z.number().default(0).describe("floor position z in metres"),
			y: z.number().optional().describe("height above the floor; 0 stands on the deck"),
			facing: z.number().optional().describe("yaw in degrees"),
			name: z.string().min(1).optional().describe("display name, e.g. 'Building A / Roof'"),
			parent: z
				.string()
				.optional()
				.describe("object id to attach to — the parent then carries this object when it moves"),
		},
	},
	async ({ kind, x, z: zPos, y, facing, name, parent }) => {
		if (liveHub?.connected) {
			try {
				const result = await liveHub.command("place_object", { kind, x, z: zPos, y, rot: facing, name, parent });
				await refreshLiveDescription();
				return text(`Placed object as ${result?.id ?? "unknown"}.\n\n${sceneReport()}`);
			} catch (error) {
				return liveError(error);
			}
		}
		const sc = scene();
		// The parent is checked before anything is created: a bad id must not
		// leave a half-made part lying around unattached.
		if (parent !== undefined && !sc.objects.some((o) => o.id === parent)) {
			return text(`No object "${parent}" to attach to. Call describe_scene for the current ids.`);
		}
		const placement = { x, z: zPos };
		if (y !== undefined) placement.y = y;
		if (facing !== undefined) placement.rot = facing;
		const object = createSceneObject(kind, sc.objects, placement);
		sc.objects = [...sc.objects, object];
		if (name !== undefined) sc.objects = updateSceneObject(sc.objects, object.id, { name });
		if (parent !== undefined) sc.objects = setSceneObjectParent(sc.objects, object.id, parent);
		const placed = sc.objects.find((o) => o.id === object.id);
		return text(
			`Placed ${placed.name} as ${placed.id}${parent !== undefined ? ` under ${parent}` : ""}.\n\n${sceneReport()}`,
		);
	},
);


registerTool(
	"group_objects",
	{
		title: "Group props so they move as one",
		description:
			"Attach objects to a parent object. The parent then carries them whenever it moves — in " +
			"the studio's gizmo as well as through update_object — so a set piece assembled from " +
			"primitives can be positioned as a single thing. Rotation and scale stay per-object. " +
			"Pass parent: null to detach.",
		inputSchema: {
			parent: z.string().nullable().describe("object id to attach to, or null to detach"),
			children: z.array(z.string()).min(1).describe("object ids to attach or detach"),
		},
	},
	async ({ parent, children }) => {
		if (liveHub?.connected) {
			try {
				await liveHub.command(parent === null ? "ungroup_objects" : "group_objects", { parent, children });
				await refreshLiveDescription();
				return text(
					(parent === null
						? `Detached ${children.length} object(s).`
						: `Grouped ${children.length} object(s) under ${parent} — move ${parent} and they follow.`) +
						`\n\n${sceneReport()}`,
				);
			} catch (error) {
				return liveError(error);
			}
		}
		const sc = scene();
		if (parent !== null && !sc.objects.some((o) => o.id === parent)) return text(`No object "${parent}".`);
		for (const child of children) {
			if (!sc.objects.some((o) => o.id === child)) return text(`No object "${child}".`);
		}
		sc.objects = children.reduce((acc, child) => setSceneObjectParent(acc, child, parent), sc.objects);
		return text(
			(parent === null ? `Detached ${children.length} object(s).` : `Grouped ${children.length} object(s) under ${parent}.`) +
				`\n\n${sceneReport()}`,
		);
	},
);

registerTool(
	"set_prompt_blocks",
	{
		title: "Author the motion beats on the timeline",
		description:
			"Write Prompt Blocks onto the timeline WITHOUT generating — the beats and their frame " +
			"ranges, so a schedule can be read and revised before any GPU time is spent. Hit " +
			"'Generate all N blocks' in the studio, or call generate_motion, when it reads right.\n\n" +
			PROMPT_GUIDE,
		inputSchema: {
			beats: z
				.array(
					z.object({
						text: z.string().min(3).describe("the beat, in ARDY's sentence shape"),
						seconds: z
							.number()
							.min(0.5)
							.max(20)
							.describe(`how long this beat holds; over ${BLOCK_MAX_SECONDS}s it becomes chained blocks`),
					}),
				)
				.min(1)
				.max(8)
				.describe("beats in order; each one becomes a contiguous block"),
		},
	},
	async ({ beats }) => {
		if (!liveHub?.connected) {
			return text("Prompt Blocks live on the studio timeline — open the editor and try again.");
		}
		const normalized = normalizePhases(beats.map((b) => b.text));
		// The timeline runs on a 24 fps production clock.
		const TIMELINE_FPS = 24;
		let cursor = 0;
		let chained = 0;
		const blocks = [];
		for (const [i, textValue] of normalized.texts.entries()) {
			const whole = beats[Math.min(normalized.sources[i], beats.length - 1)].seconds ?? 2;
			const spans = splitLongBeat(whole);
			if (spans.length > 1) chained += spans.length - 1;
			for (const span of spans) {
				const frames = Math.max(1, Math.round(span * TIMELINE_FPS));
				blocks.push({ startFrame: cursor, endFrame: cursor + frames, text: textValue });
				cursor += frames;
			}
		}
		try {
			await liveHub.command("set_prompt_blocks", { blocks });
		} catch (error) {
			return liveError(error);
		}
		const rewrites = normalized.notes
			.map((notes, i) => (notes.length ? `  ${i + 1}. ${blocks[i].text}  ← ${notes.join("; ")}` : null))
			.filter(Boolean);
		return text(
			`${blocks.length} block(s) on the timeline (${(cursor / TIMELINE_FPS).toFixed(1)}s total):\n` +
				blocks.map((b) => `  ${b.startFrame}-${b.endFrame}f  ${b.text}`).join("\n") +
				(chained > 0 ? `\n  (${chained} block(s) chained to keep every block within ${BLOCK_MAX_SECONDS}s)` : "") +
				(rewrites.length ? `\n\nRewritten for ARDY:\n${rewrites.join("\n")}` : "") +
				"\n\nGenerate them from the studio's Prompt Blocks panel, or with generate_motion.",
		);
	},
);

registerTool(
	"generate_motion",
	{
		title: "Generate character motion (ARDY)",
		description:
			"Generate a multi-phase motion clip through the ARDY bridge and, when a live editor is " +
			"connected, load it onto the active character so it appears on the timeline.\n\n" +
			PROMPT_GUIDE,
		inputSchema: {
			phases: z
				.array(
					z.union([
						z.string().min(3),
						z.object({
							text: z.string().min(3),
							seconds: z.number().min(0.5).max(30).describe("how long THIS beat holds"),
						}),
					]),
				)
				.min(2)
				.max(8)
				.describe(
					"one beat per phase, in order. Write each as ARDY writes them: " +
						'"A person walks in a circle." — subject, one action, present tense, ' +
						"full stop. Give a plain string to share the clip evenly, or " +
						"{ text, seconds } to hold a beat for a specific time.",
				),
			seconds: z
				.number()
				.min(2)
				.max(60)
				.default(9)
				.describe("total clip length; ignored when every phase carries its own seconds"),
			seed: z.number().int().optional().describe("generation seed"),
			motion_url: z
				.string()
				.regex(/^\/ardy\/motions\/[0-9]+-[0-9a-f]{6}$/)
				.optional()
				.describe("reuse an already-generated clip instead of generating again"),
		},
	},
	async ({ phases: rawPhases, seconds, seed, motion_url }) => {
		const phases = rawPhases.map((p) => (typeof p === "string" ? p : p.text));
		const phaseSeconds = rawPhases.map((p) => (typeof p === "string" ? null : p.seconds));
		const timed = phaseSeconds.some((s) => s !== null);
		const bridge = process.env.COZYCLAY_BRIDGE ?? "http://127.0.0.1:5181";
		try {
			const health = await fetch(`${bridge}/ardy/health`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json());
			if (!health.ok) throw new Error("bridge unhealthy");
		} catch {
			return text("The ARDY bridge is not running on " + bridge + ". Start the studio with `npm run dev` (it launches the bridge) and try again.");
		}

		// Every phase is rewritten into ARDY's own sentence shape before it is
		// ever sent; a compound beat is split into the extra phase it was hiding.
		const normalized = normalizePhases(phases);
		const prompts = normalized.texts.filter(Boolean);
		if (prompts.length < 2) return text("Give at least two distinct motion beats.");

		// ARDY Core is 20 fps; segments must tile 0..clipFrames exactly, and each
		// one needs at least 3 frames.
		const ARDY_FPS = 20;
		let segments;
		let clipFrames;
		let chained = 0;
		if (timed) {
			// A beat that split into pieces shares its time between them, so an
			// explicit "6 seconds of walking" stays 6 seconds however it was phrased.
			const pieceCount = normalized.sources.reduce((acc, source) => {
				acc[source] = (acc[source] ?? 0) + 1;
				return acc;
			}, {});
			segments = [];
			let cursor = 0;
			for (const [i, prompt] of prompts.entries()) {
				const whole = phaseSeconds[normalized.sources[i]] ?? seconds / phases.length;
				const share = whole / pieceCount[normalized.sources[i]];
				// The studio caps a block at BLOCK_MAX_SECONDS and refuses to generate
				// a longer one, so a long beat becomes consecutive blocks here rather
				// than something the UI would reject.
				const spans = splitLongBeat(share);
				if (spans.length > 1) chained += spans.length - 1;
				for (const span of spans) {
					const startFrame = cursor;
					cursor += Math.max(3, Math.round(span * ARDY_FPS));
					segments.push({ startFrame, endFrame: cursor, prompt });
				}
			}
			clipFrames = cursor;
		} else {
			clipFrames = Math.floor(seconds * ARDY_FPS);
			// Even division must also respect the cap: enough blocks that no single
			// one exceeds it, distributed evenly across the clip.
			const perPhase = seconds / prompts.length;
			const piecesPer = Math.ceil(perPhase / BLOCK_MAX_SECONDS);
			if (piecesPer > 1) chained = prompts.length * (piecesPer - 1);
			const total = prompts.length * piecesPer;
			const per = Math.floor(clipFrames / total);
			segments = [];
			for (const [i, prompt] of prompts.entries()) {
				for (let k = 0; k < piecesPer; k += 1) {
					const index = i * piecesPer + k;
					segments.push({
						startFrame: index * per,
						endFrame: index === total - 1 ? clipFrames : (index + 1) * per,
						prompt,
					});
				}
			}
		}
		const clipSeconds = clipFrames / ARDY_FPS;
		const rewrites = normalized.notes
			.map((notes, i) => (notes.length ? `  ${i + 1}. ${prompts[i]}  ← ${notes.join("; ")}` : null))
			.filter(Boolean);
		const chainNote = chained > 0 ? `\n  (${chained} block(s) chained to keep every block within ${BLOCK_MAX_SECONDS}s)` : "";
		const promptNote =
			rewrites.length || chainNote
				? (rewrites.length ? `\n\nRewritten for ARDY:\n${rewrites.join("\n")}` : "\n") +
					(normalized.expanded ? "\n  (a compound beat became its own phase)" : "") +
					(normalized.dropped > 0 ? `\n  (${normalized.dropped} beat(s) past the 8-phase limit were dropped)` : "") +
					chainNote
				: "";

		const deliver = async (motionUrl, note) => {
			const summary = `${note} ${clipSeconds.toFixed(1)}s / ${clipFrames} frames — ${segments.length} phases:\n` +
				segments
					.map((s) => `  ${s.startFrame}-${s.endFrame}  (${((s.endFrame - s.startFrame) / ARDY_FPS).toFixed(1)}s)  ${s.prompt}`)
					.join("\n") +
				`\nmotion: ${motionUrl}${promptNote}`;
			if (!liveHub?.connected) return text(`${summary}\n\nNo live editor connected — open the studio and it can load this URL.`);
			try {
				await liveHub.command("load_motion", { url: motionUrl, prompt: prompts.join(" "), blocks: segments });
				return text(`${summary}\n\nLoaded onto the active character with ${segments.length} prompt blocks on the timeline — press play.`);
			} catch (error) {
				return text(`${summary}\n\nGenerated, but the editor did not take it: ${error.message}`);
			}
		};

		if (motion_url) return deliver(motion_url, "Reusing");
		// segments run the autoregressive sequence generator, which is
		// incompatible with pose pinning — the bridge requires posePin:false.
		const body = { prompt: prompts.join(" "), duration: clipSeconds, segments, posePin: false };
		if (seed !== undefined) body.seed = seed;

		const res = await fetch(`${bridge}/ardy/generate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) return text(`Generation refused (HTTP ${res.status}): ${await res.text()}`);

		// The bridge streams ndjson progress lines and ends with a done/error event.
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let done = null;
		let lastProgress = "";
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true });
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (line) {
					const event = JSON.parse(line);
					if (event.event === "error") return text(`Generation failed: ${event.message ?? "generator error"}`);
					if (event.event === "done") done = event;
					else lastProgress = event.message ?? event.event ?? lastProgress;
				}
				nl = buffer.indexOf("\n");
			}
			if (done) break;
		}
		if (!done?.motionUrl) return text(`Generation ended without a motion (last progress: ${lastProgress || "none"}).`);
		return deliver(done.motionUrl, "Generated");
	},
);

registerTool(
	"update_object",
	{
		title: "Move, rotate or scale an object",
		description:
			"Change an object already in the set. Every field is optional; omitted fields are left " +
			"alone. Transforms go through the same clamp/snap path the studio's gizmo uses.",
		inputSchema: {
			id: z.string().describe("object id from place_object or describe_scene"),
			x: z.number().optional(),
			y: z.number().optional(),
			z: z.number().optional(),
			facing: z.number().optional().describe("yaw in degrees"),
			tilt: z.number().optional().describe("pitch in degrees (rotation about x)"),
			roll: z.number().optional().describe("roll in degrees (rotation about z)"),
			scale: z.number().positive().optional().describe("uniform scale factor"),
			scale_x: z.number().positive().optional().describe("width scale; overrides `scale` on this axis"),
			scale_y: z.number().positive().optional().describe("height scale; overrides `scale` on this axis"),
			scale_z: z.number().positive().optional().describe("depth scale; overrides `scale` on this axis"),
			color: z
				.string()
				.regex(/^#[0-9a-fA-F]{6}$/)
				.optional()
				.describe("hex colour, e.g. #d9b18c"),
			name: z.string().min(1).optional().describe("new display name, e.g. 'Building A'"),
		},
	},
	async ({ id, x, y, z: zPos, facing, tilt, roll, scale, scale_x, scale_y, scale_z, color, name }) => {
		if (liveHub?.connected) {
			try {
				await liveHub.command("update_object", {
					id, x, y, z: zPos, rot: facing, rotX: tilt, rotZ: roll,
					scale, scaleX: scale_x, scaleY: scale_y, scaleZ: scale_z, color, name,
				});
				await refreshLiveDescription();
				return text(`Updated ${id}.\n\n${sceneReport()}`);
			} catch (error) {
				return liveError(error);
			}
		}
		const sc = scene();
		if (!sc.objects.some((o) => o.id === id)) {
			return text(`No object "${id}" in this scene. Call describe_scene for the current ids.`);
		}
		const patch = {};
		if (x !== undefined) patch.x = x;
		if (y !== undefined) patch.y = y;
		if (zPos !== undefined) patch.z = zPos;
		if (facing !== undefined) patch.rot = facing;
		if (tilt !== undefined) patch.rotX = tilt;
		if (roll !== undefined) patch.rotZ = roll;
		if (scale !== undefined) {
			patch.scaleX = scale;
			patch.scaleY = scale;
			patch.scaleZ = scale;
		}
		if (scale_x !== undefined) patch.scaleX = scale_x;
		if (scale_y !== undefined) patch.scaleY = scale_y;
		if (scale_z !== undefined) patch.scaleZ = scale_z;
		if (color !== undefined) patch.color = color;
		if (name !== undefined) patch.name = name;
		sc.objects = updateSceneObject(sc.objects, id, patch);
		return text(`Updated ${id}.\n\n${sceneReport()}`);
	},
);

registerTool(
	"remove_object",
	{
		title: "Remove an object",
		description: "Take a prop out of the set.",
		inputSchema: { id: z.string().describe("object id") },
	},
	async ({ id }) => {
		if (liveHub?.connected) {
			try {
				await liveHub.command("remove_object", { id });
				await refreshLiveDescription();
				return text(`Removed ${id}.\n\n${sceneReport()}`);
			} catch (error) {
				return liveError(error);
			}
		}
		const sc = scene();
		if (!sc.objects.some((o) => o.id === id)) {
			return text(`No object "${id}" in this scene.`);
		}
		sc.objects = removeSceneObject(sc.objects, id);
		return text(`Removed ${id}.\n\n${sceneReport()}`);
	},
);

registerTool(
	"render_prompt",
	{
		title: "Render the AI prompt for this shot",
		description:
			"Turn the current camera, cast and set into a prompt for an AI image or video model. " +
			"The prompt carries the real framing — shot size, lens, angle and level — so the " +
			"generated frame matches the blocking.",
		inputSchema: {
			mode: z.enum(["image", "video"]).default("video").describe("still or moving"),
			model: z
				.string()
				.optional()
				.describe(
					`target model id. video: ${VIDEO_MODELS.map((m) => m.id).join(", ")}. ` +
						`image: ${IMAGE_MODELS.map((m) => m.id).join(", ")}`,
				),
			environment: z
				.string()
				.describe('the real setting, e.g. "a rain-slicked Seoul side street at night"'),
			style: z
				.string()
				.default("cinematic film still, natural light")
				.describe('look and grade, e.g. "shot on 35mm film, warm practical light"'),
			camera_move: z
				.string()
				.default(CAMERA_MOVES[0])
				.describe(`camera move. Known: ${CAMERA_MOVES.filter((m) => m !== "Custom…").join(", ")}`),
			pose_phrase: z.string().default("").describe("what character A is doing"),
			pose2_phrase: z.string().default("").describe("what character B is doing"),
		},
	},
	async ({ mode, model, environment, style, camera_move, pose_phrase, pose2_phrase }) => {
		if (liveHub?.connected) {
			try {
				await refreshLiveDescription();
			} catch (error) {
				return liveError(error);
			}
		}
		const st = stage();
		const known = CAMERA_MOVES.includes(camera_move);
		// composePrompt frames two subjects: the one the camera is on, then the
		// next visible member of the cast.
		const framed = findCharacter(state.focus) ?? st.characters[0];
		const other = st.characters.find((c) => c !== framed && !c.hidden) ?? null;
		const prompt = composePrompt({
			mode,
			model: modelById(model) ?? undefined,
			shot: currentShot(),
			subject: framed.subject,
			subject2: other?.subject ?? null,
			posePhrase: pose_phrase,
			pose2Phrase: other ? pose2_phrase : "",
			environment,
			style,
			cameraMove: known ? camera_move : "Custom…",
			customMove: known ? "" : camera_move,
			hasCharSheet: st.hasCharSheet === true,
			hasEnvSheet: false,
		});
		return text(`${slateLine(currentShot())}\n\n${prompt}`);
	},
);

registerTool(
	"mark_camera_move",
	{
		title: "Mark the start of a camera move",
		description:
			"Snapshot the current framing as the A position of a camera move. Then move the camera " +
			"and call describe_camera_move to have the move named in film vocabulary.",
		inputSchema: {},
	},
	async () => {
		try {
			await refreshLiveDescription();
		} catch (error) {
			return liveError(error);
		}
		state.markedFraming = framing();
		return text(`Marked A position: ${slateLine(currentShot())}\n\nNow move the camera, then call describe_camera_move.`);
	},
);

registerTool(
	"describe_camera_move",
	{
		title: "Name the camera move",
		description:
			"Compare the marked A position against the camera's current B position and name the move " +
			"the way a crew would — dolly in, crane down, arc left, push, and so on.",
		inputSchema: {
			duration_s: z.number().positive().default(3).describe("how long the move takes, in seconds"),
		},
	},
	async ({ duration_s }) => {
		try {
			await refreshLiveDescription();
		} catch (error) {
			return liveError(error);
		}
		if (!state.markedFraming) {
			return text("No A position marked. Call mark_camera_move first, then move the camera.");
		}
		const move = classifyMove(state.markedFraming, framing(), subject(), { durationS: duration_s });
		return text(
			[
				moveSlate(move),
				"",
				`from  ${slateLine(deriveShot(state.markedFraming.pos, subject(), (state.markedFraming.fovDeg * Math.PI) / 180))}`,
				`to    ${slateLine(currentShot())}`,
				`over  ${duration_s}s`,
			].join("\n"),
		);
	},
);

registerTool(
	"add_scene",
	{
		title: "Add a scene",
		description:
			"Add another scene to the project and make it active. This remains MCP memory-only while " +
			"an editor is connected; use load_scenes via open_project to replace the live document.",
		inputSchema: { name: z.string().default("SCENE 02").describe("scene name") },
	},
	async ({ name }) => {
		state.doc.scenes = addScene(state.doc.scenes, name);
		state.doc.activeSceneId = state.doc.scenes[state.doc.scenes.length - 1].id;
		const note = liveHub?.connected ? " (memory-only; the connected editor was not changed)" : "";
		return text(`Added "${name}"${note}.\n\n${sceneReport()}`);
	},
);

registerTool(
	"switch_scene",
	{
		title: "Switch the active scene",
		description:
			"Make a different scene active. This remains MCP memory-only while an editor is connected; " +
			"everything else operates on the active scene.",
		inputSchema: { name: z.string().describe("scene name to switch to") },
	},
	async ({ name }) => {
		const target = state.doc.scenes.find((s) => s.name.toLowerCase() === name.toLowerCase());
		if (!target) {
			return text(`No scene "${name}". Have: ${state.doc.scenes.map((s) => s.name).join(", ")}`);
		}
		state.doc.activeSceneId = target.id;
		const note = liveHub?.connected ? " (memory-only; the connected editor was not changed)" : "";
		return text(`Switched to "${target.name}"${note}.\n\n${sceneReport()}`);
	},
);

registerTool(
	"open_project",
	{
		title: "Open a .cclayproject file",
		description:
			"Load a project authored in the CozyClay studio (or saved here). Replaces the current state.",
		inputSchema: { path: z.string().describe("path to a .cclayproject file") },
	},
	async ({ path }) => {
		const full = resolve(path);
		let raw;
		try {
			raw = await readFile(full, "utf8");
		} catch (error) {
			return text(`Could not read ${full}: ${error.message}`);
		}
		const result = readProjectDocument(raw);
		if (!result.ok) return text(`Not a usable project file (${result.reason}): ${full}`);

		// Round-trip through readSceneDocument so an older document is migrated to
		// the current stage shape rather than trusted as-is.
		const scenes = readSceneDocument(serializeSceneDocument(result.project.scenesDocument));
		if (!scenes.document) return text(`That project was written by a newer CozyClay: ${full}`);
		state.doc = scenes.document;
		state.name = result.project.name;
		state.focus = null;
		state.markedFraming = null;
		if (liveHub?.connected) {
			try {
				const live = await liveHub.command("load_scenes", { document: state.doc });
				if (typeof live?.sceneName === "string" && live.sceneName) scene().name = live.sceneName;
				await refreshLiveDescription();
			} catch (error) {
				return liveError(error);
			}
		}
		return text(`Opened ${full}.\n\n${sceneReport()}`);
	},
);

registerTool(
	"save_project",
	{
		title: "Save a .cclayproject file",
		description:
			"Write the current state as a .cclayproject file. The CozyClay studio opens this file " +
			"directly, so a scene blocked here can be finished in the UI.",
		inputSchema: {
			path: z.string().describe("destination path, ending in .cclayproject"),
			name: z.string().optional().describe("project name recorded in the file"),
		},
	},
	async ({ path, name }) => {
		if (name) state.name = name;
		if (liveHub?.connected) {
			try {
				await refreshLiveDescription();
			} catch (error) {
				return liveError(error);
			}
		}
		const full = resolve(path);
		const project = createProjectDocument({
			scenesDocument: state.doc,
			workspaceLayout: null,
			customPoses: [],
			name: state.name,
		});
		try {
			await writeFile(full, JSON.stringify(project, null, "\t"), "utf8");
		} catch (error) {
			return text(`Could not write ${full}: ${error.message}`);
		}
		return text(`Saved "${state.name}" to ${full} (${state.doc.scenes.length} scene(s)).`);
	},
);

/* -------------------------------- start ---------------------------------- */

/**
 * stdio is the default because that is how an MCP client launches a local
 * server. `--http` is for driving it by hand: a long-lived endpoint on
 * loopback that survives across client restarts and can be curled.
 */
/** Counted as the tools are registered, so the status page cannot drift. */
const TOOL_COUNT = registeredTools;

const httpFlag = process.argv.indexOf("--http");
const livePortFlag = process.argv.indexOf("--live-port");
const livePort = Number(
	livePortFlag === -1 ? process.env.COZYCLAY_LIVE_PORT ?? 5184 : process.argv[livePortFlag + 1],
);
if (!Number.isInteger(livePort) || livePort < 1 || livePort > 65535) throw new Error("--live-port must be a valid TCP port.");

if (httpFlag === -1) {
	liveHub = await startLiveHub(livePort);
	await server.connect(new StdioServerTransport());
} else {
	// Tools execute in the stdio children, not this HTTP front. Each child tries
	// to own the one editor port; the winner is live and later sessions see the
	// port occupied and deliberately remain memory-only rather than sharing state.
	const requestedHttpPort = process.argv[httpFlag + 1];
	const port = Number(
		requestedHttpPort && !requestedHttpPort.startsWith("--") ? requestedHttpPort : process.env.COZYCLAY_MCP_PORT ?? 5183,
	);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--http must use a valid TCP port.");

	// One MCP session per client, each backed by its own stdio child of this
	// same file. A single shared transport would let the first client's
	// initialize claim the server and refuse every later one; sharing one
	// server object would also mean two clients silently editing one scene.
	// A child process per session keeps each client's scene its own, and reuses
	// the stdio path that the tools already run on.
	const sessions = new Map();

	const openSession = async () => {
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (id) => sessions.set(id, { transport, child }),
		});
		const child = new StdioClientTransport({
			command: process.execPath,
			args: [fileURLToPath(import.meta.url), "--live-port", String(livePort)],
		});

		// Splice the two transports together: the browser-facing session and the
		// child's stdio pipe just forward each other's messages verbatim.
		transport.onmessage = (message) => child.send(message);
		child.onmessage = (message) => transport.send(message);
		transport.onclose = () => {
			if (transport.sessionId) sessions.delete(transport.sessionId);
			child.close().catch(() => {});
		};
		child.onclose = () => transport.close().catch(() => {});

		await child.start();
		await transport.start();
		return transport;
	};

	const http = createServer((req, res) => {
		const path = (req.url ?? "/").split("?")[0];

		// A browser hitting the port should get something legible rather than a
		// protocol error, so the root is a plain status page.
		if (path === "/" && req.method === "GET") {
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			res.end(
				[
					"CozyClay MCP server",
					"",
					`endpoint  http://127.0.0.1:${port}/mcp`,
					"transport Streamable HTTP",
					`tools     ${TOOL_COUNT}`,
					"",
					"Point an MCP client at the endpoint above:",
					'  { "mcpServers": { "cozyclay": { "url": ' +
						`"http://127.0.0.1:${port}/mcp" } } }`,
					"",
				].join("\n"),
			);
			return;
		}

		if (path === "/mcp") {
			const existing = sessions.get(req.headers["mcp-session-id"])?.transport;
			const ready = existing ? Promise.resolve(existing) : openSession();
			ready
				.then((transport) => transport.handleRequest(req, res))
				.catch((error) => {
					if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: String(error?.message ?? error) }));
				});
			return;
		}

		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end(`not found — the MCP endpoint is /mcp\n`);
	});

	http.listen(port, "127.0.0.1", () => {
		console.log(`CozyClay MCP on http://127.0.0.1:${port}/mcp  (${TOOL_COUNT} tools)`);
	});
}
