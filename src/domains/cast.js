import { copyPhysicsKeys } from "../ardy/physics-review.js";
import { useSemanticState } from "../use-semantic-state.js";
import { useState, useMemo } from "react";
import {
	loadCustomPoses,
	DEFAULT_POSE,
	capturePose,
	captureHipsOffset,
	saveCustomPoses,
	deleteCustomPose,
} from "../poses.js";
import { createCharacterEntry, createCharacterLayer } from "../scenes.js";
import {
	DEFAULT_SUBJECT,
	DEFAULT_SUBJECT2,
	nextCharacterId,
	DEFAULT_PROMPT_CLIPS,
	MAX_WAYPOINTS,
	MULTIMODEL_REASONS,
	ARDY_PROMPT_HORIZON_FRAMES,
	ARDY_DURATION_MIN,
	TIMELINE_FPS,
} from "../app-stage.jsx";
import { ko, isKo } from "../locale.js";
import { createIkState } from "../ardy/ik.js";
import { judgeNextWaypoint } from "../ardy/waypoints.js";
import { StudioProtocolError } from "../studio-agent-protocol.js";
import { studioActionRefusal } from "../studio-actions.js";
import { createStableItemId, removeStableItem, updateStableItem } from "../stable-items.js";
import { trackFeature } from "../analytics.js";
import { requestBridgeExtract } from "../multimodel-ingest.js";
import { loadMotionFromUrl } from "../ardy/npz.js";
import { snapshotPlaybackBones, applyMotionFrame, restorePlaybackBones } from "../ardy/playback.js";
import { movePromptClipFrames } from "../ardy/prompt-clips.js";

import { HISTORY_LIMIT } from "../history.js";

