/**
 * CozyClay production prompt heuristics for ARDY. They are informed by NVIDIA's
 * upstream examples, not by an upstream prompt-rules document; upstream facts
 * and CozyClay policy are labeled separately in PROMPT_GUIDE.
 *
 * Upstream architecture: LLM2Vec on Llama-3-8B with MNTP and supervised
 * adapters mean-pools each prompt into one 4096-D vector, returned as
 * [B, 1, 4096]. `num_text_tokens=1` appears only in the interactive demo's
 * optional ONNX-TRT loading branch; it is not the reason every prompt has one
 * conditioning vector. NVIDIA's paper and demo presets support compound and
 * ordered prompts, so their fidelity is checkpoint-dependent.
 *
 * What this module rewrites:
 *   - no subject            "runs forward"        -> "A person runs forward."
 *   - interior states       "in astonishment"     -> dropped by CozyClay's
 *                                                    local body-action filter
 *   - camera/scene language "the camera pushes in" -> dropped by the same
 *                                                    local filter
 *
 * What it deliberately does NOT do: rewrite a caller's composite physical
 * description into something shorter. A phrase like "raises both arms while
 * stepping back, then lowers them" is the caller's authored beat; splitting it
 * on the comma or on "while"/"then" and keeping only the first fragment throws
 * away motion the caller asked for and silently animates something else.
 * One-action-per-phase is CozyClay guidance (see PROMPT_GUIDE) that callers
 * apply when authoring phases — never a deletion this module performs on their
 * behalf. Normalisation is non-destructive: subject, full stop, and the local
 * body-action filter. Everything else survives verbatim.
 */

/**
 * CozyClay studio policy, mirrored from App.jsx PROMPT_BLOCK_MAX_FRAMES: one
 * block never spans more than 5 s, and the UI rejects longer blocks. The cap
 * is measured on the Kimodo backend: walk-to-run sweeps (seeds 7/21/99;
 * seam stall ratio, 1.0 = no stall) scored 0.79 for 5 s blocks (best of the
 * sweep), close to a seam-free single take at 0.85; 8 s blocks collapsed to
 * 0.32. <2 s blocks lose about a third of their frames to the transition
 * window, making 3-5 s the recommended authoring range.
 */
export const BLOCK_MAX_SECONDS = 5;

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

/**
 * Wire tiling for a long SINGLE prompt, mirrored by generate_motion. The
 * number of blocks mirrors splitLongBeat; boundaries are rounded cumulatively so the
 * returned ranges are contiguous and the final range ends exactly at the
 * requested clip length. Short clips return one whole block.
 *
 * @param {number} clipFrames total clip length on the ARDY frame clock
 * @param {number} clipSeconds total clip length in seconds
 * @param {number} max maximum block length in seconds
 * @returns {Array<{startFrame:number,endFrame:number}>} contiguous wire ranges
 */
export function tileClipFrames(clipFrames, clipSeconds, max = BLOCK_MAX_SECONDS) {
	const count = splitLongBeat(clipSeconds, max).length;
	let startFrame = 0;
	return Array.from({ length: count }, (_, i) => {
		const endFrame = i === count - 1 ? clipFrames : Math.round(((i + 1) * clipFrames) / count);
		const block = { startFrame, endFrame };
		startFrame = endFrame;
		return block;
	});
}

/** Shown in the tool description so a caller writes good phases first time. */
export const PROMPT_GUIDE = [
	"CozyClay ARDY production heuristics:",
	"  These local workflow rules are informed by NVIDIA's upstream examples; no upstream ARDY",
	"  prompt-rules document exists. Upstream facts and CozyClay policy are labeled below.",
	'  - [Upstream examples] "A person walks in a circle." is a common example shape, not a required template.',
	"  - [Upstream architecture] LLM2Vec on Llama-3-8B with MNTP + supervised adapters mean-pools",
	"    every prompt into one pooled sentence vector: one 4096-D conditioning vector returned as",
	"    [B, 1, 4096]. `num_text_tokens=1` exists only in the optional ONNX-TRT loading branch.",
	"  - [Upstream support] Compound and ordered prompts are supported; NVIDIA includes",
	'    "A person bows down and then stands upright." Fidelity is checkpoint-dependent.',
	"  - [CozyClay reliability heuristic] For critical sequences, prefer one physical action per phase.",
	"    Phases are taken as written: a comma or a 'then'/'while'/'as'/'before' clause is NOT split",
	"    or trimmed for you, so split beats yourself when separate blocks are the safer choice.",
	`  - [CozyClay studio policy] A block holds at most ${BLOCK_MAX_SECONDS} s; longer beats are chained into`,
	"    consecutive blocks. Kimodo measurements found the best continuity at 3-5 s;",
	"    8 s drifts off the prompt, while <2 s blocks lose about a third of their frames to the transition window.",
	"  - [Kimodo measurement] The transition between blocks happens at the START of the following block (conditioned on the previous block's tail),",
	"    so the block after a hard transition (direction reversal, stop-to-sprint) pays for it out of its own duration",
	"    and needs extra time; similar-energy neighbours (walk to run) transition cleanly.",
	"  - [Kimodo upstream guide] Each prompt in a multi-block sequence must be self-contained:",
	"    'Then the person stops' gives the model nothing; 'A person walking comes to a stop' works.",
	"  - [Upstream model cards] Use neutral physical action terms rather than demographic adjectives",
	"    (a bias-mitigation rule). The model is strongest at locomotion, gestures, combat, dancing, and",
	"    everyday activities. It is not aware of scene objects: describe the body action, not object",
	"    interaction (pantomime). The text encoder truncates prompts at 512 tokens.",
	"  - [CozyClay pipeline observation] Long single-prompt takes dilute secondary actions in local",
	"    measurements. Verb choice changes action category, not a documented magnitude mechanism. State",
	"    observable intensity when useful: 'strides forward quickly', 'stops abruptly', or 'leans far",
	"    back and looks straight up'. Test intensity variants — text adherence is not guaranteed.",
	'  - Normalizer check (backward airborne flail): "A person leaps backward with arms and legs flailing."',
	"    The normalizer leaves it unchanged; split it only when separate beats are your intended workflow.",
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
