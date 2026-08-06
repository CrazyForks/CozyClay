import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

const MOVE_SPEED = 2.6; // metres per second
const CRANE_SPEED = 1.3; // Q/E up/down runs at half walk speed — fine
// vertical adjustments while posing need the finer step, not a 2.6 m/s jump
const LOOK_SENS = 0.0032; // radians per pixel
const DOLLY_STEP = 0.0016; // metres per wheel unit
const PITCH_LIMIT = (85 * Math.PI) / 180;

/** yaw/pitch -> unit forward vector for a YXZ-ordered camera */
export function forwardFrom(yaw, pitch) {
	return new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
}

/** point a camera at a target and return the matching yaw/pitch */
export function aimAt(position, target) {
	const dx = target.x - position.x;
	const dy = target.y - position.y;
	const dz = target.z - position.z;
	return {
		yaw: Math.atan2(-dx, -dz),
		pitch: Math.atan2(dy, Math.max(Math.hypot(dx, dz), 1e-6)),
	};
}

/**
 * First-person camera operator controls: WASD walks the floor, dragging looks
 * around, the wheel dollies along the lens axis, Q/E crane down and up.
 * This is how a blocking tool has to feel — you are standing behind the camera,
 * not orbiting a turntable.
 */
export function FlyControls({ enabled, camRef, look }) {
	const { gl } = useThree();
	const keys = useRef(new Set());
	const dragging = useRef(false);
	const last = useRef({ x: 0, y: 0 });

	useEffect(() => {
		if (!enabled) return undefined;
		const element = gl.domElement;
		element.tabIndex = 0;
		element.style.touchAction = "none";

		const isTyping = () => {
			const el = document.activeElement;
			return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
		};

		/* Physical key positions, not characters: `e.key` follows the OS input
		 * method, so in Hangul IME mode pressing W yields "ㅈ" and every
		 * camera key goes dead — the exact "WASD is blocked" failure Korean
		 * users hit. `e.code` is layout/IME independent. */
		const KEY_BY_CODE = { KeyW: "w", KeyA: "a", KeyS: "s", KeyD: "d", KeyQ: "q", KeyE: "e" };
		const onKeyDown = (e) => {
			if (isTyping()) return;
			const key = KEY_BY_CODE[e.code];
			if (key) {
				keys.current.add(key);
				e.preventDefault();
			}
		};
		const onKeyUp = (e) => {
			const key = KEY_BY_CODE[e.code];
			if (key) keys.current.delete(key);
		};

		const onPointerDown = (e) => {
			if (e.button !== 0) return;
			dragging.current = true;
			last.current = { x: e.clientX, y: e.clientY };
			element.setPointerCapture(e.pointerId);
			element.focus();
		};
		const onPointerMove = (e) => {
			if (!dragging.current) return;
			look.current.yaw -= (e.clientX - last.current.x) * LOOK_SENS;
			look.current.pitch -= (e.clientY - last.current.y) * LOOK_SENS;
			look.current.pitch = THREE.MathUtils.clamp(look.current.pitch, -PITCH_LIMIT, PITCH_LIMIT);
			last.current = { x: e.clientX, y: e.clientY };
		};
		const onPointerUp = (e) => {
			dragging.current = false;
			if (element.hasPointerCapture(e.pointerId)) element.releasePointerCapture(e.pointerId);
		};
		const onWheel = (e) => {
			const cam = camRef.current;
			if (!cam) return;
			e.preventDefault();
			cam.position.addScaledVector(forwardFrom(look.current.yaw, look.current.pitch), -e.deltaY * DOLLY_STEP);
		};

		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);
		element.addEventListener("pointerdown", onPointerDown);
		element.addEventListener("pointermove", onPointerMove);
		element.addEventListener("pointerup", onPointerUp);
		element.addEventListener("pointercancel", onPointerUp);
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => {
			keys.current.clear();
			dragging.current = false;
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keyup", onKeyUp);
			element.removeEventListener("pointerdown", onPointerDown);
			element.removeEventListener("pointermove", onPointerMove);
			element.removeEventListener("pointerup", onPointerUp);
			element.removeEventListener("pointercancel", onPointerUp);
			element.removeEventListener("wheel", onWheel);
		};
	}, [enabled, gl, camRef, look]);

	useFrame((_, delta) => {
		const cam = camRef.current;
		if (!cam) return;
		cam.rotation.order = "YXZ";
		cam.rotation.y = look.current.yaw;
		cam.rotation.x = look.current.pitch;
		cam.rotation.z = 0;

		if (!enabled || keys.current.size === 0) return;
		const step = MOVE_SPEED * Math.min(delta, 0.1);
		// walking stays on the floor plane; Q/E is the crane
		const forward = new THREE.Vector3(-Math.sin(look.current.yaw), 0, -Math.cos(look.current.yaw));
		const right = new THREE.Vector3(Math.cos(look.current.yaw), 0, -Math.sin(look.current.yaw));
		if (keys.current.has("w")) cam.position.addScaledVector(forward, step);
		if (keys.current.has("s")) cam.position.addScaledVector(forward, -step);
		if (keys.current.has("d")) cam.position.addScaledVector(right, step);
		if (keys.current.has("a")) cam.position.addScaledVector(right, -step);
		const crane = CRANE_SPEED * Math.min(delta, 0.1);
		if (keys.current.has("e")) cam.position.y += crane;
		if (keys.current.has("q")) cam.position.y -= crane;
		cam.position.y = Math.max(cam.position.y, 0.12);
	});

	return null;
}
