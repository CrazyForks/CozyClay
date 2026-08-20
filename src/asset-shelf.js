/**
 * Which stored images the Assets shelf may show.
 *
 * The asset store holds more than the user imported: cutting a background out
 * writes the matte mask and the cut render back as assets of their own, so a
 * raw `listAssetIds` would show every photograph twice and its purple mask
 * besides. The shelf's rule is SOURCE-vs-DERIVED:
 *
 *   show an id iff it is someone's ORIGINAL — a cutout's `sourceAssetId`, an
 *   unmatted cutout's `assetId`, or a stored picture no scene references —
 *   and hide the ids that exist only as machinery: a `matteAssetId`, or the
 *   rendered `assetId` of a matted cutout (`assetId !== sourceAssetId`).
 *
 * Source status wins a tie: duplicating a cut card before re-matting can make
 * one id both a rendered picture and another card's original, and a picture
 * anyone started from belongs on the shelf.
 *
 * Pure on purpose — ids and scene records in, ids out — so the node suite
 * (test/verify-asset-shelf.mjs) can pin the rule without a browser.
 */

import { isAssetId } from "./scene-assets.js";
import { CUTOUT_KIND } from "./scene-objects.js";

/** The stored ids the shelf shows, in stored order. */
export function sourceAssetIds(storedIds, scenes) {
	const sources = new Set();
	const derived = new Set();
	for (const scene of Array.isArray(scenes) ? scenes : []) {
		for (const object of Array.isArray(scene?.objects) ? scene.objects : []) {
			if (object?.renderer !== CUTOUT_KIND) continue;
			const { assetId, sourceAssetId, matteAssetId } = object;
			if (isAssetId(sourceAssetId)) sources.add(sourceAssetId);
			if (isAssetId(assetId)) {
				// A cutout without lineage (or whose picture IS its original) is
				// unmatted; a differing pair means the picture on the card was
				// rendered by the matte and is not something the user imported.
				const matted = isAssetId(sourceAssetId) && sourceAssetId !== assetId;
				(matted ? derived : sources).add(assetId);
			}
			if (isAssetId(matteAssetId)) derived.add(matteAssetId);
		}
	}
	return (Array.isArray(storedIds) ? storedIds : []).filter(
		(id) => isAssetId(id) && (sources.has(id) || !derived.has(id)),
	);
}
