/**
 * Set props: low-poly clay maquettes to block against.
 *
 * The set is a bare room and a figure; a shot that needs "something in the
 * world" (a car to lean on, to walk past, to frame behind glass) has nothing
 * to work with. These props are built from primitives in the same clay style
 * as the Room and the character tint, so the whole frame stays one
 * consistent maquette. Dimensions are metres against real vehicle sizes so
 * the 1.8 m figure keeps honest scale.
 */

import { useEffect, useMemo } from "react";
import * as THREE from "three";

const CLAY_CAR = "#d98770";
const CLAY_CAR_TOP = "#e49a84";
const CLAY_TIRE = "#41484c";
const CLAY_RIM = "#7c8588";
const CLAY_GLASS = "#55697a";
const CLAY_PLANE = "#7896a4";
const CLAY_PLANE_TRIM = "#e1a849";
const CLAY_CHAIR = "#b9855d";
const CLAY_CHAIR_LIGHT = "#cf9d72";

function Wheel({ position }) {
	return (
		<group position={position}>
			<mesh rotation={[0, 0, Math.PI / 2]}>
				<cylinderGeometry args={[0.33, 0.33, 0.24, 20]} />
				<meshStandardMaterial color={CLAY_TIRE} roughness={0.95} />
			</mesh>
			<mesh rotation={[0, 0, Math.PI / 2]}>
				<cylinderGeometry args={[0.17, 0.17, 0.26, 16]} />
				<meshStandardMaterial color={CLAY_RIM} roughness={0.5} metalness={0.35} />
			</mesh>
		</group>
	);
}
/**
 * A generic 5-door-ish sedan silhouette, ~4.5 m long. Origin at the centre
 * of the footprint, +Z forward.
 */
export function Car({ position = [0, 0, 0], rotY = 0, color = CLAY_CAR, topColor = CLAY_CAR_TOP }) {
	return (
		<group position={position} rotation={[0, rotY, 0]}>
			{/* lower body */}
			<mesh position={[0, 0.62, 0]}>
				<boxGeometry args={[1.78, 0.62, 4.45]} />
				<meshStandardMaterial color={color} roughness={0.55} metalness={0.25} />
			</mesh>
			{/* cabin: centred over the wheelbase, not stacked on the tail */}
			<mesh position={[0, 1.12, -0.15]}>
				<boxGeometry args={[1.58, 0.5, 2.2]} />
				<meshStandardMaterial color={topColor} roughness={0.5} metalness={0.2} />
			</mesh>
			{/* greenhouse glass band */}
			<mesh position={[0, 1.14, -0.15]}>
				<boxGeometry args={[1.62, 0.3, 1.9]} />
				<meshStandardMaterial color={CLAY_GLASS} roughness={0.15} metalness={0.6} />
			</mesh>
			{/* windshield slope */}
			<mesh position={[0, 1.05, 0.95]} rotation={[0.5, 0, 0]}>
				<boxGeometry args={[1.56, 0.42, 0.08]} />
				<meshStandardMaterial color={CLAY_GLASS} roughness={0.15} metalness={0.6} />
			</mesh>
			{/* rear glass slope */}
			<mesh position={[0, 1.05, -1.25]} rotation={[-0.55, 0, 0]}>
				<boxGeometry args={[1.56, 0.42, 0.08]} />
				<meshStandardMaterial color={CLAY_GLASS} roughness={0.15} metalness={0.6} />
			</mesh>
			<Wheel position={[0.82, 0.33, 1.45]} />
			<Wheel position={[-0.82, 0.33, 1.45]} />
			<Wheel position={[0.82, 0.33, -1.45]} />
			<Wheel position={[-0.82, 0.33, -1.45]} />
		</group>
	);
}

