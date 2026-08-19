#!/usr/bin/env node
/**
 * The background editor, driven without a browser.
 *
 * The widget is a canvas, a pointer and two typed arrays, so all three can be
 * faked: the canvas records what was drawn, the pointer handlers are called
 * directly, and the assertions are about pixels — is the removed region
 * actually purple on screen, does a stroke reach the mask, do the strokes
 * survive a change of tolerance.
 */

import { MATTE_PURPLE, createMatteEditor } from "../src/matte-editor.js";

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

globalThis.ImageData ??= class ImageData {
	constructor(data, width, height) {
		this.data = data;
		this.width = width;
		this.height = height ?? data.length / 4 / width;
	}
};
globalThis.Blob ??= class Blob {
	constructor(parts) {
		this.parts = parts;
	}
};

/* -- a picture: a red block on a grey wall, 40 x 60 ---------------------- */

const WIDTH = 40;
const HEIGHT = 60;
const BOX = { x0: 12, y0: 20, x1: 28, y1: 46 };
const source = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
for (let y = 0; y < HEIGHT; y++) {
	for (let x = 0; x < WIDTH; x++) {
		const index = (y * WIDTH + x) * 4;
		const subject = x >= BOX.x0 && x < BOX.x1 && y >= BOX.y0 && y < BOX.y1;
		source[index] = subject ? 205 : 188;
		source[index + 1] = subject ? 55 : 190;
		source[index + 2] = subject ? 45 : 186;
		source[index + 3] = 255;
	}
}

/* -- the fakes ------------------------------------------------------------ */

const handlers = new Map();
let painted = null;
const canvas = {
	width: 0,
	height: 0,
	addEventListener: (type, handler) => handlers.set(type, handler),
	removeEventListener: (type) => handlers.delete(type),
	getBoundingClientRect: () => ({ left: 0, top: 0, width: WIDTH, height: HEIGHT }),
	setPointerCapture() {},
	releasePointerCapture() {},
	hasPointerCapture: () => false,
	getContext: () => ({ putImageData: (image) => { painted = image; } }),
};
const makeCanvas = (width, height) => ({
	getContext: () => ({
		drawImage: () => {},
		getImageData: () => ({ data: Uint8ClampedArray.from(source), width, height }),
	}),
});
const asset = { id: "img-" + "c".repeat(32), type: "image/png", width: WIDTH, height: HEIGHT, bytes: new ArrayBuffer(4) };

let last = null;
const editor = createMatteEditor(canvas, {
	onChange: (stats) => { last = stats; },
	createBitmap: async () => ({ width: WIDTH, height: HEIGHT, close() {} }),
	makeCanvas,
});
await editor.load(asset);

const pixelAt = (x, y) => {
	const index = (y * painted.width + x) * 4;
	return [painted.data[index], painted.data[index + 1], painted.data[index + 2]];
};
const sourceAt = (x, y) => {
	const index = (y * WIDTH + x) * 4;
	return [source[index], source[index + 1], source[index + 2]];
};
const near = (a, b, slack = 3) => a.every((value, channel) => Math.abs(value - b[channel]) <= slack);
/** Purple over red is magenta, purple over grey is violet — so "is it
 * overlaid" is asked against the exact mix, not against a hue guess. */
const isPurple = (x, y) => near(pixelAt(x, y), sourceAt(x, y).map((value, channel) => value * 0.38 + MATTE_PURPLE[channel] * 0.62));
const isPlain = (x, y) => near(pixelAt(x, y), sourceAt(x, y));

/* -- what is on screen ---------------------------------------------------- */

expect("the editor paints something the size of the picture", painted?.width === WIDTH && painted?.height === HEIGHT);
expect("the removed background is purple", isPurple(1, 1) && isPurple(38, 58) && isPurple(20, 5));
expect("the subject keeps its own colour", isPlain(20, 30) && !isPurple(20, 30));
expect("the overlay is reported as a fraction of the frame", last.removed > 0.6 && last.removed < 0.95, JSON.stringify(last));
expect("nothing has been painted by hand yet", last.painted === 0);

/* -- painting ------------------------------------------------------------- */

const pointer = (type, x, y) => handlers.get(type)?.({ clientX: x, clientY: y, pointerId: 1, preventDefault() {} });
editor.setBrush(6);
pointer("pointerdown", 20, 30);
pointer("pointermove", 20, 36);
pointer("pointerup", 20, 36);

expect("a stroke paints the subject out, in purple", isPurple(20, 30) && isPurple(20, 34), JSON.stringify(pixelAt(20, 30)));
expect("the stroke is bounded — the far side of the subject survives", isPlain(14, 44));
expect("hand-painted pixels are counted separately", last.painted > 20, JSON.stringify(last));

editor.setMode("restore");
pointer("pointerdown", 2, 2);
pointer("pointerup", 2, 2);
expect("restore brings the wall back out of the overlay", isPlain(2, 2) && isPurple(38, 58));

/* -- the tolerance re-grows underneath the strokes ------------------------ */

const beforePainted = last.painted;
editor.setTolerance(0.05);
expect("moving the tolerance keeps the strokes", last.painted === beforePainted, JSON.stringify(last));
expect("a lower tolerance still marks the wall it can reach", last.removed > 0.3, JSON.stringify(last));
expect("the strokes are still on screen after a re-grow", isPurple(20, 30) && isPlain(2, 2));

editor.clearStrokes();
expect("clearing the strokes leaves the automatic cut alone", last.painted === 0 && isPlain(20, 30) && isPurple(1, 1));

/* -- what gets handed to the cutter --------------------------------------- */

const options = editor.options();
expect(
	"the options carry the tolerance and the paint layer at its own size",
	options.tolerance === 0.05 && options.paintWidth === WIDTH && options.paintHeight === HEIGHT && options.paint.length === WIDTH * HEIGHT,
	JSON.stringify({ ...options, paint: options.paint.length }),
);

editor.dispose();
expect("disposing lets go of the pointer", handlers.size === 0);

if (failures) process.exit(1);
console.log("all matte editor checks PASS");
