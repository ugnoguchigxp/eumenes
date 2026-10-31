import { sessionSchema } from "../api/domains/shell/contracts";
import { callJson, json, type Transport } from "./transport";

type Size = { cols: number; rows: number };
const path = (id: string) => `/api/shell/sessions/${encodeURIComponent(id)}`;

export function shellClient(transport: Transport) {
	return {
		startShell: async (input: { title?: string } & Size) =>
			callJson(transport, sessionSchema, "/api/shell/sessions", json(input)),
		restartShell: async (id: string, size: Size) =>
			callJson(transport, sessionSchema, `${path(id)}/restart`, json(size)),
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
