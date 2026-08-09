import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

/**
 * Two live viewports out of one scene.
 *
 * Blocking a shot means moving the camera and watching the frame change. Doing
 * that through a view toggle costs a round trip per nudge, so both views render
 * every frame into scissored regions of the same canvas. One scene, one WebGL
 * context, two cameras — cloning the scene would double the FBX cost for a
 * picture that is only ever a monitor.
 */

/** the plan pucks/wedge: overlay geometry only the top-down camera may see */
export const PLAN_LAYER = 2;
/** the ceiling: it would fill the entire top-down view, so hide it from the plan */
export const SHOT_LAYER = 3;
/** IK handles/gizmo: only the poser camera (the IK working view) sees them,
 * never the frozen shot camera in the inset or the plan. */
export const POSER_LAYER = 4;
/** the scene-object transform gizmo: live in both 3D working views, stripped
 * from the plan and from exported frames (the capture rig drops this layer). */
export const GIZMO_LAYER = 5;
/** the shot camera is locked to the export aspect no matter which pane holds it */
export const SHOT_ASPECT = 16 / 9;
/** half-height of the plan frustum, in metres — covers the full camera throw */
export const PLAN_EXTENT = 7.2;

const EDGE_VERTEX = `
	varying vec2 vUv;
	void main() {
		vUv = uv;
		gl_Position = vec4(position.xy, 0.0, 1.0);
	}
`;

const EDGE_FRAGMENT = `
	uniform sampler2D tNormal;
	uniform sampler2D tDepth;
	uniform vec2 texel;
	uniform vec3 edgeColor;
	uniform float cameraNear;
	uniform float cameraFar;
	uniform float orthographic;
	varying vec2 vUv;

	float linearDepth(float value) {
		if (orthographic > 0.5) return mix(cameraNear, cameraFar, value);
		float z = value * 2.0 - 1.0;
		return (2.0 * cameraNear * cameraFar) /
			(cameraFar + cameraNear - z * (cameraFar - cameraNear));
	}

	void main() {
		vec2 x = vec2(texel.x * 0.8, 0.0);
		vec2 y = vec2(0.0, texel.y * 0.8);
		float centerZ = linearDepth(texture2D(tDepth, vUv).x);
		float nearestZ = min(
			min(linearDepth(texture2D(tDepth, vUv - x).x), linearDepth(texture2D(tDepth, vUv + x).x)),
			min(linearDepth(texture2D(tDepth, vUv - y).x), linearDepth(texture2D(tDepth, vUv + y).x))
		);
		float foregroundOwner = 1.0 - step(nearestZ + max(0.002, centerZ * 0.0015), centerZ);
		float dTL = log2(1.0 + linearDepth(texture2D(tDepth, vUv - x + y).x));
		float dT  = log2(1.0 + linearDepth(texture2D(tDepth, vUv + y).x));
		float dTR = log2(1.0 + linearDepth(texture2D(tDepth, vUv + x + y).x));
		float dL  = log2(1.0 + linearDepth(texture2D(tDepth, vUv - x).x));
		float dR  = log2(1.0 + linearDepth(texture2D(tDepth, vUv + x).x));
		float dBL = log2(1.0 + linearDepth(texture2D(tDepth, vUv - x - y).x));
		float dB  = log2(1.0 + linearDepth(texture2D(tDepth, vUv - y).x));
		float dBR = log2(1.0 + linearDepth(texture2D(tDepth, vUv + x - y).x));
		float depthX = dTL + 2.0 * dL + dBL - dTR - 2.0 * dR - dBR;
		float depthY = dTL + 2.0 * dT + dTR - dBL - 2.0 * dB - dBR;
		float depthEdge = length(vec2(depthX, depthY));

		vec3 nTL = texture2D(tNormal, vUv - x + y).xyz * 2.0 - 1.0;
		vec3 nT  = texture2D(tNormal, vUv + y).xyz * 2.0 - 1.0;
		vec3 nTR = texture2D(tNormal, vUv + x + y).xyz * 2.0 - 1.0;
		vec3 nL  = texture2D(tNormal, vUv - x).xyz * 2.0 - 1.0;
		vec3 nR  = texture2D(tNormal, vUv + x).xyz * 2.0 - 1.0;
		vec3 nBL = texture2D(tNormal, vUv - x - y).xyz * 2.0 - 1.0;
		vec3 nB  = texture2D(tNormal, vUv - y).xyz * 2.0 - 1.0;
		vec3 nBR = texture2D(tNormal, vUv + x - y).xyz * 2.0 - 1.0;
		vec3 normalX = nTL + 2.0 * nL + nBL - nTR - 2.0 * nR - nBR;
		vec3 normalY = nTL + 2.0 * nT + nTR - nBL - 2.0 * nB - nBR;
		float normalEdge = sqrt(dot(normalX, normalX) + dot(normalY, normalY));

		float depthLine = smoothstep(0.055, 0.16, depthEdge);
		float normalLine = smoothstep(0.7, 1.7, normalEdge);
		float edge = max(depthLine * foregroundOwner, normalLine * 0.68);
		gl_FragColor = vec4(edgeColor, edge * 0.76);
	}
`;

