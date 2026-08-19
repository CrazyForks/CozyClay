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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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
		for (const o of sc.objects) {
			const size = objectSize(o);
			lines.push(
				`  ${o.id}  ${o.name}  at x ${round(o.x)}, y ${round(o.y)}, z ${round(o.z)}` +
					`  yaw ${round(o.rot, 1)}deg  size ${round(size.width)}x${round(size.height)}x${round(size.depth)}m`,
			);
		}
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

server.registerTool(
	"describe_scene",
	{
		title: "Describe the scene",
		description:
			"Read the whole authoring state: camera, lens, current framing, cast positions and every " +
			"object in the set. Call this before changing anything, and after, to confirm the result.",
		inputSchema: {},
	},
	async () => text(sceneReport()),
);

server.registerTool(
	"describe_shot",
	{
		title: "Describe the current shot",
		description:
			"Turn the current camera geometry into film vocabulary — shot size, angle on the subject, " +
			"camera level, and the nearest real prime lens. This is what the camera is actually seeing.",
		inputSchema: {},
	},
	async () => text(shotReport()),
);

server.registerTool(
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
		if (x !== undefined) state.camera.x = x;
		if (y !== undefined) state.camera.y = y;
		if (zPos !== undefined) state.camera.z = zPos;
		if (focal_mm !== undefined) state.camera.focalMm = focal_mm;
		return text(`Camera set.\n\n${shotReport()}`);
	},
);

server.registerTool(
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

		state.camera.x = s.x + Math.sin(theta) * horizontal;
		state.camera.z = s.z + Math.cos(theta) * horizontal;
		state.camera.y = camY;
		state.camera.focalMm = lensMm;

		const note =
			lensMm !== focal_mm
				? `Note: ${focal_mm}mm could not hold a ${size} from ${level} level — the lens would have to be ` +
					`inside the subject. Went to ${lensMm}mm to keep the size and the angle.\n\n`
				: "";
		return text(`${note}Framed.\n\n${shotReport()}`);
	},
);

server.registerTool(
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

server.registerTool(
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

server.registerTool(
	"remove_character",
	{
		title: "Remove a character",
		description: "Take a character out of the cast. The last remaining character cannot be removed.",
		inputSchema: {
			character: z.string().describe('which character — letter, slot number or id'),
		},
	},
	async ({ character }) => {
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

server.registerTool(
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
		const target = findCharacter(character);
		if (!target) return text(`No character "${character}". ${castHint()}`);
		state.focus = target.id;
		return text(`Framing ${letterFor(target)} "${target.subject}".\n\n${shotReport()}`);
	},
);

server.registerTool(
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
		},
	},
	async ({ kind, x, z: zPos, y, facing }) => {
		const sc = scene();
		const placement = { x, z: zPos };
		if (y !== undefined) placement.y = y;
		if (facing !== undefined) placement.rot = facing;
		const object = createSceneObject(kind, sc.objects, placement);
		sc.objects = [...sc.objects, object];
		return text(`Placed ${object.name} as ${object.id}.\n\n${sceneReport()}`);
	},
);

server.registerTool(
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
			scale: z.number().positive().optional().describe("uniform scale factor"),
			color: z
				.string()
				.regex(/^#[0-9a-fA-F]{6}$/)
				.optional()
				.describe("hex colour, e.g. #d9b18c"),
		},
	},
	async ({ id, x, y, z: zPos, facing, scale, color }) => {
		const sc = scene();
		if (!sc.objects.some((o) => o.id === id)) {
			return text(`No object "${id}" in this scene. Call describe_scene for the current ids.`);
		}
		const patch = {};
		if (x !== undefined) patch.x = x;
		if (y !== undefined) patch.y = y;
		if (zPos !== undefined) patch.z = zPos;
		if (facing !== undefined) patch.rot = facing;
		if (scale !== undefined) {
			patch.scaleX = scale;
			patch.scaleY = scale;
			patch.scaleZ = scale;
		}
		if (color !== undefined) patch.color = color;
		sc.objects = updateSceneObject(sc.objects, id, patch);
		return text(`Updated ${id}.\n\n${sceneReport()}`);
	},
);

server.registerTool(
	"remove_object",
	{
		title: "Remove an object",
		description: "Take a prop out of the set.",
		inputSchema: { id: z.string().describe("object id") },
	},
	async ({ id }) => {
		const sc = scene();
		if (!sc.objects.some((o) => o.id === id)) {
			return text(`No object "${id}" in this scene.`);
		}
		sc.objects = removeSceneObject(sc.objects, id);
		return text(`Removed ${id}.\n\n${sceneReport()}`);
	},
);

server.registerTool(
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

server.registerTool(
	"mark_camera_move",
	{
		title: "Mark the start of a camera move",
		description:
			"Snapshot the current framing as the A position of a camera move. Then move the camera " +
			"and call describe_camera_move to have the move named in film vocabulary.",
		inputSchema: {},
	},
	async () => {
		state.markedFraming = framing();
		return text(`Marked A position: ${slateLine(currentShot())}\n\nNow move the camera, then call describe_camera_move.`);
	},
);

server.registerTool(
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

server.registerTool(
	"add_scene",
	{
		title: "Add a scene",
		description: "Add another scene to the project and make it active.",
		inputSchema: { name: z.string().default("SCENE 02").describe("scene name") },
	},
	async ({ name }) => {
		state.doc.scenes = addScene(state.doc.scenes, name);
		state.doc.activeSceneId = state.doc.scenes[state.doc.scenes.length - 1].id;
		return text(`Added "${name}".\n\n${sceneReport()}`);
	},
);

server.registerTool(
	"switch_scene",
	{
		title: "Switch the active scene",
		description: "Make a different scene active. Everything else operates on the active scene.",
		inputSchema: { name: z.string().describe("scene name to switch to") },
	},
	async ({ name }) => {
		const target = state.doc.scenes.find((s) => s.name.toLowerCase() === name.toLowerCase());
		if (!target) {
			return text(`No scene "${name}". Have: ${state.doc.scenes.map((s) => s.name).join(", ")}`);
		}
		state.doc.activeSceneId = target.id;
		return text(`Switched to "${target.name}".\n\n${sceneReport()}`);
	},
);

server.registerTool(
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
		return text(`Opened ${full}.\n\n${sceneReport()}`);
	},
);

server.registerTool(
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

await server.connect(new StdioServerTransport());
