#!/usr/bin/env node
/**
 * The ARDY prompt normaliser, checked against the shape ARDY's own examples use
 * (nv-tlabs/ardy, scripts/generate.py: "A person walks in a circle.").
 *
 * The rules under test are the ones the repository states or implies:
 * an explicit subject, a closing full stop, and nothing the body cannot perform
 * (emotion, camera, scenery).
 *
 * One action per prompt is guidance for whoever writes the phases, NOT a
 * deletion the normaliser performs: a composite physical beat comes back whole,
 * commas and "then"/"while"/"as"/"before" clauses included.
 */
import { BLOCK_MAX_SECONDS, PROMPT_GUIDE, normalizePhase, normalizePhases, splitLongBeat } from "./ardy-prompts.mjs";

let failures = 0;
const check = (label, ok, detail = "") => {
	if (!ok) {
		failures += 1;
		console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
	}
};

/* ------------------------------ sentence shape --------------------------- */

const subject = normalizePhase("runs forward");
check("a missing subject is supplied", subject.text === "A person runs forward.", subject.text);

const kept = normalizePhase("A person jumps.");
check("an already-correct prompt is left alone", kept.text === "A person jumps.", kept.text);
check("an untouched prompt reports no edits", kept.notes.length === 0, kept.notes.join("; "));

const stop = normalizePhase("A person waves");
check("a missing full stop is closed", stop.text === "A person waves.", stop.text);

const cased = normalizePhase("the woman walks in a circle");
check("an existing subject is preserved", cased.text === "The woman walks in a circle.", cased.text);

/* ------------------------ composite beats survive ------------------------ */
// The normaliser must never trade away wording the caller authored.

const compound = normalizePhase("walks forward slowly, then stops abruptly");
check(
	"a comma + 'then' beat is kept whole",
	compound.text === "A person walks forward slowly, then stops abruptly.",
	compound.text,
);
check("keeping a beat whole reports no split", compound.notes.every((n) => !/own phase/.test(n)), compound.notes.join("; "));

const comma = normalizePhase("stands up, brushes off the knees");
check("a comma-joined pair keeps both actions", comma.text === "A person stands up, brushes off the knees.", comma.text);

const simultaneous = normalizePhase("raises both arms while stepping back");
check("a 'while' clause survives", simultaneous.text === "A person raises both arms while stepping back.", simultaneous.text);

const ordered = normalizePhase("crouches low before springing straight up");
check("a 'before' clause survives", ordered.text === "A person crouches low before springing straight up.", ordered.text);

const asClause = normalizePhase("turns the head as the shoulders drop");
check("an 'as' clause survives", asClause.text === "A person turns the head as the shoulders drop.", asClause.text);

const leading = normalizePhase("then runs forward, arms swinging wide");
check("a leading connective goes but the clause stays", leading.text === "A person runs forward, arms swinging wide.", leading.text);

/* ------------------------------ unrenderable ----------------------------- */

const emotion = normalizePhase("staggers back a step in astonishment");
check("an interior state is dropped", !/astonishment/i.test(emotion.text), emotion.text);
check("the body action survives", /staggers back/i.test(emotion.text), emotion.text);

const scenery = normalizePhase("looks up at something enormous");
check("scenery reference is dropped", !/enormous/i.test(scenery.text), scenery.text);

const camera = normalizePhase("turns while the camera pushes in");
check("camera language is dropped", !/camera/i.test(camera.text), camera.text);
check("the body action outlives the camera clause", /turns/i.test(camera.text), camera.text);

const afterCamera = normalizePhase("turns while the camera pushes in and raises one arm");
check("a body action after a camera clause survives", /raises one arm/i.test(afterCamera.text), afterCamera.text);
check("and the camera clause is still gone", !/camera/i.test(afterCamera.text), afterCamera.text);

// Physical-world nouns a character interacts with are NOT camera/scene language.
// The normaliser must leave them alone entirely (no note, no edit).
const building = normalizePhase("A person climbs a building.");
check("a building as an object survives", building.text === "A person climbs a building.", building.text);

