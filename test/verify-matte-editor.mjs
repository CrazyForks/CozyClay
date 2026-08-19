#!/usr/bin/env node
/**
 * The background editor, driven without a browser.
 *
 * The widget is a canvas, a pointer and two typed arrays, so all three can be
 * faked: the canvas records what was drawn, the pointer handlers are called
 * directly, and the assertions are about pixels — does it open on the
 * untouched photograph, does the brush lay purple down, does the eraser take
 * it off, and is the mask it finally hands over exactly what was on screen.
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

/* -- it opens on the picture, untouched ---------------------------------- */

expect("the editor paints something the size of the picture", painted?.width === WIDTH && painted?.height === HEIGHT);
expect(
	"nothing is marked until someone asks — the photograph is the default",
	isPlain(1, 1) && isPlain(20, 30) && isPlain(38, 58) && last.painted === 0,
	JSON.stringify(last),
);
expect("with nothing painted there is nothing to apply", editor.options() === null && editor.hasPaint() === false);

/* -- the brush lays purple down ------------------------------------------- */

const pointer = (type, x, y) => handlers.get(type)?.({ clientX: x, clientY: y, pointerId: 1, preventDefault() {} });
editor.setBrush(6);
pointer("pointerdown", 4, 4);
pointer("pointermove", 4, 12);
pointer("pointerup", 4, 12);

expect("a stroke marks the wall purple", isPurple(4, 4) && isPurple(4, 10), JSON.stringify(pixelAt(4, 4)));
expect("the stroke is bounded — the rest of the picture is untouched", isPlain(30, 30) && isPlain(20, 30));
expect("what is painted is counted", last.painted > 20 && last.coverage > 0, JSON.stringify(last));

/* -- and the eraser takes it off ------------------------------------------ */

editor.setMode("erase");
pointer("pointerdown", 4, 4);
pointer("pointerup", 4, 4);
expect("erasing takes the purple back off", isPlain(4, 4) && isPurple(4, 12));
editor.setMode("paint");

/* -- auto-detect is an offer, not the default ----------------------------- */

const painterlyBefore = last.painted;
const added = editor.autoDetect(0.18);
expect("auto-detect adds the wall it finds", added > 0 && last.painted > painterlyBefore);
expect("auto-detect marks the background and leaves the subject", isPurple(1, 1) && isPurple(38, 58) && isPlain(20, 30));

// The hand-painted stroke was already purple; a second pass must not undo it.
pointer("pointerdown", 20, 30);
pointer("pointerup", 20, 30);
expect("a correction after auto-detect sticks", isPurple(20, 30));
editor.autoDetect(0.3);
expect("running auto-detect again keeps the corrections", isPurple(20, 30));

/* -- what gets handed to the cutter --------------------------------------- */

const options = editor.options();
let purple = 0;
for (const value of options.mask) purple += value;
expect(
	"the mask is the picture's own size, and is exactly what is purple",
	options.mask.length === WIDTH * HEIGHT && options.maskWidth === WIDTH && options.maskHeight === HEIGHT && purple === last.painted,
	JSON.stringify({ length: options.mask.length, purple, painted: last.painted }),
);
expect("no tolerance travels with it — the growth already happened on screen", options.tolerance === undefined);

editor.clear();
expect("clear puts the photograph back", last.painted === 0 && isPlain(1, 1) && isPlain(20, 30) && editor.options() === null);

editor.dispose();
expect("disposing lets go of the pointer", handlers.size === 0);

if (failures) process.exit(1);
console.log("all matte editor checks PASS");
