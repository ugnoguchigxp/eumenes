import type { MonitoringSnapshot } from "../../../../api/domains/monitoring/contracts";
import { initialSpatialItems, type SpatialItem } from "../background";
import { monitoringDetails } from "./details";
import { displayStale, STALE_AFTER_MS } from "./freshness";
export { STALE_AFTER_MS } from "./freshness";

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
		const observations = item.state.observations;
		const stale = displayStale(snapshot!, item, ageMs, failed);
		const observed = observations?.flatMap((o) =>
			o.observedAt === null ? [] : [o.observedAt],
		);
		const health =
			item.state.faultRemainingMs !== undefined &&
			ageMs >= item.state.faultRemainingMs
				? (item.state.settledHealth ?? item.state.health)
				: item.state.health;
		const details = monitoringDetails(
			item.state,
			observations ? snapshot!.larm : undefined,
		);
		return {
			...layout,
			id: item.id,
			label: item.label,
			state: {
				health,
				activity: item.state.activity,
				stale,
				...(item.state.utilization === undefined
					? {}
					: { utilization: item.state.utilization }),
				source: item.state.service
					? "activity"
					: observations && !observed?.length
						? "unconfirmed"
						: "measurement",
				...(item.state.service
					? { checkedAt: snapshot!.observedAt }
					: observations
						? observed?.length
							? { observedAt: Math.min(...observed) }
							: {}
						: { observedAt: snapshot!.observedAt }),
				...(details.length ? { details } : {}),
			},
		};
	});
}