/** Compact single-engine propeller plane, ~3.4 m wingspan and +Z forward. */
export function SmallPlane({ position = [0, 0, 0], rotY = 0 }) {
	return (
		<group position={position} rotation={[0, rotY, 0]}>
			{/* fuselage and tapered nose */}
			<mesh position={[0, 0.76, 0]} rotation={[Math.PI / 2, 0, 0]}>
				<cylinderGeometry args={[0.23, 0.31, 2.75, 16]} />
				<meshStandardMaterial color={CLAY_PLANE} roughness={0.58} metalness={0.18} />
			</mesh>
			<mesh position={[0, 0.76, 1.55]} rotation={[Math.PI / 2, 0, 0]}>
				<coneGeometry args={[0.23, 0.55, 16]} />
				<meshStandardMaterial color={CLAY_PLANE_TRIM} roughness={0.52} metalness={0.2} />
			</mesh>

			{/* main wing and tail plane */}
			<mesh position={[0, 0.73, 0.15]}>
				<boxGeometry args={[3.4, 0.09, 0.58]} />
				<meshStandardMaterial color={CLAY_PLANE} roughness={0.62} metalness={0.14} />
			</mesh>
			<mesh position={[0, 0.84, -1.18]}>
				<boxGeometry args={[1.45, 0.07, 0.38]} />
				<meshStandardMaterial color={CLAY_PLANE_TRIM} roughness={0.62} metalness={0.12} />
			</mesh>
			<mesh position={[0, 1.08, -1.2]} rotation={[0.22, 0, 0]}>
				<boxGeometry args={[0.08, 0.62, 0.48]} />
				<meshStandardMaterial color={CLAY_PLANE} roughness={0.62} metalness={0.12} />
			</mesh>

			{/* cockpit canopy */}
			<mesh position={[0, 1.02, 0.42]} scale={[0.62, 0.46, 0.9]}>
				<sphereGeometry args={[0.42, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
				<meshStandardMaterial color={CLAY_GLASS} roughness={0.16} metalness={0.55} />
			</mesh>

			{/* propeller hub and blades */}
			<group position={[0, 0.76, 1.86]}>
				<mesh rotation={[Math.PI / 2, 0, 0]}>
					<cylinderGeometry args={[0.11, 0.11, 0.2, 12]} />
					<meshStandardMaterial color={CLAY_RIM} roughness={0.45} metalness={0.4} />
				</mesh>
				<mesh position={[0, 0, 0.12]} rotation={[0, 0, 0.28]}>
					<boxGeometry args={[1.25, 0.08, 0.06]} />
					<meshStandardMaterial color={CLAY_TIRE} roughness={0.8} />
				</mesh>
			</group>

			{/* simple landing gear */}
			{[-0.55, 0.55].map((x) => (
				<group key={x} position={[x, 0.2, 0.15]}>
					<mesh position={[0, 0.24, 0]} rotation={[0, 0, x < 0 ? -0.35 : 0.35]}>
						<boxGeometry args={[0.045, 0.55, 0.045]} />
						<meshStandardMaterial color={CLAY_RIM} roughness={0.65} metalness={0.3} />
					</mesh>
					<mesh rotation={[0, 0, Math.PI / 2]}>
						<cylinderGeometry args={[0.16, 0.16, 0.09, 14]} />
						<meshStandardMaterial color={CLAY_TIRE} roughness={0.95} />
					</mesh>
				</group>
			))}
		</group>
	);
}

export function Chair({ position = [0, 0, 0], rotY = 0 }) {
	const legPositions = [
		[-0.24, 0.23, -0.22],
		[0.24, 0.23, -0.22],
		[-0.24, 0.23, 0.22],
		[0.24, 0.23, 0.22],
	];
	return (
		<group position={position} rotation={[0, rotY, 0]} scale={0.9}>
			<mesh position={[0, 0.49, 0]} castShadow receiveShadow>
				<boxGeometry args={[0.6, 0.12, 0.58]} />
				<meshStandardMaterial color={CLAY_CHAIR_LIGHT} roughness={0.86} />
			</mesh>
			{legPositions.map((leg, index) => (
				<mesh key={index} position={leg} castShadow receiveShadow>
					<boxGeometry args={[0.09, 0.46, 0.09]} />
					<meshStandardMaterial color={CLAY_CHAIR} roughness={0.9} />
				</mesh>
			))}
			<mesh position={[-0.24, 0.92, -0.245]} castShadow receiveShadow>
				<boxGeometry args={[0.09, 0.86, 0.09]} />
				<meshStandardMaterial color={CLAY_CHAIR} roughness={0.9} />
			</mesh>
			<mesh position={[0.24, 0.92, -0.245]} castShadow receiveShadow>
				<boxGeometry args={[0.09, 0.86, 0.09]} />
				<meshStandardMaterial color={CLAY_CHAIR} roughness={0.9} />
			</mesh>
			<mesh position={[0, 1.08, -0.245]} castShadow receiveShadow>
				<boxGeometry args={[0.52, 0.38, 0.1]} />
				<meshStandardMaterial color={CLAY_CHAIR_LIGHT} roughness={0.86} />
			</mesh>
		</group>
	);
}

/**
 * The creatable primitives, Unity's 3D Object menu in clay. Each one is built
 * with its base on the local floor (y = 0), so an object's `y` reads as height
 * above the deck rather than "half of me is underground".
 */
function Primitive({ kind, color }) {
	const material = <meshStandardMaterial color={color} roughness={0.82} side={kind === "plane" ? THREE.DoubleSide : THREE.FrontSide} />;
	if (kind === "sphere") {
		return (
			<mesh position={[0, 0.5, 0]} castShadow receiveShadow>
				<sphereGeometry args={[0.5, 28, 18]} />
				{material}
			</mesh>
		);
	}
	if (kind === "capsule") {
		return (
			<mesh position={[0, 0.7, 0]} castShadow receiveShadow>
				<capsuleGeometry args={[0.35, 0.7, 6, 18]} />
				{material}
			</mesh>
		);
	}
	if (kind === "cylinder") {
		return (
			<mesh position={[0, 0.5, 0]} castShadow receiveShadow>
				<cylinderGeometry args={[0.5, 0.5, 1, 26]} />
				{material}
			</mesh>
		);
	}
	if (kind === "cone") {
		return (
			<mesh position={[0, 0.5, 0]} castShadow receiveShadow>
				<coneGeometry args={[0.5, 1, 26]} />
				{material}
			</mesh>
		);
	}
	if (kind === "plane") {
		return (
			<mesh position={[0, 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
				<planeGeometry args={[2, 2]} />
				{material}
			</mesh>
		);
	}
	return (
		<mesh position={[0, 0.5, 0]} castShadow receiveShadow>
			<boxGeometry args={[1, 1, 1]} />
			{material}
		</mesh>
	);
}

const PRIMITIVE_KINDS = new Set(["cube", "sphere", "capsule", "cylinder", "cone", "plane"]);

function SceneObjectContent({ renderer, color }) {
	if (renderer === "car") return <Car color={color} />;
	if (renderer === "small-plane") return <SmallPlane />;
	if (renderer === "chair") return <Chair />;
	if (PRIMITIVE_KINDS.has(renderer)) return <Primitive kind={renderer} color={color} />;
	return null;
}

/**
 * Selection cage: the object's bounding box drawn as EDGES only. A wireframe
 * box draws every triangle diagonal too, which reads as a scribble over the
 * object instead of a selection.
 */
function SelectionBox({ object }) {
	const height = Math.max(object.height ?? 1, 0.08);
	const width = object.footprint?.width ?? 1;
	const depth = object.footprint?.depth ?? 1;
	const edges = useMemo(
		() => new THREE.EdgesGeometry(new THREE.BoxGeometry(width * 1.04, height * 1.04, depth * 1.04)),
		[width, height, depth],
	);
	useEffect(() => () => edges.dispose(), [edges]);
	return (
		<lineSegments geometry={edges} position={[0, height / 2, 0]} renderOrder={998}>
			<lineBasicMaterial color="#e7b557" transparent opacity={0.95} depthTest={false} depthWrite={false} />
		</lineSegments>
	);
}

const DEG = Math.PI / 180;

function SceneObject({ object, selected }) {
	return (
		<group
			position={[object.x, object.y ?? 0, object.z]}
			rotation={[(object.rotX ?? 0) * DEG, object.rot * DEG, (object.rotZ ?? 0) * DEG]}
			scale={[object.scaleX ?? 1, object.scaleY ?? 1, object.scaleZ ?? 1]}
			// the viewport picker walks up from a hit mesh to find this id
			userData={{ sceneObjectId: object.id }}
		>
			<SceneObjectContent renderer={object.renderer} color={object.color} />
			{selected && <SelectionBox object={object} />}
		</group>
	);
}

/** User-added scene objects, all driven by the shared object registry. */
export function SetProps({ objects = [], selectedId = null }) {
	return (
		<group>
			{objects.map((object) => (
				<SceneObject key={object.id} object={object} selected={object.id === selectedId} />
			))}
		</group>
	);
}
