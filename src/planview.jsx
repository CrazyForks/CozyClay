import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import * as THREE from "three";
import { aimAt } from "./controls.jsx";
import { PLAN_LAYER } from "./dualview.jsx";
import { objectSize } from "./scene-objects.js";

const ROOM_LIMIT = 11; // stay inside the set walls
const ACTOR_LIMIT = 4; // matches the Subject sliders' range
const PUCK_R = 0.34;
const GRAB_R = 1.0; // the pick radius, well beyond the drawn disc
const HANDLE_DIST = 1.25; // how far the facing handle sits from the centre
const HANDLE_R = 0.14;
const HANDLE_GRAB = 0.5;

/** yaw that makes the character's local +Z face the given direction */
const yawToward = (dx, dz) => Math.atan2(dx, dz);
const wrapDeg = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;
/** world position of a puck's facing handle */
const handleAt = (e) => {
	const distance = e.handleDist ?? HANDLE_DIST;
	return { x: e.x + distance * Math.sin(e.yaw), z: e.z + distance * Math.cos(e.yaw) };
};
const near = (ax, az, bx, bz, r) => (ax - bx) ** 2 + (az - bz) ** 2 < r * r;
const insideFootprint = (point, entity, padding = 0.2) => {
	const dx = point.x - entity.x;
	const dz = point.z - entity.z;
	const cos = Math.cos(entity.yaw);
	const sin = Math.sin(entity.yaw);
	const localX = dx * cos - dz * sin;
	const localZ = dx * sin + dz * cos;
	return (
		Math.abs(localX) <= entity.footprint.width / 2 + padding &&
		Math.abs(localZ) <= entity.footprint.depth / 2 + padding
	);
};

/** The lens cone, so you can see what the camera covers without leaving the plan. */
function FrustumWedge({ fovDeg, active }) {
	const geometry = useMemo(() => new THREE.BufferGeometry(), []);
	const half = (fovDeg * Math.PI) / 180 / 2;
	// a 16:9 frame is wider than the vertical fov it is specified by
	const spread = Math.atan(Math.tan(half) * (16 / 9));
	const reach = 6;
	useEffect(() => {
		const points = new Float32Array([
			0, 0, 0,
			-Math.sin(spread) * reach, 0, -Math.cos(spread) * reach,
			Math.sin(spread) * reach, 0, -Math.cos(spread) * reach,
		]);
		geometry.setAttribute("position", new THREE.BufferAttribute(points, 3));
		geometry.computeVertexNormals();
	}, [geometry, spread]);

	return (
		<mesh geometry={geometry} position={[0, 0.02, 0]} renderOrder={8}>
			<meshBasicMaterial
				color="#4e9fb3"
				transparent
				opacity={active ? 0.32 : 0.18}
				side={THREE.DoubleSide}
				depthWrite={false}
				depthTest={false}
			/>
		</mesh>
	);
}

/**
 * A staging puck: drag the body to slide it, drag the outrigger handle to turn it.
 *
 * Rotation has to be available right here. Reaching for a numeric slider on the
 * far side of the screen to spin an actor is the single most awkward thing a
 * plan board can ask for, so the facing indicator doubles as the grab point.
 *
 * Purely visual — picking is done analytically against circles on the floor,
 * because these live in a viewport that is not the one driving R3F's events.
 */
