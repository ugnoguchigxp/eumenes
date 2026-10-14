import { Vector3, type OrthographicCamera } from "three";
import type { SpatialItem, SpatialModel } from "../contracts";
import type { SpatialOptions } from "../options";
import type { SceneEnvelope } from "./camera";
type Entry = { item: SpatialItem; model: SpatialModel };

export function fitEnvelope(
	entries: Iterable<Entry>,
	settings: SpatialOptions,
	selected: string | null,
	envelope: SceneEnvelope,
) {
	envelope.x = envelope.y = envelope.z = 1;
	const core = Math.min(settings.core, settings.focusCore);
	for (const { item, model } of entries) {
		const bounds = model.bounds?.(settings.scatter, core) ?? {
			radius: 1.1 * (1 + (4.6 * settings.scatter) / 100),
			depth: 1.75,
		};
		envelope.x = Math.max(
			envelope.x,
			(item.orbit?.radius ?? Math.abs(item.position[0])) + bounds.radius,
		);
		envelope.y = Math.max(
			envelope.y,
			(item.orbit?.radius ?? Math.abs(item.position[1])) + bounds.radius,
		);
		envelope.z = Math.max(
			envelope.z,
			Math.abs(item.position[2]) + bounds.depth,
		);
		if (item.id === selected) envelope.focusRadius = bounds.radius;
	}
}

export function hitTestEntries(
	entries: Iterable<Entry>,
	camera: OrthographicCamera,
	rect: Pick<DOMRect, "width" | "height">,
	x: number,
	y: number,
) {
	const projected = new Vector3();
	let nearest: string | null = null,
		distance = Infinity;
	const radius = Math.max(
		12,
		(1.6 * rect.width) / (camera.right - camera.left),
	);
	for (const { item, model } of entries) {
		projected.copy(model.object.position).project(camera);
		const d = Math.hypot(
			((projected.x + 1) * rect.width) / 2 - x,
			((1 - projected.y) * rect.height) / 2 - y,
		);
		if (d < radius && d < distance) {
			nearest = item.id;
			distance = d;
		}
	}
	return nearest;
}
