export type Listener = { data(bytes: Uint8Array): void; end(): void };

const encoder = new TextEncoder();
const frame = (event: string, data: string) =>
	encoder.encode(`event: ${event}\ndata: ${data}\n\n`);

/**
 * Server-sent events of one session: `output` frames carry base64 PTY bytes (the backlog first),
 * `exit` ends a run. A client that cannot keep up is disconnected rather than buffered; ending
 * without an `exit` frame tells it to read the session again.
 */
export function outputStream(
	session: {
		status: "running" | "exited";
		backlog: Uint8Array[];
		listeners: Set<Listener>;
	},
	signal: AbortSignal,
	heartbeatMs: number,
): Response {
	let cleanup = () => {};
	const body = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				let ended = false;
				const drop = () => {
					if (ended) return;
					cleanup();
					controller.close();
				};
				const send = (chunk: Uint8Array) => {
					if (ended) return;
					if ((controller.desiredSize ?? 0) <= 0) drop();
					else controller.enqueue(chunk);
				};
				const listener: Listener = {
					data: (bytes) =>
						send(frame("output", Buffer.from(bytes).toString("base64"))),
					end() {
						if (ended) return;
						controller.enqueue(frame("exit", "{}"));
						drop();
					},
				};
				const heartbeat = setInterval(
					() => send(encoder.encode(": heartbeat\n\n")),
					heartbeatMs,
				);
				heartbeat.unref?.();
				cleanup = () => {
					ended = true;
					clearInterval(heartbeat);
					session.listeners.delete(listener);
					signal.removeEventListener("abort", drop);
				};
				signal.addEventListener("abort", drop, { once: true });
				if (session.backlog.length)
					listener.data(Buffer.concat(session.backlog));
				if (signal.aborted) drop();
				else if (session.status !== "running") listener.end();
				else session.listeners.add(listener);
			},
			cancel() {
				cleanup();
			},
		},
		{ highWaterMark: 64 },
	);
	return new Response(body, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-store",
			"X-Accel-Buffering": "no",
		},
	});
}
