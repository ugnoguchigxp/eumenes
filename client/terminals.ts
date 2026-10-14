import {
	terminalSessionViewSchema,
	terminalSessionsViewSchema,
} from "../api/domains/terminals/contracts";
import type { Transport } from "./transport";
import { json } from "./transport";

type Size = { cols: number; rows: number };
const path = (id: string) => `/api/terminals/${encodeURIComponent(id)}`;

export function terminalsClient(transport: Transport) {
	return {
		terminals: async (signal?: AbortSignal) =>
			terminalSessionsViewSchema.parse(
				await (await transport.call("/api/terminals", { signal })).json(),
			),
		startTerminal: async (input: { title?: string } & Size) =>
			terminalSessionViewSchema.parse(
				await (await transport.call("/api/terminals", json(input))).json(),
			),
		restartTerminal: async (id: string, size: Size) =>
			terminalSessionViewSchema.parse(
				await (await transport.call(`${path(id)}/restart`, json(size))).json(),
			),
		terminalInput: async (id: string, data: string) => {
			await transport.call(`${path(id)}/input`, json({ data }));
		},
		resizeTerminal: async (id: string, size: Size) => {
			await transport.call(`${path(id)}/resize`, json(size));
		},
		/** Server-sent events of the session's PTY output (`output` base64 frames, then `exit`). */
		terminalOutput: (id: string, signal: AbortSignal) =>
			transport.call(`${path(id)}/output`, { signal }),
	};
}
