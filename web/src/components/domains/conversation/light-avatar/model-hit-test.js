// @ts-check
import * as THREE from "three";
const clamp = THREE.MathUtils.clamp;
/** @param {THREE.WebGLRenderer} renderer @param {THREE.PerspectiveCamera} camera @param {(name: import("./skeleton.ts").BoneName) => THREE.Bone} bone */
export function createAvatarHitTest(renderer, camera, bone) {
	const hitCenter = new THREE.Vector3(),
		hitEnd = new THREE.Vector3(),
		hitEdge = new THREE.Vector3(),
		cameraRight = new THREE.Vector3();

	/**
	 * Projects a world point and a radius at its depth to canvas pixels (mutates `world`).
	 * @param {THREE.Vector3} world
	 * @param {number} radius
	 * @param {DOMRect} rect
	 */
	function toScreen(world, radius, rect) {
		hitEdge.copy(world).addScaledVector(cameraRight, radius).project(camera);
		world.project(camera);
		const x = ((world.x + 1) / 2) * rect.width,
			y = ((1 - world.y) / 2) * rect.height;
		return { x, y, r: Math.abs(((hitEdge.x + 1) / 2) * rect.width - x) };
	}

	/**
	 * Screen-space test against the last drawn pose: a ball for the head, a capsule from the
	 * tail to the neck for the body. The head wins where both overlap.
	 * @param {number} clientX
	 * @param {number} clientY
	 * @returns {"head" | "body" | null}
	 */
	function hitTest(clientX, clientY) {
		const rect = renderer.domElement.getBoundingClientRect();
		if (!rect.width || !rect.height) return null;
		const px = clientX - rect.left,
			py = clientY - rect.top;
		cameraRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
		const head = toScreen(
			bone("head").localToWorld(hitCenter.set(0, 0.45, 0)),
			0.6,
			rect,
		);
		if (Math.hypot(px - head.x, py - head.y) <= head.r) return "head";
		const a = toScreen(bone("tail_01").getWorldPosition(hitCenter), 0.6, rect);
		const b = toScreen(bone("neck").getWorldPosition(hitEnd), 0.6, rect);
		const dx = b.x - a.x,
			dy = b.y - a.y;
		const t = clamp(
			((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy || 1),
			0,
			1,
		);
		return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy)) <= a.r
			? "body"
			: null;
	}
	return hitTest;
}
