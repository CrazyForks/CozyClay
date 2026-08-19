/**
 * The background editor: the photograph as it arrived, and a purple brush.
 *
 * The rule is that what is purple is what goes. Not a suggestion the machine
 * then reinterprets — the purple IS the mask, and applying takes exactly those
 * pixels, whether a third of the picture is marked or all of it.
 *
 * Painting is not a pixel brush, though. A stroke is a set of SEEDS: on
 * release, the same region growth the automatic pass uses runs from every
 * place the brush touched, and the wall it reaches turns purple in one go.
 * Dragging across a background is therefore "cut this out", not "colour this
 * in" — the brush says WHERE, the algorithm decides HOW FAR. The eraser is a
 * plain brush, because taking back a mistake should be exact.
 *
 * That is why the page opens on the untouched picture. An automatic cut shown
 * before anyone asked for it hides the thing that matters: a hole in the
 * subject and a piece of wall that survived both look like nothing once the
 * background is gone. Purple inverts that — nothing photographed for a set is
 * this violet, so every purple pixel is a decision you can see and argue with.
 *
 * The paint layer is kept at the picture's FULL resolution while interaction
 * runs on a preview at most 512 px wide. Painting a preview and scaling the
 * result up would turn a machine-cut edge into a staircase; painting into full
 * resolution and only DISPLAYING the preview costs nothing extra and keeps the
 * edge exactly as sharp as the picture is.
 *
 * No framework: a canvas, a pointer and two typed arrays, mounted the same way
 * from the studio's React sidebar and from the plain-DOM bench.
 */

import { backgroundMask, paintMask } from "./matte.js";

/** The overlay colour. Chosen to be impossible: nothing photographed for a set
 * is this violet, so every purple pixel is a decision, not the picture. */
export const MATTE_PURPLE = [139, 92, 246];
const OVERLAY_ALPHA = 0.62;
/** Interaction runs on a preview this wide at most — the paint underneath it
 * stays at the picture's own resolution. */
