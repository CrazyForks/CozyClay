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

/** Recover the clip's authored sampling rate from its animation key times. */
export function glbSampleFps(clip, fallback = 24) {
	const periods = [];
	for (const track of clip?.tracks ?? []) {
		for (let i = 1; i < track.times.length; i += 1) {
			const period = track.times[i] - track.times[i - 1];
			if (period > 1e-6) periods.push(period);
		}
	}
	if (periods.length === 0) return fallback;
	periods.sort((a, b) => a - b);
	const fps = 1 / periods[Math.floor(periods.length / 2)];
	const integer = Math.round(fps);
	return Math.abs(fps - integer) < 0.01 ? integer : fps;
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
		// Ground from vertices actually weighted to foot/toe bones. Using the
		// lowest point of the entire body lets a low hand or a bad pose move the
		// whole actor vertically.
		const skinned = [];
		probe.traverse((o) => {
			if (o.isSkinnedMesh) skinned.push(o);
		});
		if (skinned.length === 0) return { anchor: [-p.x, 0, -p.z], floorOffsets: [0] };

		const footVertices = [];
		for (const mesh of skinned) {
			const skinIndex = mesh.geometry.attributes.skinIndex;
			const skinWeight = mesh.geometry.attributes.skinWeight;
			const footBones = new Set(
				mesh.skeleton.bones
					.map((bone, index) => (/foot|toe/i.test(bone.name) ? index : -1))
					.filter((index) => index >= 0),
			);
			if (!skinIndex || !skinWeight || footBones.size === 0) continue;
			const indices = [];
			for (let i = 0; i < skinIndex.count; i += 1) {
				let weight = 0;
				for (let lane = 0; lane < skinIndex.itemSize; lane += 1) {
					if (footBones.has(skinIndex.getComponent(i, lane))) {
						weight += skinWeight.getComponent(i, lane);
					}
				}
				if (weight >= 0.2) indices.push(i);
			}
			if (indices.length > 0) footVertices.push({ mesh, indices });
		}

		// Numeric/anonymous rigs cannot expose foot semantics. Keep a safe
		// fallback, but authored rigs use only their foot-weighted surface.
		const surfaces =
			footVertices.length > 0
				? footVertices
				: skinned.map((mesh) => ({
						mesh,
						indices: Array.from(
							{ length: mesh.geometry.attributes.position.count },
							(_, index) => index,
						),
					}));
		const v = new Vector3();
		const lowestFootY = () => {
			let min = Infinity;
			for (const { mesh, indices } of surfaces) {
				mesh.skeleton.update();
				for (const index of indices) {
					mesh.getVertexPosition(index, v);
					v.applyMatrix4(mesh.matrixWorld);
					if (v.y < min) min = v.y;
				}
			}
			return min;
		};

		const count = glbFrameCount(clip.duration, fps);
		const rawOffsets = [];
		for (let i = 0; i < count; i += 1) {
			probeMixer.setTime(Math.min(clip.duration, i / fps));
			probe.updateMatrixWorld(true);
			rawOffsets.push(-lowestFootY());
		}

		// A centred median follows slow solve-height drift while rejecting
		// frame-to-frame sole noise. It adds no lag because the entire clip is
		// available before playback.
		const radius = Math.max(1, Math.round(fps * 0.15));
		const floorOffsets = rawOffsets.map((_, index) => {
			const window = rawOffsets
				.slice(Math.max(0, index - radius), Math.min(rawOffsets.length, index + radius + 1))
				.sort((a, b) => a - b);
			return window[Math.floor(window.length / 2)];
		});

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
	// `onClip` is read through a ref so a caller that re-renders (or passes a
	// fresh callback every time) cannot interrupt playback. The authored fps is
	// read from the clip itself rather than inheriting ARDY's 20 fps timeline.
	const onClipRef = useRef(onClip);
	onClipRef.current = onClip;

	useEffect(() => {
		const clip = gltf.animations?.[0];
		if (!clip) return undefined;
		const action = mixer.clipAction(clip);
		action.play();
		// Report the clip's own length once per clip so the timeline can size
		// itself to the take rather than the take being cropped to the timeline.
		if (onClipRef.current && reported.current !== clip.uuid) {
			reported.current = clip.uuid;
			const sampleFps = glbSampleFps(clip, fps);
			onClipRef.current({
				duration: clip.duration,
				fps: sampleFps,
				frames: glbFrameCount(clip.duration, sampleFps),
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
