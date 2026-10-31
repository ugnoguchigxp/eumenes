import type {
	MonitoringItem,
	MonitoringSnapshot,
} from "../../../../api/domains/monitoring/contracts";

/** Three missed one-minute reads, shared with the original host monitoring policy. */
export const STALE_AFTER_MS = 3 * 60_000;

/** Display the last valid sample between polls without changing the upstream quality or time. */
export function displayStale(
	snapshot: MonitoringSnapshot,
	item: MonitoringItem,
	elapsed: number,
	failed: boolean,
) {
	if (failed || elapsed > STALE_AFTER_MS) return true;
	const observations = item.state.observations;
	if (!observations) return !!item.state.stale;
	const remote = snapshot.larm;
	const receivedAt = remote?.snapshotReceivedAt;
	const sinceReceipt =
		receivedAt === undefined
			? 0
			: Math.max(0, snapshot.observedAt - receivedAt);
	if (
		remote &&
		(remote.snapshotStatus.status !== "ok" ||
			remote.eventsStatus.status === "epoch_mismatch" ||
			(remote.snapshot && remote.bootEpoch !== remote.snapshot.bootEpoch))
	)
		return true;
	if (sinceReceipt + elapsed > STALE_AFTER_MS) return true;
	return (
		observations.some(
			(o) =>
				o.status === "stale" ||
				(o.observedAt !== null &&
					(o.ageMs - sinceReceipt > o.maxAgeMs ||
						(remote?.snapshot &&
							o.observedAt > Date.parse(remote.snapshot.generatedAt)))),
		) ||
		(!remote && !!item.state.stale)
	);
}
