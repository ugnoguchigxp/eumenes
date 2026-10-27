import {
	sseFrame,
	sseResponse,
	sseStream,
	type SseSink,
} from "../infrastructure/sse";

// State invalidations only: snapshots remain authoritative in the existing APIs.
export function createChanges(
	options: {
		debounceMs?: number;
		heartbeatMs?: number;
		maxClients?: number;
	} = {},
) {
	const session = crypto.randomUUID();
	let revision = 0;
	let closed = false;
	let pending: ReturnType<typeof setTimeout> | undefined;
	const clients = new Set<SseSink>();
	const frame = (event: string) =>
		sseFrame({ id: `${session}:${revision}`, event, data: "{}" });
	return {
		publish() {
			if (closed || pending) return;
			pending = setTimeout(() => {
				pending = undefined;
				revision++;
				for (const client of clients) client.send(frame("change"));
			}, options.debounceMs ?? 100);
			pending.unref?.();
		},
		open(signal: AbortSignal, lastEventId?: string): Response {
			if (closed || clients.size >= (options.maxClients ?? 32))
				return Response.json(
					{ error: "event_stream_unavailable" },
					{ status: 503 },
				);
			return sseResponse(
				sseStream({
					signal,
					highWaterMark: 16,
					// Disconnect slow clients rather than retaining unbounded notifications.
					lagging: "disconnect",
					heartbeatMs: options.heartbeatMs,
					open(client) {
						clients.add(client);
						// Resnapshot unless the client proves it saw this session's latest revision.
						if (lastEventId === `${session}:${revision}`)
							client.send(frame("resumed"));
						else client.send(frame("reset"));
						return () => clients.delete(client);
					},
				}),
			);
		},
		close() {
			closed = true;
			clearTimeout(pending);
			for (const client of clients) client.end();
		},
	};
}
export type Changes = ReturnType<typeof createChanges>;
