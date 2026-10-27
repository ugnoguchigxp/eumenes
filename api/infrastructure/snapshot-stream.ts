import { sseFrame, sseStream } from "./sse";

let clients = 0;
/** Bounded latest snapshots recover bursts and reconnects without a second ledger. */
export function snapshotStream<T>(
	subscribe: (listener: (value: T) => void) => () => void,
	terminal: (value: T) => boolean,
	signal: AbortSignal,
) {
	if (clients >= 32) throw new Error("stream_capacity");
	// An aborted request never subscribes (the stream closes at once), so it is not counted.
	let counted = !signal.aborted;
	if (counted) clients++;
	const release = () => {
		if (!counted) return;
		counted = false;
		clients--;
	};
	return sseStream({
		signal,
		highWaterMark: 4,
		lagging: "latest",
		open(sink) {
			let stop: () => void;
			try {
				stop = subscribe((value) => {
					const frame = sseFrame({ data: JSON.stringify(value) });
					if (terminal(value)) sink.end(frame);
					else sink.send(frame);
				});
			} catch (error) {
				release();
				throw error;
			}
			return () => {
				stop();
				release();
			};
		},
	});
}
