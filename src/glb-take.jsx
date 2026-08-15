/**
 * A baked skinned-glb take on the timeline.
 *
 * The cskel27 path (src/ardy/playback.js) retargets a 27-joint clip onto the
 * Mixamo rig: it composes each bone's bind quaternion, drives bone POSITIONS
 * from posedJoints, and rebuilds parent chains through `chainParent`/`chainRel`.
 * All of that assumes the x-bot topology (129 bones). A clip that already ships
 * its own rig and its own skinning has nothing to retarget, and pushing it
 * through that path was measured to distort it badly — the rig it arrives with
 * is the rig it is correct on.
 *
 * So this is a SEPARATE path, not a change to that one. It plays the glb's own
 * animation on the glb's own skeleton and only borrows the timeline's clock.
 * Nothing here touches the cskel27 pipeline, ARDY playback, or the IK layer.
 */
import { useEffect, useMemo, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { AnimationMixer, MeshStandardMaterial, Vector3 } from "three";
import { SkeletonUtils } from "three/examples/jsm/Addons.js";

/** A take is glb-shaped when its URL says so; the loader cannot guess. */
export function isGlbTakeUrl(url) {
	return typeof url === "string" && /\.glb(\?|#|$)/i.test(url);
}

/**
 * Frame count for a clip, from its own duration and fps. Rounding down and
 * adding the frame at t=0 keeps the last frame reachable without inventing a
 * frame past the end of the clip.
 */
export function glbFrameCount(durationSeconds, fps) {
	if (!(durationSeconds > 0) || !(fps > 0)) return 1;
	return Math.max(1, Math.floor(durationSeconds * fps + 1e-6) + 1);
}

export function GlbTake({ url, frame = 0, fps = 24, position = [0, 0, 0], rot = 0, onClip }) {
	const gltf = useGLTF(url);

	// Clone per instance: two takes of the same url must not share one skeleton,
	// and SkeletonUtils is the clone that carries bones/skinning correctly.
	const scene = useMemo(() => {
		const clone = SkeletonUtils.clone(gltf.scene);
		clone.traverse((child) => {
			if (!child.isMesh) return;
			// Use a neutral mid-grey clay instead of the reconstruction export's
			// near-black diagnostic material. It keeps form readable under the
			// editor lights without turning into a white silhouette.
			child.material = new MeshStandardMaterial({
				color: "#a9aca9",
				roughness: 0.86,
				metalness: 0,
			});
			child.frustumCulled = false;
		});
		return clone;
	}, [gltf.scene]);
	const mixer = useMemo(() => new AnimationMixer(scene), [scene]);
	useEffect(
		() => () => {
			scene.traverse((child) => {
				if (child.isMesh) child.material.dispose();
			});
		},
		[scene],
	);
	const reported = useRef(null);

	// The clip carries the performer's own world position, so playing it at the
	// anchor adds the two and drops the figure wherever the solve happened to
	// put them — in practice, on top of the camera. Anchor on the take's FIRST
	// frame instead (the same rule the cskel27 path uses) so the performance
	// starts where the subject is placed and keeps its own travel from there.
	// Horizontal travel stays relative to frame 0. Vertical placement is
	// different: monocular solves commonly put the whole body a few centimetres
	// above the floor and vary that error over time, so each timeline frame gets
	// its own measured sole correction.
	const placement = useMemo(() => {
		const clip = gltf.animations?.[0];
		if (!clip) return { anchor: [0, 0, 0], floorOffsets: [0] };
		const probe = SkeletonUtils.clone(gltf.scene);
		const probeMixer = new AnimationMixer(probe);
		probeMixer.clipAction(clip).play();
		probeMixer.setTime(0);
		probe.updateMatrixWorld(true);
		let root = null;
		probe.traverse((o) => {
			if (!root && o.isBone) root = o;
		});
		if (!root) return { anchor: [0, 0, 0], floorOffsets: [0] };
		const p = new Vector3();
		root.getWorldPosition(p);
		// The correction must come from the skinned surface. Static geometry
		// bounds do not follow bones and therefore cannot locate an animated sole.
		// The lowest point is measured on the SKINNED SURFACE, not inferred.
		//
		// Bone positions plus a rest-pose sole offset was an estimate of where
		// the foot is, and it read high: it assumes the sole keeps a fixed
		// distance below the ankle, which stops being true the moment the ankle
		// rotates. That left the figure hovering.
		//
		// SkinnedMesh.getVertexPosition applies the CURRENT skinning, so it
		// answers the question directly. Only the vertices that can plausibly
		// touch the ground are tracked -- picked once as the lowest slice of the
		// bind pose -- so this stays cheap while remaining exact for the part
		// that matters.
		let skinned = null;
		probe.traverse((o) => {
			if (!skinned && o.isSkinnedMesh) skinned = o;
		});
		if (!skinned) return { anchor: [-p.x, 0, -p.z], floorOffsets: [0] };

		skinned.skeleton.pose();
		probe.updateMatrixWorld(true);
		const posAttr = skinned.geometry.attributes.position;
		const bindY = [];
		for (let i = 0; i < posAttr.count; i += 1) bindY.push([i, posAttr.getY(i)]);
		bindY.sort((a, b) => a[1] - b[1]);
		const soleIdx = bindY.slice(0, Math.min(220, bindY.length)).map((e) => e[0]);

		const v = new Vector3();
		const lowestSoleY = () => {
			let min = Infinity;
			for (const i of soleIdx) {
				skinned.getVertexPosition(i, v);
				v.applyMatrix4(skinned.matrixWorld);
				if (v.y < min) min = v.y;
			}
			return min;
		};

		// Measure at the timeline's native frame rate. Applying the correction
		// for the current frame removes solve-height drift instead of grounding
		// only the single lowest frame and leaving the rest visibly airborne.
		const count = glbFrameCount(clip.duration, fps);
		const floorOffsets = [];
		for (let i = 0; i < count; i += 1) {
			probeMixer.setTime(Math.min(clip.duration, i / fps));
			probe.updateMatrixWorld(true);
			floorOffsets.push(-lowestSoleY());
		}

		probeMixer.setTime(0);
		probe.updateMatrixWorld(true);
		root.getWorldPosition(p);
		return { anchor: [-p.x, 0, -p.z], floorOffsets };
	}, [gltf.scene, gltf.animations, fps]);
	const anchorOffset = placement.anchor;
	const floorOffset =
		placement.floorOffsets[Math.min(Math.max(0, Math.round(frame)), placement.floorOffsets.length - 1)] ?? 0;

	// The action is bound to the CLIP and to nothing else.
	//
	// It used to depend on `onClip` and `fps` as well. `onClip` is an inline
	// arrow in the caller, so its identity changes on every App render — and
	// moving the camera renders App. Each of those renders tore the effect
	// down, and the cleanup's action.stop() drops the skeleton back to its
	// bind pose: the take snapped to a T-pose and stopped the moment anyone
	// touched the camera. `fps` had the same hazard for any fps change.
	//
	// Both are read through refs instead, so a caller that re-renders (or
	// passes a fresh callback every time, which is the normal React thing to
	// do) can no longer interrupt playback. The effect now runs once per clip.
	const onClipRef = useRef(onClip);
	onClipRef.current = onClip;
	const fpsRef = useRef(fps);
	fpsRef.current = fps;

	useEffect(() => {
		const clip = gltf.animations?.[0];
		if (!clip) return undefined;
		const action = mixer.clipAction(clip);
		action.play();
		// Report the clip's own length once per clip so the timeline can size
		// itself to the take rather than the take being cropped to the timeline.
		if (onClipRef.current && reported.current !== clip.uuid) {
			reported.current = clip.uuid;
			onClipRef.current({
				duration: clip.duration,
				frames: glbFrameCount(clip.duration, fpsRef.current),
			});
		}
		return () => {
			action.stop();
			mixer.uncacheClip(clip);
		};
	}, [gltf.animations, mixer]);

	// Scrub, never advance: the timeline owns the clock, so the mixer is driven
	// to an absolute time. Letting it integrate its own delta would drift away
	// from the playhead and desync from every other track.
	useEffect(() => {
		if (!gltf.animations?.length) return;
		mixer.setTime(Math.max(0, frame) / (fps > 0 ? fps : 24));
	}, [mixer, frame, fps, gltf.animations]);

	useEffect(() => () => mixer.stopAllAction(), [mixer]);

	return (
		<group position={[position[0] + anchorOffset[0], position[1] + floorOffset, position[2] + anchorOffset[2]]} rotation={[0, (rot * Math.PI) / 180, 0]}>
			<primitive object={scene} />
		</group>
	);
}
