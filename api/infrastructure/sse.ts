/** Headers of every server-sent event stream: never cached, never buffered by a proxy. */
export const SSE_HEADERS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-store",
	"X-Accel-Buffering": "no",
} as const;

/** The server's keep-alive; a client counts three missing ones as a half-open link. */
const SSE_HEARTBEAT_MS = 15_000;
const HEARTBEAT = ": heartbeat\n\n";

/** One event: `id` and `event` only when given, then its data line. */
export function sseFrame(fields: {
	id?: string;
	event?: string;
	data: string;
}): string {
	return `${fields.id === undefined ? "" : `id: ${fields.id}\n`}${fields.event === undefined ? "" : `event: ${fields.event}\n`}data: ${fields.data}\n\n`;
}

export type SseSink = {
	/** Queues a frame. */
	send(frame: string): void;
	/** Queues a last frame (when given) and ends the stream. */
	end(frame?: string): void;
};

/**
 * One server-sent event stream: heartbeats, the client's abort and an end that runs once.
 * `lagging` is what a client that cannot keep up gets:
 * - `disconnect`: its stream ends, so it reads the state again (a last frame is still queued);
 * - `latest`: only the newest frame is kept until it can take it, and heartbeats wait.
 * `open` subscribes; the function it returns unsubscribes whenever the stream ends.
 */
export function sseStream(options: {
	signal: AbortSignal;
	highWaterMark: number;
	lagging: "disconnect" | "latest";
	heartbeatMs?: number;
	open(sink: SseSink): (() => void) | void;
}): ReadableStream<Uint8Array> {
	const { signal } = options;
	const encoder = new TextEncoder();
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let ended = false;
	let unsubscribe: (() => void) | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let pending: string | undefined;
	let last = false;
	const cleanup = () => {
		if (ended) return;
		ended = true;
		clearInterval(heartbeat);
		signal.removeEventListener("abort", close);
		unsubscribe?.();
	};
	function close() {
		if (ended) return;
		cleanup();
		try {
			controller.close();
		} catch {
			/* already closed */
		}
	}
	const room = () => (controller.desiredSize ?? 0) > 0;
	const flush = () => {
		if (ended || pending === undefined || !room()) return;
		// Taken before enqueueing: enqueue may call `pull` (this function) again at once.
		const frame = pending;
		pending = undefined;
		controller.enqueue(encoder.encode(frame));
		if (last) close();
	};
	const sink: SseSink =
		options.lagging === "disconnect"
			? {
					send(frame) {
						if (ended) return;
						// Disconnect a slow client rather than retaining unbounded frames.
						if (!room()) close();
						else controller.enqueue(encoder.encode(frame));
					},
					end(frame) {
						if (ended) return;
						if (frame !== undefined) controller.enqueue(encoder.encode(frame));
						close();
					},
				}
			: {
					send(frame) {
						if (ended) return;
						// The newest frame decides: a later one that is not the last keeps the stream open.
						pending = frame;
						last = false;
						flush();
					},
					end(frame) {
						if (ended) return;
						if (frame === undefined) return close();
						pending = frame;
						last = true;
						flush();
					},
				};
	return new ReadableStream<Uint8Array>(
		{
			start(next) {
				controller = next;
				if (signal.aborted) return close();
				signal.addEventListener("abort", close, { once: true });
				try {
					const stop = options.open(sink);
					if (stop) {
						// The subscription may have ended the stream before it returned.
						if (ended) stop();
						else unsubscribe = stop;
					}
				} catch (error) {
					cleanup();
					controller.error(error);
					return;
				}
				if (ended) return;
				heartbeat = setInterval(() => {
					if (options.lagging === "disconnect") sink.send(HEARTBEAT);
					else if (pending === undefined && room())
						controller.enqueue(encoder.encode(HEARTBEAT));
				}, options.heartbeatMs ?? SSE_HEARTBEAT_MS);
				(heartbeat as { unref?: () => void }).unref?.();
			},
			pull: flush,
			cancel: cleanup,
		},
		{ highWaterMark: options.highWaterMark },
	);
}

/** The stream as an HTTP response with the event stream headers. */
export const sseResponse = (body: ReadableStream<Uint8Array>) =>
	new Response(body, { headers: SSE_HEADERS });
