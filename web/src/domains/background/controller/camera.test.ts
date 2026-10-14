import { OrthographicCamera, Vector3 } from "three";
import { expect, test } from "vitest";
import { createCameraController } from "./camera";
import { defaultSpatialOptions } from "../options";

test("portrait framing fits the full expanded scene and focus transitions end in a top view", () => {
	const camera = new OrthographicCamera(-15, 15, 15, -15, 0.1, 100);
	const view = createCameraController(camera);
	view.resize(390, 844);
	view.update(
		0,
		{ ...defaultSpatialOptions, scatter: 200 },
		undefined,
		8.4,
		false,
	);
	expect(camera.right).toBeGreaterThan(19);
	view.begin();
	const focus = new Vector3(6, 0, 0);
	view.update(0.4, defaultSpatialOptions, focus, 8.4, false);
	expect(view.pending).toBe(true);
	view.update(0.5, defaultSpatialOptions, focus, 8.4, false);
	expect(view.pending).toBe(false);
	expect(view.focusAmount).toBe(1);
	expect(camera.position.y).toBeCloseTo(focus.y);
	expect(camera.position.z).toBeCloseTo(40);
	expect(focus.clone().project(camera).x).toBeLessThan(0);
	view.begin();
	view.update(0.4, defaultSpatialOptions, undefined, 8.4, false);
	expect(view.focusAmount).toBeGreaterThan(0);
	expect(view.focusAmount).toBeLessThan(1);
	view.update(0, defaultSpatialOptions, undefined, 8.4, true);
	expect(view.focusAmount).toBe(0);
	expect(view.pending).toBe(false);
});
