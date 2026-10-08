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
	const clients = new Set<{
		send: (frame: string) => void;
		close: () => void;
	}>();
	const frame = (event: string) =>
		`id: ${session}:${revision}\nevent: ${event}\ndata: {}\n\n`;
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
		open(signal: AbortSignal): Response {
			if (closed || clients.size >= (options.maxClients ?? 32))
				return Response.json(
					{ error: "event_stream_unavailable" },
					{ status: 503 },
				);
			let cleanup = () => {};
			const body = new ReadableStream<Uint8Array>(
				{
					start(controller) {
						let ended = false;
						const encoder = new TextEncoder();
						const client = {
							send(value: string) {
								if (ended) return;
								// Disconnect slow clients rather than retaining unbounded notifications.
								if ((controller.desiredSize ?? 0) <= 0) {
									client.close();
									return;
								}
								controller.enqueue(encoder.encode(value));
							},
							close() {
								if (ended) return;
								cleanup();
								controller.close();
							},
						};
						const heartbeat = setInterval(
							() => client.send(": heartbeat\n\n"),
							options.heartbeatMs ?? 15_000,
						);
						heartbeat.unref?.();
						cleanup = () => {
							ended = true;
							clearInterval(heartbeat);
							clients.delete(client);
							signal.removeEventListener("abort", client.close);
						};
						clients.add(client);
						signal.addEventListener("abort", client.close, { once: true });
						if (signal.aborted) client.close();
						// Always resnapshot on connect, including a missed range or server restart.
						else client.send(frame("reset"));
					},
					cancel() {
						cleanup();
					},
				},
				{ highWaterMark: 16 },
			);
			return new Response(body, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-store",
					"X-Accel-Buffering": "no",
				},
			});
		},
		close() {
			closed = true;
			clearTimeout(pending);
			for (const client of clients) client.close();
		},
	};
}
export type Changes = ReturnType<typeof createChanges>;
