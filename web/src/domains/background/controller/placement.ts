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
