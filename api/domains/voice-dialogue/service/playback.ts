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
	audible = true,
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
		const done = state.finished && state.chunks.size === 1;
		const applied = update(
			db,
			id,
			current.revision,
			done ? "played" : current.status,
			clock(),
		);
		if (!applied) return false;
		const played = [
			...state.played,
			...(audible ? [{ index, text: chunk.text }] : []),
		].sort((a, b) => a.index - b.index);
		// A clause given up on was never heard: the answer reached the user only in part.
		if (done && current.runId)
			dialogue.recordHeardInTransaction(
				db,
				current.runId,
				state.skipped > 0 || !audible
					? played.length
						? "partial"
						: "none"
					: "full",
				state.skipped > 0 || !audible
					? played.map((part) => part.text).join("")
					: undefined,
			);
		return played;
	});
	if (!recorded) return;
	// The transaction (including COMMIT) succeeded. Apply before the next serialized writer can run.
	state.chunks.delete(index);
	state.played = recorded;
	if (!audible) state.skipped++;
	state.markPlayed(index);
	state.wake();
	if (state.finished && !state.chunks.size) audio.delete(id);
}

/**
 * Cancels a turn (`cancel`) and records how far its stopped answer reached the user: only as far as it was played.
 * Keep the speech handle across cancellation, then read the played part after the cancel's writer turn. Earlier
 * queued acknowledgements are included; later ones cannot change a cancelled turn. False when unknown.
 */
export async function cancelHeard(
	store: SqliteStore,
	dialogue: Pick<DialogueService, "recordHeardInTransaction">,
	audio: Map<string, Speech>,
	id: string,
	cancel: () => Promise<boolean>,
): Promise<boolean> {
	const turn = store.read((db) => get(db, id));
	if (!turn) return false;
	const { runId } = turn;
	const speaking =
		!!runId && ["responding", "synthesizing", "ready"].includes(turn.status);
	const speech = audio.get(id);
	const cancelled = await cancel();
	const played = [...(speech?.played ?? [])];
	if (cancelled && speaking)
		await store.write((db) =>
			dialogue.recordHeardInTransaction(
				db,
				runId,
				played.length ? "partial" : "none",
				played.map((part) => part.text).join(""),
			),
		);
	return true;
}
