let clients = 0;
/** Bounded latest snapshots recover bursts and reconnects without a second ledger. */
export function snapshotStream<T>(
	subscribe: (listener: (value: T) => void) => () => void,
	terminal: (value: T) => boolean,
	signal: AbortSignal,
) {
	if (clients >= 32) throw new Error("stream_capacity");
	clients++;
	const encoder = new TextEncoder();
	let stop: () => void = () => {},
		heartbeat: ReturnType<typeof setInterval> | undefined,
		closed = false,
		pending: Uint8Array | undefined,
		final = false;
	let controller: ReadableStreamDefaultController<Uint8Array>;
	const cleanup = () => {
		if (closed) return;
		closed = true;
		clients--;
		stop();
		clearInterval(heartbeat);
		signal.removeEventListener("abort", abort);
	};
	const end = () => {
		try {
			controller.close();
		} catch {
			/* already closed */
		}
	};
	const abort = () => {
		cleanup();
		end();
	};
	const flush = () => {
		if (closed || !pending || (controller.desiredSize ?? 0) <= 0) return;
		const next = pending;
		pending = undefined;
		controller.enqueue(next);
		if (final) {
			cleanup();
			end();
		}
	};
	return new ReadableStream<Uint8Array>(
		{
			start(next) {
				controller = next;
				signal.addEventListener("abort", abort, { once: true });
				stop = subscribe((value) => {
					if (closed) return;
					pending = encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
					final = terminal(value);
					flush();
				});
				if (closed) {
					stop();
					return;
				}
				heartbeat = setInterval(() => {
					if (!closed && !pending && (controller.desiredSize ?? 0) > 0)
						controller.enqueue(encoder.encode(": heartbeat\n\n"));
				}, 15000);
				if (signal.aborted) abort();
			},
			pull: flush,
			cancel: cleanup,
		},
		{ highWaterMark: 4 },
	);
}
