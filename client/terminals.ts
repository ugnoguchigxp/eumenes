import {
	terminalSessionViewSchema,
	terminalSessionsViewSchema,
} from "../api/domains/terminals/contracts";
import { callJson, json, type Transport } from "./transport";

type Size = { cols: number; rows: number };
const path = (id: string) => `/api/terminals/${encodeURIComponent(id)}`;

export function terminalsClient(transport: Transport) {
	return {
		terminals: async (signal?: AbortSignal) =>
			callJson(transport, terminalSessionsViewSchema, "/api/terminals", {
				signal,
			}),
		startTerminal: async (input: { title?: string } & Size) =>
			callJson(
				transport,
				terminalSessionViewSchema,
				"/api/terminals",
				json(input),
			),
		restartTerminal: async (id: string, size: Size) =>
			callJson(
				transport,
				terminalSessionViewSchema,
				`${path(id)}/restart`,
				json(size),
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