export const EDIT_PREVIEW_MAX = 512;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function createMatteEditor(canvas, {
	onChange = () => {},
	createBitmap = globalThis.createImageBitmap,
	makeCanvas = (width, height) => new OffscreenCanvas(width, height),
} = {}) {
	const view = canvas.getContext("2d", { willReadFrequently: true });
	const state = {
		/** the picture at full size — what Auto-detect reads and what the paint
		 * layer is sized to */
		full: null,
		/** the same picture small enough to repaint on every pointer move */
		preview: null,
		/** 1 = purple = this goes. Full resolution, and the only mask there is. */
		paint: null,
		tolerance: 0.18,
		brush: 18,
		mode: "paint",
		painting: false,
		last: null,
		/** where this stroke has touched, in full-resolution pixels — the seeds
		 * the growth runs from when the pointer comes up */
		seeds: [],
	};

	/** full-resolution pixels per preview pixel */
	const ratio = () => (state.full && state.preview ? state.full.width / state.preview.width : 1);

	function report() {
		if (!state.paint) return onChange({ painted: 0, coverage: 0 });
		let painted = 0;
		for (let pixel = 0; pixel < state.paint.length; pixel++) painted += state.paint[pixel];
		onChange({ painted, coverage: painted / state.paint.length });
	}

	/** Repaint the preview: the picture, plus purple wherever the paint layer
	 * says a pixel goes. The mask is sampled from full resolution rather than
	 * kept in two places, so what is displayed can never drift from what will
	 * be applied. */
	function repaint() {
		if (!state.preview) return;
		const { width, height, data } = state.preview;
		const scale = ratio();
		const fullWidth = state.full.width;
		const out = new Uint8ClampedArray(data.length);
		const [pr, pg, pb] = MATTE_PURPLE;
		for (let y = 0; y < height; y++) {
			const fy = Math.min(state.full.height - 1, Math.floor(y * scale));
			for (let x = 0; x < width; x++) {
				const index = (y * width + x) << 2;
				const alpha = data[index + 3] / 255;
				// Transparent parts of the source read as the page behind them, so
				// they get the studio's own dark ground rather than black.
				let r = data[index] * alpha + 26 * (1 - alpha);
				let g = data[index + 1] * alpha + 30 * (1 - alpha);
				let b = data[index + 2] * alpha + 32 * (1 - alpha);
				if (state.paint[fy * fullWidth + Math.min(fullWidth - 1, Math.floor(x * scale))]) {
					r = r * (1 - OVERLAY_ALPHA) + pr * OVERLAY_ALPHA;
					g = g * (1 - OVERLAY_ALPHA) + pg * OVERLAY_ALPHA;
					b = b * (1 - OVERLAY_ALPHA) + pb * OVERLAY_ALPHA;
				}
				out[index] = r;
				out[index + 1] = g;
				out[index + 2] = b;
				out[index + 3] = 255;
			}
		}
		canvas.width = width;
		canvas.height = height;
		view.putImageData(new ImageData(out, width, height), 0, 0);
		report();
	}

	/* --------------------------------------------------------- pointer --- */

	/** Where a pointer is, in FULL-resolution pixels: the canvas is displayed
	 * at whatever width the sidebar gives it, backed by a preview, backed by
	 * the picture — three scales, collapsed here once. */
	function at(event) {
		const rect = canvas.getBoundingClientRect();
		const scale = (rect.width ? canvas.width / rect.width : 1) * ratio();
		return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale };
	}

	function radius() {
		const rect = canvas.getBoundingClientRect();
		const scale = (rect.width ? canvas.width / rect.width : 1) * ratio();
		return Math.max(1, (state.brush / 2) * scale);
	}

	function stroke(from, to) {
		const value = state.mode === "erase" ? 0 : 1;
		const r = radius();
		const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / Math.max(1, r * 0.4)));
		let touched = 0;
		for (let step = 1; step <= steps; step++) {
			const x = from.x + ((to.x - from.x) * step) / steps;
			const y = from.y + ((to.y - from.y) * step) / steps;
			touched += paintMask(state.paint, state.full, { x, y, radius: r, value });
			// Paint mode leaves a seed behind at every dab. The growth waits for
			// the pointer to come up: one flood per stroke is fast, one per
			// pointermove would be a full-resolution flood 60 times a second.
			if (value === 1) state.seeds.push({ x, y });
		}
		if (touched) repaint();
	}

	/** The stroke is over: grow the background out from everywhere it touched. */
	function growFromStroke() {
		const seeds = state.seeds;
		state.seeds = [];
		if (!seeds.length || !state.full) return;
		const reached = backgroundMask(state.full, { points: seeds, tolerance: state.tolerance });
		let added = 0;
		for (let pixel = 0; pixel < reached.length; pixel++) {
			if (!reached[pixel] || state.paint[pixel]) continue;
			state.paint[pixel] = 1;
			added += 1;
		}
		if (added) repaint();
	}

	const onDown = (event) => {
		if (!state.preview) return;
		event.preventDefault();
		canvas.setPointerCapture?.(event.pointerId);
		state.painting = true;
		state.last = at(event);
		stroke(state.last, state.last);
	};
	const onMove = (event) => {
		if (!state.painting) return;
		const point = at(event);
		stroke(state.last, point);
		state.last = point;
	};
	const onUp = (event) => {
		if (!state.painting) return;
		state.painting = false;
		growFromStroke();
		if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
	};
	canvas.addEventListener("pointerdown", onDown);
	canvas.addEventListener("pointermove", onMove);
	canvas.addEventListener("pointerup", onUp);
	canvas.addEventListener("pointercancel", onUp);
	canvas.addEventListener("pointerleave", onUp);

	/* ------------------------------------------------------------- api --- */

	return {
		/**
		 * Decode an asset and show it AS IT IS. Nothing is marked until someone
		 * asks — either with the brush or with Auto-detect.
		 */
		async load(asset) {
			const bitmap = await createBitmap(new Blob([asset.bytes], { type: asset.type }));
			try {
				const read = (width, height) => {
					const work = makeCanvas(width, height);
					const context = work.getContext("2d", { willReadFrequently: true });
					context.drawImage(bitmap, 0, 0, width, height);
					const image = context.getImageData(0, 0, width, height);
					return { data: image.data, width, height };
				};
				state.full = read(bitmap.width, bitmap.height);
				const scale = Math.min(1, EDIT_PREVIEW_MAX / Math.max(bitmap.width, bitmap.height));
				state.preview = scale === 1
					? { data: Uint8ClampedArray.from(state.full.data), width: state.full.width, height: state.full.height }
					: read(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
				state.paint = new Uint8Array(state.full.width * state.full.height);
				repaint();
			} finally {
				bitmap?.close?.();
			}
		},

		/** Put a saved selection back on the picture — the second half of a
		 * card's state, alongside the photograph itself. */
		setMask(mask, width, height) {
			if (!state.paint || !mask) return false;
			if (width !== state.full.width || height !== state.full.height) return false;
			state.paint.set(mask);
			repaint();
			return true;
		},

		/**
		 * The first pass, on request: grow the background from the frame's edges
		 * and paint what it reaches. It ADDS to the purple rather than replacing
		 * it, so running it again at a higher tolerance extends the selection
		 * instead of discarding the corrections already made by hand.
		 */
		autoDetect(tolerance = state.tolerance) {
			if (!state.full) return 0;
			state.tolerance = clamp(Number(tolerance) || 0, 0.01, 0.9);
			const found = backgroundMask(state.full, { tolerance: state.tolerance });
			let added = 0;
			for (let pixel = 0; pixel < found.length; pixel++) {
				if (!found[pixel] || state.paint[pixel]) continue;
				state.paint[pixel] = 1;
				added += 1;
			}
			repaint();
			return added;
		},

		setTolerance(value) {
			state.tolerance = clamp(Number(value) || 0, 0.01, 0.9);
		},
		setBrush(value) {
			state.brush = clamp(Number(value) || 1, 2, 200);
		},
		/** "paint" lays purple down; "erase" takes it off. */
		setMode(mode) {
			state.mode = mode === "erase" ? "erase" : "paint";
		},
		mode: () => state.mode,
		tolerance: () => state.tolerance,
		/** Back to the untouched photograph. */
		clear() {
			if (!state.paint) return;
			state.paint.fill(0);
			repaint();
		},
		hasPaint: () => !!state.paint?.some((value) => value === 1),
		/**
		 * What the cutter needs: the purple, at the picture's own resolution.
		 * No tolerance travels with it — the growth already happened, on screen,
		 * where it could be corrected.
		 */
		options() {
			return state.paint && this.hasPaint()
				? { mask: state.paint, maskWidth: state.full.width, maskHeight: state.full.height }
				: null;
		},
		dispose() {
			canvas.removeEventListener("pointerdown", onDown);
			canvas.removeEventListener("pointermove", onMove);
			canvas.removeEventListener("pointerup", onUp);
			canvas.removeEventListener("pointercancel", onUp);
			canvas.removeEventListener("pointerleave", onUp);
		},
	};
}
