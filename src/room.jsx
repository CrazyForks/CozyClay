/**
 * The blocking set: an open stage floor.
 *
 * The set used to be a two-walled room corner, which kept AI blocking frames
 * enclosed but boxed the camera and capped how far a run or a chase could be
 * staged. The walls are gone: the stage is now a near-infinite open deck —
 * large enough that no ordinary blocking ever meets its edge — and enclosure,
 * when a shot needs it, comes from placed set pieces instead of the stage.
 *
 * Dimensions are metres. The floor is deliberately finite (a plane, not a
 * shader-infinite grid) so exports keep a clean horizon and the framing math
 * never meets an unbounded surface.
 */

// Bright enough to sit clearly above the grid lines: the deck reads as a lit
// surface with lines drawn ON it, not as a dark line-texture tiling to the fog.
const FLOOR = "#f4f0e8";

export const STAGE_SIZE = 500;

export function Room() {
	return (
		<group>
			<mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
				<planeGeometry args={[STAGE_SIZE, STAGE_SIZE]} />
				<meshBasicMaterial color={FLOOR} />
			</mesh>
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