function Puck({ color, dragging, turning, showBody = true, handleDist = HANDLE_DIST }) {
	return (
		<group>
			{showBody && (
				<>
					<mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={10}>
						<circleGeometry args={[PUCK_R, 6, Math.PI / 6]} />
						<meshBasicMaterial color={color} transparent opacity={0.94} depthWrite={false} depthTest={false} />
					</mesh>
					<mesh position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={10}>
						<ringGeometry
							args={[
								PUCK_R * (dragging ? 1.24 : 1.14),
								PUCK_R * (dragging ? 1.45 : 1.32),
								6,
								1,
								Math.PI / 6,
							]}
						/>
						<meshBasicMaterial
							color={color}
							transparent
							opacity={dragging ? 0.9 : 0.46}
							depthWrite={false}
							depthTest={false}
						/>
					</mesh>
				</>
			)}

			{/* stem: makes the handle read as attached to the puck, not as debris */}
			<mesh position={[0, 0.035, handleDist / 2]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={9}>
				<planeGeometry args={[0.045, handleDist]} />
				<meshBasicMaterial
					color={color}
					transparent
					opacity={turning ? 0.9 : 0.35}
					depthWrite={false}
					depthTest={false}
				/>
			</mesh>
			<mesh position={[0, 0.045, handleDist]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={11}>
				<circleGeometry args={[turning ? HANDLE_R * 1.2 : HANDLE_R, 4, Math.PI / 4]} />
				<meshBasicMaterial color={color} depthWrite={false} depthTest={false} />
			</mesh>
			<mesh position={[0, 0.044, handleDist]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={11}>
				<ringGeometry args={[HANDLE_R * 1.42, HANDLE_R * 1.62, 4, 1, Math.PI / 4]} />
				<meshBasicMaterial
					color={color}
					transparent
					opacity={turning ? 0.85 : 0.38}
					depthWrite={false}
					depthTest={false}
				/>
			</mesh>
		</group>
	);
}

/**
 * Floor-plan annotation. Lies flat on the deck so it reads from straight above.
 *
 * Short by design: full names ran into each other the moment two actors stood
 * closer than the width of the word, which in a two-shot is always.
 */
function PlanLabel({ text, color, offset = -0.72 }) {
	return (
		<Text
			position={[0, 0.05, offset]}
			rotation={[-Math.PI / 2, 0, 0]}
			fontSize={0.3}
			color={color}
			anchorX="center"
			anchorY="middle"
			outlineWidth={0.025}
			outlineColor="#0e0d10"
			outlineOpacity={0.72}
			renderOrder={12}
			depthOffset={-1}
		>
			{text}
		</Text>
	);
}

function SceneObjectFootprint({ object, selected, dragging, turning }) {
	const { width, depth } = objectSize(object);
	const handleDist = depth / 2 + 0.65;
	const rotation = (object.rot * Math.PI) / 180;
	return (
		<group position={[object.x, 0, object.z]} rotation={[0, rotation, 0]}>
			<mesh position={[0, 0.032, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={10}>
				<planeGeometry args={[width, depth]} />
				<meshBasicMaterial
					color={selected ? "#e7b557" : "#c7836f"}
					transparent
					opacity={selected ? 0.46 : 0.24}
					depthWrite={false}
					depthTest={false}
				/>
			</mesh>
			<mesh position={[0, 0.04, 0]} renderOrder={11}>
				<boxGeometry args={[width, 0.02, depth]} />
				<meshBasicMaterial color={selected ? "#d99725" : "#9b695a"} wireframe depthTest={false} />
			</mesh>
			<group position={[0, 0, depth / 2 + 0.45]} rotation={[0, -rotation, 0]}>
				<PlanLabel
					text={object.name.slice(0, 8).toUpperCase()}
					color={selected ? "#b37610" : "#7c574d"}
					offset={0}
				/>
			</group>
			{selected && <Puck color="#e7b557" showBody={false} handleDist={handleDist} dragging={dragging} turning={turning} />}
		</group>
	);
}

const WAYPOINT_COLOR = "#6f9f86";

/**
 * The root path: numbered dots at each waypoint's floor position, connected
 * in chronological frame order. Lies flat on the deck like the pucks, so it
 * reads from straight above and never enters shot-camera exports.
 */
function WaypointPath({ waypoints, start, activeWaypointFrame }) {
	const line = useMemo(() => {
		if (waypoints.length < 1) return null;
		const pathPoints = [{ x: start.x, z: start.z }, ...waypoints];
		const positions = new Float32Array(pathPoints.length * 3);
		pathPoints.forEach((w, i) => {
			positions[i * 3] = w.x;
			positions[i * 3 + 1] = 0.02;
			positions[i * 3 + 2] = w.z;
		});
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
		return geometry;
	}, [start.x, start.z, waypoints]);

	return (
		<group>
			{line && (
				<line geometry={line} renderOrder={9}>
					<lineBasicMaterial color={WAYPOINT_COLOR} transparent opacity={0.55} depthWrite={false} depthTest={false} />
				</line>
			)}
			{waypoints.map((w, i) => {
				const active = w.frame === activeWaypointFrame;
				return (
				<group key={w.frame} position={[w.x, 0, w.z]}>
					<mesh position={[0, 0.045, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={11}>
						<circleGeometry args={[active ? 0.2 : 0.15, 20]} />
						<meshBasicMaterial color={active ? "#ffd76c" : WAYPOINT_COLOR} depthWrite={false} depthTest={false} />
					</mesh>
					<Text
						position={[0, 0.05, 0.3]}
						rotation={[-Math.PI / 2, 0, 0]}
						fontSize={0.26}
						color={active ? "#ffd76c" : WAYPOINT_COLOR}
						anchorX="center"
						anchorY="middle"
						outlineWidth={0.04}
						outlineColor="#0e0d10"
						outlineOpacity={0.85}
						renderOrder={12}
						depthOffset={-1}
					>
						{i + 1}
					</Text>
				</group>
				);
			})}
		</group>
	);
}

/**
 * Top-down staging board. Drag a puck to move it, drag its handle to turn it.
 *
 * Picking is analytic rather than raycast-against-meshes: the board lives in a
 * second viewport with its own camera, and R3F's event system only knows about
 * the default one. Everything here sits on the y=0 plane, so a ground-plane
 * intersection plus circle tests is both simpler and exact.
 *
 * Dragging is tracked on `window`, not on the host element: an element only
 * reports moves that still hit it, so a fast drag off the edge silently strands
 * the puck.
 */
export function PlanBoard({ hostRef, planCamRef, shotCamRef, look, fovDeg, charA, setCharA, charB, setCharB, showB, waypoints, activeWaypointFrame, onSelectWaypoint, onMoveWaypoint, onSelectEntity, sceneObjects = [], selectedSceneObjectId, onMoveSceneObject, onObjectMoveStart, onObjectMoveEnd }) {
	const [drag, setDrag] = useState(null); // { id, mode }
	const rootRef = useRef();
	const camPos = useRef();
	const camRot = useRef();
	const dragRef = useRef(null);
	// Numbered waypoints are direct-manipulation handles. Empty floor presses
	// intentionally do nothing; root keyframes are authored in the timeline.
	const tools = useMemo(
		() => ({
			raycaster: new THREE.Raycaster(),
			plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
			pointer: new THREE.Vector2(),
			hit: new THREE.Vector3(),
		}),
		[],
	);

	// The overlay belongs to the plan camera alone. Without this the pucks would
	// be drawn flat across the floor of the shot — and into exported frames.
	useLayoutEffect(() => {
		rootRef.current?.traverse((o) => o.layers.set(PLAN_LAYER));
	});

	// The drag listeners must never be re-registered mid-drag: their cleanup
	// clears dragRef, so a dep that changes while dragging (charA.x does, on the
	// very first move) would kill the drag after one frame. Read live values
	// through a ref and keep the effect's deps stable.
	const latest = useRef({ charA, charB, showB, waypoints, onSelectWaypoint, onMoveWaypoint, onSelectEntity, sceneObjects, selectedSceneObjectId, onMoveSceneObject, onObjectMoveStart, onObjectMoveEnd });
	latest.current = { charA, charB, showB, waypoints, onSelectWaypoint, onMoveWaypoint, onSelectEntity, sceneObjects, selectedSceneObjectId, onMoveSceneObject, onObjectMoveStart, onObjectMoveEnd };

	const targets = () => {
		const { charA: a, charB: b, showB: two } = latest.current;
		const cam = shotCamRef.current;
		const out = [];
		if (cam) out.push({ id: "cam", x: cam.position.x, z: cam.position.z, yaw: look.current.yaw });
		out.push({ id: "a", x: a.x, z: a.z, yaw: (a.rot * Math.PI) / 180 });
		if (two) out.push({ id: "b", x: b.x, z: b.z, yaw: (b.rot * Math.PI) / 180 });
		for (const object of latest.current.sceneObjects) {
			const { width, depth } = objectSize(object);
			out.push({
				id: `object:${object.id}`,
				objectId: object.id,
				x: object.x,
				z: object.z,
				yaw: (object.rot * Math.PI) / 180,
				rot: object.rot,
				footprint: { width, depth },
				handleDist: depth / 2 + 0.65,
				selected: object.id === latest.current.selectedSceneObjectId,
			});
		}
		return out;
	};

	const aimTarget = () => {
		const { charA: a, charB: b, showB: two } = latest.current;
		const y = 1.35;
		if (!two) return { x: a.x, y, z: a.z };
		return { x: (a.x + b.x) / 2, y, z: (a.z + b.z) / 2 };
	};

	useFrame(() => {
		const cam = shotCamRef.current;
		if (!cam || !camPos.current || !camRot.current) return;
		camPos.current.position.set(cam.position.x, 0, cam.position.z);
		camRot.current.rotation.y = look.current.yaw;
	});

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return undefined;
		const snap = (v, limit) => THREE.MathUtils.clamp(Math.round(v / 0.05) * 0.05, -limit, limit);

		/** pointer -> a point on the floor, seen through the plan camera */
		const toFloor = (event) => {
			const cam = planCamRef.current;
			if (!cam) return null;
			const r = host.getBoundingClientRect();
			if (r.width < 2 || r.height < 2) return null;
			tools.pointer.set(
				((event.clientX - r.left) / r.width) * 2 - 1,
				-((event.clientY - r.top) / r.height) * 2 + 1,
			);
			tools.raycaster.setFromCamera(tools.pointer, cam);
			return tools.raycaster.ray.intersectPlane(tools.plane, tools.hit) ? tools.hit : null;
		};

		// A generous nearest-point hit target makes the numbered roots draggable
		// directly, without requiring a prior timeline selection/focus step.
		const pick = (p) => {
			let nearestWaypoint = null;
			let nearestDistance = Infinity;
			for (const waypoint of latest.current.waypoints) {
				const distance = (p.x - waypoint.x) ** 2 + (p.z - waypoint.z) ** 2;
				if (distance < nearestDistance) {
					nearestWaypoint = waypoint;
					nearestDistance = distance;
				}
			}
			if (nearestWaypoint && nearestDistance < 0.5 ** 2) {
				return { id: `waypoint:${nearestWaypoint.frame}`, mode: "waypoint", origin: nearestWaypoint };
			}
			// Overlapping pucks (S1 sitting on the camera, like a close-up
			// setup): the FIRST list entry used to win, so grabbing S1 near the
			// cam moved the camera instead and the character never budged —
			// "the puck doesn't move". Pick the NEAREST target instead.
			const list = targets();
			let best = null;
			for (const e of list) {
				const h = handleAt(e);
				const dh = (p.x - h.x) ** 2 + (p.z - h.z) ** 2;
				if ((!e.objectId || e.selected) && dh < HANDLE_GRAB * HANDLE_GRAB && (!best || dh < best.d)) best = { id: e.id, mode: "turn", origin: e, d: dh };
				const db = (p.x - e.x) ** 2 + (p.z - e.z) ** 2;
				const bodyHit = e.objectId ? insideFootprint(p, e) : db < GRAB_R * GRAB_R;
				if (bodyHit && (!best || db < best.d)) best = { id: e.id, mode: "move", origin: e, d: db };
			}
			if (best) return { id: best.id, mode: best.mode, origin: best.origin };
			return null;
		};

		const onDown = (event) => {
			if (event.button !== 0) return;
			const p = toFloor(event);
			const grip = p && pick(p);
			if (!grip) return;
			event.preventDefault();
			event.stopPropagation();
			dragRef.current = grip;
			setDrag({ id: grip.id, mode: grip.mode });
			if (grip.mode === "waypoint") latest.current.onSelectWaypoint?.(grip.origin.frame);
			else latest.current.onSelectEntity?.(grip.id);
			// Scene-object grips only: select FIRST (the call above), then
			// begin — App's select handler settles any open transaction, so
			// beginning before the select would leak the freshly-issued token
			// instantly (plan §6.4). Camera, character and waypoint grips
			// write separate state and must never open a scene transaction.
			if (grip.origin.objectId) {
				dragRef.current.token = latest.current.onObjectMoveStart?.({
					owner: "plan",
					cancel: () => teardownDrag(grip),
				});
			}
			host.style.cursor = grip.mode === "turn" ? "ew-resize" : "grabbing";
		};

		// hover is the only cue that these are handles at all
		const onHover = (event) => {
			if (dragRef.current) return;
			const p = toFloor(event);
			const grip = p && pick(p);
			host.style.cursor = !grip
				? "default"
				: grip.mode === "turn"
					? "ew-resize"
					: "grab";
		};

		const onMove = (event) => {
			const grip = dragRef.current;
			if (!grip) return;
			const p = toFloor(event);
			if (!p) return;

			if (grip.mode === "waypoint") {
				latest.current.onMoveWaypoint?.(grip.origin.frame, snap(p.x, ROOM_LIMIT), snap(p.z, ROOM_LIMIT));
				return;
			}

			if (grip.mode === "turn") {
				const dx = p.x - grip.origin.x;
				const dz = p.z - grip.origin.z;
				// Right on the pivot there is no direction to read, and atan2 of a
				// near-zero vector snaps wildly. Hold the last angle instead.
				if (dx * dx + dz * dz < 0.04) return;
				const yaw = yawToward(dx, dz);
				if (grip.id === "cam") {
					// a manual aim; the operator has decided to point off-subject
					look.current.yaw = yaw;
					return;
				}
				// 5° detents, because actors are blocked to clean angles
				const deg = wrapDeg(Math.round((yaw * 180) / Math.PI / 5) * 5);
				if (grip.origin.objectId) latest.current.onMoveSceneObject?.(grip.origin.objectId, { rot: deg }, grip.token);
				else if (grip.id === "a") setCharA((prev) => ({ ...prev, rot: deg }));
				else setCharB((prev) => ({ ...prev, rot: deg }));
				return;
			}

			if (grip.id === "cam") {
				const cam = shotCamRef.current;
				if (!cam) return;
				cam.position.set(snap(p.x, ROOM_LIMIT), cam.position.y, snap(p.z, ROOM_LIMIT));
				// Sliding the camera across the floor plan must keep it pointed at the
				// cast. Without this every drag leaves the lens staring at a wall.
				const angles = aimAt(cam.position, aimTarget());
				look.current.yaw = angles.yaw;
				look.current.pitch = angles.pitch;
				return;
			}
			const next = { x: snap(p.x, ACTOR_LIMIT), z: snap(p.z, ACTOR_LIMIT) };
			if (grip.origin.objectId) latest.current.onMoveSceneObject?.(grip.origin.objectId, {
				x: snap(p.x, ROOM_LIMIT),
				z: snap(p.z, ROOM_LIMIT),
			}, grip.token);
			else if (grip.id === "a") setCharA((prev) => ({ ...prev, ...next }));
			else setCharB((prev) => ({ ...prev, ...next }));
		};

		// Teardown-only close: null the drag ref and reset the drag visuals.
		// Never closes the transaction — used by the store's cancel (which is
		// forbidden from calling the end prop back, plan §6.2) as well as the
		// producer's own close paths.
		const teardownDrag = (grip) => {
			if (!grip || dragRef.current !== grip) return;
			dragRef.current = null;
			setDrag(null);
			host.style.cursor = "default";
		};

		// pointerup, pointercancel, window blur and unmount all COMMIT: the
		// travel already applied is real work the user can see, so it becomes
		// one undo entry rather than being silently reverted (plan §6.3).
		// Escape is the only gesture that rolls back.
		const closeDrag = (commit) => {
			const grip = dragRef.current;
			if (!grip) return;
			const token = grip.token;
			teardownDrag(grip);
			if (token != null) latest.current.onObjectMoveEnd?.(token, { commit });
		};

		const onUp = () => {
			closeDrag(true);
		};

		const onCancel = () => closeDrag(true);

		const onBlur = () => closeDrag(true);

		const onEscape = (event) => {
			if (event.key !== "Escape") return;
			if (!dragRef.current) return;
			// Capture-phase stopPropagation keeps the same press from also
			// reaching App's Escape-clears-selection handler (plan §7).
			event.stopPropagation();
			closeDrag(false);
		};

		host.addEventListener("pointerdown", onDown);
		host.addEventListener("pointermove", onHover);
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onCancel);
		window.addEventListener("blur", onBlur);
		window.addEventListener("keydown", onEscape, true);
		return () => {
			host.removeEventListener("pointerdown", onDown);
			host.removeEventListener("pointermove", onHover);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onCancel);
			window.removeEventListener("blur", onBlur);
			window.removeEventListener("keydown", onEscape, true);
			closeDrag(true);
		};
	}, [hostRef, planCamRef, shotCamRef, tools, setCharA, setCharB, look]);

	const state = (id) => ({ dragging: drag?.id === id && drag.mode === "move", turning: drag?.id === id && drag.mode === "turn" });

	return (
		<group ref={rootRef}>
			<group ref={camPos}>
				<PlanLabel text="CAM" color="#247da0" />
				<group ref={camRot}>
					<FrustumWedge fovDeg={fovDeg} active={drag?.id === "cam"} />
					<Puck color="#4e9fb3" {...state("cam")} />
				</group>
			</group>

			<group position={[charA.x, 0, charA.z]}>
				<PlanLabel text="S1" color="#273849" />
				<group rotation={[0, (charA.rot * Math.PI) / 180, 0]}>
					<Puck color="#273849" {...state("a")} />
				</group>
			</group>

			{showB && (
				<group position={[charB.x, 0, charB.z]}>
					<PlanLabel text="S2" color="#d65f55" />
					<group rotation={[0, (charB.rot * Math.PI) / 180, 0]}>
						<Puck color="#d65f55" {...state("b")} />
					</group>
				</group>
			)}

			{sceneObjects.map((object) => (
				<SceneObjectFootprint
					key={object.id}
					object={object}
					selected={object.id === selectedSceneObjectId}
					{...state(`object:${object.id}`)}
				/>
			))}

			{waypoints.length > 0 && <WaypointPath waypoints={waypoints} start={charA} activeWaypointFrame={activeWaypointFrame} />}
		</group>
	);
}
