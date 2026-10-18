import { OrthographicCamera, Vector3, Group } from "three";
import { expect, test, vi } from "vitest";
import { createCameraController } from "./camera";
import { fitEnvelope } from "./placement";
import { defaultSpatialOptions } from "../options";
test("portrait fits core placement and focus ends in the adopted oblique view", () => {
	const camera = new OrthographicCamera(-15, 15, 15, -15, 0.1, 100),
		view = createCameraController(camera),
		bounds = { x: 13, y: 13, z: 1, focusRadius: 1.8 };
	view.resize(390, 844);
	view.update(0, defaultSpatialOptions, undefined, bounds, true);
	expect(camera.right).toBeCloseTo(13 * 1.045);
	view.begin();
	const focus = new Vector3(6, 0, 0);
	view.update(0.4, defaultSpatialOptions, focus, bounds, false);
	expect(view.pending).toBe(true);
	view.update(0.5, defaultSpatialOptions, focus, bounds, false);
	expect(view.pending).toBe(false);
	expect(view.focusAmount).toBe(1);
	const direction = camera.position.clone().sub(focus).normalize();
	expect(direction.distanceTo(new Vector3(4, -6, 5).normalize())).toBeLessThan(
		1e-10,
	);
	expect(focus.clone().project(camera).x).toBeLessThan(0);
	view.begin();
	view.update(0.4, defaultSpatialOptions, undefined, bounds, false);
	expect(view.focusAmount).toBeGreaterThan(0);
	view.update(0, defaultSpatialOptions, undefined, bounds, true);
	expect(view.focusAmount).toBe(0);
});
test("diffusion 0 to 500 never changes the projection in wide or focused views", () => {
	const boundsFn = vi.fn((scatter: number) => ({
			radius: scatter ? 30 : 1,
			depth: 1,
		})),
		entries = [
			{
				item: {
					id: "cpu",
					label: "CPU",
					model: "cpu",
					position: [6, 0, 0] as const,
					state: {
						health: "healthy" as const,
						activity: "working" as const,
						stale: false,
					},
				},
				model: {
					object: new Group(),
					bounds: boundsFn,
					update() {},
					dispose() {},
				},
			},
		];
	for (const selected of [null, "cpu"]) {
		const camera = new OrthographicCamera(-15, 15, 15, -15, 0.1, 100),
			view = createCameraController(camera),
			bounds = { x: 0, y: 0, z: 0, focusRadius: 0 };
		view.resize(1280, 720);
		let before: number[] | undefined;
		for (const scatter of [0, 100, 350, 500]) {
			fitEnvelope(
				entries,
				{ ...defaultSpatialOptions, scatter },
				selected,
				bounds,
			);
			view.update(
				0,
				defaultSpatialOptions,
				selected ? new Vector3(6, 0, 0) : undefined,
				bounds,
				true,
			);
			if (before) expect(camera.projectionMatrix.elements).toEqual(before);
			else before = camera.projectionMatrix.elements.slice();
		}
	}
	expect(boundsFn.mock.calls.every(([scatter]) => scatter === 0)).toBe(true);
});
test("top-view preference stays available and core envelope fits wide view", () => {
	const camera = new OrthographicCamera(-15, 15, 15, -15, 0.1, 100),
		view = createCameraController(camera),
		bounds = { x: 12, y: 12, z: 1, focusRadius: 1.8 };
	view.resize(2048, 862);
	view.update(
		0,
		{ ...defaultSpatialOptions, view: "top" },
		undefined,
		bounds,
		true,
	);
	for (const x of [-12, 12])
		for (const y of [-12, 12]) {
			const p = new Vector3(x, y, 0).project(camera);
			expect(Math.abs(p.x)).toBeLessThan(1);
			expect(Math.abs(p.y)).toBeLessThan(1);
		}
});
