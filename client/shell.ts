import { sessionSchema, sessionsSchema } from "../api/domains/shell/contracts";
import type { Transport } from "./transport";
import { json } from "./transport";

type Size = { cols: number; rows: number };
const path = (id: string) => `/api/shell/sessions/${encodeURIComponent(id)}`;

export function shellClient(transport: Transport) {
	return {
		shellSessions: async (signal?: AbortSignal) =>
			sessionsSchema.parse(
				await (await transport.call("/api/shell/sessions", { signal })).json(),
			),
		startShell: async (input: { title?: string } & Size) =>
			sessionSchema.parse(
				await (await transport.call("/api/shell/sessions", json(input))).json(),
			),
		restartShell: async (id: string, size: Size) =>
			sessionSchema.parse(
				await (await transport.call(`${path(id)}/restart`, json(size))).json(),
			),
		shellInput: async (id: string, data: string) => {
			await transport.call(`${path(id)}/input`, json({ data }));
		},
		resizeShell: async (id: string, size: Size) => {
			await transport.call(`${path(id)}/resize`, json(size));
		},
		/** Server-sent events of the session's PTY output (`output` base64 frames, then `exit`). */
		shellOutput: (id: string, signal: AbortSignal) =>
			transport.call(`${path(id)}/output`, { signal }),
	};
}
