import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { DialogueService } from "../../dialogue";
import type { Speech } from "./speech-state";
import { get, update } from "../repository";

/**
 * Commit the existing player's acknowledgement before releasing an operation gate. The last clause of a finished
 * answer tells the conversation that the answer was heard in full.
 */
export async function recordPlayed(
	store: SqliteStore,
	dialogue: Pick<DialogueService, "recordHeardInTransaction">,
	audio: Map<string, Speech>,
	id: string,
	index: number,
	clock: () => string,
) {
	const state = audio.get(id);
	if (!state?.chunks.has(index)) return;
	const recorded = await store.write((db) => {
		const chunk = state.chunks.get(index);
		const current = get(db, id);
		if (
			!chunk ||
			!current ||
			!["responding", "synthesizing", "ready"].includes(current.status)
		)
			return false;
		state.chunks.delete(index);
		const done = state.finished && !state.chunks.size;
		const applied = update(
			db,
			id,
			current.revision,
			done ? "played" : current.status,
			clock(),
		);
		if (!applied) {
			state.chunks.set(index, chunk);
			return false;
		}
		state.played.push(chunk.text);
		// A clause given up on was never heard: the answer reached the user only in part.
		if (done && current.runId)
			dialogue.recordHeardInTransaction(
				db,
				current.runId,
				state.skipped > 0 ? "partial" : "full",
				state.skipped > 0 ? state.played.join("") : undefined,
			);
		return true;
	});
	if (!recorded) return;
	state.markPlayed(index);
	state.wake();
	if (state.finished && !state.chunks.size) audio.delete(id);
}

/**
 * Cancels a turn (`cancel`) and records how far its stopped answer reached the user: only as far as it was played.
 * What was played is read before the cancel (which keeps its place among the writes) and recorded after it. False
 * when the turn is unknown.
 */
export async function cancelHeard(
	store: SqliteStore,
	dialogue: Pick<DialogueService, "recordHeardInTransaction">,
	audio: Map<string, Speech>,
	id: string,
	cancel: () => Promise<unknown>,
): Promise<boolean> {
	const turn = store.read((db) => get(db, id));
	if (!turn) return false;
	const { runId } = turn;
	const speaking = !!runId && ["synthesizing", "ready"].includes(turn.status);
	const played = [...(audio.get(id)?.played ?? [])];
	await cancel();
	if (speaking)
		await store.write((db) =>
			dialogue.recordHeardInTransaction(
				db,
				runId,
				played.length ? "partial" : "none",
				played.join(""),
			),
		);
	return true;
}
