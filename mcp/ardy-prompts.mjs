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
 *   - compound actions      "stands, then runs"   -> split across phases
 *   - interior states       "in astonishment"     -> dropped; ARDY animates
 *                                                    bodies, not feelings
 *   - camera/scene language "the rocket looms"    -> dropped; the prompt
 *                                                    describes the BODY only
 */

/** Shown in the tool description so a caller writes good phases first time. */
export const PROMPT_GUIDE = [
	"ARDY prompt rules (from nv-tlabs/ardy):",
	'  - One action per phase, phrased like ARDY\'s own examples: "A person walks in a circle."',
	"  - Subject + single present-tense action + full stop. The prompt becomes ONE embedding",
	"    (num_text_tokens=1), so two actions in one phase average together instead of playing in order.",
	"  - Sequence = more phases, never a compound sentence.",
	"  - Describe the BODY: no emotions, no camera, no scenery, no props the model cannot infer.",
	'  - Good: ["A person walks forward.", "A person stops and looks up.", "A person steps backward."]',
	'  - Bad:  ["walks forward slowly, then stops abruptly", "staggers back in astonishment"]',
].join("\n");

/** Interior states and cinematic language ARDY has no body channel for. */
const UNRENDERABLE = [
	/\b(in|with)\s+(astonishment|awe|wonder|surprise|fear|joy|excitement|disbelief)\b/gi,
	/\b(astonished|amazed|awestruck|terrified|delighted|confused|nervous|curious)ly?\b/gi,
	/\b(as if|like)\s+[^,.]+/gi,
	/\b(at|toward|towards)\s+(something|the)\s+(enormous|huge|massive|towering|giant)\b/gi,
	/\b(the\s+)?(camera|shot|frame|rocket|spaceship|building)\b[^,.]*/gi,
];

/** Connectives that mean "a second action is hiding in this sentence". */
const SPLIT_ON = /\s*,?\s*\b(?:and then|then|after that|before|while|as)\b\s*/i;

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

	for (const pattern of UNRENDERABLE) {
		if (pattern.test(s)) {
			s = tidy(s.replace(pattern, ""));
			notes.push("dropped language ARDY cannot animate (emotion, camera or scenery)");
			break;
		}
	}

	// Keep the first action; a trailing clause belongs in its own phase.
	const parts = s.split(SPLIT_ON).map(tidy).filter(Boolean);
	if (parts.length > 1) {
		s = parts[0];
		notes.push(`kept the first action; "${parts.slice(1).join(" / ")}" belongs in its own phase`);
	}

	// A comma usually joins two actions too ("walks forward, stops abruptly").
	const commaParts = s.split(/\s*,\s*/).map(tidy).filter(Boolean);
	if (commaParts.length > 1) {
		s = commaParts[0];
		notes.push("kept one action per prompt");
	}

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
 * Normalise a whole beat list. A phrase that carried a trailing action gets it
 * back as its own phase, so "stands up then runs" becomes two real beats
 * instead of one averaged embedding — capped so a caller cannot blow past the
 * schema's phase limit.
 */
export function normalizePhases(phases, max = 8) {
	const expanded = [];
	for (const phase of phases) {
		const pieces = String(phase ?? "")
			.split(SPLIT_ON)
			.map(tidy)
			.filter(Boolean);
		expanded.push(...(pieces.length ? pieces : [phase]));
	}
	const capped = expanded.slice(0, max);
	const results = capped.map((piece) => normalizePhase(piece));
	return {
		texts: results.map((r) => r.text),
		notes: results.map((r) => r.notes),
		expanded: expanded.length > phases.length,
		dropped: expanded.length - capped.length,
	};
}
