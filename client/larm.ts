import { statusResponseSchema } from "../api/domains/larm/contracts";
import { callJson, json, type Transport } from "./transport";
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
				...json({ revision, active, sentAt }, "PUT"),
				keepalive: true,
				signal,
			});
		},
		status: async () =>
			callJson(transport, statusResponseSchema, "/api/status"),
		connectLarm: async () =>
			callJson(transport, statusResponseSchema, "/api/larm/connect", {
				method: "POST",
			}),
	};
}
