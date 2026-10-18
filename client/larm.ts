import { statusResponseSchema } from "../api/domains/larm/contracts";
import type { Transport } from "./transport";
export function larmClient(transport: Transport) {
	return {
		identity: transport.identity,
		async screenPresence(
			id: string,
			revision: number,
			active: boolean,
			sentAt: number,
			signal?: AbortSignal,
		) {
			await transport.call(`/api/inference/screen/${encodeURIComponent(id)}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ revision, active, sentAt }),
				keepalive: true,
				signal,
			});
		},
		status: async () =>
			statusResponseSchema.parse(
				await (await transport.call("/api/status")).json(),
			),
		connectLarm: async () =>
			statusResponseSchema.parse(
				await (
					await transport.call("/api/larm/connect", { method: "POST" })
				).json(),
			),
	};
}
