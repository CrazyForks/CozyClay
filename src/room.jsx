/**
 * The blocking set: an open room corner.
 *
 * A blocking frame needs walls far more than it needs a pretty floor. An
 * infinite grid gives an AI model no sense of enclosure, so depth, headroom and
 * the horizon line all read as ambiguous. Two perpendicular walls and a floor
 * preserve that context without enclosing the camera in a box.
 *
 * Dimensions are metres and stage-sized (24 x 24) so a 1.8 m figure has room
 * to walk real paths while the corner still reads as an enclosure.
 */

const FLOOR = "#e7e1d7";
const BACK_WALL = "#eef1ed";
const SIDE_WALL = "#e4ecec";
const SKIRTING = "#bdcccc";

const SIZE = 24;
const HEIGHT = 6.2;
const BACK_Z = -10;
function Skirting({ position, rotation }) {
	return (
		<mesh position={position} rotation={rotation}>
			<boxGeometry args={[SIZE, 0.16, 0.06]} />
			<meshBasicMaterial color={SKIRTING} />
		</mesh>
	);
}

export function Room() {
	return (
		<group>
			<mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
				<planeGeometry args={[SIZE, SIZE]} />
				<meshBasicMaterial color={FLOOR} />
			</mesh>

			<mesh position={[0, HEIGHT / 2, BACK_Z]}>
				<planeGeometry args={[SIZE, HEIGHT]} />
				<meshBasicMaterial color={BACK_WALL} />
			</mesh>
			<mesh position={[-SIZE / 2, HEIGHT / 2, 0]} rotation={[0, Math.PI / 2, 0]}>
				<planeGeometry args={[SIZE, HEIGHT]} />
				<meshBasicMaterial color={SIDE_WALL} />
			</mesh>

			<Skirting position={[0, 0.08, BACK_Z + 0.03]} rotation={[0, 0, 0]} />
			<Skirting position={[-SIZE / 2 + 0.03, 0.08, 0]} rotation={[0, Math.PI / 2, 0]} />
		</group>
	);
}

/** Key/fill/rim rig tuned so a clay figure keeps readable form from any angle. */
export function StageLights() {
	return (
		<>
			<hemisphereLight args={["#fffdf6", "#d8d0c3", 0.9]} />
			<ambientLight intensity={0.18} />
			<directionalLight color="#fff8e8" position={[6, 9, 4]} intensity={1.12} />
			<directionalLight color="#dff6f7" position={[-6, 4, -4]} intensity={0.36} />
			<directionalLight color="#ffffff" position={[2, 3, 9]} intensity={0.22} />
		</>
	);
}
