import { OrthographicCamera, Vector3 } from "three";
import type { SpatialOptions } from "../options";

export type SceneEnvelope = {
	x: number;
	y: number;
	z: number;
	focusRadius: number;
};
const origin = new Vector3();
const padding = 1.045;
export function createCameraController(camera: OrthographicCamera) {
	const center = new Vector3(),
		direction = new Vector3(0, -1.5, 1).normalize();
	const fromCenter = center.clone(),
		fromDirection = direction.clone(),
		targetDirection = new Vector3();
	let size = 11,
		fromSize = size,
		elapsed = 1;
	let reserve = 0,
		fromReserve = 0,
		focusAmount = 0,
		fromFocusAmount = 0;
	let width = 800,
		height = 600;
	return {
		resize(w: number, h: number) {
			width = w;
			height = h;
		},
		begin() {
			fromCenter.copy(center);
			fromDirection.copy(direction);
			fromSize = size;
			fromReserve = reserve;
			fromFocusAmount = focusAmount;
			elapsed = 0;
		},
		get focusAmount() {
			return focusAmount;
		},
		get pending() {
			return elapsed < 0.85;
		},
		update(
			dt: number,
			options: SpatialOptions,
			focus: Vector3 | undefined,
			bounds: SceneEnvelope,
			reduced: boolean,
		) {
			elapsed = reduced ? 1 : Math.min(1, elapsed + dt);
			const x = Math.min(1, elapsed / 0.85);
			const blend = x * x * x * (x * (6 * x - 15) + 10);
			const aspect = width / Math.max(1, height);
			const tilt =
				focus || options.view === "top"
					? 0
					: 1.5 * Math.max(0, Math.min(1, (aspect - 0.8) / 0.8));
			center.copy(fromCenter).lerp(focus ?? origin, blend);
			targetDirection.set(0, -tilt, 1).normalize();
			direction.copy(fromDirection).lerp(targetDirection, blend).normalize();
			const targetReserve = focus ? Math.min(280, width * 0.45) + 24 : 0;
			reserve = fromReserve + (targetReserve - fromReserve) * blend;
			focusAmount =
				fromFocusAmount + ((focus ? 1 : 0) - fromFocusAmount) * blend;
			const laneAspect = Math.max(0.1, (width - reserve) / Math.max(1, height));
			const halfX =
				Math.max(1, focus ? bounds.focusRadius : bounds.x) * padding;
			const halfY =
				Math.max(
					1,
					focus
						? bounds.focusRadius
						: bounds.y * direction.z + bounds.z * Math.abs(direction.y),
				) * padding;
			const targetSize = Math.max(halfY, halfX / laneAspect);
			size = fromSize + (targetSize - fromSize) * blend;
			const shift = (size * aspect * reserve) / width;
			camera.left = -size * aspect + shift;
			camera.right = size * aspect + shift;
			camera.top = size;
			camera.bottom = -size;
			camera.position.copy(center).addScaledVector(direction, 40);
			camera.up.set(0, 1, 0);
			camera.lookAt(center);
			camera.updateProjectionMatrix();
			camera.updateMatrixWorld();
			return blend;
		},
	};
}
