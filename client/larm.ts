import type { LarmStatus } from "../api/domains/larm/contracts";
import type { Transport } from "./transport";
type Status = { service: string; larm: LarmStatus };
export function larmClient(transport: Transport) {
	return {
		identity: transport.identity,
		status: async () =>
			(await (await transport.call("/api/status")).json()) as Status,
		connectLarm: async () =>
			(await (
				await transport.call("/api/larm/connect", { method: "POST" })
			).json()) as Status,
	};
}
export type LarmClient = ReturnType<typeof larmClient>;
