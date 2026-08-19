#!/usr/bin/env node
/**
 * The ARDY prompt normaliser, checked against the shape ARDY's own examples use
 * (nv-tlabs/ardy, scripts/generate.py: "A person walks in a circle.").
 *
 * The rules under test are the ones the repository states or implies:
 * an explicit subject, exactly one action per prompt because the conditioning
 * collapses to a single text token, a closing full stop, and nothing the body
 * cannot perform (emotion, camera, scenery).
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

/* --------------------------- one action per prompt ----------------------- */

const compound = normalizePhase("walks forward slowly, then stops abruptly");
check("a compound beat keeps only its first action", compound.text === "A person walks forward slowly.", compound.text);
check("the split is reported", compound.notes.some((n) => /own phase/.test(n)), compound.notes.join("; "));

const comma = normalizePhase("stands up, brushes off the knees");
check("a comma-joined pair keeps one action", comma.text === "A person stands up.", comma.text);

/* ------------------------------ unrenderable ----------------------------- */

const emotion = normalizePhase("staggers back a step in astonishment");
check("an interior state is dropped", !/astonishment/i.test(emotion.text), emotion.text);
check("the body action survives", /staggers back/i.test(emotion.text), emotion.text);

const scenery = normalizePhase("looks up at something enormous");
check("scenery reference is dropped", !/enormous/i.test(scenery.text), scenery.text);

const camera = normalizePhase("turns while the camera pushes in");
check("camera language is dropped", !/camera/i.test(camera.text), camera.text);

/* -------------------------------- sequences ------------------------------ */

const seq = normalizePhases(["stands up from a chair then runs forward", "trips and falls"]);
check("a hidden action becomes its own phase", seq.texts.length === 3, seq.texts.join(" | "));
check("expansion is reported", seq.expanded === true);
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
