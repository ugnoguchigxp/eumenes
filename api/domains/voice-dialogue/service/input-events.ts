import type { SqliteStore } from "../../../infrastructure/sqlite";
import { sseFrame, sseStream } from "../../../infrastructure/sse";
import { get } from "../repository";

/** A current snapshot and subsequent revisions, with no replay buffer or transcript logging. */
export function inputEvents(
	store: SqliteStore,
	id: string,
	signal: AbortSignal,
) {
	if (!store.read((db) => get(db, id)))
		throw new Error("voice_input_not_ready");
	return sseStream({
		signal,
		highWaterMark: 2,
		lagging: "latest",
		open(sink) {
			let revision = -1;
			const send = () => {
				const turn = store.read((db) => get(db, id));
				if (!turn) return sink.end();
				if (turn.revision <= revision) return;
				revision = turn.revision;
				const frame = sseFrame({ data: JSON.stringify(turn) });
				if (turn.status === "recognizing") sink.send(frame);
				else sink.end(frame);
			};
			const stop = store.onCommit(send);
			send();
			return stop;
		},
	});
}
