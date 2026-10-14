import { OrthographicCamera, Vector3 } from "three";
import type { SpatialOptions } from "../options";

export function createCameraController(camera: OrthographicCamera) {
	const center = new Vector3();
	const direction = new Vector3(0, -0.55, 1).normalize();
	const fromCenter = center.clone(),
		fromDirection = direction.clone();
	let size = 15,
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
			wideExtent: number,
			reduced: boolean,
		) {
			elapsed = reduced ? 1 : Math.min(1, elapsed + dt);
			const x = Math.min(1, elapsed / 0.85);
			const blend = x * x * x * (x * (6 * x - 15) + 10);
			const target = focus ?? new Vector3();
			center.copy(fromCenter).lerp(target, blend);
			direction
				.copy(fromDirection)
				.lerp(
					new Vector3(
						0,
						focus || options.view === "top" ? 0 : -0.55,
						1,
					).normalize(),
					blend,
				)
				.normalize();
			const reach = 1.1 * (1 + (4.6 * options.scatter) / 100);
			const targetSize = focus
				? Math.max(2.85, reach * 1.2 + 0.3)
				: Math.max(10, wideExtent + reach * 1.05 + 0.55);
			size = fromSize + (targetSize - fromSize) * blend;
			const aspect = width / Math.max(1, height);
			const targetReserve = focus ? Math.min(280, width * 0.45) + 24 : 0;
			reserve = fromReserve + (targetReserve - fromReserve) * blend;
			focusAmount =
				fromFocusAmount + ((focus ? 1 : 0) - fromFocusAmount) * blend;
			const halfY = Math.max(
				size,
				size / Math.max(0.1, (width - reserve) / Math.max(1, height)),
			);
			const shift = (halfY * aspect * reserve) / width;
			camera.left = -halfY * aspect + shift;
			camera.right = halfY * aspect + shift;
			camera.top = halfY;
			camera.bottom = -halfY;
			camera.position.copy(center).addScaledVector(direction, 40);
			camera.up.set(0, 1, 0);
			camera.lookAt(center);
			camera.updateProjectionMatrix();
			camera.updateMatrixWorld();
			return blend;
		},
	};
}
