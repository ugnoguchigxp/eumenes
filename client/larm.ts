import type { Transport } from "./transport";
export function larmClient(transport: Transport) {
	return {
		identity: transport.identity,
		status: async () =>
			(await (await transport.call("/api/status")).json()) as {
				service: string;
				larm: { state: string; capabilities: string[]; error?: string };
			},
	};
}
export type LarmClient = ReturnType<typeof larmClient>;
