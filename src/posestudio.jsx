import { useEffect, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { POSE_BONES, normalizeBoneName, primeBindPose } from "./poses.js";
import { IK_TRACKS, MID_TRACKS } from "./ardy/ik.js";
import { POSER_LAYER } from "./dualview.jsx";

/** Same normalised-name match rule as poses.js: equal, or one is a suffix of
 * the other, so `mixamorig:LeftArm`, `mixamorigLeftArm` and `LeftArm` all hit. */
function matchesBone(boneName, entry) {
	const norm = normalizeBoneName(boneName);
	const target = normalizeBoneName(entry.bone);
	return norm === target || norm.endsWith(target) || target.endsWith(norm);
}

const HANDLE_RADIUS = 0.05;

/** Handle colour by joint group, mirroring the reference's arm/leg/torso/head
 * colour coding. */
function handleColor(entry) {
	const id = entry.id;
	if (id === "hips" || id.startsWith("spine") || id === "chest") return "#ffd23d";
	if (id === "neck" || id === "head") return "#b98cff";
	if (id.includes("Arm") || id.includes("ForeArm") || id.includes("Hand") || id.includes("Shoulder")) return "#ff8a3d";
	return "#4dd2ff";
}

/**
 * Draggable joint spheres for pose mode. While `enabled`, renders one handle
 * per POSE_BONES joint at the joint's world position. Dragging a handle swings
 * that joint's limb toward the pointer: the pointer is projected onto the
 * camera-facing plane through the joint and the bone is rotated so its
 * bone->child direction follows the projected point (the rotation axis that
 * best matches the drag direction in screen space). Each move calls
 * `onChange()`.
 */
export function PoseHandles({ root, enabled, onChange }) {
	const { camera, gl, raycaster } = useThree();
	const meshRefs = useRef([]);
	const jointsRef = useRef(new Map());
	const dragRef = useRef(null);
	const dragHandlersRef = useRef(null);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const tmp = useRef({
		origin: new THREE.Vector3(),
		limb: new THREE.Vector3(),
		dir: new THREE.Vector3(),
		quat: new THREE.Quaternion(),
		ndc: new THREE.Vector2(),
		target: new THREE.Vector3(),
		qDelta: new THREE.Quaternion(),
		qWorld: new THREE.Quaternion(),
		qParent: new THREE.Quaternion(),
		qNew: new THREE.Quaternion(),
	}).current;
	// Late safety net only. Character primes the bind at clone time, while the
	// rig is untouched; by the time this mounts a pose has already been applied,
	// so a snapshot taken here would call that pose "rest". primeBindPose is a
	// no-op when the stamp exists, which is the normal path.
	useEffect(() => {
		primeBindPose(root);
	}, [root]);

	// Resolve every joint to its bone instances whenever the character or pose
	// mode changes. Mixamo FBX exports nest an identity "skinned" copy under
	// the control bone; the first match is the control bone and dragging it
	// carries the whole subtree, so the nested copy must not be written again.
	// Resolution happens in an effect but is consumed during render, so a
	// version counter is what actually re-renders the handles into the scene.
	const [resolved, setResolved] = useState(0);

	useEffect(() => {
		jointsRef.current.clear();
		if (!root || !enabled) {
			setResolved((n) => n + 1);
			return;
		}
		for (const entry of POSE_BONES) {
			const found = [];
			root.traverse((object) => {
				if (object.isBone && matchesBone(object.name, entry)) found.push(object);
			});
			if (found.length) jointsRef.current.set(entry.id, found);
		}
		setResolved((n) => n + 1);
	}, [root, enabled]);

	useEffect(() => {
		if (!enabled) return undefined;
		const onMove = (ev) => {
			const d = dragRef.current;
			if (!d) return;
			const rect = gl.domElement.getBoundingClientRect();
			tmp.ndc.set(
				((ev.clientX - rect.left) / rect.width) * 2 - 1,
				-((ev.clientY - rect.top) / rect.height) * 2 + 1
			);
			raycaster.setFromCamera(tmp.ndc, camera);
			if (!raycaster.ray.intersectPlane(d.plane, tmp.target)) return;
			tmp.target.sub(d.origin);
			if (tmp.target.lengthSq() < 1e-8) return;
			tmp.target.normalize();
			tmp.qDelta.setFromUnitVectors(d.limbDir, tmp.target);
			for (const bone of d.writable) {
				bone.parent.getWorldQuaternion(tmp.qParent).invert();
				bone.getWorldQuaternion(tmp.qWorld);
				tmp.qNew.multiplyQuaternions(tmp.qDelta, tmp.qWorld).premultiply(tmp.qParent);
				bone.quaternion.copy(tmp.qNew);
				bone.updateMatrixWorld(true);
			}
			onChangeRef.current?.();
		};
		const onUp = () => {
			// Detach this drag's listeners but KEEP the handler pair — nulling
			// it here bricks every subsequent drag (startDrag refuses to start
			// without it), the same failure the IK handles had. removeEventListener
			// is idempotent.
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			dragRef.current = null;
			gl.domElement.style.cursor = "";
		};
		dragHandlersRef.current = { onMove, onUp };
		return () => {
			// Abort an in-flight drag when pose mode closes mid-drag.
			if (dragHandlersRef.current) {
				window.removeEventListener("pointermove", dragHandlersRef.current.onMove);
				window.removeEventListener("pointerup", dragHandlersRef.current.onUp);
				window.removeEventListener("pointercancel", dragHandlersRef.current.onUp);
				dragHandlersRef.current = null;
			}
			dragRef.current = null;
			gl.domElement.style.cursor = "";
		};
	}, [enabled, camera, gl, raycaster, tmp]);

	useFrame(() => {
		if (!enabled) return;
		for (let i = 0; i < POSE_BONES.length; i++) {
			const mesh = meshRefs.current[i];
			if (!mesh) continue;
			const instances = jointsRef.current.get(POSE_BONES[i].id);
			if (instances?.length) mesh.position.copy(instances[0].getWorldPosition(tmp.origin));
		}
	});

	if (!enabled || !root) return null;

	const startDrag = (entry) => (ev) => {
		ev.stopPropagation();
		// Stop the fly-camera controls' element-level pointerdown from also
		// firing: R3F's canvas listener was registered before theirs, so
		// stopImmediatePropagation here keeps the camera still while posing.
		if (ev.nativeEvent.stopImmediatePropagation) ev.nativeEvent.stopImmediatePropagation();
		const instances = jointsRef.current.get(entry.id);
		if (!instances?.length || !dragHandlersRef.current) return;
		const bone = instances[0];
		bone.getWorldPosition(tmp.origin);
		let child = null;
		for (const c of bone.children) {
			if (c.isBone && normalizeBoneName(c.name) !== normalizeBoneName(bone.name)) {
				child = c;
				break;
			}
		}
		if (child) child.getWorldPosition(tmp.limb).sub(tmp.origin);
		else tmp.limb.set(0, 1, 0).applyQuaternion(bone.getWorldQuaternion(tmp.quat)); // Mixamo limbs run along +Y
		if (tmp.limb.lengthSq() < 1e-8) return;
		tmp.limb.normalize();
		const writable = [];
		for (const inst of instances) {
			let nested = false;
			for (let p = inst.parent; p; p = p.parent) {
				if (writable.includes(p)) {
					nested = true;
					break;
				}
			}
			if (!nested) writable.push(inst);
		}
		camera.getWorldDirection(tmp.dir);
		dragRef.current = {
			writable,
			origin: tmp.origin.clone(),
			limbDir: tmp.limb.clone(),
			plane: new THREE.Plane().setFromNormalAndCoplanarPoint(tmp.dir.clone(), tmp.origin.clone()),
		};
		gl.domElement.style.cursor = "grabbing";
		window.addEventListener("pointermove", dragHandlersRef.current.onMove);
		window.addEventListener("pointerup", dragHandlersRef.current.onUp);
		window.addEventListener("pointercancel", dragHandlersRef.current.onUp);
	};

	return (
		<group key={resolved}>
			{POSE_BONES.map((entry, i) =>
				jointsRef.current.has(entry.id) ? (
					<mesh
						key={entry.id}
						ref={(m) => {
							meshRefs.current[i] = m;
						}}
						renderOrder={999}
						onPointerDown={startDrag(entry)}
						onPointerOver={() => (gl.domElement.style.cursor = "grab")}
						onPointerOut={() => {
							if (!dragRef.current) gl.domElement.style.cursor = "";
						}}
					>
						<sphereGeometry args={[HANDLE_RADIUS, 16, 16]} />
						<meshStandardMaterial
							color="#000000"
							emissive={handleColor(entry)}
							emissiveIntensity={1.5}
							toneMapped={false}
							depthTest={false}
							transparent
							opacity={0.95}
						/>
					</mesh>
				) : null
			)}
		</group>
	);
}

/** IK handle colour by limb, matching the FK handle coding: arms orange,
 * legs blue. */
function ikHandleColor(track) {
	return track.kind === "arm" ? "#ff8a3d" : "#4dd2ff";
}

/** World-axis gizmo colours (Blender / Cascadeur convention). */
const AXIS_DEFS = [
	{ axis: "X", dir: new THREE.Vector3(1, 0, 0), color: "#ff5340" },
	{ axis: "Y", dir: new THREE.Vector3(0, 1, 0), color: "#54e05c" },
	{ axis: "Z", dir: new THREE.Vector3(0, 0, 1), color: "#3d8bff" },
];
const GIZMO_LEN = 0.22;
const GIZMO_SHAFT_R = 0.012;
const GIZMO_TIP_R = 0.03;
const HANDLE_R = 0.055; // chain target spheres
const JOINT_R = 0.042; // mid-joint + FK swing spheres
const SWING_RING_R = 0.12; // effector rotation ring
const SWING_RING_TUBE = 0.012; // visible tube
const SWING_RING_PICK_TUBE = 0.045; // invisible grab tube
/** Unfocused handles fade back so the focused one reads clearly. */
const OPACITY_FOCUSED = 1;
const OPACITY_UNFOCUSED = 0.3;
/** FK swing drag speed: TransformControls uses 20/camDist, tuned for its
 * gizmo rings; posing needs finer steps, so the same formula runs at 5 —
 * a ~60 px drag reads as ~15°, a full-screen sweep as ~165°. */
const FK_ROTATE_SPEED = 5;

/**
 * Draggable IK/FK handles, DCC-style (Unity grab-handle + Cascadeur
 * manipulators). Three handle kinds:
 *
 * - chain targets (wrists/ankles): the handle is the TARGET, decoupled from
 *   the effector — it follows the pointer freely and the limb only reaches
 *   for it. Focused ones get the mini move-gizmo (X/Y/Z axis arrows + the
 *   centre sphere free-drag).
 * - mid joints (elbows/knees): drag repositions the mid joint with both
 *   ends pinned; the handle snaps to the clamped elbow/knee position. Also
 *   position handles, so they get the gizmo when focused.
 * - FK swing joints (shoulders, spine, chest, neck, head, hips): drag
 *   swings the part toward the pointer — rotation only, no gizmo.
 *
 * Unfocused handles render at low opacity so the focused one stands out.
 * Every drag move calls `onSolve(kind, trackId, targetWorld)`; the drag end
 * calls `onDragEnd(trackId)` so the caller can key it.
 */
export function IkHandles({ chains, fkJoints, ikState, enabled, focus, onFocus, onSolve, onDragEnd }) {
	const { camera, gl, raycaster } = useThree();
	const handleRefs = useRef({}); // id -> mesh (all sphere handles)
	const gizmoRef = useRef(null);
	const ringRef = useRef(null); // swing ring around the focused effector
	const dragRef = useRef(null);
	const handlersRef = useRef(null);
	const solveRef = useRef(onSolve);
	const endRef = useRef(onDragEnd);
	const focusRef = useRef(onFocus);
	// The pointerdown handler filters picks through the CURRENT focus: while
	// a joint is focused, only that joint (sphere + its gizmo arrows) is
	// interactive — unfocused handles are inert, so they can never shadow a
	// gizmo arrow (the "the yellow circles block the gizmo" failure).
	const focusIdRef = useRef(focus);
	solveRef.current = onSolve;
	endRef.current = onDragEnd;
	focusRef.current = onFocus;
	focusIdRef.current = focus;
	const tmp = useRef({
		ndc: new THREE.Vector2(),
		hit: new THREE.Vector3(),
		delta: new THREE.Vector3(),
		target: new THREE.Vector3(),
		pos: new THREE.Vector3(),
	}).current;

	useEffect(() => {
		if (!enabled) return undefined;
		const onMove = (ev) => {
			const d = dragRef.current;
			if (!d) return;
			if (d.kind === "empty") {
				// past the click threshold it's a camera drag, not a focus click
				if (Math.hypot(ev.clientX - d.downXY[0], ev.clientY - d.downXY[1]) > CLICK_PX) d.moved = true;
				return;
			}
			const rect = gl.domElement.getBoundingClientRect();
			tmp.ndc.set(
				((ev.clientX - rect.left) / rect.width) * 2 - 1,
				-((ev.clientY - rect.top) / rect.height) * 2 + 1
			);
			raycaster.setFromCamera(tmp.ndc, camera);
			if (!raycaster.ray.intersectPlane(d.plane, tmp.hit)) return;
			if (d.kind === "fk" || d.kind === "swing" || (d.kind === "body" && !d.axisDir)) {
				// Swing = trackball rotation (TransformControls rotate model):
				// axis = offset × eye, angle = (offset · tangent) × speed/camDist,
				// applied absolutely from the drag-start orientation (no compounding).
				// The body centre sphere swings the body; its arrows translate.
				tmp.delta.subVectors(tmp.hit, d.hitStart);
				const axis = tmp.delta.clone().cross(d.eye);
				if (axis.lengthSq() < 1e-12) return;
				axis.normalize();
				const tangent = axis.clone().cross(d.eye).normalize();
				const angle = tmp.delta.dot(tangent) * (FK_ROTATE_SPEED / d.camDist);
				if (Math.hypot(ev.clientX - d.downXY[0], ev.clientY - d.downXY[1]) > CLICK_PX) d.moved = true;
				solveRef.current?.(d.kind, d.trackId, { axis, angle, startQuat: d.startQuat, startParentQuat: d.startParentQuat });
				return;
			}
			if (d.kind === "body" && d.axisDir) {
				// Body translate: absolute from the drag-start local position,
				// so repeated moves never compound — the hips' local start plus
				// the world delta along the dragged axis.
				tmp.delta.subVectors(tmp.hit, d.hitStart);
				const along = tmp.delta.dot(d.axisDir);
				if (Math.hypot(ev.clientX - d.downXY[0], ev.clientY - d.downXY[1]) > CLICK_PX) d.moved = true;
				solveRef.current?.(d.kind, d.trackId, { worldDelta: d.axisDir.clone().multiplyScalar(along), startLocalPos: d.startLocalPos });
				return;
			}
			if (d.axisDir) {
				// Axis drag: keep only the axis component of the pointer travel.
				tmp.delta.subVectors(tmp.hit, d.hitStart);
				const along = tmp.delta.dot(d.axisDir);
				tmp.target.copy(d.targetStart).addScaledVector(d.axisDir, along);
			} else {
				// Free drag: camera-facing plane, pointer-exact via the grab offset.
				tmp.target.copy(tmp.hit).add(d.offset);
			}
			if (Math.hypot(ev.clientX - d.downXY[0], ev.clientY - d.downXY[1]) > CLICK_PX) d.moved = true;
			solveRef.current?.(d.kind, d.trackId, tmp.target);
		};
		const onUp = (ev) => {
			// Detach this drag's listeners but KEEP the handler pair — nulling
			// it here would brick every subsequent drag (beginDrag refuses to
			// start without it), which is exactly the "second drag does
			// nothing" failure. removeEventListener is idempotent.
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			const d = dragRef.current;
			dragRef.current = null;
			gl.domElement.style.cursor = "";
			if (!d) return;
			// Click (never dragged): the focused sphere toggles focus OFF; a
			// not-yet-focused sphere just took focus (nothing to bake). An
			// empty-canvas click releases focus too.
			if (!d.moved) {
				if (d.kind === "empty") {
					if (focusIdRef.current) focusRef.current?.(null);
					return;
				}
				if (d.wasFocused && !d.axisDir) {
					focusRef.current?.(null); // toggle off
				}
				// axis-arrow clicks and fresh-sphere clicks: nothing to bake
				return;
			}
			endRef.current?.(d.trackId);
		};
		handlersRef.current = { onMove, onUp };
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			handlersRef.current = null;
			dragRef.current = null;
			gl.domElement.style.cursor = "";
		};
	}, [enabled, camera, gl, raycaster, tmp]);

	// QA hook: live handle world positions for headless checks (harmless).
	if (typeof window !== "undefined") {
		window.__ikHandlePos = (id) => {
			const m = handleRefs.current[id];
			return m ? m.getWorldPosition(new THREE.Vector3()) : null;
		};
		// world → screen for a handle (or the focused ring's edge), so headless
		// drags can land on the mesh pixel-exactly.
		window.__ikProject = (world) => {
			const v = world.clone ? world.clone() : new THREE.Vector3(world.x, world.y, world.z);
			v.project(camera);
			const rect = gl.domElement.getBoundingClientRect();
			return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
		};
		// effector local quaternion per chain track — rotation-edit assertions.
		window.__ikEffectorQuat = (id) => {
			const bone = chains?.get(id)?.bones[2];
			return bone ? { x: bone.quaternion.x, y: bone.quaternion.y, z: bone.quaternion.z, w: bone.quaternion.w } : null;
		};
		// is the swing ring mounted for this track (focused chain)?
		window.__ikRingVisible = () => !!ringRef.current;
	}

	// Handles + gizmo follow the live state every frame. A chain handle RIDES
	// its effector (the actual wrist/ankle) at all times — pose changes,
	// character moves and scrubs can never strand it in stale world space
	// (the "IK handle escapes" bug) — EXCEPT while that chain is being
	// dragged, when it tracks the pointer target for 1:1 feedback past reach.
	// On release it returns to the effector, i.e. exactly where the hand is.
	useFrame(() => {
		if (!enabled || !ikState) return;
		const draggingChain = dragRef.current?.kind === "chain" ? dragRef.current.trackId : null;
		for (const track of IK_TRACKS) {
			const mesh = handleRefs.current[track.id];
			const chain = chains?.get(track.id);
			if (!mesh || !chain) continue;
			if (draggingChain === track.id) {
				const t = ikState.targets.get(track.id);
				if (t) mesh.position.copy(t);
			} else {
				mesh.position.copy(chain.bones[2].getWorldPosition(tmp.pos));
			}
		}
		for (const track of MID_TRACKS) {
			const mesh = handleRefs.current[track.id];
			const chain = chains?.get(track.chain);
			if (mesh && chain) mesh.position.copy(chain.bones[1].getWorldPosition(tmp.pos));
		}
		for (const [id, joint] of fkJoints ?? []) {
			const mesh = handleRefs.current[id];
			if (mesh && joint) mesh.position.copy(joint.bone.getWorldPosition(tmp.pos));
		}
		if (gizmoRef.current && focus) {
			const mid = MID_TRACKS.find((t) => t.id === focus);
			const chainTrack = IK_TRACKS.find((t) => t.id === focus);
			if (chainTrack) {
				const chain = chains?.get(focus);
				if (draggingChain === focus) {
					const t = ikState.targets.get(focus);
					if (t) gizmoRef.current.position.copy(t);
				} else if (chain) {
					gizmoRef.current.position.copy(chain.bones[2].getWorldPosition(tmp.pos));
				}
			} else if (mid) {
				const chain = chains?.get(mid.chain);
				if (chain) gizmoRef.current.position.copy(chain.bones[1].getWorldPosition(tmp.pos));
			} else if (focus === "hips") {
				// the body gizmo rides the hips bone (also while it translates)
				const joint = fkJoints?.get("hips");
				if (joint) gizmoRef.current.position.copy(joint.bone.getWorldPosition(tmp.pos));
			}
		}
		// The swing ring rides the focused chain's effector and always faces
		// the camera: a trackball ring, not a bone-aligned one — the drag math
		// is trackball, so the affordance must match.
		if (ringRef.current && focus) {
			const chain = chains?.get(focus);
			if (chain) {
				ringRef.current.position.copy(chain.bones[2].getWorldPosition(tmp.pos));
				ringRef.current.quaternion.copy(camera.getWorldQuaternion(new THREE.Quaternion()));
			}
		}
	});

	/* Hit-testing is OWNED, not delegated to R3F: R3F computes the pointer
	 * NDC from its own measured canvas size, which drifts a few percent from
	 * the live rect (window resizes, layout shifts) — big handle spheres
	 * still catch the skewed ray, but small gizmo cones miss it entirely,
	 * which is exactly the "the handle doesn't grab" failure. A manual
	 * pointerdown + raycast against the registered handle/gizmo meshes uses
	 * the CURRENT canvas rect, so every hit is pixel-exact. */
	const pickRefs = useRef([]); // [{ mesh, track, axisDir, kind }]

/** Click/drag threshold (screen px): a press that never moves past this is
 * a click (focus toggle), not a drag (no key baked). */
const CLICK_PX = 4;

	const beginDrag = (kind, track, axisDir, ndc, downXY) => {
		if (!handlersRef.current) return;
		if (kind === "empty") {
			// An empty-canvas press: no drag, just a click candidate that
			// releases focus on pointerup (see onUp).
			dragRef.current = { kind: "empty", trackId: "empty", downXY, moved: false };
			window.addEventListener("pointermove", handlersRef.current.onMove);
			window.addEventListener("pointerup", handlersRef.current.onUp);
			window.addEventListener("pointercancel", handlersRef.current.onUp);
			return;
		}
		let origin;
		if (kind === "chain" || kind === "swing") {
			// Every drag starts from the CURRENT effector — the handle rides the
			// wrist between drags, so that is where the user grabs it.
			origin = chains.get(track.id).bones[2].getWorldPosition(new THREE.Vector3());
		} else if (kind === "mid") {
			origin = chains.get(track.chain).bones[1].getWorldPosition(new THREE.Vector3());
		} else {
			origin = fkJoints.get(track.id).bone.getWorldPosition(new THREE.Vector3());
		}
		raycaster.setFromCamera(ndc, camera);
		let plane;
		if (axisDir) {
			// TransformControls: plane normal = axis × (eye × axis) — the plane
			// contains the axis and is as view-perpendicular as possible.
			const eye = camera.getWorldDirection(new THREE.Vector3());
			const normal = axisDir.clone().cross(eye).cross(axisDir).normalize();
			plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
		} else {
			plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
				camera.getWorldDirection(new THREE.Vector3()),
				origin
			);
		}
		const hit = new THREE.Vector3();
		raycaster.ray.intersectPlane(plane, hit);
		dragRef.current = {
			kind,
			trackId: track.id,
			plane,
			axisDir: axisDir || null,
			targetStart: origin,
			hitStart: hit.clone(),
			offset: axisDir ? new THREE.Vector3() : origin.clone().sub(hit),
			downXY,
			moved: false,
			// Whether THIS handle was already focused when the press began —
			// a no-move click toggles focus OFF only then; a click on a fresh
			// (unfocused) handle must keep the focus it just took.
			wasFocused: focusIdRef.current === track.id,
		};
		if (kind === "fk" || kind === "swing" || kind === "body") {
			// Swing/translate start state, frozen at drag start so moves stay
			// absolute: the bone's orientation, its parent's world rotation,
			// the bone→camera eye, the camera distance, and (for the body) the
			// hips' local position. "swing" rotates a chain's end bone (the
			// hand/foot); "fk"/"body" rotate an FK joint's bone.
			const bone = kind === "swing" ? chains.get(track.id)?.bones[2] : fkJoints?.get(track.id)?.bone;
			if (!bone) {
				// A pick whose bone is gone (stale rig) must not half-start a drag.
				dragRef.current = null;
				return;
			}
			dragRef.current.startQuat = bone.quaternion.clone();
			dragRef.current.startParentQuat = bone.parent.getWorldQuaternion(new THREE.Quaternion());
			dragRef.current.eye = origin.clone().sub(camera.getWorldPosition(new THREE.Vector3())).negate().normalize();
			dragRef.current.camDist = camera.getWorldPosition(new THREE.Vector3()).distanceTo(origin);
			if (kind === "body") dragRef.current.startLocalPos = fkJoints.get(track.id).bone.position.clone();
		}
		focusRef.current?.(track.id);
		gl.domElement.style.cursor = "grabbing";
		window.addEventListener("pointermove", handlersRef.current.onMove);
		window.addEventListener("pointerup", handlersRef.current.onUp);
		window.addEventListener("pointercancel", handlersRef.current.onUp);
	};

	// Capture-phase pointerdown on the canvas: nearest registered handle /
	// gizmo mesh under the pointer starts a drag. While a joint is FOCUSED,
	// the pick list narrows to that joint only (sphere + its gizmo arrows),
	// so unfocused handles are inert and can never shadow a gizmo arrow;
	// with nothing focused every sphere is a focus+drag target. A press that
	// hits nothing records an empty click (releases focus on pointerup).
	useEffect(() => {
		if (!enabled) return undefined;
		const el = gl.domElement;
		const onDown = (ev) => {
			if (ev.button !== 0) return;
			const downXY = [ev.clientX, ev.clientY];
			const focused = focusIdRef.current;
			let picks = pickRefs.current.filter((p) => p.mesh);
			if (focused) picks = picks.filter((p) => p.track.id === focused);
			else picks = picks.filter((p) => !p.axisDir); // spheres only
			if (!picks.length) {
				if (focused) beginDrag("empty", { id: "empty" }, null, null, downXY);
				return;
			}
			const rect = el.getBoundingClientRect();
			const ndc = new THREE.Vector2(
				((ev.clientX - rect.left) / rect.width) * 2 - 1,
				-((ev.clientY - rect.top) / rect.height) * 2 + 1
			);
			raycaster.setFromCamera(ndc, camera);
			const hits = raycaster.intersectObjects(picks.map((p) => p.mesh), false);
			if (!hits.length) {
				if (focused) beginDrag("empty", { id: "empty" }, null, null, downXY);
				return;
			}
			const pick = picks.find((p) => p.mesh === hits[0].object);
			if (!pick) return;
			ev.stopImmediatePropagation();
			ev.stopPropagation();
			ev.preventDefault();
			beginDrag(pick.kind, pick.track, pick.axisDir, ndc, downXY);
		};
		// The handles live on POSER_LAYER so they render only in the poser
		// (IK working) view; the raycaster must see that layer to hit them.
		raycaster.layers.enable(POSER_LAYER);
		el.addEventListener("pointerdown", onDown, true);
		return () => {
			el.removeEventListener("pointerdown", onDown, true);
			raycaster.layers.disable(POSER_LAYER);
		};
	});

	if (!enabled || !chains || !ikState) return null;

	const register = (track, kind, axisDir = null, part = null) => (m) => {
		const idx = pickRefs.current.findIndex((p) => p.track === track && p.kind === kind && p.axisDir === axisDir && p.part === part);
		if (idx >= 0) pickRefs.current[idx].mesh = m;
		else pickRefs.current.push({ mesh: m, track, axisDir, kind, part });
	};

	const sphereFor = (track, kind, color, radius) => {
		const focused = focus === track.id;
		return (
			<mesh
				key={track.id}
				ref={(m) => {
					handleRefs.current[track.id] = m;
					if (m) m.layers.set(POSER_LAYER);
					register(track, kind)(m);
				}}
				renderOrder={999}
				scale={focused ? 1.2 : 1}
				onPointerOver={() => (gl.domElement.style.cursor = "grab")}
				onPointerOut={() => {
					if (!dragRef.current) gl.domElement.style.cursor = "";
				}}
			>
				<sphereGeometry args={[radius, 16, 16]} />
				<meshStandardMaterial
					color="#000000"
					emissive={color}
					emissiveIntensity={focused ? 2.6 : 1.4}
					toneMapped={false}
					depthTest={false}
					transparent
					opacity={focused ? OPACITY_FOCUSED : OPACITY_UNFOCUSED}
				/>
			</mesh>
		);
	};

		// The gizmo appears on chain + mid (position) handles — and on the hips
	// BODY handle: its arrows translate the body (Y = height, for crouching
	// and lying poses) while its centre sphere keeps swinging the body.
	const gizmoTrack =
		IK_TRACKS.find((t) => t.id === focus) ||
		MID_TRACKS.find((t) => t.id === focus) ||
		(focus === "hips" ? (fkJoints?.get("hips")?.track ?? null) : null);
	const gizmoKind = IK_TRACKS.find((t) => t.id === focus) ? "chain" : MID_TRACKS.find((t) => t.id === focus) ? "mid" : focus === "hips" ? "body" : null;
	// The focused chain (hand/foot) also gets a rotation ring: arrows move
	// the wrist/ankle, the ring turns the hand/foot itself.
	const swingTrack = IK_TRACKS.find((t) => t.id === focus) ?? null;

	return (
		<group>
			{IK_TRACKS.map((track) => (chains.has(track.id) ? sphereFor(track, "chain", ikHandleColor(track), HANDLE_R) : null))}
			{MID_TRACKS.map((track) => (chains.has(track.chain) ? sphereFor(track, "mid", ikHandleColor({ kind: track.chain.includes("Hand") ? "arm" : "leg" }), JOINT_R) : null))}
			{[...(fkJoints ?? [])].map(([id, joint]) => sphereFor(joint.track, id === "hips" ? "body" : "fk", joint.track.color, id === "hips" ? HANDLE_R : JOINT_R))}

			{/* Mini move-gizmo on the focused position handle: world-axis arrows. */}
			{gizmoTrack && (
				<group ref={gizmoRef} renderOrder={999}>
					{AXIS_DEFS.map(({ axis, dir, color }) => {
						const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
						return (
							<group key={axis} quaternion={quat}>
								<mesh
									position={[0, GIZMO_LEN / 2, 0]}
									ref={(m) => {
										if (m) m.layers.set(POSER_LAYER);
										register(gizmoTrack, gizmoKind, dir, "shaft")(m);
									}}
									onPointerOver={() => (gl.domElement.style.cursor = "grab")}
									onPointerOut={() => {
										if (!dragRef.current) gl.domElement.style.cursor = "";
									}}
								>
									<cylinderGeometry args={[GIZMO_SHAFT_R, GIZMO_SHAFT_R, GIZMO_LEN, 8]} />
									<meshStandardMaterial color="#000000" emissive={color} emissiveIntensity={2.2} toneMapped={false} depthTest={false} transparent opacity={0.9} />
								</mesh>
								<mesh
									position={[0, GIZMO_LEN + 0.04, 0]}
									ref={(m) => {
										if (m) m.layers.set(POSER_LAYER);
										register(gizmoTrack, gizmoKind, dir, "tip")(m);
									}}
									onPointerOver={() => (gl.domElement.style.cursor = "grab")}
									onPointerOut={() => {
										if (!dragRef.current) gl.domElement.style.cursor = "";
									}}
								>
									<coneGeometry args={[GIZMO_TIP_R, 0.08, 12]} />
									<meshStandardMaterial color="#000000" emissive={color} emissiveIntensity={2.4} toneMapped={false} depthTest={false} transparent opacity={0.95} />
								</mesh>
							</group>
						);
					})}
				</group>
			)}

			{/* Trackball rotation ring on the focused hand/foot: turns the
			    effector itself while the position gizmo keeps moving it. A thin
			    visible torus plus a fat invisible one — a 3 px tube raycasts
			    terribly, so the pick target is generous. */}
			{swingTrack && (
				<group ref={(g) => { ringRef.current = g; }} renderOrder={999}>
					<mesh
						ref={(m) => {
							if (m) m.layers.set(POSER_LAYER);
						}}
						onPointerOver={() => (gl.domElement.style.cursor = "grab")}
						onPointerOut={() => {
							if (!dragRef.current) gl.domElement.style.cursor = "";
						}}
					>
						<torusGeometry args={[SWING_RING_R, SWING_RING_TUBE, 10, 48]} />
						<meshStandardMaterial
							color="#000000"
							emissive={ikHandleColor(swingTrack)}
							emissiveIntensity={2.2}
							toneMapped={false}
							depthTest={false}
							transparent
							opacity={0.9}
						/>
					</mesh>
					<mesh
						ref={(m) => {
							if (m) m.layers.set(POSER_LAYER);
							register(swingTrack, "swing", null, "ring")(m);
						}}
					>
						<torusGeometry args={[SWING_RING_R, SWING_RING_PICK_TUBE, 8, 32]} />
						<meshBasicMaterial transparent opacity={0} depthWrite={false} />
					</mesh>
				</group>
			)}
		</group>
	);
}

