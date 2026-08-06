import { useEffect, useMemo, useState } from "react";
import { buildHierarchyNodes } from "./hierarchy-model.js";

function indexParents(nodes, parent = null, parents = new Map()) {
	for (const node of nodes) {
		if (parent) parents.set(node.id, parent);
		if (node.children) indexParents(node.children, node.id, parents);
	}
	return parents;
}

function TreeRow({ node, depth, selectedId, expanded, onSelect, onToggle, badge, status }) {
	const branch = !!node.children?.length;
	return (
		<div
			className={"hierarchy-row-wrap" + (selectedId === node.id ? " selected" : "")}
			style={{ "--hierarchy-depth": depth }}
			data-node-id={node.id}
			role="treeitem"
			aria-selected={selectedId === node.id}
			aria-expanded={branch ? expanded : undefined}
		>
			{branch ? (
				<button
					type="button"
					className="hierarchy-toggle"
					aria-label={`${expanded ? "Collapse" : "Expand"} ${node.label}`}
					onClick={() => onToggle(node.id)}
				>
					{expanded ? "▾" : "▸"}
				</button>
			) : (
				<span className="hierarchy-toggle placeholder" />
			)}
			<button type="button" className="hierarchy-row" onClick={() => onSelect(node.id)}>
				<span className={`hierarchy-icon ${node.kind}`} aria-hidden="true" />
				<span className="hierarchy-label">{node.label}</span>
				{status && <span className="hierarchy-status">{status}</span>}
				{badge !== null && badge !== undefined && <span className="hierarchy-badge">{badge}</span>}
			</button>
		</div>
	);
}

export default function HierarchyPanel({
	selectedId,
	onSelect,
	showB,
	motionFrames,
	promptCount,
	ikFrames,
	ikMode,
	waypointCount,
	sceneObjects = [],
}) {
	const [expanded, setExpanded] = useState(() => new Set(["shot", "characters", "characterA", "characterA.motion"]));
	const hierarchyNodes = useMemo(() => buildHierarchyNodes(sceneObjects), [sceneObjects]);
	const parents = useMemo(() => indexParents(hierarchyNodes), [hierarchyNodes]);

	useEffect(() => {
		setExpanded((current) => {
			const next = new Set(current);
			let id = selectedId;
			while (parents.has(id)) {
				id = parents.get(id);
				next.add(id);
			}
			if (ikMode) {
				next.add("characterA");
				next.add("characterA.rig");
			}
			return next;
		});
	}, [ikMode, parents, selectedId]);

	const toggle = (id) => {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	const badgeFor = (id) => {
		if (id === "characters") return showB ? 2 : 1;
		if (id === "characterA.motion" || id === "characterA.baseMotion") return motionFrames ? `${motionFrames}f` : "empty";
		if (id === "characterA.promptBlocks") return promptCount;
		if (id === "characterA.ik") return ikFrames;
		if (id === "rootPath") return waypointCount;
		if (id === "props") return sceneObjects.length;
		return null;
	};
	const statusFor = (id) => {
		if (id === "characterA" && ikMode) return "IK ON";
		return null;
	};

	const renderNodes = (nodes, depth = 0) =>
		nodes.flatMap((node) => {
			if (node.optional === "showB" && !showB) return [];
			const open = expanded.has(node.id);
			return [
				<TreeRow
					key={node.id}
					node={node}
					depth={depth}
					selectedId={selectedId}
					expanded={open}
					onSelect={onSelect}
					onToggle={toggle}
					badge={badgeFor(node.id)}
					status={statusFor(node.id)}
				/>,
				...(node.children && open ? renderNodes(node.children, depth + 1) : []),
			];
		});

	return (
		<section className="hierarchy-pane" aria-label="Shot hierarchy">
			<div className="hierarchy-heading">
				<div>
					<span className="hierarchy-kicker">Hierarchy</span>
					<strong>Shot structure</strong>
				</div>
				<span className="hierarchy-frame-status">{motionFrames ? `${motionFrames} frames` : "Blocking"}</span>
			</div>
			<div className="hierarchy-tree" role="tree">
				{renderNodes(hierarchyNodes)}
			</div>
		</section>
	);
}
