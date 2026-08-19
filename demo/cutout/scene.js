/**
 * The demo's own viewer. Deliberately NOT the studio: no React, no dual view,
 * no ink pass, no history store — just a floor, a 1.8 m figure for scale, and
 * whatever cards the page hands it.
 *
 * The point of keeping it separate is that the interesting modules
 * (scene-objects.js, scene-assets.js) are proven to stand on their own. If the
 * card comes out the right size here, in a viewer that shares nothing with the
 * studio but those two files, then the size lives in the model where it
 * belongs and not in App.jsx.
 */

import * as THREE from "three";
import { objectSize } from "../../src/scene-objects.js";

const GREY_BOX = "#c2c6c8";
const FLOOR = "#9ba3a6";
const ROOM_LIMIT = 11;

export function createViewer(canvas) {
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
	renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;

	const scene = new THREE.Scene();
	scene.background = new THREE.Color("#1b1f21");
	scene.fog = new THREE.Fog("#1b1f21", 14, 34);

	const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 120);
	// Eye level, one figure's distance back: the shot the studio opens on.
	const orbit = { yaw: 0.6, pitch: 0.16, distance: 6.4, target: new THREE.Vector3(0, 1, 0) };

	const key = new THREE.DirectionalLight("#fff6e8", 2.1);
	key.position.set(4.5, 7, 3.5);
	key.castShadow = true;
	key.shadow.mapSize.set(1024, 1024);
	key.shadow.camera.left = -12;
	key.shadow.camera.right = 12;
	key.shadow.camera.top = 12;
	key.shadow.camera.bottom = -12;
	scene.add(key);
	scene.add(new THREE.HemisphereLight("#dfe9ef", "#33393c", 1.15));

	const floor = new THREE.Mesh(
		new THREE.PlaneGeometry(ROOM_LIMIT * 2, ROOM_LIMIT * 2),
		new THREE.MeshStandardMaterial({ color: FLOOR, roughness: 0.98 }),
	);
	floor.rotation.x = -Math.PI / 2;
	floor.receiveShadow = true;
	scene.add(floor);

	// One line per metre: the grid IS the ruler this whole feature is about.
	const grid = new THREE.GridHelper(ROOM_LIMIT * 2, ROOM_LIMIT * 2, "#6f797d", "#848d90");
	grid.material.opacity = 0.55;
	grid.material.transparent = true;
	grid.position.y = 0.002;
	scene.add(grid);

	/** The 1.8 m stand-in the whole shot vocabulary is measured against. */
	const figure = new THREE.Group();
	const clay = new THREE.MeshStandardMaterial({ color: GREY_BOX, roughness: 0.85 });
	const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.21, 0.86, 6, 18), clay);
	body.position.y = 0.92;
	body.castShadow = true;
	const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 14), clay);
	head.position.y = 1.62;
	head.castShadow = true;
	const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.5, 6, 14), clay);
	legs.position.y = 0.36;
	legs.castShadow = true;
	figure.add(body, head, legs);
	figure.position.set(-1.15, 0, 0);
	scene.add(figure);

	const cards = new THREE.Group();
	scene.add(cards);

	const resize = () => {
		const width = canvas.clientWidth || 1;
		const height = canvas.clientHeight || 1;
		renderer.setSize(width, height, false);
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
	};

	const place = () => {
		const { yaw, pitch, distance, target } = orbit;
		camera.position.set(
			target.x + Math.sin(yaw) * Math.cos(pitch) * distance,
			target.y + Math.sin(pitch) * distance,
			target.z + Math.cos(yaw) * Math.cos(pitch) * distance,
		);
		camera.lookAt(target);
	};

	let frame = 0;
	const tick = () => {
		frame = requestAnimationFrame(tick);
		resize();
		place();
		renderer.render(scene, camera);
	};
	tick();

	/* ------------------------------------------------------------ input --- */

	let dragging = null;
	canvas.addEventListener("pointerdown", (event) => {
		dragging = { x: event.clientX, y: event.clientY };
		canvas.setPointerCapture(event.pointerId);
	});
	canvas.addEventListener("pointermove", (event) => {
		if (!dragging) return;
		orbit.yaw -= (event.clientX - dragging.x) * 0.006;
		orbit.pitch = Math.max(-0.2, Math.min(1.1, orbit.pitch + (event.clientY - dragging.y) * 0.004));
		dragging = { x: event.clientX, y: event.clientY };
	});
	const release = (event) => {
		dragging = null;
		if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
	};
	canvas.addEventListener("pointerup", release);
	canvas.addEventListener("pointercancel", release);
	canvas.addEventListener(
		"wheel",
		(event) => {
			event.preventDefault();
			orbit.distance = Math.max(2, Math.min(22, orbit.distance * (1 + event.deltaY * 0.0012)));
		},
		{ passive: false },
	);

	/* ------------------------------------------------------------ cards --- */

	/**
	 * Rebuild the group from records. The demo redraws wholesale on every
	 * change — a studio would not, but a dozen cards is nothing, and it keeps
	 * this file free of the diffing that would make it interesting.
	 */
	function render(objects, textures, { asBlockout = false, selectedId = null } = {}) {
		for (const child of [...cards.children]) {
			cards.remove(child);
			child.geometry?.dispose();
			child.material?.dispose?.();
		}
		for (const object of objects) {
			const size = objectSize(object);
			const group = new THREE.Group();
			group.position.set(object.x, object.y ?? 0, object.z);
			group.rotation.y = (object.rot ?? 0) * (Math.PI / 180);

			if (asBlockout) {
				// The comparison the feature exists to win: the same footprint as
				// a grey box, which is all a blockout can say about a real thing.
				const box = new THREE.Mesh(
					new THREE.BoxGeometry(size.width, size.height, Math.max(size.depth, 0.35)),
					new THREE.MeshStandardMaterial({ color: GREY_BOX, roughness: 0.85 }),
				);
				box.position.y = size.height / 2;
				box.castShadow = true;
				box.receiveShadow = true;
				group.add(box);
			} else {
				const texture = textures.get(object.assetId) ?? null;
				const card = new THREE.Mesh(
					new THREE.PlaneGeometry(size.width, size.height),
					new THREE.MeshStandardMaterial({
						map: texture,
						color: texture ? 0xffffff : GREY_BOX,
						side: THREE.DoubleSide,
						// Alpha-CUT: the card keeps writing depth, so it sorts against
						// the figure and the floor like a solid thing.
						alphaTest: texture ? 0.5 : 0,
						roughness: 0.92,
						metalness: 0,
					}),
				);
				card.position.y = size.height / 2;
				card.castShadow = true;
				card.receiveShadow = true;
				group.add(card);
			}

			if (object.id === selectedId) {
				const cage = new THREE.LineSegments(
					new THREE.EdgesGeometry(new THREE.BoxGeometry(size.width * 1.04, size.height * 1.04, Math.max(size.depth, 0.04) * 1.04)),
					new THREE.LineBasicMaterial({ color: "#e7b557", transparent: true, opacity: 0.95, depthTest: false }),
				);
				cage.position.y = size.height / 2;
				cage.renderOrder = 998;
				group.add(cage);
			}
			cards.add(group);
		}
	}

	return {
		render,
		frameCards() {
			orbit.distance = 6.4;
			orbit.yaw = 0.6;
			orbit.pitch = 0.16;
		},
		dispose() {
			cancelAnimationFrame(frame);
			renderer.dispose();
		},
	};
}
