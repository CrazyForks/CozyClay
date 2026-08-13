import { useEffect, useMemo, useRef, useState } from "react";
import { ko, isKo } from "./locale.js";
import { buildHierarchyNodes } from "./hierarchy-model.js";
import { sceneObjectIdFromHierarchy } from "./scene-objects.js";
import AddObjectMenu, { CatalogueEntries, displayObjectLabel } from "./object-catalog.jsx";

const HIERARCHY_LABELS_KO = {
	"SHOT 01": "샷 01",
	Camera: "카메라",
	Characters: "캐릭터",
	"Character 1": "캐릭터 1",
	"Character 2": "캐릭터 2",
	Character: "캐릭터",
	Motion: "모션",
	"Base Motion": "기본 모션",
	"Prompt Blocks": "프롬프트 블록",
	"IK Corrections": "IK 보정",
	Rig: "리그",
	"Root / Hips": "루트 / 골반",
	Spine: "척추",
	"Left Arm": "왼팔",
	"Right Arm": "오른팔",
	"Left Leg": "왼다리",
	"Right Leg": "오른다리",
	"Root Path": "루트 경로",
	Environment: "환경",
	Props: "소품",
};

function displayHierarchyLabel(node) {
	if (node.kind === "object") return displayObjectLabel(node.label);
	return isKo ? (HIERARCHY_LABELS_KO[node.label] ?? node.label) : node.label;
}

function indexParents(nodes, parent = null, parents = new Map()) {
	for (const node of nodes) {
		if (parent) parents.set(node.id, parent);
		if (node.children) indexParents(node.children, node.id, parents);
	}
	return parents;
}

/** Fixed-position menu at the pointer: the object-row actions
 * (Rename / Duplicate / Delete / Frame) or the create catalogue, matching
 * Unity's Hierarchy right-click menu (docs/unity-reference.md §9.7).
 * Closes on Escape, on any outside mousedown, and after a pick. */
function RowContextMenu({ menu, onClose, onAction, onAddObject }) {
	const rootRef = useRef(null);

	useEffect(() => {
		if (!menu) return undefined;
		const onDocDown = (event) => {
			if (rootRef.current && !rootRef.current.contains(event.target)) onClose();
		};
		const onKey = (event) => {
			if (event.key !== "Escape") return;
			// Capture phase + stopImmediatePropagation: closing the menu must
			// not also run the app's window-level Escape (clear selection).
			event.stopImmediatePropagation();
			onClose();
		};
		document.addEventListener("mousedown", onDocDown);
		window.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("mousedown", onDocDown);
			window.removeEventListener("keydown", onKey, true);
		};
	}, [menu, onClose]);

	if (!menu) return null;
	// Keep the menu inside the window; `height` is an upper bound per kind,
	// so a short menu never sits below the pointer that opened it.
	const style = {
		left: Math.max(4, Math.min(menu.x, window.innerWidth - 244)),
		top: Math.max(4, Math.min(menu.y, window.innerHeight - menu.height)),
	};
	return (
		<div className="hierarchy-context-menu" role="menu" style={style} ref={rootRef}>
			{menu.kind === "object" ? (
				<>
					<button type="button" role="menuitem" className="hierarchy-context-item" onClick={() => onAction("rename", menu.id)}>
						{ko("Rename", "이름 바꾸기")}
					</button>
					<button type="button" role="menuitem" className="hierarchy-context-item" onClick={() => onAction("duplicate", menu.id)}>
						{ko("Duplicate", "복제")}
					</button>
					<button type="button" role="menuitem" className="hierarchy-context-item" onClick={() => onAction("delete", menu.id)}>
						{ko("Delete", "삭제")}
					</button>
					<button type="button" role="menuitem" className="hierarchy-context-item" onClick={() => onAction("frame", menu.id)}>
						{ko("Frame", "프레임 맞추기")}
					</button>
				</>
			) : (
				<CatalogueEntries onPick={onAddObject} />
			)}
		</div>
	);
}

