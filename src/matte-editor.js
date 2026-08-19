/**
 * The background editor: a picture with its removed parts painted purple, and
 * a brush to argue with the machine about where they are.
 *
 * An automatic cut is right most of the time and wrong in exactly the places
 * that matter — the gap under a chair, the shadow the wall throws, the corner
 * of a sign the growth could not reach. Showing the result as a finished
 * cutout hides the disagreement: you see what is left, not what was taken, so
 * a hole in the subject and a piece of wall that survived look the same
 * (nothing). Painting the removed region PURPLE inverts that. Purple is always
 * "this goes", it never occurs in the picture, and the eye reads a stray purple
 * blob on the subject instantly.
 *
 * The brush writes to a separate paint layer, never to the automatic mask, so
 * the tolerance slider can re-grow the cut underneath work already done.
 *
 * No framework: this is a canvas, a pointer and two typed arrays, mounted the
 * same way from the studio's React sidebar and from the plain-DOM bench.
 */

import { backgroundMask, combineMask, paintMask } from "./matte.js";

/** The overlay colour. Chosen to be impossible: nothing photographed for a set
 * is this violet, so every purple pixel is a decision, not the picture. */
export const MATTE_PURPLE = [139, 92, 246];
const OVERLAY_ALPHA = 0.62;
/** Interaction runs on a preview this wide at most. A brush stroke is coarse
 * by nature, and repainting four megapixels per pointer move is not. */
export const EDIT_PREVIEW_MAX = 512;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Mount an editor onto a canvas.
 *
 * `deps` carries the browser APIs so a host can hand in its own (and so this
 * file stays testable in principle): `createBitmap` and `makeCanvas`.
 */
export function createMatteEditor(canvas, {
	onChange = () => {},
	createBitmap = globalThis.createImageBitmap,
	makeCanvas = (width, height) => new OffscreenCanvas(width, height),
} = {}) {
	const view = canvas.getContext("2d", { willReadFrequently: true });
	const state = {
		/** the picture, scaled down to preview size */
		preview: null,
		/** the automatic mask at preview size, re-grown when tolerance moves */
		auto: null,
		/** strokes: +1 remove, -1 restore, 0 untouched */
		paint: null,
		tolerance: 0.18,
		brush: 18,
		mode: "remove",
		painting: false,
		last: null,
	};

	/** Repaint: the picture, then purple wherever the combined mask says the
	 * background is. One ImageData, built fresh — at preview size that is a
	 * fraction of a millisecond and it can never drift from the mask. */
	function repaint() {
		if (!state.preview) return;
		const { width, height, data } = state.preview;
		const mask = combineMask(state.auto, state.paint, { width, height });
		const out = new Uint8ClampedArray(data.length);
		const [pr, pg, pb] = MATTE_PURPLE;
		for (let pixel = 0; pixel < width * height; pixel++) {
			const index = pixel << 2;
			const alpha = data[index + 3] / 255;
			// Transparent parts of the source read as the page behind them, so
			// they get the studio's own dark ground rather than black.
			let r = data[index] * alpha + 26 * (1 - alpha);
			let g = data[index + 1] * alpha + 30 * (1 - alpha);
			let b = data[index + 2] * alpha + 32 * (1 - alpha);
			if (mask[pixel]) {
				r = r * (1 - OVERLAY_ALPHA) + pr * OVERLAY_ALPHA;
				g = g * (1 - OVERLAY_ALPHA) + pg * OVERLAY_ALPHA;
				b = b * (1 - OVERLAY_ALPHA) + pb * OVERLAY_ALPHA;
			}
			out[index] = r;
			out[index + 1] = g;
			out[index + 2] = b;
			out[index + 3] = 255;
		}
		canvas.width = width;
		canvas.height = height;
		view.putImageData(new ImageData(out, width, height), 0, 0);
		let removed = 0;
		for (let pixel = 0; pixel < mask.length; pixel++) removed += mask[pixel];
		onChange({ removed: removed / (width * height), painted: paintedCount() });
	}

	function paintedCount() {
		if (!state.paint) return 0;
		let count = 0;
		for (let pixel = 0; pixel < state.paint.length; pixel++) if (state.paint[pixel]) count += 1;
		return count;
	}

	function grow() {
		if (!state.preview) return;
		state.auto = backgroundMask(state.preview, { tolerance: state.tolerance });
		repaint();
	}

	/* --------------------------------------------------------- pointer --- */

	/** Canvas pixels from a pointer event, in preview coordinates. */
	function at(event) {
		const rect = canvas.getBoundingClientRect();
		return {
			x: ((event.clientX - rect.left) / rect.width) * canvas.width,
			y: ((event.clientY - rect.top) / rect.height) * canvas.height,
		};
	}

	/** Brush radius in preview pixels: the slider is in screen pixels, so it
	 * has to travel through the same scale the canvas is displayed at. */
	function radius() {
		const rect = canvas.getBoundingClientRect();
		const scale = rect.width ? canvas.width / rect.width : 1;
		return Math.max(1, (state.brush / 2) * scale);
	}

	function stroke(from, to) {
		const value = state.mode === "restore" ? -1 : 1;
		const r = radius();
		const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / Math.max(1, r * 0.4)));
		let touched = 0;
		for (let step = 1; step <= steps; step++) {
			touched += paintMask(state.paint, state.preview, {
				x: from.x + ((to.x - from.x) * step) / steps,
				y: from.y + ((to.y - from.y) * step) / steps,
				radius: r,
				value,
			});
		}
		if (touched) repaint();
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
		state.painting = false;
		if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
	};
	canvas.addEventListener("pointerdown", onDown);
	canvas.addEventListener("pointermove", onMove);
	canvas.addEventListener("pointerup", onUp);
	canvas.addEventListener("pointercancel", onUp);
	canvas.addEventListener("pointerleave", onUp);

	/* ------------------------------------------------------------- api --- */

	return {
		/** Decode an asset and grow its first mask. */
		async load(asset) {
			const bitmap = await createBitmap(new Blob([asset.bytes], { type: asset.type }));
			try {
				const scale = Math.min(1, EDIT_PREVIEW_MAX / Math.max(bitmap.width, bitmap.height));
				const width = Math.max(1, Math.round(bitmap.width * scale));
				const height = Math.max(1, Math.round(bitmap.height * scale));
				const work = makeCanvas(width, height);
				const context = work.getContext("2d", { willReadFrequently: true });
				context.drawImage(bitmap, 0, 0, width, height);
				const image = context.getImageData(0, 0, width, height);
				state.preview = { data: image.data, width, height };
				state.paint = new Int8Array(width * height);
				grow();
			} finally {
				bitmap?.close?.();
			}
		},
		setTolerance(value) {
			state.tolerance = clamp(Number(value) || 0, 0.01, 0.9);
			grow();
		},
		setBrush(value) {
			state.brush = clamp(Number(value) || 1, 2, 200);
		},
		setMode(mode) {
			state.mode = mode === "restore" ? "restore" : "remove";
		},
		mode: () => state.mode,
		tolerance: () => state.tolerance,
		/** Throw the strokes away, keep the automatic cut. */
		clearStrokes() {
			if (!state.paint) return;
			state.paint.fill(0);
			repaint();
		},
		/** What `cutOutBackground` needs to reproduce exactly what is on screen:
		 * the tolerance to re-grow at full resolution, plus the strokes and the
		 * size they were painted at. */
		options() {
			return state.preview
				? {
						tolerance: state.tolerance,
						paint: state.paint,
						paintWidth: state.preview.width,
						paintHeight: state.preview.height,
					}
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
