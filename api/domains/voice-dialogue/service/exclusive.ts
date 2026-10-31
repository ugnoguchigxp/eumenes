import type { Database } from "bun:sqlite";
import { get, update } from "../repository";
/** The responder may bind only the generation still owning the microphone turn. */
export function linkVoiceRun(
	db: Database,
	id: string,
	runId: string,
	sessions: ReadonlyMap<string, number>,
	at: string,
) {
	const current = get(db, id);
	if (
		!current ||
		current.status !== "responding" ||
		sessions.get(current.sessionId) !== current.generation
	)
		throw new Error("voice_turn_inactive");
	if (current.runId === runId) return;
	if (!update(db, id, current.revision, "responding", at, { runId }))
		throw new Error("voice_turn_inactive");
}
/** Switching voice frontends releases all legacy generations and pending playback. */
export async function pauseLegacy(
	sessions: ReadonlyMap<string, number>,
	stop: (id: string, generation: number) => Promise<unknown>,
	controllers: ReadonlyMap<string, AbortController>,
	warming: ReadonlyMap<string, AbortController>,
	audio: ReadonlyMap<string, { wake: () => void }>,
) {
	const generations = Array.from(sessions);
	for (const [id, generation] of generations) await stop(id, generation);
	for (const c of controllers.values()) c.abort();
	for (const c of warming.values()) c.abort();
	for (const a of audio.values()) a.wake();
}