function TreeRow({
	node,
	depth,
	selectedId,
	expanded,
	onSelect,
	onToggle,
	badge,
	status,
	editing,
	onRenameCommit,
	onRenameCancel,
	onRowContextMenu,
}) {
	const branch = !!node.children?.length;
	const label = displayHierarchyLabel(node);
	const rowWrapRef = useRef(null);
	const inputRef = useRef(null);
	// A commit/cancel may race the blur that follows the input unmounting;
	// the flag ends the edit session exactly once.
	const doneRef = useRef(false);

	const finish = () => {
		if (doneRef.current) return;
		doneRef.current = true;
		const name = (inputRef.current?.value ?? "").trim();
		if (name) onRenameCommit(name);
		else onRenameCancel(); // an empty name is a cancel, like Unity
		rowWrapRef.current?.focus();
	};
	const cancel = () => {
		if (doneRef.current) return;
		doneRef.current = true;
		onRenameCancel();
	};

	return (
		<div
			ref={rowWrapRef}
			className={"hierarchy-row-wrap" + (selectedId === node.id ? " selected" : "")}
			style={{ "--hierarchy-depth": depth }}
			data-node-id={node.id}
			role="treeitem"
			tabIndex={-1}
			aria-selected={selectedId === node.id}
			aria-expanded={branch ? expanded : undefined}
			onContextMenu={(event) => onRowContextMenu(event, node.id)}
		>
			{branch ? (
				<button
					type="button"
					className="hierarchy-toggle"
					aria-label={isKo ? `${label} ${expanded ? "접기" : "펼치기"}` : `${expanded ? "Collapse" : "Expand"} ${label}`}
					onClick={() => onToggle(node.id)}
				>
					{expanded ? "▾" : "▸"}
				</button>
			) : (
				<span className="hierarchy-toggle placeholder" />
			)}
			{editing ? (
				// In-place rename, Unity-style: Enter commits, Escape reverts,
				// blur commits (docs/unity-reference.md §9.7). A div, not the
				// row button — an input inside a button is invalid HTML.
				<div className="hierarchy-row">
					<span className={`hierarchy-icon ${node.kind}`} aria-hidden="true" />
					<input
						ref={inputRef}
						className="hierarchy-rename-input"
						defaultValue={node.label}
						aria-label={isKo ? `${label} 이름 바꾸기` : `Rename ${label}`}
						autoFocus
						onFocus={(event) => event.currentTarget.select()}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								event.stopPropagation(); // keep the tree hotkey quiet
								finish();
							} else if (event.key === "Escape") {
								event.stopPropagation(); // revert only, not clear-selection
								cancel();
							}
						}}
						onBlur={finish}
					/>
				</div>
			) : (
				<button type="button" className="hierarchy-row" onClick={() => onSelect(node.id)}>
					<span className={`hierarchy-icon ${node.kind}`} aria-hidden="true" />
					<span className="hierarchy-label">{label}</span>
					{status && <span className="hierarchy-status">{status}</span>}
					{badge !== null && badge !== undefined && badge !== 0 && <span className="hierarchy-badge">{badge}</span>}
				</button>
			)}
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
	onAddObject,
	onRenameObject,
	onDuplicateObject,
	onDeleteObject,
	onFrameObject,
}) {
	const [expanded, setExpanded] = useState(() => new Set(["shot", "characters", "characterA", "characterA.motion"]));
	const [contextMenu, setContextMenu] = useState(null);
	// Row currently in in-place rename. The panel owns it: F2/Return and the
	// row context menu are the only ways in, so app state stays out of it.
	const [editingId, setEditingId] = useState(null);
	const treeRef = useRef(null);
	const lastTreeSelectRef = useRef(null);
	const firstRenderRef = useRef(true);
	const pendingScrollRef = useRef(false);
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

	// Selection made outside the tree (viewport click, plan board, inspector)
	// scrolls the row into view (docs/unity-reference.md §9.6). Tree-originated
	// selections skip this — the browser already scrolls the clicked row. The
	// tab may be hidden at selection time (selecting switches to the inspector),
	// so a hidden-tree selection is remembered and scrolled once the tree shows.
	useEffect(() => {
		if (firstRenderRef.current) {
			firstRenderRef.current = false;
			return;
		}
		if (lastTreeSelectRef.current !== selectedId) pendingScrollRef.current = true;
	}, [selectedId]);

	useEffect(() => {
		const tree = treeRef.current;
		if (!tree || tree.offsetParent === null) return;
		if (!pendingScrollRef.current) return;
		pendingScrollRef.current = false;
		if (!selectedId) return;
		const row = tree.querySelector(`[data-node-id="${CSS.escape(selectedId)}"]`);
		row?.scrollIntoView({ block: "nearest" });
	});

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
		if (id === "characterA.motion" || id === "characterA.baseMotion") return motionFrames ? `${motionFrames}f` : ko("empty", "비어 있음");
		if (id === "characterA.promptBlocks") return promptCount;
		if (id === "characterA.ik") return ikFrames;
		if (id === "rootPath") return waypointCount;
		if (id === "props") return sceneObjects.length;
		return null;
	};
	const statusFor = (id) => {
		if (id === "characterA" && ikMode) return ko("IK ON", "IK 켜짐");
		return null;
	};

	const handleSelect = (id) => {
		lastTreeSelectRef.current = id;
		onSelect(id);
	};

	const openRowMenu = (event, id) => {
		event.preventDefault();
		event.stopPropagation(); // a row pick must not also open the create menu
		if (sceneObjectIdFromHierarchy(id) !== null) {
			setContextMenu({ x: event.clientX, y: event.clientY, height: 148, kind: "object", id });
		} else {
			setContextMenu({ x: event.clientX, y: event.clientY, height: 344, kind: "create" });
		}
	};

	const openCreateMenu = (event) => {
		event.preventDefault(); // suppress the browser menu on the tree only
		setContextMenu({ x: event.clientX, y: event.clientY, height: 344, kind: "create" });
	};

	const handleMenuAction = (action, hierarchyId) => {
		setContextMenu(null);
		if (action === "rename") {
			setEditingId(hierarchyId);
			return;
		}
		const objectId = sceneObjectIdFromHierarchy(hierarchyId);
		if (!objectId) return;
		if (action === "duplicate") onDuplicateObject?.(objectId);
		else if (action === "delete") onDeleteObject?.(objectId);
		else if (action === "frame") onFrameObject?.(objectId);
	};

	const commitRename = (hierarchyId, name) => {
		setEditingId(null);
		const objectId = sceneObjectIdFromHierarchy(hierarchyId);
		if (objectId) onRenameObject?.(objectId, name);
	};

	const cancelRename = () => {
		setEditingId(null);
	};

	// F2 / Return rename the selected row in place while focus is in the
	// tree (docs/unity-reference.md §9.2). The rename input stops its own
	// Enter/Escape, so an active edit never re-triggers this.
	const onTreeKeyDown = (event) => {
		if (editingId) return;
		if (event.key !== "F2" && event.key !== "Enter") return;
		if (sceneObjectIdFromHierarchy(selectedId) === null) return;
		event.preventDefault();
		setEditingId(selectedId);
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
					onSelect={handleSelect}
					onToggle={toggle}
					badge={badgeFor(node.id)}
					status={statusFor(node.id)}
					editing={editingId === node.id}
					onRenameCommit={(name) => commitRename(node.id, name)}
					onRenameCancel={cancelRename}
					onRowContextMenu={openRowMenu}
				/>,
				...(node.children && open ? renderNodes(node.children, depth + 1) : []),
			];
		});

	return (
		<section className="hierarchy-pane" aria-label={ko("Shot hierarchy", "샷 계층")}>
			<div className="hierarchy-heading">
				<div>
					<span className="hierarchy-kicker">{ko("Hierarchy", "계층")}</span>
					<strong>{ko("Shot structure", "샷 구조")}</strong>
				</div>
				<span className="hierarchy-frame-status">{motionFrames ? (isKo ? `${motionFrames}프레임` : `${motionFrames} frames`) : ko("Blocking", "블로킹")}</span>
			</div>
			{onAddObject && (
				<div className="hierarchy-toolbar">
					<AddObjectMenu onAdd={onAddObject} />
					<span className="hierarchy-frame-status">{motionFrames ? (isKo ? `${motionFrames}프레임` : `${motionFrames} frames`) : ko("Blocking", "블로킹")}</span>
				</div>
			)}
			<div className="hierarchy-tree" role="tree" ref={treeRef} onKeyDown={onTreeKeyDown} onContextMenu={openCreateMenu}>
				{renderNodes(hierarchyNodes)}
			</div>
			<RowContextMenu
				menu={contextMenu}
				onClose={() => setContextMenu(null)}
				onAction={handleMenuAction}
				onAddObject={(kind) => {
					setContextMenu(null);
					onAddObject?.(kind);
				}}
			/>
		</section>
	);
}
