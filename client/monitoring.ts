import { monitoringSnapshotSchema } from "../api/domains/monitoring/contracts";
import { callJson, type Transport } from "./transport";

export function monitoringClient(transport: Transport) {
	return {
		monitoringSnapshot: async (signal?: AbortSignal) =>
			callJson(
				transport,
				monitoringSnapshotSchema,
				"/api/monitoring/snapshot",
				{
					signal,
				},
			),
	};
}