/** largest centred sub-rect of `rect` with the given aspect */
export function fitAspect(rect, aspect) {
	let w = rect.w;
	let h = w / aspect;
	if (h > rect.h) {
		h = rect.h;
		w = h * aspect;
	}
	return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h };
}

export function DualRender({ stageRef, mainRef, insetRef, shotCamRef, planCamRef, poserCamRef, ikMode = false, planIsMain }) {
	const { gl, scene, size } = useThree();
	const edgePass = useMemo(() => {
		const target = new THREE.WebGLRenderTarget(1, 1, {
			depthBuffer: true,
			stencilBuffer: false,
			minFilter: THREE.NearestFilter,
			magFilter: THREE.NearestFilter,
		});
		target.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
		target.depthTexture.minFilter = THREE.NearestFilter;
		target.depthTexture.magFilter = THREE.NearestFilter;
		const normalMaterial = new THREE.MeshNormalMaterial({
			blending: THREE.NoBlending,
			side: THREE.DoubleSide,
		});
		const material = new THREE.ShaderMaterial({
			vertexShader: EDGE_VERTEX,
			fragmentShader: EDGE_FRAGMENT,
			transparent: true,
			depthTest: false,
			depthWrite: false,
			toneMapped: false,
			uniforms: {
				tNormal: { value: target.texture },
				tDepth: { value: target.depthTexture },
				texel: { value: new THREE.Vector2(1, 1) },
				edgeColor: { value: new THREE.Color("#243b4d") },
				cameraNear: { value: 0.1 },
				cameraFar: { value: 100 },
				orthographic: { value: 0 },
			},
		});
		const passScene = new THREE.Scene();
		const passCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
		passScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
		return { target, normalMaterial, material, passScene, passCamera };
	}, []);

	useEffect(() => () => {
		edgePass.target.dispose();
		edgePass.normalMaterial.dispose();
		edgePass.material.dispose();
		edgePass.passScene.children[0].geometry.dispose();
	}, [edgePass]);

	// Layer masks are set once. The shot camera must never pick up the plan
	// overlay, or exported frames would carry pucks across the floor.
	useEffect(() => {
		const shot = shotCamRef.current;
		const plan = planCamRef.current;
		const poser = poserCamRef?.current;
		if (shot) {
			shot.layers.set(0);
			shot.layers.enable(SHOT_LAYER);
			shot.layers.enable(GIZMO_LAYER);
		}
		if (plan) {
			plan.layers.set(0);
			plan.layers.enable(PLAN_LAYER);
		}
		if (poser) {
			poser.layers.set(0);
			poser.layers.enable(SHOT_LAYER);
			poser.layers.enable(POSER_LAYER);
			poser.layers.enable(GIZMO_LAYER);
		}
	});

	// priority 1 takes over the render loop; R3F stops auto-rendering for us
	useFrame(() => {
		const shotCam = shotCamRef.current;
		const planCam = planCamRef.current;
		const poserCam = poserCamRef?.current;
		const stage = stageRef.current;
		if (!shotCam || !planCam || !stage || !mainRef.current || !insetRef.current) return;

		const base = stage.getBoundingClientRect();
		const rectOf = (el) => {
			const r = el.getBoundingClientRect();
			return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
		};
		const mainRect = rectOf(mainRef.current);
		const insetRect = rectOf(insetRef.current);
		if (mainRect.w < 2 || insetRect.w < 2) return;

		const planPane = planIsMain ? mainRect : insetRect;
		const shotPane = planIsMain ? insetRect : mainRect;

		// scissor bounds the clear, viewport bounds the image: letterbox bars in
		// the shot pane get painted with the scene background instead of leaking
		// whatever was underneath.
		const draw = (camera, pane, imageRect, ink = true) => {
			const glY = size.height - (pane.y + pane.h);
			gl.setScissorTest(true);
			gl.setScissor(pane.x, glY, pane.w, pane.h);
			const img = imageRect ?? pane;
			const imgY = size.height - (img.y + img.h);
			if (ink) {
				const targetWidth = Math.max(1, Math.round(img.w * gl.getPixelRatio()));
				const targetHeight = Math.max(1, Math.round(img.h * gl.getPixelRatio()));
				edgePass.target.setSize(targetWidth, targetHeight);
				edgePass.material.uniforms.texel.value.set(1 / targetWidth, 1 / targetHeight);
				gl.setRenderTarget(edgePass.target);
				gl.setScissorTest(false);
				gl.setClearColor(0x000000, 0);
				gl.clear(true, true, false);
				scene.overrideMaterial = edgePass.normalMaterial;
				gl.render(scene, camera);
				scene.overrideMaterial = null;
			}
			gl.setRenderTarget(null);
			gl.setScissorTest(true);
			gl.setScissor(pane.x, glY, pane.w, pane.h);
			gl.setViewport(img.x, imgY, img.w, img.h);
			gl.render(scene, camera);
			if (ink) {
				const uniforms = edgePass.material.uniforms;
				uniforms.cameraNear.value = camera.near;
				uniforms.cameraFar.value = camera.far;
				uniforms.orthographic.value = camera.isOrthographicCamera ? 1 : 0;
				gl.autoClear = false;
				gl.render(edgePass.passScene, edgePass.passCamera);
				gl.autoClear = true;
			}
		};

		gl.autoClear = true;
		shotCam.aspect = SHOT_ASPECT;
		shotCam.updateProjectionMatrix();
		// An orthographic plan keeps every puck the same size and the floor
		// undistorted; a perspective one skews the pucks near the edges and reads
		// as a 3/4 view rather than a plan.
		if (planCam.isOrthographicCamera) {
			const a = planPane.w / planPane.h;
			planCam.top = PLAN_EXTENT;
			planCam.bottom = -PLAN_EXTENT;
			planCam.left = -PLAN_EXTENT * a;
			planCam.right = PLAN_EXTENT * a;
		} else {
			planCam.aspect = planPane.w / planPane.h;
		}
		planCam.updateProjectionMatrix();

		if (ikMode && poserCam) {
			// IK mode: the main pane is the poser working view (free navigation,
			// handle layer visible); the inset is the FROZEN shot camera — the
			// separate camera-placement screen the framing lives on.
			poserCam.aspect = mainRect.w / mainRect.h;
			poserCam.updateProjectionMatrix();
			draw(poserCam, mainRect);
			draw(shotCam, insetRect, fitAspect(insetRect, SHOT_ASPECT));
		} else if (planIsMain) {
			draw(planCam, planPane, null, false);
			draw(shotCam, shotPane, fitAspect(shotPane, SHOT_ASPECT));
		} else {
			draw(shotCam, shotPane, fitAspect(shotPane, SHOT_ASPECT));
			draw(planCam, planPane, null, false);
		}

		gl.setScissorTest(false);
		gl.setViewport(0, 0, size.width, size.height);
	}, 1);

	return null;
}
