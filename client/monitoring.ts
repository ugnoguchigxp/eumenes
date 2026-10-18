import { monitoringSnapshotSchema } from "../api/domains/monitoring/contracts";
import type { Transport } from "./transport";

export function monitoringClient(transport: Transport) {
	return {
		monitoringSnapshot: async (signal?: AbortSignal) =>
			monitoringSnapshotSchema.parse(
				await (
					await transport.call("/api/monitoring/snapshot", { signal })
				).json(),
			),
	};
}
