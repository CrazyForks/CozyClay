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
import { AnimationMixer } from "three";
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
	const scene = useMemo(() => SkeletonUtils.clone(gltf.scene), [gltf.scene]);
	const mixer = useMemo(() => new AnimationMixer(scene), [scene]);
	const reported = useRef(null);

	useEffect(() => {
		const clip = gltf.animations?.[0];
		if (!clip) return undefined;
		const action = mixer.clipAction(clip);
		action.play();
		// Report the clip's own length once per clip so the timeline can size
		// itself to the take rather than the take being cropped to the timeline.
		if (onClip && reported.current !== clip.uuid) {
			reported.current = clip.uuid;
			onClip({ duration: clip.duration, frames: glbFrameCount(clip.duration, fps) });
		}
		return () => {
			action.stop();
			mixer.uncacheClip(clip);
		};
	}, [gltf.animations, mixer, fps, onClip]);

	// Scrub, never advance: the timeline owns the clock, so the mixer is driven
	// to an absolute time. Letting it integrate its own delta would drift away
	// from the playhead and desync from every other track.
	useEffect(() => {
		if (!gltf.animations?.length) return;
		mixer.setTime(Math.max(0, frame) / (fps > 0 ? fps : 24));
	}, [mixer, frame, fps, gltf.animations]);

	useEffect(() => () => mixer.stopAllAction(), [mixer]);

	return (
		<group position={position} rotation={[0, (rot * Math.PI) / 180, 0]}>
			<primitive object={scene} />
		</group>
	);
}
