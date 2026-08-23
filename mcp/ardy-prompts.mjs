/**
 * Writing prompts the way ARDY was trained to read them.
 *
 * ARDY's own examples are the specification (nv-tlabs/ardy, scripts/generate.py):
 *
 *     python scripts/generate.py "A person walks in a circle."
 *     python scripts/generate.py "A person jumps." --model core --duration 8.0
 *     python scripts/generate.py "A person waves." --model g1 --num_samples 4
 *
 * Three properties do the work: an explicit subject ("A person"), exactly one
 * physical action, and a full stop. The demo's preset Prompt List is built the
 * same way, so this is the distribution the text encoder actually saw.
 *
 * The reason one action per prompt matters is architectural, not stylistic:
 * the interactive demo builds its denoiser with `num_text_tokens=1`
 * (scripts/interactive_demo/loading.py), so the entire prompt collapses into a
 * SINGLE conditioning embedding. Two actions in one sentence do not run in
 * sequence — they average into one confused pose. A sequence of actions is
 * expressed as a sequence of prompts (CozyClay's Prompt Blocks), never as a
 * compound sentence.
 *
 * What that rules out, and what this module rewrites:
 *   - no subject            "runs forward"        -> "A person runs forward."
 *   - interior states       "in astonishment"     -> dropped; ARDY animates
 *                                                    bodies, not feelings
 *   - camera/scene language "the camera pushes in" -> dropped; the prompt
 *                                                    describes the BODY only
 *
 * What it deliberately does NOT do: rewrite a caller's composite physical
 * description into something shorter. A phrase like "raises both arms while
 * stepping back, then lowers them" is the caller's authored beat; splitting it
 * on the comma or on "while"/"then" and keeping only the first fragment throws
 * away motion the caller asked for and silently animates something else.
 * One-action-per-phase is guidance (see PROMPT_GUIDE) that callers apply when
 * they author phases — never a deletion this module performs on their behalf.
 * Normalisation here is non-destructive: subject, full stop, and removal of
 * language ARDY has no body channel for. Everything else survives verbatim.
 */

/**
 * Quality policy, mirrored from the studio (App.jsx PROMPT_BLOCK_MAX_FRAMES):
 * one block never spans more than 4 s. ARDY's trained window is 10 s, but a
 * long single block drifts — chained 4 s blocks keep each call inside the
 * model's sweet spot. The studio refuses to generate a longer block, so a tool
 * that produced one would be authoring something the UI would then reject.
 */
export const BLOCK_MAX_SECONDS = 4;

/**
 * Split a beat that runs longer than the cap into consecutive blocks that do
 * not. The wording is kept for each piece: continuing the same action is
 * exactly what the chained-block design is for. Returns whole seconds-ish
 * spans that sum to the original duration.
 */
export function splitLongBeat(seconds, max = BLOCK_MAX_SECONDS) {
	if (!(seconds > max)) return [seconds];
	const count = Math.ceil(seconds / max);
	const even = seconds / count;
	return Array.from({ length: count }, () => even);
}

/** Shown in the tool description so a caller writes good phases first time. */
export const PROMPT_GUIDE = [
	"ARDY prompt rules (from nv-tlabs/ardy):",
	'  - One action per phase, phrased like ARDY\'s own examples: "A person walks in a circle."',
	"  - Subject + single present-tense action + full stop. The prompt becomes ONE embedding",
	"    (num_text_tokens=1), so two actions in one phase average together instead of playing in order.",
	"  - Sequence = more phases, never a compound sentence. Phases are taken as written:",
	"    a comma or a 'then'/'while'/'as'/'before' clause is NOT split or trimmed for you, so",
	"    split sequential beats yourself instead of relying on a rewrite.",
	`  - A block holds at most ${BLOCK_MAX_SECONDS} s. Longer beats are chained into consecutive blocks,`,
	"    because a single long block drifts away from its prompt.",
	"  - Describe the BODY: no emotions, no camera, no scenery, no props the model cannot infer.",
	"  - WRITE THE AMPLITUDE. A diffusion model regresses toward the mean, so a neutral verb",
	"    generates a smaller motion than the words suggest. Pick the strong verb and state the",
	"    magnitude: 'strides forward quickly' over 'walks forward', 'stops abruptly' over 'slows",
	"    to a stop', 'leans far back and looks straight up' over 'looks up'. Simultaneous detail",
	"    describing ONE pose is fine; sequential actions still need separate phases.",
	'  - Good: ["A person strides forward quickly.", "A person stops abruptly.", "A person leans far back and looks straight up."]',
	'  - Bad:  ["walks forward slowly, then stops abruptly", "staggers back in astonishment"]',
	'  - Tested preset (backward airborne flail): "A person leaps backward with arms and legs flailing."',
	"    Tested caveat: 'flailing' reads as ONE action, so the prompt normalises unchanged; split it",
	'    yourself only if you want the leap and the flail as separate beats.',
].join("\n");