export function useCast(appContext) {
	// The cast is ONE list now: every character (position, rig model, pose,
	// subject line) lives in `characters`, and the legacy A/B view of the
	// world is derived below so the rest of the studio keeps working while
	// spawned extras ride the same rails.
	const [characters, setCharacters, editCharacters] = useSemanticState(appContext.shared.startupStage.characters, appContext.shared.markSemanticEdit, "characters");

	const [customPoses, setCustomPoses] = useState(() => loadCustomPoses());

	const [posing, setPosing] = useState(null);

	const [posingClosing, setPosingClosing] = useState(false);

	const [studioPick, setStudioPick] = useState(null);

	const [rigs, setRigs] = useState({});

	const [rigMountEpoch, setRigMountEpoch] = useState(0);

	const [poseRevision, setPoseTick] = useState(0);

	/* --------------------- derived cast view + shims ---------------------- */
	// Fallback second slot mirrors the old charB defaults so preset math and
	// the two-subject inspector never see a hole before B exists.
	const charA = characters[0] ?? createCharacterEntry(null, 0);

	const charB = characters[1] ?? { ...createCharacterEntry(null, 1), x: 1.15, z: 0.1, rot: -14 };

	const showB = characters.some((entry, index) => index > 0 && !entry.hidden);

	const poseA = charA.pose ?? DEFAULT_POSE;

	const poseB = charB.pose ?? DEFAULT_POSE;

	const subject = charA.subject ?? DEFAULT_SUBJECT;

	const subject2 = charB.subject ?? DEFAULT_SUBJECT2;

	const rigA = rigs[charA.id] ?? null;

	const rigB = (characters[1] ? rigs[charB.id] : null) ?? null;

	function updateCharacterAt(index, next) {
		editCharacters((list) => list.map((entry, i) => {
			if (i !== index) return entry;
			const resolved = typeof next === "function" ? next(entry) : next;
			return { ...entry, ...resolved };
		}));
	}

	// The shims keep the legacy call sites (inspector sliders, presets, pose
	// studio, prompts) untouched while the list stays the source of truth.
	const setCharA = (next) => updateCharacterAt(0, next);

	const setCharB = (next) => updateCharacterAt(1, next);

	const setPoseA = (pose) => updateCharacterAt(0, (entry) => ({ pose: typeof pose === "function" ? pose(entry.pose ?? DEFAULT_POSE) : pose }));

	const setPoseB = (pose) => updateCharacterAt(1, (entry) => ({ pose: typeof pose === "function" ? pose(entry.pose ?? DEFAULT_POSE) : pose }));

	const setSubject = (value) => updateCharacterAt(0, (entry) => ({ subject: typeof value === "function" ? value(entry.subject) : value }));

	const setSubject2 = (value) => updateCharacterAt(1, (entry) => ({ subject: typeof value === "function" ? value(entry.subject) : value }));

	function setShowB(next) {
		recordCharacterUndo();
		editCharacters((list) => {
			const anyVisibleExtra = list.some((entry, i) => i > 0 && !entry.hidden);
			const on = typeof next === "function" ? next(anyVisibleExtra) : next;
			if (on) {
				if (anyVisibleExtra) return list;
				const hiddenIdx = list.findIndex((entry, i) => i > 0 && entry.hidden);
				if (hiddenIdx > 0) return list.map((entry, i) => (i === hiddenIdx ? { ...entry, hidden: false } : entry));
				return [...list, createCharacterEntry({ id: nextCharacterId(list), x: 1.15, z: 0.1, rot: -14, pose: DEFAULT_POSE, subject: DEFAULT_SUBJECT2 }, list.length)];
			}
			return list.map((entry, i) => (i > 0 && !entry.hidden ? { ...entry, hidden: true } : entry));
		});
	}

	function moveCharacter(charId, next) {
		editCharacters((list) => list.map((entry) => {
			if (entry.id !== charId) return entry;
			const resolved = typeof next === "function" ? next(entry) : next;
			return { ...entry, ...resolved };
		}));
	}

	function removeCharacter(charId) {
		const list = appContext.live.characters;
		if (list.length <= 1) return;
		recordCharacterUndo();
		const nextCharacters = list.filter((entry) => entry.id !== charId);
		appContext.publishCharacters(nextCharacters);
		editCharacters(nextCharacters);
		// The deleted layer's untrimmed take goes with it: a recycled id must
		// never inherit a stranger's take, and its stature left with the entry.
		appContext.shared.motionFullRef.current.delete(charId);
		setRigs((current) => {
			if (!(charId in current)) return current;
			const next = { ...current };
			delete next[charId];
			return next;
		});
	}

	const reportRig = (charId) => {
		if (!appContext.shared.rigReportersRef.current.has(charId)) {
			appContext.shared.rigReportersRef.current.set(charId, (rig) => {
				setRigs((current) => (current[charId] === rig ? current : { ...current, [charId]: rig }));
				window.__cozyclayMcpRigReady = [...new Set([...(window.__cozyclayMcpRigReady ?? []), charId])];
				window.dispatchEvent(new CustomEvent("cozyclay:mcp-rig-ready", { detail: charId }));
				const waiter = appContext.shared.rigWaitersRef.current.get(charId);
				if (waiter) {
					appContext.shared.rigWaitersRef.current.delete(charId);
					waiter(rig);
				}
			});
		}
		return appContext.shared.rigReportersRef.current.get(charId);
	};

	const spawnCharacter = (model, x, z) => {
		recordCharacterUndo();
		const id = nextCharacterId(characters);
		editCharacters((list) => [...list, createCharacterEntry({ id, model, x, z, pose: DEFAULT_POSE, subject: "a person" }, list.length)]);
		appContext.shared.setSelectedHierarchyId(`character:${id}`);
		appContext.notify(ko("Character added to the scene", "인물을 씬에 추가했어요"));
	};

	// Viewport picks tag bodies with "A"/"B"/charId and surfaces route the
	// result to a hierarchy row: the first two keep their legacy row ids.
	const charKeyToHierarchyId = (key) => {
		if (key === "A" || key === "a" || key === "char:A") return "characterA";
		if (key === "B" || key === "b" || key === "char:B") return "characterB";
		return `character:${key.startsWith("char:") ? key.slice(5) : key}`;
	};

	/* ------------------- active character (motion layer) ------------------- */
	// Every character owns an animation layer (root path, prompt blocks,
	// generated clip, IK keys). The studio's motion machinery edits ONE layer
	// at a time — the ACTIVE character's — and selection decides who that is.
	const charIdFromHierarchyId = (hierarchyId) => {
		if (hierarchyId === "characterA") return characters[0]?.id ?? null;
		if (hierarchyId === "characterB") return characters[1]?.id ?? null;
		if (hierarchyId?.startsWith("character:")) return hierarchyId.slice(10);
		return null;
	};

	// State, not a ref: a ref written inside an effect never re-renders, so
	// with an idle app the active character silently stayed behind the row
	// the user just clicked.
	const [activeCharacterId, setActiveCharacterId] = useState(characters[0]?.id ?? null);

	/** The hierarchy row id a cast LIST index owns — mirror of
	 * hierarchy-model's characterRowId, for building namespaced rig ids. */
	const rowIdForCharIndex = (index) => index === 0 ? "characterA" : index === 1 ? "characterB" : characters[index] ? `character:${characters[index].id}` : "characterA";

	const activeChar = characters.find((entry) => entry.id === activeCharacterId) ?? characters[0] ?? charA;

	// Root paths and prompt blocks are the active character's animation layer.
	// With the Inspector driven by selection, showing those tools means putting
	// that character in the hierarchy selection.
	const selectActiveCharacterInHierarchy = () => {
		const id = activeCharacterId ?? characters[0]?.id;
		if (id) appContext.shared.setSelectedHierarchyId(`character:${id}`);
	};

	const activeCharIndex = Math.max(0, characters.findIndex((entry) => entry.id === activeChar.id));

	const activeRig = rigs[activeChar.id] ?? null;

	const waitForRig = (charId, timeoutMs = 10000) => {
		const current = rigs[charId];
		if (current) return Promise.resolve(current);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				appContext.shared.rigWaitersRef.current.delete(charId);
				reject(new Error(ko("The active character's rig is not loaded", "활성 인물의 리그가 로드되지 않았어요")));
			}, timeoutMs);
			appContext.shared.rigWaitersRef.current.set(charId, (rig) => {
				clearTimeout(timer);
				resolve(rig);
			});
		});
	};

	// Read-only previews of the other cast members' layers for the timeline,
	// memoized: a fresh array every render would re-render every lane on
	// every playhead tick.
	const ghostLayers = useMemo(() => characters.flatMap((entry, index) => entry.id === activeChar.id || entry.hidden ? [] : [{
		owner: `S${index + 1}`,
		promptClips: entry.layer?.promptClips ?? [],
		waypointFrames: (entry.layer?.waypoints ?? []).map((waypoint) => waypoint.frame),
	}]), [characters, activeChar.id]);

	// Undo/redo (plan §6.5). The store settles any open drag first, so a
	// mid-drag press commits that drag as one entry and then steps past it.
	// After a step the selection can point at a deleted object — drop it to
	/* ---------------------- character undo stack ---------------------------
	 * The scene history store owns scene OBJECTS; the cast lives outside it.
	 * Character gestures (spawn, remove, show/hide, plan-board drags) push a
	 * full-cast snapshot with the editing buffer folded in, and undo/redo
	 * picks the newer of the two stacks so one Ctrl+Z history covers both. */
	const snapshotCast = (includeShots = false) => ({
		characters: appContext.live.characters.map((entry) => ({
			...entry,
			layer: entry.id === activeChar.id
				? { waypoints: appContext.shared.bufferRef.current.waypoints, promptClips: appContext.shared.bufferRef.current.promptClips }
				: entry.layer,
		})),
		bufferMotion: appContext.shared.bufferRef.current.motion,
		bufferCharId: appContext.shared.loadedLayerCharRef.current,
		// The ACTIVE character's authored IK layer. Only the keys (deep-copied so
		// undo can never hand back live quaternions) and the committed-edit list
		// travel: targets/plants/tracked are transient solver state the next
		// seed/drag rebuilds anyway.
		ikKeys: appContext.shared.snapshotIkKeys(appContext.shared.ikStateRef.current),
		committedIkEdits: appContext.shared.committedIkEdits,
		// Shot-op entries carry the shot list too; character-op entries leave it
		// out so undoing a character move never rolls back unrecorded shot edits.
		...(includeShots ? { shots: appContext.shared.shots } : {}),
	});

	function recordCharacterUndo() {
		appContext.recordCharacterUndo(snapshotCast());
	}

	/** The Inspector's character Transform rows. The viewport gizmo already
	 * records on drag start; these numeric rows are the same edit through
	 * another door, so they record once per scrub / typed commit. */
	function changeInspectorCharacter(gesture, patch) {
		appContext.shared.beginGestureUndo(`character:${activeChar.id}:${gesture}`);
		updateCharacterAt(activeCharIndex, patch);
	}

	function restoreCast(snapshot) {
		// Captured BEFORE the buffer pointer moves: whose IK state the live ref
		// currently holds.
		const loadedIk = appContext.shared.loadedLayerCharRef.current;
		if (snapshot.shots) appContext.shared.setShots(snapshot.shots);
		setCharacters(snapshot.characters);
		const bufferChar = snapshot.characters.find((entry) => entry.id === snapshot.bufferCharId) ?? snapshot.characters[0];
		setWaypoints((bufferChar?.layer?.waypoints ?? []).map((waypoint) => ({ ...waypoint })));
		setPromptClips((bufferChar?.layer?.promptClips ?? []).map((clip) => ({ ...clip })));
		appContext.shared.setMotion(snapshot.bufferMotion);
		appContext.shared.loadedLayerCharRef.current = bufferChar?.id ?? null;
		setActiveCharacterId(bufferChar?.id ?? null);
		// IK keys go back onto the snapshot owner's layer state (again deep-copied,
		// so stepping through the same entry twice cannot alias what the rig is now
		// mutating) and the tick bumps so markers and the keyed pose re-derive.
		if (snapshot.ikKeys) {
			// The keys belong to the snapshot's buffer character. When that
			// character has no stored layer state yet, it gets a fresh one —
			// falling back to the live ref would hand the keys to whoever is
			// active NOW, cross-wiring two characters' corrections (#77).
			let target;
			if (bufferChar?.id === loadedIk) {
				target = appContext.shared.ikStateRef.current;
			} else {
				target = appContext.shared.ikStatesRef.current.get(bufferChar?.id);
				if (!target) {
					target = createIkState();
					if (bufferChar?.id) appContext.shared.ikStatesRef.current.set(bufferChar.id, target);
				}
			}
			target.keys = appContext.shared.snapshotIkKeys({ keys: snapshot.ikKeys });
			target.tracked = new Set([...target.keys.values()].flatMap((entry) => [...entry.keys()]));
			appContext.shared.setCommittedIkEdits(snapshot.committedIkEdits ?? []);
			appContext.shared.setIkTick((value) => value + 1);
		}
	}

	const [hasCharSheet, setHasCharSheet] = useState(appContext.shared.startupStage.hasCharSheet);

	// Bumped when something outside the Inspector needs the Prompt Blocks panel
	// on screen — selecting or adding a block on the timeline.
	const [promptBlocksReveal, setPromptBlocksReveal] = useState(0);

	const revealPromptBlocks = () => setPromptBlocksReveal((n) => n + 1);

	// Root waypoints {frame, x, z, heading: null}, kept sorted by frame —
	// the fixed bridge contract rejects out-of-order or duplicate frames.
	const [waypointMode, setWaypointMode] = useState(false);

	const [waypoints, setWaypoints] = useState(appContext.shared.startupStage.characters?.[0]?.layer?.waypoints ?? appContext.shared.startupShotState?.waypoints ?? []);

	const [activeWaypointId, setActiveWaypointId] = useState(null);

	const [pendingWaypointFrame, setPendingWaypointFrame] = useState(null);

	const [promptClips, setPromptClips, editPromptClips] = useSemanticState(() => (appContext.shared.startupStage.characters?.[0]?.layer?.promptClips ?? DEFAULT_PROMPT_CLIPS).map((clip) => ({ ...clip })), appContext.shared.markSemanticEdit, "promptClips");

	const [selectedPromptId, setSelectedPromptId] = useState(null);

	const [photoPoseState, setPhotoPoseState] = useState("idle");

	const [photoPoseError, setPhotoPoseError] = useState("");

	// The library is the user's own material: poses read from photographs and
	// poses saved off the rig, accumulating across sessions and projects. No
	// presets ship in it — DEFAULT_POSE is the character's spawn state, not a
	// library entry.
	const allPoses = customPoses;

	// The dropdowns must be able to show and re-select the pose a character is
	// actually in, and a fresh character is in the default — which is not a
	// library entry. An empty library would otherwise render a blank select.
	const selectablePoses = useMemo(() => [DEFAULT_POSE, ...customPoses], [customPoses]);

	// The pose studio follows the character it was opened for: `posing` is a
	// charId, so every cast member gets the same studio, not just the first two.
	const posingIndex = characters.findIndex((entry) => entry.id === posing);

	const posingChar = posingIndex >= 0 ? characters[posingIndex] : null;

	const posedRig = () => rigs[posing] ?? null;

	const setPosed = (pose) => {
		if (posingIndex >= 0) updateCharacterAt(posingIndex, { pose: typeof pose === "function" ? pose(posingChar?.pose ?? DEFAULT_POSE) : pose });
	};

	/* ------------------------- waypoint workspace --------------------------- */
	// A walking pace turns clicked distance into clip time, so pins land at
	// frames the character can actually reach without ice-skating.
	const WALK_SPEED_MPS = 1.4;

	const ROOT_ROOM_LIMIT = 11;

	const clampRootPosition = (value) => Math.max(-ROOT_ROOM_LIMIT, Math.min(ROOT_ROOM_LIMIT, value));

	// Frame 0 of a root path is the ACTIVE character's spot — each layer's
	// path starts from its own cast member.
	const rootStart = () => ({ frame: 0, x: activeChar.x, z: activeChar.z });

	function validateWaypointAt(ordered, index, candidate, start = rootStart()) {
		const previous = index > 0 ? ordered[index - 1] : start;
		const beforePrevious = index > 1 ? ordered[index - 2] : null;
		const inbound = judgeNextWaypoint(previous, candidate, appContext.shared.tlFps, beforePrevious);
		if (!inbound.ok) return inbound;
		const next = ordered[index + 1];
		if (!next) return inbound;
		const outbound = judgeNextWaypoint(candidate, next, appContext.shared.tlFps, previous);
		if (!outbound.ok) return outbound;
		return { ok: true, warnings: [...inbound.warnings, ...outbound.warnings] };
	}

	function queueRootWaypointFrame(frame) {
		const target = Math.max(1, Math.min(Math.round(frame), appContext.shared.tlFrameCount - 1));
		const existing = waypoints.find((waypoint) => waypoint.frame === target);
		if (existing) {
			setActiveWaypointId(existing.id);
			setPendingWaypointFrame(null);
			appContext.shared.setTlFrame(target);
			setWaypointMode(true);
			selectActiveCharacterInHierarchy();
			appContext.notify(isKo ? `프레임 ${target}의 루트 웨이포인트를 선택했어요. 탑뷰에서 점을 드래그해 위치를 조정하세요.` : `Root waypoint at frame ${target} selected — drag the pin in the Top-View to reposition.`);
			return;
		}
		setPendingWaypointFrame(target);
		setActiveWaypointId(null);
		appContext.shared.setTlFrame(target);
		setWaypointMode(true);
		selectActiveCharacterInHierarchy();
		appContext.notify(isKo ? `프레임 ${target}이 예약됐어요. 샷 뷰 바닥을 클릭하면 그 위치에 루트 웨이포인트가 생성됩니다.` : `Frame ${target} is reserved — click the Shot-view floor to drop the root waypoint there.`);
	}

	/* One root-path core for every cast member, shared by the Shot-view floor
	 * click, the plan-board drag, the timeline marker and run_action. It takes
	 * the character explicitly: the loaded layer's path lives in the editing
	 * buffer, every other character's on its cast entry. Refusals throw a
	 * StudioProtocolError naming the fix; the UI door shows it as a toast. */
	function castMemberOf(characterId) {
		const character = appContext.live.characters.find((entry) => entry.id === characterId);
		if (!character) throw new StudioProtocolError("STALE_TARGET", `Character ${characterId} is not in this scene.`);
		return character;
	}

	function readCharacterWaypoints(characterId) {
		if (characterId === appContext.shared.loadedLayerCharRef.current) return appContext.shared.bufferRef.current.waypoints;
		return appContext.live.characters.find((entry) => entry.id === characterId)?.layer?.waypoints ?? [];
	}

	function writeCharacterWaypoints(characterId, next) {
		if (characterId === appContext.shared.loadedLayerCharRef.current) {
			appContext.shared.bufferRef.current = { ...appContext.shared.bufferRef.current, waypoints: next };
			setWaypoints(next);
			return;
		}
		appContext.shared.publishStudioCharacters(appContext.live.characters.map((entry) => entry.id === characterId
			? { ...entry, layer: { ...(entry.layer ?? createCharacterLayer()), waypoints: next } }
			: entry), true);
	}

	/** Pin the character's root at `point` ({x, z}) on `frame`, or — frame null —
	 * at walking-distance pacing from the previous pin. Returns the placed
	 * waypoint, its index on the path and the judge's warnings. */
	function addCharacterWaypoint(characterId, point, frame = null) {
		const character = castMemberOf(characterId);
		const ordered = [...readCharacterWaypoints(characterId)].sort((a, b) => a.frame - b.frame);
		if (ordered.length + 1 > MAX_WAYPOINTS) {
			throw studioActionRefusal("TARGET_NOT_READY", `The root path is capped at ${MAX_WAYPOINTS} waypoints; remove one first.`,
				isKo ? `루트 경로는 웨이포인트 ${MAX_WAYPOINTS}개까지 사용할 수 있어요` : `The root path is capped at ${MAX_WAYPOINTS} waypoints`);
		}
		const x = clampRootPosition(point.x);
		const z = clampRootPosition(point.z);
		const start = { frame: 0, x: character.x, z: character.z };
		const last = ordered[ordered.length - 1] ?? start;
		const lastFrame = appContext.shared.frameCountRef.current - 1;
		if (frame !== null && (frame < 1 || frame > lastFrame)) throw new StudioProtocolError("INVALID_RANGE", `Frame ${frame} is outside the root path's frames 1-${lastFrame}.`);
		const at = frame ?? last.frame + Math.max(8, Math.round((Math.hypot(x - last.x, z - last.z) / WALK_SPEED_MPS) * appContext.shared.tlFps));
		if (at > lastFrame) {
			throw studioActionRefusal("INVALID_RANGE", "The path already fills the clip — extend the duration or clear a waypoint.",
				ko("The path already fills the clip — extend the duration or clear a waypoint", "경로가 이미 클립 길이를 채웠어요. 시간을 늘리거나 웨이포인트를 지워 주세요"));
		}
		if (ordered.some((waypoint) => waypoint.frame === at)) {
			throw studioActionRefusal("INVALID_ARGUMENT", `Frame ${at} already has a root waypoint — pick an empty frame or move that one.`,
				isKo ? `프레임 ${at}에는 이미 루트 웨이포인트가 있어요. 타임라인에서 빈 프레임을 선택하세요.` : `Frame ${at} already has a root waypoint — pick an empty frame on the timeline.`);
		}
		// The generator cannot refuse an impossible pin, so placement is the
		// last moment to: block out-of-band legs with the fix named.
		const insertAt = ordered.findIndex((waypoint) => waypoint.frame > at);
		const index = insertAt === -1 ? ordered.length : insertAt;
		const waypoint = { id: createStableItemId("waypoint"), frame: at, x, z, heading: null };
		const next = [...ordered.slice(0, index), waypoint, ...ordered.slice(index)];
		const verdict = validateWaypointAt(next, index, waypoint, start);
		if (!verdict.ok) throw studioActionRefusal("INVALID_ARGUMENT", `Not placed — ${verdict.error}`, isKo ? `배치하지 못했어요 — ${verdict.error}` : `Not placed — ${verdict.error}`);
		// Past every refusal: the pre-drop path is worth one Ctrl+Z entry.
		recordCharacterUndo();
		writeCharacterWaypoints(characterId, next);
		return { waypoint, index, warnings: verdict.warnings };
	}

	function moveCharacterWaypoint(characterId, frame, point) {
		const character = castMemberOf(characterId);
		const ordered = [...readCharacterWaypoints(characterId)].sort((a, b) => a.frame - b.frame);
		const index = ordered.findIndex((waypoint) => waypoint.frame === frame);
		if (index === -1) throw new StudioProtocolError("STALE_TARGET", `${character.subject || character.id} has no root waypoint at frame ${frame}.`);
		const moved = { ...ordered[index], x: clampRootPosition(point.x), z: clampRootPosition(point.z) };
		if (moved.x === ordered[index].x && moved.z === ordered[index].z) return { waypoint: ordered[index], index, warnings: [] };
		const next = ordered.map((waypoint, i) => (i === index ? moved : waypoint));
		const verdict = validateWaypointAt(next, index, moved, { frame: 0, x: character.x, z: character.z });
		if (!verdict.ok) {
			throw studioActionRefusal("INVALID_ARGUMENT", `This position doesn't fit the root path: ${verdict.error}`,
				isKo ? `이 위치는 루트 경로에 맞지 않아요: ${verdict.error}` : `This position doesn't fit the root path: ${verdict.error}`);
		}
		// A plan-board drag recorded its one entry when the gesture began; every
		// other move is its own entry.
		const past = appContext.castHistory.past;
		if (!(appContext.shared.gestureUndoRef.current?.key === "waypoint-drag" && past[past.length - 1]?.tick === appContext.shared.gestureUndoRef.current.tick)) recordCharacterUndo();
		writeCharacterWaypoints(characterId, next);
		return { waypoint: moved, index, warnings: verdict.warnings };
	}

	function removeCharacterWaypoint(characterId, frame) {
		const character = castMemberOf(characterId);
		const current = readCharacterWaypoints(characterId);
		const waypoint = current.find((entry) => entry.frame === frame);
		if (!waypoint) throw new StudioProtocolError("STALE_TARGET", `${character.subject || character.id} has no root waypoint at frame ${frame}.`);
		recordCharacterUndo();
		writeCharacterWaypoints(characterId, removeStableItem(current, waypoint.id, "waypoints"));
		return waypoint;
	}

	function clearCharacterWaypoints(characterId) {
		castMemberOf(characterId);
		const current = readCharacterWaypoints(characterId);
		if (!current.length) return 0;
		recordCharacterUndo();
		writeCharacterWaypoints(characterId, []);
		return current.length;
	}

	/** ARDY-demo style authoring: each empty-floor press in the Shot view drops
	    the next waypoint where it was clicked; the frame gap comes from walking
	    distance. The bird's-eye board selects and drags existing waypoints. */
	function addFloorWaypoint(point) {
		const ordered = [...waypoints].sort((a, b) => a.frame - b.frame);
		const last = ordered[ordered.length - 1] ?? rootStart();
		const pendingFrame = pendingWaypointFrame == null ? null : Math.max(1, Math.min(Math.round(pendingWaypointFrame), appContext.shared.tlFrameCount - 1));
		// A scrubbed playhead is an explicit statement of time: a click lands on
		// that exact frame. An untouched playhead (it snaps to the last pin
		// after every placement) falls back to walking-distance pacing.
		const playhead = Math.round(appContext.shared.tlFrame);
		const pinned = pendingFrame != null || playhead > last.frame;
		const frame = pendingFrame ?? (pinned ? Math.min(playhead, appContext.shared.tlFrameCount - 1) : null);
		const before = readCharacterWaypoints(activeChar.id);
		const placedAction = appContext.shared.runStudioAction("character.addWaypoint", { characterId: activeChar.id, position: { x: point.x, z: point.z }, ...(frame == null ? {} : { frame }) });
		if (!placedAction) {
			if (pendingFrame != null && ordered.some((waypoint) => waypoint.frame === pendingFrame)) setPendingWaypointFrame(null);
			return;
		}
		const path = readCharacterWaypoints(activeChar.id);
		const index = path.findIndex((waypoint) => !before.includes(waypoint));
		const waypoint = path[index];
		appContext.shared.setTlFrame(waypoint.frame);
		setActiveWaypointId(waypoint.id);
		setPendingWaypointFrame(null);
		const { warnings } = validateWaypointAt(path, index, waypoint);
		const placed = isKo
			? `루트 웨이포인트 ${index + 1} 추가: 프레임 ${waypoint.frame}${pendingFrame != null ? " (타임라인 예약 프레임)" : pinned ? " (재생 헤드 위치)" : ` (~${(waypoint.frame / appContext.shared.tlFps).toFixed(1)}초 걷기 기준)`}`
			: `Waypoint ${index + 1} — frame ${waypoint.frame} ${pendingFrame != null ? "(at the reserved frame)" : pinned ? "(at the playhead)" : `(~${(waypoint.frame / appContext.shared.tlFps).toFixed(1)}s at a walk)`}`;
		appContext.notify(warnings.length ? `${placed} · ⚠ ${warnings[0]}` : placed);
	}

	function moveWaypoint(id, x, z) {
		const waypoint = waypoints.find((entry) => entry.id === id);
		if (!waypoint) throw new Error(`Unknown waypoints ID: ${id}`);
		if (!appContext.shared.runStudioAction("character.moveWaypoint", { characterId: activeChar.id, frame: waypoint.frame, position: { x, z } })) return;
		setActiveWaypointId(id);
		setPendingWaypointFrame((current) => (current === waypoint.frame ? null : current));
		const path = readCharacterWaypoints(activeChar.id);
		const index = path.findIndex((entry) => entry.id === id);
		const { warnings } = index === -1 ? { warnings: [] } : validateWaypointAt(path, index, path[index]);
		if (warnings.length) appContext.notify(isKo ? `루트 웨이포인트 이동됨: ${warnings[0]}` : `Root waypoint moved: ${warnings[0]}`);
	}

	function removeWaypoint(id) {
		const waypoint = waypoints.find((entry) => entry.id === id);
		if (!waypoint) throw new Error(`Unknown waypoints ID: ${id}`);
		if (!appContext.shared.runStudioAction("character.removeWaypoint", { characterId: activeChar.id, frame: waypoint.frame })) return;
		setActiveWaypointId((current) => (current === id ? null : current));
		setPendingWaypointFrame((current) => (current === waypoint.frame ? null : current));
	}

	function toggleWaypointMode() {
		const next = !waypointMode;
		// Both modes want the viewport pointer; the last one switched on wins,
		// the other stands down rather than fighting for pointerdown.
		if (next && appContext.shared.lineEditMode) appContext.shared.exitLineEditMode();
		setWaypointMode(next);
		if (!next) {
			setPendingWaypointFrame(null);
			appContext.notify(ko("2D Root path constraints off", "2D 루트 경로 제약 꺼짐"));
			return;
		}

		appContext.notify(ko("2D Root path on — click the set floor in the Shot view to drop waypoints; Subject 1 is the frame 0 start", "2D 루트 경로 켜짐 — 샷 뷰의 세트 바닥을 클릭해 웨이포인트를 놓으세요. 인물 1이 0프레임 시작점입니다"));
	}

	function openStudio(charId) {
		setPosing(charId);
		setPosingClosing(false);
		const entry = characters.find((item) => item.id === charId);
		setStudioPick((entry?.pose ?? DEFAULT_POSE)?.id ?? null);
	}

	function closeStudio() {
		// let the panel play its exit animation before it leaves the tree
		setPosingClosing(true);
		window.setTimeout(() => {
			setPosing(null);
			setPosingClosing(false);
		}, 190);
	}

	/** Save the ACTIVE character's rig exactly as it stands — the motion frame
	 * with any IK corrections already composited — into the pose library.
	 * Unlike savePose (the studio's FK author), this never writes back onto the
	 * character: a running take must survive having its best frame bottled. */
	function saveCurrentPose() {
		if (!activeRig) return;
		trackFeature("pose_edit");
		const pose = {
			id: `custom_${Date.now()}`,
			label: isKo ? `내 포즈 ${customPoses.length + 1}` : `My Pose ${customPoses.length + 1}`,
			prompt: "in the exact body pose shown in the blocking frame",
			bones: capturePose(activeRig),
			// A take frame carries its measured hips height; bottling the frame
			// without it would save every crouch as a float.
			rootY: captureHipsOffset(activeRig),
			custom: true,
		};
		const next = [...customPoses, pose];
		setCustomPoses(next);
		saveCustomPoses(next);
		setStudioPick(pose.id);
		appContext.notify(appContext.shared.motion
			? ko(`Saved this frame's pose to the library as “${pose.label}”`, `지금 프레임의 자세를 “${pose.label}”로 라이브러리에 저장했어요`)
			: ko(`Saved the current pose to the library as “${pose.label}”`, `지금 자세를 “${pose.label}”로 라이브러리에 저장했어요`));
	}

	function savePose() {
		const rig = posedRig();
		if (!rig) return;
		trackFeature("pose_edit");
		const pose = {
			id: `custom_${Date.now()}`,
		label: isKo ? `내 포즈 ${customPoses.length + 1}` : `My Pose ${customPoses.length + 1}`,
			prompt: "in the exact body pose shown in the blocking frame",
			bones: capturePose(rig),
			custom: true,
		};
		const next = [...customPoses, pose];
		setCustomPoses(next);
		saveCustomPoses(next);
		setStudioPick(pose.id);
		// The library is not on the cast history; writing the saved pose onto the
		// posed character is, and setPosed only writes when one is being posed.
		if (posingIndex >= 0) recordCharacterUndo();
		setPosed(pose);
		appContext.notify(ko("Pose saved", "포즈 저장됨"));
	}

	/**
	 * Read a body pose out of one photograph.
	 *
	 * A still is the degenerate footage case, so it walks the same proven path:
	 * landmarks -> one-frame take -> applyMotionFrame -> capturePose. Posing the
	 * rig and reading it back is what makes the result an ordinary editable pose
	 * rather than a motion layer — the IK handles keep working on it, and the
	 * playback bones are restored so nothing about the take survives the read.
	 *
	 * Depth in a single frame is inferred, not measured, so this is a starting
	 * pose to refine, which is why it lands in the studio instead of on the
	 * character directly.
	 */
	async function posePhotoFile(file) {
		if (!file || photoPoseState === "running") return;
		// Reachable from the Inspector as well as the studio panel, and posedRig()
		// only answers while the studio is open — fall back to the character the
		// hierarchy has selected, which is the one the pose will be applied to.
		const rig = posedRig() ?? activeRig;
		let objectUrl = "";
		setPhotoPoseState("running");
		setPhotoPoseError("");
		try {
			if (!rig) throw new Error("rig-not-loaded");
			objectUrl = URL.createObjectURL(file);
			let bones = null;
			let rootY = 0;
			let gpuError = null;
			// GVHMR on the box measures the body over the whole clip,
			// which is more reliable than a single-frame depth estimate.
			// The bridge wraps the still into a second of video and runs the exact
			// GVHMR footage pipeline. A missing bridge or another backend is an error.
			try {
				const health = await fetch("/ardy/health", { signal: AbortSignal.timeout(2000) }).catch(() => null);
				if (!health?.ok) throw new Error("extract-bridge-required");
				const healthPayload = await health.json().catch(() => null);
				if (healthPayload?.extractionBackend !== "gvhmr") throw new Error("extract-backend-unsupported");
				const done = await requestBridgeExtract(file, {});
				const take = await loadMotionFromUrl(done.motionUrl);
				// The middle frame: the wrap's smoothing passes have settled
				// there, while frame 0 can still carry filter warm-up.
				const frame = Math.floor((take.frames - 1) / 2);
				const snapshot = snapshotPlaybackBones(rig);
				try {
					applyMotionFrame(rig, { ...take, anchorFrame: frame }, frame);
					bones = capturePose(rig);
					// GVHMR measured the hips' true height — a crouch is a crouch
					// because the hips came DOWN, not just because the knees bent.
					rootY = captureHipsOffset(rig);
				} finally {
					restorePlaybackBones(rig, snapshot);
				}
			} catch (error) {
				gpuError = error;
				console.warn("photo pose: GVHMR extract failed", error);
			}
			if (!bones) throw new Error(gpuError?.message || "extract-run-failed");
			const pose = {
				id: `photo_${Date.now()}`,
				label: isKo ? `사진 포즈 ${customPoses.length + 1}` : `Photo Pose ${customPoses.length + 1}`,
				prompt: "in the exact body pose shown in the reference photograph",
				bones,
				rootY,
				custom: true,
			};
			const next = [...customPoses, pose];
			setCustomPoses(next);
			saveCustomPoses(next);
			setStudioPick(pose.id);
			// The studio poses whichever character it was opened on; the Inspector
			// poses the selected one. Write the pose to whichever that is.
			const poseTargetIndex = posingIndex >= 0 ? posingIndex : activeCharIndex;
			// A running take drives the same bones a pose writes, so the read would
			// land invisibly underneath it. Applying from a photo follows the same
			// rule the Apply button already states: the motion goes first.
			const hadMotion = Boolean(appContext.shared.motion);
			// One gesture, one Ctrl+Z entry. clearMotion() already snapshots the
			// pre-gesture cast — pose included — so undoing it brings back the take
			// AND the pose this write replaces. With no take to clear, the pose
			// write is the whole edit and records itself.
			if (hadMotion) appContext.shared.clearMotion();
			else recordCharacterUndo();
			updateCharacterAt(poseTargetIndex, { pose });
			setPhotoPoseState("done");
			// The pose is already saved and written by this point. GVHMR either
			// returns a measured pose or the named error above reaches the user.
			appContext.notify(hadMotion
					? ko("Cleared the motion and posed from the photo — refine it with the handles", "모션을 지우고 사진으로 자세를 잡았어요 — 핸들로 다듬어 보세요")
					: ko("Pose read from the photo — refine it with the handles", "사진에서 자세를 읽었어요 — 핸들로 다듬어 보세요"));
		} catch (error) {
			const code = error?.message ?? String(error);
			// fitLandmarksToPose refuses a sample whose torso is not visible; that is
			// a photograph problem, not an engine problem, so it is named as one.
			const named = code.startsWith("fitLandmarksToPose:") ? "pose-partly-occluded" : code;
			setPhotoPoseState("error");
			setPhotoPoseError(MULTIMODEL_REASONS[named]?.[isKo ? 1 : 0] ?? named);
		} finally {
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		}
	}

	function removePose(id) {
		const next = deleteCustomPose(id, customPoses);
		setCustomPoses(next);
		saveCustomPoses(next);
		// Deleting a pose that is ON a character resets that character to the
		// default — a cast change, so it belongs on Ctrl+Z. Deleting an unused
		// library entry changes no character and records nothing.
		if (poseA?.id === id || poseB?.id === id) recordCharacterUndo();
		if (poseA?.id === id) setPoseA(DEFAULT_POSE);
		if (poseB?.id === id) setPoseB(DEFAULT_POSE);
		if (studioPick === id) setStudioPick(DEFAULT_POSE.id);
	}

	function addPromptClip(frame, surface = "timeline") {
		const snapped = Math.max(0, Math.round(frame / ARDY_PROMPT_HORIZON_FRAMES) * ARDY_PROMPT_HORIZON_FRAMES);
		// Add at the playhead when the spot is free; only fall through to
		// after-the-last-block when the playhead slot is taken. The old
		// unconditional max() made the button's "at frame N" label a lie.
		const blocked = promptClips.some((clip) => snapped < clip.endFrame && snapped + ARDY_PROMPT_HORIZON_FRAMES > clip.startFrame);
		const startFrame = blocked
			? Math.max(snapped, promptClips.reduce((max, clip) => Math.max(max, clip.endFrame), 0))
			: snapped;
		const clip = { id: createStableItemId("prompt-clip"), startFrame, endFrame: startFrame + ARDY_PROMPT_HORIZON_FRAMES, text: "" };
		recordCharacterUndo();
		editPromptClips((prev) => [...prev, clip]);
		setSelectedPromptId(clip.id);
		appContext.shared.setTlFrameCount((count) => Math.max(count, clip.endFrame));
		appContext.shared.setArdyDuration(Math.max(ARDY_DURATION_MIN, clip.endFrame / TIMELINE_FPS));
		trackFeature("prompt_block_add");
	}

	function changePromptClip(id, text) {
		const clip = promptClips.find((entry) => entry.id === id);
		if (!clip) throw new Error(`Unknown promptClips ID: ${id}`);
		if (clip.text === text) return;
		// Typing is one entry per editing session, not per keystroke: the first
		// change on a clip snapshots the text as it stood, and the rest of the
		// session keeps writing into that same entry. Reached from the inspector
		// field and from the timeline chip alike.
		appContext.shared.recordSessionUndo(appContext.shared.promptTextSessionRef, `prompt-text:${id}`);
		editPromptClips((prev) => updateStableItem(prev, id, (clip) => ({ ...clip, text }), "promptClips"));
		if (id === selectedPromptId) appContext.shared.setArdyPrompt(text);
	}

	// Quality policy: one prompt block never spans more than 5 s. Kimodo
	// walk-to-run sweeps (seeds 7/21/99; seam stall ratio, 1.0 = no stall)
	// scored 0.79 for 5 s blocks (best of the sweep), close to a seam-free
	// single take at 0.85; 8 s blocks collapsed to 0.32. <2 s blocks lose
	// about a third of their frames to the transition window, so 3-5 s is the recommended
	// authoring range.
	const PROMPT_BLOCK_MAX_FRAMES = 5 * TIMELINE_FPS;

	function resizePromptClip(id, edge, rawFrame) {
		editPromptClips((prev) => {
			const candidate = updateStableItem(prev, id, (clip) => {
				const snapped = Math.max(0, Math.round(rawFrame / ARDY_PROMPT_HORIZON_FRAMES) * ARDY_PROMPT_HORIZON_FRAMES);
				return edge === "start"
					? { ...clip, startFrame: Math.min(Math.max(snapped, clip.endFrame - PROMPT_BLOCK_MAX_FRAMES), clip.endFrame - ARDY_PROMPT_HORIZON_FRAMES) }
					: { ...clip, endFrame: Math.min(Math.max(clip.startFrame + ARDY_PROMPT_HORIZON_FRAMES, snapped), clip.startFrame + PROMPT_BLOCK_MAX_FRAMES) };
			}, "promptClips");
			// Same rule the move path enforces: one prompt per frame range.
			// A resize that lands on a neighbour used to slip through and get
			// silently truncated by the generator; reject it at the handle.
			const resized = candidate.find((clip) => clip.id === id);
			if (resized && candidate.some((clip) => clip.id !== id && resized.startFrame < clip.endFrame && resized.endFrame > clip.startFrame)) {
				return prev;
			}
			const end = candidate.reduce((max, clip) => Math.max(max, clip.endFrame), ARDY_PROMPT_HORIZON_FRAMES);
			appContext.shared.setTlFrameCount((count) => Math.max(count, end));
			appContext.shared.setArdyDuration(end / TIMELINE_FPS);
			return candidate;
		});
	}

	function movePromptClip(id, rawStartFrame) {
		if (!promptClips.some((clip) => clip.id === id)) throw new Error(`Unknown promptClips ID: ${id}`);
		editPromptClips((prev) => {
			const next = movePromptClipFrames(prev, id, rawStartFrame, ARDY_PROMPT_HORIZON_FRAMES);
			if (next === prev) return prev;
			const end = next.reduce((max, clip) => Math.max(max, clip.endFrame), ARDY_PROMPT_HORIZON_FRAMES);
			appContext.shared.setTlFrameCount((count) => Math.max(count, end));
			appContext.shared.setArdyDuration(end / TIMELINE_FPS);
			return next;
		});
	}

	function removePromptClip(id) {
		if (!promptClips.some((clip) => clip.id === id)) throw new Error(`Unknown promptClips ID: ${id}`);
		recordCharacterUndo();
		editPromptClips((prev) => removeStableItem(prev, id, "promptClips"));
		if (selectedPromptId === id) setSelectedPromptId(null);
	}
	function beginNativeStudioAction(domain, targetId = null) {
		if (appContext.shared.studioActionGroupRef.current) throw new StudioProtocolError("TARGET_BUSY", "A command owns native history.");
		const historyEntryId = crypto.randomUUID(), objects = appContext.shared.storeRef.current.objects;
		const history = appContext.castHistory, past = [...history.past], future = [...history.future], states = [];
		let objectSession, changed = false, firstEntry;
		const session = {
			touch(domain, targetId) {
				if (domain === "objects") { objectSession ??= appContext.shared.objectsDomain.beginStudioObjectAction(); return; }
				if (!states.some(row => row.domain === domain && row.targetId === targetId)) states.push({ domain, targetId, state: appContext.shared.snapshotStudioDomain(domain, targetId) });
			},
			run(fn) {
				const finish = result => {
					const added = history.past.filter(entry => !past.includes(entry));
					firstEntry ??= added[0]; changed ||= added.length > 0;
					history.past = [...past]; history.future = [...future];
					return result;
				};
				const result = objectSession ? objectSession.run(fn) : fn();
				return result?.then ? result.then(finish) : finish(result);
			},
			commit() {
				const objectsChanged = objectSession?.commit() ?? false;
				appContext.patchLive({ objects: appContext.shared.storeRef.current.objects });
				const compound = states.length > 1 || (states.length > 0 && objectsChanged);
				if (changed || (compound && objectsChanged)) {
					const tick = appContext.nextTick(), saved = states[0];
					const studio = compound ? { domain: "compound", state: states, objectsChanged } : saved;
					history.past.push({ tick, snapshot: firstEntry?.snapshot ?? appContext.shared.snapshotCast(true), studio: { ...studio, historyEntryId, objects: appContext.shared.storeRef.current.objects } });
					history.past = history.past.slice(-HISTORY_LIMIT); history.future = [];
					appContext.shared.studioHistoryRef.current.set(historyEntryId, { tick, domain: studio.domain, ...(objectsChanged ? { before: objects } : {}) });
				} else if (objectsChanged) appContext.shared.studioHistoryRef.current.set(historyEntryId, { domain: "objects", before: objects, tick: appContext.objectClock, depth: appContext.shared.storeRef.current.depths().past });
				changed ||= objectsChanged;
				appContext.shared.studioActionGroupRef.current = null;
				return { historyEntryId: changed ? historyEntryId : null };
			},
			cancel({ restore = true } = {}) {
				objectSession?.cancel();
				if (restore) {
					for (const row of [...states].reverse()) appContext.shared.publishStudioDomain(row.domain, row.targetId, row.state);
					history.past = past; history.future = future;
				}
				appContext.shared.studioActionGroupRef.current = null;
			},
		};
		session.touch(domain, targetId); appContext.shared.studioActionGroupRef.current = session;
		return session;
	}
	function publishNativeStudioDomain(domain, targetId, state) {
		if (domain === "shot") appContext.shared.shotsDomain.publishStudioShots(state);
		else if (domain === "stage") appContext.shared.publishStudioStage(state.stage);
		else if (domain === "cast") { appContext.shared.publishStudioCharacters(state.characters); appContext.shared.syncStudioLayerBuffer(state.characters); }
		else appContext.shared.publishStudioMotion(targetId, state);
	}
	function isNativeStudioHistoryRetained(receipt) {
		const id = receipt?.undo?.historyEntryId, entry = appContext.shared.studioHistoryRef.current.get(id);
		if (!entry) return false;
		const retained = (!entry.before || appContext.shared.storeRef.current.hasHistoryState(entry.before)) && (entry.domain === "objects"
			|| [...appContext.castHistory.past, ...appContext.castHistory.future].some(row => row.studio?.historyEntryId === id));
		if (!retained) appContext.shared.studioHistoryRef.current.delete(id);
		return retained;
	}
	function stepNativeStudioHistory(redo) {
		const history = appContext.castHistory, from = redo ? history.future : history.past, to = redo ? history.past : history.future;
		const top = from.at(-1);
		// Object undo/redo advances the global clock, even when it returns to the
		// exact object state captured by this Studio entry. Use that boundary
		// instead of hiding older Studio history behind the traversal tick.
		if (!top?.studio || top.studio.objects !== appContext.shared.storeRef.current.objects) return false;
		const entry = top.studio;
		const state = entry.domain === "compound" ? entry.state.map(row => ({ ...row, state: appContext.shared.snapshotStudioDomain(row.domain, row.targetId) })) : appContext.shared.snapshotStudioDomain(entry.domain, entry.targetId);
		if (entry.objectsChanged) appContext.shared.objectsDomain.stepObjectHistory(redo);
		to.push({ ...top, studio: { ...entry, objects: appContext.shared.storeRef.current.objects, state } }); from.pop();
		if (entry.domain === "compound") { for (const row of [...entry.state].reverse()) appContext.shared.publishStudioDomain(row.domain, row.targetId, row.state); }
		else publishNativeStudioDomain(entry.domain, entry.targetId, entry.state);
		appContext.shared.sceneRevisionRef.current++; appContext.nextTick();
		appContext.notify(redo ? ko("Redone", "다시 실행됨") : ko("Undone", "실행 취소됨")); return true;
	}
	function commitNativeStudioDraft(payload) {
		const historyEntryId = crypto.randomUUID();
		if (payload.domain === "objects") {
			appContext.shared.objectsDomain.commitStudioObjects(payload.draft, historyEntryId);
		} else {
			appContext.shared.recordStudioHistory(payload.domain, null, historyEntryId);
			if (payload.domain === "stage") appContext.shared.publishStudioStage(payload.draft);
			else if (payload.domain === "cast") { appContext.shared.publishStudioCharacters(payload.draft, true); appContext.shared.syncStudioLayerBuffer(payload.draft); }
			else appContext.shared.shotsDomain.commitStudioShots(payload.draft);
		}
		return { historyEntryId };
	}
	function canUndoNativeStudioReceipt(receipt) {
		const entry = receipt?.undo && appContext.shared.studioHistoryRef.current.get(receipt.undo.historyEntryId);
		if (!entry || receipt.revision.after !== appContext.shared.sceneRevisionRef.current) return false;
		return entry.domain === "objects" ? entry.tick === appContext.objectClock && entry.tick >= (appContext.castHistory.past.at(-1)?.tick ?? 0) && entry.depth === appContext.shared.storeRef.current.depths().past :
			entry.tick === appContext.castHistory.past.at(-1)?.tick && entry.tick > appContext.objectClock;
	}
	function applyExternalCharacters(characters) {
		const merged = characters.map(entry => {
			const current = appContext.live.characters.find(item => item.id === entry.id);
			return current?.sessionMotion ? { ...entry, sessionMotion: current.sessionMotion } : entry;
		});
		appContext.publishCharacters(merged);
		setCharacters(merged);
		appContext.shared.restoreMotionRefs(merged);
	}
	function publishStudioCharacters(next, authored = false) {
		appContext.publishCharacters(next); appContext.patchLive({ characters: next });
		(authored ? editCharacters : setCharacters)(next);
	}
	/** The active character's layer lives in the editing buffer, and the read
	 * model folds that buffer back over the cast. A published or restored prompt
	 * schedule or root path has to reach it in the same tick, or the next read
	 * would revert it. */
	function syncStudioLayerBuffer(rows) {
		const layer = rows.find(entry => entry.id === appContext.shared.loadedLayerCharRef.current)?.layer;
		const changed = key => Array.isArray(layer?.[key]) && JSON.stringify(layer[key]) !== JSON.stringify(appContext.shared.bufferRef.current[key]);
		const clips = changed("promptClips"), path = changed("waypoints");
		if (!clips && !path) return;
		appContext.shared.bufferRef.current = { ...appContext.shared.bufferRef.current, ...(clips ? { promptClips: layer.promptClips } : {}), ...(path ? { waypoints: layer.waypoints } : {}) };
		if (clips) setPromptClips(layer.promptClips);
		if (path) setWaypoints(layer.waypoints);
	}
	// props so the inspector cannot show a ghost.
	function undoScene() {
		if (appContext.shared.studioBindingRef.current?.stepHistory(false)) return;
		const charTop = appContext.castHistory.past[appContext.castHistory.past.length - 1];
		if (charTop && charTop.tick > appContext.objectClock) {
			appContext.castHistory.future.push({ tick: charTop.tick, snapshot: snapshotCast(Boolean(charTop.snapshot.shots)) });
			appContext.castHistory.past.pop();
			restoreCast(charTop.snapshot);
			appContext.notify(ko("Undone", "실행 취소됨"));
			return;
		}
		appContext.suppressObjectClock = true;
		const restored = appContext.shared.objectsDomain.stepObjectHistory(false);
		appContext.suppressObjectClock = false;
		if (restored === null) {
			appContext.notify(ko("Nothing to undo", "실행 취소할 작업이 없어요"));
			return;
		}
		appContext.advanceObjectClock();
		if (appContext.shared.objectDeleteUndo?.id && restored.some((object) => object.id === appContext.shared.objectDeleteUndo.id)) {
			appContext.shared.setSelectedHierarchyId(`object:${appContext.shared.objectDeleteUndo.id}`);
			appContext.shared.setObjectDeleteUndo(null);
		} else if (appContext.shared.selectedSceneObjectId && !restored.some((object) => object.id === appContext.shared.selectedSceneObjectId)) {
			appContext.shared.setSelectedHierarchyId("props");
		}
		appContext.notify(ko("Undone", "실행 취소됨"));
	}
	function redoScene() {
		if (appContext.shared.studioBindingRef.current?.stepHistory(true)) return;
		const charTop = appContext.castHistory.future[appContext.castHistory.future.length - 1];
		if (charTop && charTop.tick > appContext.objectClock) {
			appContext.castHistory.past.push({ tick: charTop.tick, snapshot: snapshotCast(Boolean(charTop.snapshot.shots)) });
			appContext.castHistory.future.pop();
			restoreCast(charTop.snapshot);
			appContext.notify(ko("Redone", "다시 실행됨"));
			return;
		}
		appContext.suppressObjectClock = true;
		const restored = appContext.shared.objectsDomain.stepObjectHistory(true);
		appContext.suppressObjectClock = false;
		if (restored === null) {
			appContext.notify(ko("Nothing to redo", "다시 실행할 작업이 없어요"));
			return;
		}
		appContext.advanceObjectClock();
		if (appContext.shared.selectedSceneObjectId && !restored.some((object) => object.id === appContext.shared.selectedSceneObjectId)) {
			appContext.shared.setSelectedHierarchyId("props");
		}
		appContext.notify(ko("Redone", "다시 실행됨"));
	}
	function recordStudioHistory(domain, targetId, historyEntryId) {
		const tick = appContext.nextTick();
		appContext.castHistory.past.push({ tick, snapshot: snapshotCast(domain === "shot"),
			studio: { domain, targetId, historyEntryId, objects: appContext.shared.storeRef.current.objects, state: snapshotStudioDomain(domain, targetId) } });
		appContext.castHistory.past = appContext.castHistory.past.slice(-HISTORY_LIMIT);
		appContext.castHistory.future = [];
		appContext.shared.studioHistoryRef.current.set(historyEntryId, { tick, domain });
	}
	function snapshotStudioDomain(domain, targetId) {
		const state = appContext.shared.readStudioState();
		if (domain === "shot") return { shots: state.shots, camera: state.camera, manual: state.manual };
		if (domain === "stage") return { stage: state.stage };
		if (domain === "cast") return { characters: state.characters };
		const target = state.targets.get(targetId);
		return { character: state.characters.find(c => c.id === targetId), fullMotion: appContext.shared.motionFullRef.current.get(targetId),
			ikState: { ...createIkState(), keys: copyPhysicsKeys(target?.ikState?.keys ?? new Map()), tracked: new Set(target?.ikState?.tracked ?? []) },
			frameCount: state.frameCount, committedIkEdits: targetId === appContext.shared.loadedLayerCharRef.current ? appContext.shared.committedIkEdits : [],
			renderer: target?.rig ? appContext.shared.snapshotExportRig(target.rig) : null };
	}
	function removeLegacyRootWaypoint() {
		// Subject 1 is the sole frame-zero root start. Drop any legacy seeded
		// waypoint so Top-View never renders two start markers.
		setWaypoints((current) => current.filter((waypoint) => waypoint.frame !== 0));
		setActiveWaypointId(null);
		setPendingWaypointFrame((current) => (current === 0 ? null : current));
	}
	function switchActiveCharacterLayer() {
		const previous = appContext.shared.loadedLayerCharRef.current;
		if (previous === activeChar.id) return;
		// Leaving IK on switch: the handles are re-seated per rig, and a
		// half-dragged chain must never leak onto another character.
		if (appContext.shared.ikMode) appContext.shared.leaveIkMode();
		if (previous) {
			appContext.shared.ikStatesRef.current.set(previous, appContext.shared.bufferRef.current.ik);
			setCharacters((list) => list.map((entry) => entry.id === previous
				? { ...entry, layer: { waypoints: appContext.shared.bufferRef.current.waypoints, promptClips: appContext.shared.bufferRef.current.promptClips }, sessionMotion: appContext.shared.bufferRef.current.motion }
				: entry));
		}
		const layer = activeChar.layer ?? createCharacterLayer();
		setWaypoints(layer.waypoints.map((waypoint) => ({ ...waypoint })));
		setPromptClips(layer.promptClips.map((clip) => ({ ...clip })));
		// A clip that arrived while this character was inactive (an extra
		// extraction take, a restored motionRef, a queued generation) becomes
		// trimmable the moment it enters the buffer. Seed only when absent: an
		// existing entry is the UNTRIMMED take, and the buffer may be holding a
		// cut view of it.
		if (activeChar.sessionMotion && !appContext.shared.motionFullRef.current.has(activeChar.id)) {
			appContext.shared.motionFullRef.current.set(activeChar.id, activeChar.sessionMotion);
		}
		appContext.shared.motionDomain.setMotion(activeChar.sessionMotion ?? null);
		setSelectedPromptId(null);
		setWaypointMode(false);
		setActiveWaypointId(null);
		setPendingWaypointFrame(null);
		appContext.shared.ikStateRef.current = appContext.shared.ikStatesRef.current.get(activeChar.id) ?? createIkState();
		appContext.shared.loadedLayerCharRef.current = activeChar.id;
	}
	function createLegacyCastHandlers(finitePatch, characterForRef) {
		function replaceCharacters(next) { appContext.publishCharacters(next); appContext.patchLive({ characters: next }); editCharacters(next); }
		function addLiveCharacter(args) {
			if (typeof args.subject !== "string") throw new Error("Invalid subject");
			const live = appContext.live.state;
			const patch = finitePatch(args, ["x", "z", "rot"]);
			live.recordCharacterUndo();
			const id = nextCharacterId(live.characters);
			replaceCharacters([...live.characters, createCharacterEntry({ id, model: args.model, subject: args.subject, pose: DEFAULT_POSE, ...patch }, live.characters.length)]);
			return { id };
		}
		function updateLiveCharacter(args) {
			const live = appContext.live.state;
			const character = characterForRef(live.characters, args.ref);
			if (!character) throw new Error("Character not found");
			const patch = finitePatch(args, ["x", "y", "z", "rot"]);
			if (args.subject !== undefined) {
				if (typeof args.subject !== "string") throw new Error("Invalid subject");
				patch.subject = args.subject;
			}
			if (args.hidden !== undefined) {
				if (typeof args.hidden !== "boolean") throw new Error("Invalid hidden");
				patch.hidden = args.hidden;
			}
			if (!Object.keys(patch).some((key) => patch[key] !== character[key])) return { id: character.id };
			live.recordCharacterUndo();
			replaceCharacters(live.characters.map((entry) => entry.id === character.id ? { ...entry, ...patch } : entry));
			return { id: character.id };
		}
		function removeLiveCharacter(args) {
			const live = appContext.live.state;
			const character = characterForRef(live.characters, args.ref);
			if (!character) throw new Error("Character not found");
			if (live.characters.length <= 1) throw new Error("Cannot remove the final character");
			live.removeCharacter(character.id);
			appContext.patchLive({ characters: appContext.live.characters });
			return { id: character.id };
		}
		function setLivePromptBlocks(args) {
			if (!Array.isArray(args.blocks)) throw new Error("Invalid blocks");
			const stamp = Date.now();
			const clips = args.blocks.map((block, i) => {
				const startFrame = Math.round(Number(block.startFrame));
				const endFrame = Math.round(Number(block.endFrame));
				if (!Number.isFinite(startFrame) || !Number.isFinite(endFrame) || endFrame <= startFrame) {
					throw new Error(`Invalid frame range on block ${i + 1}`);
				}
				if (typeof block.text !== "string" || !block.text.trim()) throw new Error(`Block ${i + 1} needs text`);
				return { id: `prompt-${stamp}-${i}`, startFrame, endFrame, text: block.text.trim() };
			});
			const live = appContext.live.state;
			live.recordCharacterUndo();
			appContext.patchLive({ promptClips: clips });
			live.editPromptClips(clips);
			if (clips.length) {
				live.setTlFrameCount((count) => Math.max(count, clips[clips.length - 1].endFrame));
			}
			return { blocks: clips.length };
		}
		return { add_character: addLiveCharacter, update_character: updateLiveCharacter, remove_character: removeLiveCharacter, set_prompt_blocks: setLivePromptBlocks };
	}
	function toggleCharacterHidden(charId) { recordCharacterUndo(); editCharacters((list) => list.map((item) => (item.id === charId ? { ...item, hidden: item.hidden !== true } : item))); }
	return {
		applyExternalCharacters, publishStudioCharacters, syncStudioLayerBuffer, undoScene, redoScene, recordStudioHistory, snapshotStudioDomain, removeLegacyRootWaypoint, switchActiveCharacterLayer, createLegacyCastHandlers, toggleCharacterHidden,
		beginNativeStudioAction, publishNativeStudioDomain, isNativeStudioHistoryRetained, stepNativeStudioHistory, commitNativeStudioDraft, canUndoNativeStudioReceipt,
		characters, setCharacters, editCharacters, customPoses, setCustomPoses, posing, setPosing, posingClosing,
		studioPick, setStudioPick, rigs, rigMountEpoch, setRigMountEpoch, setPoseTick, charA, charB, showB,
		poseA, poseB, subject, subject2, updateCharacterAt, setShowB, moveCharacter, removeCharacter, reportRig,
		spawnCharacter, charKeyToHierarchyId, charIdFromHierarchyId, activeCharacterId, setActiveCharacterId,
		rowIdForCharIndex, activeChar, selectActiveCharacterInHierarchy, activeCharIndex, activeRig, waitForRig,
		ghostLayers, snapshotCast, recordCharacterUndo, changeInspectorCharacter, restoreCast, hasCharSheet,
		setHasCharSheet, promptBlocksReveal, setPromptBlocksReveal, revealPromptBlocks, waypointMode,
		setWaypointMode, waypoints, setWaypoints, activeWaypointId, setActiveWaypointId, pendingWaypointFrame,
		setPendingWaypointFrame, promptClips, setPromptClips, editPromptClips, selectedPromptId,
		setSelectedPromptId, photoPoseState, photoPoseError, setPhotoPoseError, allPoses, selectablePoses,
		posingIndex, posingChar, posedRig, setPosed, rootStart, queueRootWaypointFrame, castMemberOf,
		addCharacterWaypoint, moveCharacterWaypoint, removeCharacterWaypoint, clearCharacterWaypoints,
		addFloorWaypoint, moveWaypoint, removeWaypoint, toggleWaypointMode, openStudio, closeStudio,
		saveCurrentPose, savePose, posePhotoFile, removePose, addPromptClip, changePromptClip,
		PROMPT_BLOCK_MAX_FRAMES, resizePromptClip, movePromptClip, removePromptClip,
	};
}
