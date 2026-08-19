#!/usr/bin/env node
/**
 * Background removal, on pictures whose right answer is known exactly.
 *
 * Synthetic images are the point here, not a shortcut: a photograph can only
 * be judged by eye, but a red square on a grey wall has an exact expected
 * mask, and a wall that shades from top to bottom has an exact expected
 * failure mode for the global-threshold approach this one deliberately is not.
 */

import { webcrypto } from "node:crypto";
import { borderSeeds, cropPixels, cutOutBackground, opaqueBounds, removeBackground } from "../src/matte.js";

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

/** A picture built from a per-pixel function: (x, y) => [r, g, b, a]. */
function picture(width, height, paint) {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b, a = 255] = paint(x, y);
			const index = (y * width + x) * 4;
			data[index] = r;
			data[index + 1] = g;
			data[index + 2] = b;
			data[index + 3] = a;
		}
	}
	return { data, width, height };
}
const alphaAt = ({ data, width }, x, y) => data[(y * width + x) * 4 + 3];
const inBox = (x, y, box) => x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1;

/* ------------------------------------------------ a subject on a wall ---- */

const BOX = { x0: 20, y0: 30, x1: 60, y1: 90 };
const flat = picture(80, 120, (x, y) => (inBox(x, y, BOX) ? [200, 60, 50] : [190, 192, 188]));
const cut = removeBackground(flat, { shrink: 0, feather: 0 });

expect("the wall is gone", alphaAt(cut, 2, 2) === 0 && alphaAt(cut, 78, 118) === 0 && alphaAt(cut, 40, 10) === 0);
expect("the subject is untouched", alphaAt(cut, 40, 60) === 255 && alphaAt(cut, 21, 31) === 255 && alphaAt(cut, 59, 89) === 255);
expect(
	"every subject pixel survives and every wall pixel does not",
	(() => {
		for (let y = 0; y < 120; y++) {
			for (let x = 0; x < 80; x++) {
				const kept = alphaAt(cut, x, y) > 0;
				if (kept !== inBox(x, y, BOX)) return false;
			}
		}
		return true;
	})(),
);
expect("the removal is reported as a count", cut.removed === 80 * 120 - 40 * 60, String(cut.removed));
expect("the source picture is not mutated", flat.data[3] === 255 && flat.data.at(-1) === 255);

/* ---------------------------------------------------- a shaded wall ------ */

// The wall runs 150 → 230 top to bottom: far wider than any tolerance that
// still leaves the subject alone. Local growth is the only thing that gets it.
const graded = picture(80, 120, (x, y) => (inBox(x, y, BOX) ? [40, 90, 190] : [150 + Math.round((y / 119) * 80), 150 + Math.round((y / 119) * 80), 148 + Math.round((y / 119) * 80)]));
const gradedCut = removeBackground(graded, { tolerance: 0.1, shrink: 0, feather: 0 });
expect(
	"a wall that shades top to bottom still goes in one piece",
	alphaAt(gradedCut, 5, 5) === 0 && alphaAt(gradedCut, 5, 60) === 0 && alphaAt(gradedCut, 5, 118) === 0,
);
expect("the subject survives the gradient", alphaAt(gradedCut, 40, 60) === 255);

/* ------------------------------------------- a subject touching the edge -- */

// A person standing at the bottom of the frame touches the border, so the
// border is not a reliable sample of background on its own. The dominant
// colours are: a minority colour on one edge is the subject, not the wall.
const ROOTED = { x0: 30, y0: 60, x1: 50, y1: 120 };
const rooted = picture(80, 120, (x, y) => (inBox(x, y, ROOTED) ? [30, 140, 60] : [205, 203, 200]));
const rootedCut = removeBackground(rooted, { shrink: 0, feather: 0 });
expect(
	"a subject standing on the frame edge is not eaten from its own feet",
	alphaAt(rootedCut, 40, 119) === 255 && alphaAt(rootedCut, 40, 80) === 255,
);
expect("the wall around it still goes", alphaAt(rootedCut, 5, 119) === 0 && alphaAt(rootedCut, 70, 60) === 0);

/* --------------------------------------------------- pointed at a colour -- */

