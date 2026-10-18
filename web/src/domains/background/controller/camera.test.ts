import { OrthographicCamera, Vector3 } from "three";
import { expect, test } from "vitest";
import { createCameraController } from "./camera";
import { defaultSpatialOptions } from "../options";

test("portrait framing zooms the expanded scene by 1.7x and focus transitions end in a top view", () => {
	const camera = new OrthographicCamera(-15, 15, 15, -15, 0.1, 100);
	const view = createCameraController(camera);
	const bounds = { x: 22, y: 22, z: 3, focusRadius: 6 };
	view.resize(390, 844);
	view.update(
		0,
		{ ...defaultSpatialOptions, scatter: 200 },
		undefined,
		bounds,
		false,
	);
	expect(camera.right).toBeCloseTo((22 * 1.045) / 1.7);
	view.begin();
	const focus = new Vector3(6, 0, 0);
	view.update(0.4, defaultSpatialOptions, focus, bounds, false);
	expect(view.pending).toBe(true);
	view.update(0.5, defaultSpatialOptions, focus, bounds, false);
	expect(view.pending).toBe(false);
	expect(view.focusAmount).toBe(1);
	expect(camera.position.y).toBeCloseTo(focus.y);
	expect(camera.position.z).toBeCloseTo(40);
	expect(focus.clone().project(camera).x).toBeLessThan(0);
	view.begin();
	view.update(0.4, defaultSpatialOptions, undefined, bounds, false);
	expect(view.focusAmount).toBeGreaterThan(0);
	expect(view.focusAmount).toBeLessThan(1);
	view.update(0, defaultSpatialOptions, undefined, bounds, true);
	expect(view.focusAmount).toBe(0);
	expect(view.pending).toBe(false);
});

test("wide fitting uses the projected axes and keeps the envelope zoomed by 1.7x inside the frustum", () => {
	const camera = new OrthographicCamera(-15, 15, 15, -15, 0.1, 100);
	const view = createCameraController(camera);
	view.resize(2048, 862);
	const bounds = { x: 15.9, y: 15.9, z: 2.32, focusRadius: 6 };
	view.update(0, defaultSpatialOptions, undefined, bounds, true);
	expect(camera.top).toBeLessThan(10);
	for (const x of [-bounds.x, bounds.x])
		for (const y of [-bounds.y, bounds.y])
			for (const z of [-bounds.z, bounds.z]) {
				const point = new Vector3(x, y, z).project(camera);
				expect(Math.abs(point.x) / 1.7).toBeLessThan(1);
				expect(Math.abs(point.y) / 1.7).toBeLessThan(1);
			}
	// The outermost dust leaves the frame.
	expect(
		Math.abs(new Vector3(0, bounds.y, bounds.z).project(camera).y),
	).toBeGreaterThan(1);
});
