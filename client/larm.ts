import { statusResponseSchema } from "../api/domains/larm/contracts";
import type { Transport } from "./transport";
export function larmClient(transport: Transport) {
	return {
		identity: transport.identity,
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
export type LarmClient = ReturnType<typeof larmClient>;
