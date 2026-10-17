import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { Speech } from "./speech-state";
import { get, update } from "../repository";

/** Commit the existing player's acknowledgement before releasing an operation gate. */
export async function recordPlayed(
	store: SqliteStore,
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
		const applied = update(
			db,
			id,
			current.revision,
			state.finished && !state.chunks.size ? "played" : current.status,
			clock(),
		);
		if (!applied) state.chunks.set(index, chunk);
		return applied;
	});
	if (!recorded) return;
	state.markPlayed(index);
	state.wake();
	if (state.finished && !state.chunks.size) audio.delete(id);
}
