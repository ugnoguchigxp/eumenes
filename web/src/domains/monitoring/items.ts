import type { MonitoringSnapshot } from "../../../../api/domains/monitoring/contracts";
import { initialSpatialItems, type SpatialItem } from "../background";

/** Three missed one-minute reads make an observation old (spec §3). */
export const STALE_AFTER_MS = 3 * 60_000;

/**
 * Snapshot items placed on the Spatial layout by shape. Before the first read nothing is
 * known, so the background keeps its unconfirmed samples (undefined). A failed read
 * means the backend did not answer: it is disconnected and every other item is old.
 * `ageMs` is measured on this device's clock since the snapshot arrived (no clock skew).
 */
export function monitoringItems(
	snapshot: MonitoringSnapshot | undefined,
	failed: boolean,
	ageMs: number,
): readonly SpatialItem[] | undefined {
	if (!snapshot && !failed) return undefined;
	const old = failed || !snapshot || ageMs > STALE_AFTER_MS;
	return initialSpatialItems.map((layout) => {
		const item = snapshot?.items.find(
			(i) =>
				i.shape === (layout.model === "backend" ? "network" : layout.model),
		);
		if (layout.model === "backend" && failed)
			return {
				...layout,
				id: item?.id ?? layout.id,
				label: item?.label ?? "Eumenes Backend",
				state: {
					health: "disconnected",
					activity: "idle",
					stale: true,
					source: "measurement",
				},
			};
		if (!item) return { ...layout, state: { ...layout.state, stale: old } };
		return {
			...layout,
			id: item.id,
			label: item.label,
			state: {
				health: item.state.health,
				activity: item.state.activity,
				stale: old,
				...(item.state.utilization === undefined
					? {}
					: { utilization: item.state.utilization }),
				source: "measurement",
				observedAt: snapshot!.observedAt,
			},
		};
	});
}
