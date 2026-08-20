#!/usr/bin/env node
// The Assets shelf must show what the user IMPORTED and hide what the matte
// pipeline DERIVED. This suite pins that split as pure data-in/data-out.
import { sourceAssetIds } from "../src/asset-shelf.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

const hex = (seed) => seed.repeat(32).slice(0, 32);
const SOURCE = `img-${hex("a")}`; // photograph a matted cutout came from
const RENDERED = `img-${hex("b")}`; // the cut picture that cutout renders
const MATTE = `img-${hex("c")}`; // the purple selection mask
const PLAIN = `img-${hex("d")}`; // an unmatted cutout's own picture
const ORPHAN = `img-${hex("e")}`; // stored, referenced by no scene

const scenes = [
	{
		id: "scene-1",
		objects: [
			// A matted cutout: renders RENDERED, came from SOURCE, mask MATTE.
			{ id: "cutout", renderer: "cutout", assetId: RENDERED, sourceAssetId: SOURCE, matteAssetId: MATTE },
			// An untouched cutout: its picture is its own original.
			{ id: "cutout-2", renderer: "cutout", assetId: PLAIN, sourceAssetId: PLAIN, matteAssetId: "" },
			// A non-cutout object never contributes ids.
			{ id: "cube", renderer: "cube" },
		],
	},
];

const stored = [SOURCE, RENDERED, MATTE, PLAIN, ORPHAN];
const shown = sourceAssetIds(stored, scenes);

expect("a matted cutout's photograph is a source", shown.includes(SOURCE));
expect("its rendered (cut) picture is derived and hidden", !shown.includes(RENDERED), shown.join(", "));
expect("its matte mask is derived and hidden", !shown.includes(MATTE), shown.join(", "));
expect("an unmatted cutout's picture is a source", shown.includes(PLAIN));
expect("a stored but unreferenced picture still shows", shown.includes(ORPHAN));
expect("stored order is kept", JSON.stringify(shown) === JSON.stringify([SOURCE, PLAIN, ORPHAN]), shown.join(", "));

// The same id can be one cutout's rendered picture AND another's original —
// duplicating a card before matting does exactly this. Source status wins.
const reused = sourceAssetIds([RENDERED, SOURCE], [
	{
		objects: [
			{ renderer: "cutout", assetId: RENDERED, sourceAssetId: SOURCE, matteAssetId: MATTE },
			{ renderer: "cutout", assetId: RENDERED, sourceAssetId: RENDERED, matteAssetId: "" },
		],
	},
]);
expect("an id that is anyone's source stays visible", reused.includes(RENDERED));

// A legacy record without sourceAssetId is its own original.
const legacy = sourceAssetIds([PLAIN], [{ objects: [{ renderer: "cutout", assetId: PLAIN }] }]);
expect("a cutout without lineage fields counts as unmatted", legacy.includes(PLAIN));

// Garbage in, calm out: the selector never throws on hostile shapes.
expect(
	"nonsense scenes and ids are tolerated",
	JSON.stringify(sourceAssetIds(["not-an-id", null, SOURCE], [null, {}, { objects: "x" }])) === JSON.stringify([SOURCE]),
);
expect("no stored ids means an empty shelf", sourceAssetIds([], scenes).length === 0 && sourceAssetIds(null, scenes).length === 0);

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nverify-asset-shelf: all green");