const rocket = normalizePhase("A person boards a rocket.");
check("a rocket as an object survives", rocket.text === "A person boards a rocket.", rocket.text);

const spaceship = normalizePhase("A person enters the spaceship.");
check("a spaceship as an object survives", spaceship.text === "A person enters the spaceship.", spaceship.text);

const filmedCamera = normalizePhase("A person films the camera.");
check("a camera as an object survives", filmedCamera.text === "A person films the camera.", filmedCamera.text);

// ...while genuine camera clauses are still stripped, note included.
const wavesCamera = normalizePhase("A person waves while the camera pushes in.");
check("a trailing camera clause is dropped", wavesCamera.text === "A person waves.", wavesCamera.text);
check("the drop is still explained", wavesCamera.notes.some((n) => /cannot animate/.test(n)), wavesCamera.notes.join("; "));

const bowsShot = normalizePhase("the shot widens as a person bows");
check("a leading shot clause is dropped", bowsShot.text === "A person bows.", bowsShot.text);
check("the shot drop is still explained", bowsShot.notes.some((n) => /cannot animate/.test(n)), bowsShot.notes.join("; "));

/* -------------------------------- sequences ------------------------------ */

const seq = normalizePhases(["stands up from a chair then runs forward", "trips and falls"]);
check("one beat in, one phase out", seq.texts.length === 2, seq.texts.join(" | "));
check("a composite beat is not re-cut", seq.texts[0] === "A person stands up from a chair then runs forward.", seq.texts[0]);
check("no expansion is reported", seq.expanded === false);
check("each phase still maps to its own input", seq.sources.join(",") === "0,1", seq.sources.join(","));
check(
	"every phase ends up in ARDY's shape",
	seq.texts.every((t) => /^(A|The)\s+\w+.*\.$/.test(t)),
	seq.texts.join(" | "),
);

const capped = normalizePhases(Array.from({ length: 12 }, (_, i) => `does action ${i}`));
check("the phase cap holds", capped.texts.length === 8, String(capped.texts.length));
check("dropped beats are counted", capped.dropped === 4, String(capped.dropped));

const blank = normalizePhases(["   ", "walks"]);
check("blank beats do not become prompts", blank.texts.filter(Boolean).length === 1, blank.texts.join(" | "));

/* --------------------------------- guide --------------------------------- */

check("the guide shows ARDY's own example", PROMPT_GUIDE.includes("A person walks in a circle."));
check("the guide warns that phases are taken as written", /NOT split or trimmed for you/.test(PROMPT_GUIDE));
check("the guide explains the single-token reason", /num_text_tokens=1/.test(PROMPT_GUIDE));

if (failures > 0) {
	console.log(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("all ARDY prompt checks passed");

/* ------------------------------ the 4 s cap ------------------------------ */
// Mirrors the studio's PROMPT_BLOCK_MAX_FRAMES: a longer block drifts, and the
// UI refuses to generate one, so the tools must never author one either.

check("the cap is four seconds", BLOCK_MAX_SECONDS === 4);
check("a short beat is left whole", splitLongBeat(3).length === 1);
check("a beat exactly at the cap is left whole", splitLongBeat(4).length === 1);

const six = splitLongBeat(6);
check("a 6 s beat becomes two blocks", six.length === 2, JSON.stringify(six));
check("the split preserves the total duration", Math.abs(six.reduce((a, b) => a + b, 0) - 6) < 1e-9);
check("no piece exceeds the cap", six.every((s) => s <= BLOCK_MAX_SECONDS + 1e-9), JSON.stringify(six));

const eleven = splitLongBeat(11);
check("an 11 s beat becomes three blocks", eleven.length === 3, JSON.stringify(eleven));
check("every piece of a long beat is within the cap", eleven.every((s) => s <= BLOCK_MAX_SECONDS + 1e-9));
check("the guide states the cap", PROMPT_GUIDE.includes(`${BLOCK_MAX_SECONDS} s`));
