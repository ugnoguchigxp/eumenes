import { sseFrame, sseResponse, sseStream } from "../sse";

export type Listener = { data(bytes: Uint8Array): void; end(): void };

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
	return sseResponse(
		sseStream({
			signal,
			highWaterMark: 64,
			lagging: "disconnect",
			heartbeatMs,
			open(sink) {
				const listener: Listener = {
					data: (bytes) =>
						sink.send(
							sseFrame({
								event: "output",
								data: Buffer.from(bytes).toString("base64"),
							}),
						),
					end: () => sink.end(sseFrame({ event: "exit", data: "{}" })),
				};
				if (session.backlog.length)
					listener.data(Buffer.concat(session.backlog));
				if (session.status !== "running") listener.end();
				else session.listeners.add(listener);
				return () => session.listeners.delete(listener);
			},
		}),
	);
}