/**
 * Pose Studio overlay panel. `poses` is the merged list (built-ins + custom)
 * the caller owns; every pose has `{ id, label, bones }` and custom poses add
 * `{ thumb, custom: true }`. The tile entry animation cascades with the same
 * stagger as the reference.
 */
export function PoseStudioPanel({ subject, poses, selectedId, onSelect, onApply, onReset, onSave, onDelete, onClose, closing }) {
	const poseLabelsKo = {
		"T-pose": "T 포즈",
		Relaxed: "편안한 자세",
		Contrapposto: "콘트라포스토",
		Walking: "걷는 자세",
		Seated: "앉은 자세",
		"Arms crossed": "팔짱",
		Pointing: "가리키기",
		"Hands on hips": "허리에 손",
		"Looking back": "뒤돌아보기",
		"Hands up": "손 올리기",
		Wave: "손 흔들기",
		Thinking: "생각하기",
		Crouch: "웅크리기",
		Kneel: "무릎 꿇기",
		Run: "달리기",
		Jump: "점프",
	};
	const categoryLabelsKo = {
		all: "전체",
		basic: "기본",
		gesture: "제스처",
		action: "동작",
		floor: "바닥",
		custom: "내 포즈",
	};
	const displayPoseLabel = (pose) => pose.custom ? pose.label : poseLabelsKo[pose.label] ?? pose.label;
	const poseCategory = (pose) => pose.custom ? "custom" : pose.category ?? "basic";
	const [category, setCategory] = useState("all");
	const categories = ["all", ...Array.from(new Set(poses.map(poseCategory)))];
	const visiblePoses = category === "all" ? poses : poses.filter((pose) => poseCategory(pose) === category);
	return (
		<div className={"pose-studio" + (closing ? " closing" : "")}>
			<div className="studio-head">
				<span>포즈 스튜디오 · 인물 {subject}</span>
				<button type="button" className="x" onClick={onClose} aria-label="포즈 스튜디오 닫기">
					✕
				</button>
			</div>
			<div className="studio-actions">
				<button type="button" className="btn primary full" onClick={onApply}>
					포즈 적용
				</button>
				<button type="button" className="btn ghost full" onClick={onReset}>
					포즈 초기화
				</button>
			</div>
			{categories.length > 2 && (
				<div className="studio-actions" aria-label="포즈 카테고리">
					{categories.map((item) => (
						<button
							type="button"
							key={item}
							className={"btn ghost" + (item === category ? " active" : "")}
							aria-pressed={item === category}
							onClick={() => setCategory(item)}
						>
							{categoryLabelsKo[item] ?? item}
						</button>
					))}
				</div>
			)}
			<div className="pose-grid">
				{visiblePoses.map((pose, index) => (
					<button
						type="button"
						key={pose.id}
						className={"pose-tile" + (pose.id === selectedId ? " active" : "")}
						data-pose-id={pose.id}
						data-pose-category={poseCategory(pose)}
						style={{ animationDelay: `${0.04 + index * 0.028}s` }}
						onClick={() => onSelect(pose.id)}
					>
						{pose.thumb ? <img src={pose.thumb} alt={displayPoseLabel(pose)} /> : <div className="tile-blank" />}
						<span>{displayPoseLabel(pose)}</span>
						{pose.custom && (
							<em
								className="del"
								title="삭제"
								onClick={(e) => {
									e.stopPropagation();
									onDelete(pose.id);
								}}
							>
								✕
							</em>
						)}
					</button>
				))}
				<button type="button" className="pose-tile add" data-pose-id="save-custom" title="현재 캐릭터 포즈 저장" onClick={onSave}>
					<span className="add-plus">＋</span>
					<span className="add-text">포즈 저장</span>
				</button>
			</div>
		</div>
	);
}
