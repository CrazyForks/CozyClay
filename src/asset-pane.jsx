import { useEffect, useState } from "react";
import { ko } from "./locale.js";
import { CHARACTER_MODEL_IDS } from "./scenes.js";
import { OBJECT_LIBRARY } from "./scene-objects.js";
import { displayObjectGroupName, displayObjectLabel } from "./object-catalog.jsx";
import { assetAspect } from "./scene-assets.js";
import { assetRecord } from "./scene-asset-cache.js";

/** Casting assets offered in the bottom Assets tab. `id` doubles as the FBX
 * file stem and the ARDY wire rig name (see scenes.js). */
export const CHARACTER_ASSETS = CHARACTER_MODEL_IDS.map((id) => ({
	id,
	label: id === "y-bot-tpose" ? "Y Bot" : "X Bot",
}));

/** Shelf thumbnail edge: enough pixels for a 108 px card on a 2x display. */
const THUMB_WIDTH = 96;

/**
 * id → Promise<{ url, aspect, name } | null>, for the session. Thumbnails are
 * derived data — the bytes are content-addressed, so an id's picture never
 * changes — which makes a module Map the whole cache story: a tab switch or a
 * re-render redraws nothing, and a reload just re-decodes 96 px thumbs.
 */
const thumbCache = new Map();

function loadThumb(id) {
	if (!thumbCache.has(id)) {
		thumbCache.set(id, (async () => {
			const record = await assetRecord(id);
			if (!record) return null;
			const bitmap = await createImageBitmap(new Blob([record.bytes], { type: record.type }), {
				resizeWidth: THUMB_WIDTH,
				resizeQuality: "high",
			});
			const canvas = document.createElement("canvas");
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			canvas.getContext("2d").drawImage(bitmap, 0, 0);
			bitmap.close?.();
			return { url: canvas.toDataURL(), aspect: assetAspect(record) ?? 1, name: record.name };
		})().catch(() => null));
	}
	return thumbCache.get(id);
}

/** The grab wire every card shares: left button only, App owns the rest. */
function grabProps(onAssetGrab, payload) {
	return {
		onPointerDown: (event) => {
			if (event.button !== 0) return;
			event.preventDefault();
			onAssetGrab?.(payload, event);
		},
	};
}

/** One imported picture. The card renders immediately as a skeleton and the
 * thumbnail lands when the decode does — the grid never waits on a decode. */
function ImageAssetCard({ id, onAssetGrab }) {
	// null = decoding (skeleton), undefined = record gone, object = ready. A
	// cached thumb still starts null for one microtask; no frame is lost.
	const [thumb, setThumb] = useState(null);
	useEffect(() => {
		let alive = true;
		loadThumb(id).then((result) => {
			if (alive) setThumb(result ?? undefined);
		});
		return () => {
			alive = false;
		};
	}, [id]);
	// undefined = the record is gone (another tab swept it); show nothing
	// rather than a card that spawns a blank quad.
	if (thumb === undefined) return null;
	const label = thumb?.name?.replace(/\.[^.]+$/, "") || ko("Image", "이미지");
	return (
		<button
			type="button"
			className="asset-card"
			title={ko(`Drag ${label} into the scene`, `${label}을(를) 씬에 드래그하세요`)}
			{...grabProps(onAssetGrab, { kind: "image", assetId: id, label, aspect: thumb?.aspect ?? 1, thumb: thumb?.url ?? null })}
		>
			{thumb ? (
				<img className="asset-card-thumb" src={thumb.url} alt="" draggable={false} />
			) : (
				<span className="asset-card-thumb asset-card-thumb-skeleton" aria-hidden="true" />
			)}
			<span className="asset-card-label">{label}</span>
			<span className="asset-card-kind">{ko("Image", "이미지")}</span>
		</button>
	);
}

/**
 * Bottom-window asset shelf: everything placeable, one grid — the cast, the
 * object catalogue and the user's imported pictures, each under its own
 * heading. The drag itself is owned by App (ghost overlay + ground raycast on
 * drop); the pane only reports the grab with a discriminated payload.
 *
 * `imageAssetIds` is null while App's asset scan is in flight, then the list
 * of SOURCE ids (see asset-shelf.js) — derived mattes and cut renders never
 * reach this component.
 */
export default function AssetPane({ onAssetGrab, imageAssetIds }) {
	return (
		<div className="assets-shelf">
			<section className="assets-section">
				<h3 className="assets-section-title">{ko("Characters", "인물")}</h3>
				<div className="assets-grid">
					{CHARACTER_ASSETS.map((asset) => (
						<button
							type="button"
							className="asset-card"
							key={asset.id}
							title={ko(`Drag ${asset.label} into the scene`, `${asset.label}을(를) 씬에 드래그하세요`)}
							{...grabProps(onAssetGrab, { kind: "character", id: asset.id, label: asset.label })}
						>
							<span className="asset-card-swatch" data-model={asset.id} aria-hidden="true" />
							<span className="asset-card-label">{asset.label}</span>
							<span className="asset-card-kind">{ko("Character", "인물")}</span>
						</button>
					))}
				</div>
			</section>
			<section className="assets-section">
				<h3 className="assets-section-title">{ko("Objects", "오브젝트")}</h3>
				<div className="assets-grid">
					{OBJECT_LIBRARY.map((entry) => (
						<button
							type="button"
							className="asset-card"
							key={entry.kind}
							title={ko(
								`Drag ${entry.label} into the scene`,
								`${displayObjectLabel(entry.label)}을(를) 씬에 드래그하세요`,
							)}
							{...grabProps(onAssetGrab, { kind: "object", objectKind: entry.kind, label: displayObjectLabel(entry.label), color: entry.color })}
						>
							<span className="asset-card-swatch" style={{ background: entry.color }} aria-hidden="true" />
							<span className="asset-card-label">{displayObjectLabel(entry.label)}</span>
							<span className="asset-card-kind">{displayObjectGroupName(entry.group)}</span>
						</button>
					))}
				</div>
			</section>
			<section className="assets-section">
				<h3 className="assets-section-title">{ko("My images", "내 이미지")}</h3>
				{imageAssetIds === null ? (
					// The scan is still in flight: skeleton cards, never the empty
					// message — "no images" must be a fact, not a race.
					<div className="assets-grid" aria-busy="true">
						{[0, 1, 2].map((n) => (
							<span className="asset-card asset-card-skeleton" key={n} aria-hidden="true" />
						))}
					</div>
				) : imageAssetIds.length === 0 ? (
					// The empty state REPLACES the grid and points at the real
					// import controls; the shelf itself has no import button.
					<p className="assets-empty">
						{ko(
							"No imported images yet. Use \u201cImport image as cutout\u201d in the Props inspector, or drop or paste a picture into the studio.",
							"아직 가져온 이미지가 없어요. 소품 인스펙터의 \u201c이미지를 컷아웃으로 가져오기\u201d를 사용하거나, 이미지를 스튜디오에 드래그하거나 붙여넣으세요.",
						)}
					</p>
				) : (
					<div className="assets-grid">
						{imageAssetIds.map((id) => (
							<ImageAssetCard key={id} id={id} onAssetGrab={onAssetGrab} />
						))}
					</div>
				)}
			</section>
		</div>
	);
}
