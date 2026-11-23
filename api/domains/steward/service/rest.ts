import type { Database } from "bun:sqlite";
import type { StewardDeps } from "./types";

/** The time of the user's newest utterance in the conversation; null when there is none. */
function lastUserMs(
	db: Database,
	deps: StewardDeps,
	conversationId: string,
): number | null {
	const { conversation } = deps;
	const ordinal = conversation.nthLatestUserOrdinalInTransaction(
		db,
		conversationId,
		1,
	);
	if (ordinal <= 0) return null;
	const found = conversation.messagesAfterInTransaction(
		db,
		conversationId,
		ordinal - 1,
		1,
	)[0];
	return found ? Date.parse(found.message.createdAt) : null;
}

/**
 * Whether the conversations rest: no run is going in any of them and the user's last utterance is past the
 * interval they chose (`deps.restMs`). `restAt` is when they will, when only time is missing; a conversation with
 * a run going has none (the run's end kicks the steward again).
 */
export function restOf(
	db: Database,
	deps: StewardDeps,
	conversationIds: readonly string[],
): { rested: boolean; restAt: number | null } {
	const now = deps.nowMs();
	const restMs = deps.restMs();
	let restAt = now;
	for (const id of conversationIds) {
		if (deps.foregroundActive(db, id)) return { rested: false, restAt: null };
		const last = lastUserMs(db, deps, id);
		if (last !== null) restAt = Math.max(restAt, last + restMs);
	}
	return { rested: restAt <= now, restAt: restAt > now ? restAt : null };
}