const twoWalls = picture(60, 60, (x, y) => (y < 30 ? [40, 40, 44] : [220, 220, 216]));
const pointed = removeBackground(twoWalls, { points: [{ x: 5, y: 50 }], tolerance: 0.12, shrink: 0, feather: 0 });
expect(
	"clicking one background keeps the other side",
	alphaAt(pointed, 30, 50) === 0 && alphaAt(pointed, 30, 5) === 255,
);
expect(
	"seeds come from the click, not the frame",
	borderSeeds(twoWalls, [{ x: 5, y: 50 }]).seeds.length === 3,
);

/* ------------------------------------------------------ shrink & feather -- */

const shrunk = removeBackground(flat, { shrink: 1, feather: 0 });
expect("shrink eats the fringe of the kept region", alphaAt(shrunk, 20, 30) === 0 && alphaAt(shrunk, 22, 32) === 255);
const feathered = removeBackground(flat, { shrink: 0, feather: 1 });
const edge = alphaAt(feathered, 20, 60);
expect("feather softens the boundary without hollowing the subject", edge > 0 && edge < 255 && alphaAt(feathered, 40, 60) === 255, String(edge));

/* ----------------------------------------------------------------- trim -- */

const bounds = opaqueBounds(cut);
expect(
	"the trim box is exactly the subject",
	bounds.x === 20 && bounds.y === 30 && bounds.width === 40 && bounds.height === 60,
	JSON.stringify(bounds),
);
const cropped = cropPixels(cut, bounds);
expect("cropping keeps the picture, not the margin", cropped.width === 40 && cropped.height === 60 && alphaAt(cropped, 0, 0) === 255);
expect("a picture with nothing left has no box", opaqueBounds(picture(4, 4, () => [0, 0, 0, 0])) === null);

/* --------------------------------------------------- the browser glue ---- */

// Stubs for decode / canvas: enough of the API surface to drive the real path.
function stubs(source) {
	return {
		subtle: webcrypto.subtle,
		createBitmap: async () => ({ width: source.width, height: source.height, close() {} }),
		makeCanvas: (width, height) => {
			const store = { data: new Uint8ClampedArray(width * height * 4), width, height };
			return {
				getContext: () => ({
					drawImage: () => store.data.set(source.data),
					getImageData: () => ({ data: Uint8ClampedArray.from(source.data), width, height }),
					putImageData: (image) => store.data.set(image.data),
				}),
				convertToBlob: async ({ type }) => ({ type, arrayBuffer: async () => store.data.buffer.slice(0) }),
			};
		},
	};
}
globalThis.ImageData ??= class ImageData {
	constructor(data, width, height) {
		this.data = data;
		this.width = width;
		this.height = height ?? data.length / 4 / width;
	}
};

const asset = { id: "img-" + "a".repeat(32), type: "image/png", width: 80, height: 120, bytes: new ArrayBuffer(8), name: "sofa.png" };
const result = await cutOutBackground(asset, { shrink: 0, feather: 0 }, stubs(flat));
expect("the cut comes back as its own asset", result.asset.id !== asset.id && result.asset.type === "image/png");
expect("the cut asset is trimmed to the subject", result.asset.width === 40 && result.asset.height === 60);
expect("the name follows the picture", result.asset.name === "sofa.png");
expect(
	"the height scale keeps the subject the size it was",
	Math.abs(result.heightScale - 60 / 120) < 1e-9,
	String(result.heightScale),
);
expect("how much went is reported", Math.abs(result.removed - (80 * 120 - 40 * 60) / (80 * 120)) < 1e-9, String(result.removed));

const untrimmed = await cutOutBackground(asset, { shrink: 0, feather: 0, trim: false }, stubs(flat));
expect("trimming can be declined", untrimmed.asset.width === 80 && untrimmed.heightScale === 1);

await cutOutBackground(asset, { tolerance: 1.5 }, stubs(flat)).then(
	() => expect("a tolerance that eats everything fails with a readable reason", false, "resolved"),
	(error) => expect("a tolerance that eats everything fails with a readable reason", /lower tolerance/.test(error.message), error.message),
);
await cutOutBackground(null, {}, stubs(flat)).then(
	() => expect("a missing asset is refused", false, "resolved"),
	(error) => expect("a missing asset is refused", /asset record/.test(error.message), error.message),
);

if (failures) process.exit(1);
console.log("all matte checks PASS");
