import type { z } from "zod";
import type { monitoringSnapshotSchema } from "../../larm/contracts";
import type { MonitoringItem } from "../contracts";

type Snapshot = z.infer<typeof monitoringSnapshotSchema>;
type Readiness = NonNullable<MonitoringItem["state"]["readiness"]>;

/** Only the producer's explicit runtime, health and load signals establish a warm model. */
export function runtimeReadiness(snapshot: Snapshot) {
	const counts = new Map<Readiness, number>();
	for (const runtime of snapshot.core.runtimes) {
		const status =
			runtime.status.status === "ok" ? runtime.status.value : undefined;
		const health =
			runtime.healthOk.status === "ok" ? runtime.healthOk.value : undefined;
		const load =
			runtime.modelLoadState.status === "ok"
				? runtime.modelLoadState.value
				: undefined;
		let readiness: Readiness = "unknown";
		if (status === "FAILED" || load === "failed") readiness = "failed";
		else if (status === "STOPPING") readiness = "stopping";
		else if (status === "STARTING" || load === "loading")
			readiness = "starting";
		else if (status === "COLD" || load === "unloaded") readiness = "cold";
		else if ((status === "HOT" || status === "BUSY") && health === true)
			readiness = load === "loaded" ? "warm_ready" : "ready";
		counts.set(readiness, (counts.get(readiness) ?? 0) + 1);
	}
	return [...counts].map(([readiness, count]) => ({ readiness, count }));
}
