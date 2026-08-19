import { ko } from "./locale.js";
import { CHARACTER_MODEL_IDS } from "./scenes.js";

/** Casting assets offered in the bottom Assets tab. `id` doubles as the FBX
 * file stem and the ARDY wire rig name (see scenes.js). */
export const CHARACTER_ASSETS = CHARACTER_MODEL_IDS.map((id) => ({
	id,
	label: id === "y-bot-tpose" ? "Y Bot" : "X Bot",
}));

/** Bottom-window asset shelf: character cards the operator drags into the
 * shot pane to spawn. The drag itself is owned by App (ghost overlay +
 * ground raycast on drop); the pane only reports the grab. */
export default function AssetPane({ onAssetGrab }) {
	return (
		<div className="assets-grid">
			{CHARACTER_ASSETS.map((asset) => (
				<button
					type="button"
					className="asset-card"
					key={asset.id}
					title={ko(`Drag ${asset.label} into the scene`, `${asset.label}을(를) 씬에 드래그하세요`)}
					onPointerDown={(event) => {
						if (event.button !== 0) return;
						event.preventDefault();
						onAssetGrab?.(asset, event);
					}}
				>
					<span className="asset-card-swatch" data-model={asset.id} aria-hidden="true" />
					<span className="asset-card-label">{asset.label}</span>
					<span className="asset-card-kind">{ko("Character", "인물")}</span>
				</button>
			))}
		</div>
	);
}