/**
 * Interior states and cinematic language ARDY has no body channel for.
 *
 * Every pattern is bounded to the offending words themselves. None of them may
 * run to the end of a clause or sentence, because a caller's physical wording
 * often sits on the far side of the phrase being removed ("turns while the
 * camera pushes in and raises one arm" must keep the arm).
 */
const UNRENDERABLE = [
	/\b(in|with)\s+(astonishment|awe|wonder|surprise|fear|joy|excitement|disbelief)\b/gi,
	/\b(astonished|amazed|awestruck|terrified|delighted|confused|nervous|curious)ly?\b/gi,
	/\b(at|toward|towards)\s+(something|the)\s+(enormous|huge|massive|towering|giant)(\s+\w+)?\b/gi,
	// A camera/scene clause: the noun used as the SUBJECT of a cinematic verb
	// phrase ("the camera pushes in"), never as an object ("films the camera") —
	// so at least one following word is required, and the phrase stops at the
	// next clause boundary so the body action after it survives. Physical props
	// a character interacts with (rocket, building, spaceship) are not listed:
	// they are body-relevant, not cinematic.
	/\b(?:while|as|and)?\s*(?:the\s+)?(?:camera|shot|frame)\b(?:\s+(?!(?:and|as|while)\b)\w+){1,3}/gi,
];

/** A leftover connective at either end once an unrenderable clause is removed. */
const DANGLING_CONNECTIVE = /^(?:and|then|so|while|as|before|after that)\s+|\s+(?:and|while|as|before)$/gi;

const SUBJECT = /^(a|the)\s+(person|man|woman|character|figure|human)\b/i;

const tidy = (s) =>
	s
		.replace(/\s+/g, " ")
		.replace(/\s+([,.])/g, "$1")
		.replace(/[,;]+$/, "")
		.trim();

/**
 * Rewrite one caller phrase into ARDY's sentence shape.
 * Returns `{ text, notes }` — notes explain every edit, so a caller can see
 * why their wording changed rather than silently getting something else.
 */
export function normalizePhase(raw) {
	const notes = [];
	let s = tidy(String(raw ?? ""));
	if (!s) return { text: "", notes: ["empty phrase"] };

	let stripped = false;
	for (const pattern of UNRENDERABLE) {
		pattern.lastIndex = 0;
		if (pattern.test(s)) {
			pattern.lastIndex = 0;
			s = tidy(s.replace(pattern, " "));
			stripped = true;
		}
	}
	if (stripped) {
		s = tidy(s.replace(DANGLING_CONNECTIVE, " "));
		notes.push("dropped language ARDY cannot animate (emotion, camera or scenery)");
	}
	if (!s) return { text: "", notes: [...notes, "nothing physical left to animate"] };

	// Commas and "then"/"while"/"as"/"before" clauses are the caller's wording and
	// stay put. Composite beats are their problem to split into phases; silently
	// deleting half a prompt animates something the caller never asked for.

	s = s.replace(/^(and|then|so)\s+/i, "");
	if (!SUBJECT.test(s)) {
		s = s.replace(/^[A-Z]/, (c) => c.toLowerCase());
		s = `A person ${s}`;
		notes.push('added the subject ARDY expects ("A person ...")');
	} else {
		s = s.replace(/^./, (c) => c.toUpperCase());
	}

	if (!/[.!?]$/.test(s)) {
		s = `${s}.`;
		notes.push("closed the sentence");
	}
	return { text: tidy(s), notes };
}

/**
 * Normalise a whole beat list. One input beat is one output phase: a beat is
 * never split on a connective, because the caller's phase list is the sequence
 * and re-cutting it silently changes the animation they asked for. The list is
 * still capped so a caller cannot blow past the schema's phase limit.
 *
 * `sources` therefore maps 1:1 onto the inputs, and `expanded` is always false;
 * both are kept so callers that divide a beat's duration across its pieces
 * (server.mjs) keep working unchanged.
 */
export function normalizePhases(phases, max = 8) {
	const expanded = [];
	const sources = [];
	for (const [index, phase] of phases.entries()) {
		expanded.push(String(phase ?? ""));
		// Which input each output came from, so a caller that attached a duration
		// to a beat can still line its beats up with the prompts they produced.
		sources.push(index);
	}
	const capped = expanded.slice(0, max);
	const results = capped.map((piece) => normalizePhase(piece));
	return {
		texts: results.map((r) => r.text),
		notes: results.map((r) => r.notes),
		sources: sources.slice(0, max),
		// Kept for the callers that report it; normalisation never adds a phase now.
		expanded: false,
		dropped: expanded.length - capped.length,
	};
}
