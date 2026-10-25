import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import {
	dot,
	unpackVector,
	vectorSpaceKey,
} from "../../../infrastructure/vector";
import type { ConversationService } from "../../conversation";
import type { MemoryVectorSpace, TurnRecall } from "../contracts";
import { isBlocked, latestTurnVectors } from "../repository";

/**
 * Exchanges and similarity of a search. Embeddings of unrelated texts often score high (multilingual-e5 dot
 * products are commonly 0.7 and above), so a hit must pass an absolute floor and also stay close to the best
 * hit. Both values await calibration against the live embedding model.
 */
export const RECALL_MIN_SCORE = 0.8;
/** A hit scoring more than this below the best one is not returned. */
const RECALL_RELATIVE_GATE = 0.05;
/** Candidates examined per search (each costs reading its exchange). */
const MAX_ATTEMPTS = 50;

export type RecallInput = {
	conversationId: string;
	space: MemoryVectorSpace;
	vector: ArrayLike<number>;
	/** Most exchanges returned. */
	limit: number;
	minScore: number;
	/** Messages to leave out (shown verbatim, or already found): an exchange containing one is skipped. */
	excludeMessageIds?: Iterable<string> | undefined;
};

/**
 * Earlier exchanges of a conversation that resemble `vector` (the steward's forget candidates). The vectors are
 * per message (user and assistant); a hit stands for its whole exchange (the run's input and adopted answer),
 * which is returned once. Scheduled prompts, blocked messages and messages whose text changed since they were
 * embedded are never returned. null when nothing qualifies.
 */
export function recallTurns(
	db: Database,
	conversation: ConversationService,
	input: RecallInput,
): TurnRecall | null {
	if (input.limit < 1) return null;
	const skipped = new Set(input.excludeMessageIds ?? []);
	const dimension = input.space.dimension;
	const scored: Array<{ messageId: string; digest: string; score: number }> =
		[];
	for (const row of latestTurnVectors(
		db,
		input.conversationId,
		vectorSpaceKey(input.space),
	)) {
		// Left-out messages are skipped here so they do not use up the attempts.
		if (skipped.has(row.messageId)) continue;
		const vector = unpackVector(row.vector);
		if (vector.length !== dimension || input.vector.length !== dimension)
			continue;
		const score = dot(vector, input.vector);
		if (score >= input.minScore)
			scored.push({ messageId: row.messageId, digest: row.digest, score });
	}
	scored.sort((a, b) => b.score - a.score);
	// Close to the best hit only: a topic that merely resembles everything is not a match.
	const floor = (scored[0]?.score ?? 0) - RECALL_RELATIVE_GATE;

	const seenRuns = new Set<string>();
	const pins: TurnRecall["pins"] = [];
	let found = 0;
	let attempts = 0;
	for (const hit of scored) {
		if (found >= input.limit || hit.score < floor || ++attempts > MAX_ATTEMPTS)
			break;
		const message = conversation.messageInTransaction(db, hit.messageId);
		// A message whose text changed no longer matches what its vector says.
		if (!message || sha256Hex(message.message.text) !== hit.digest) continue;
		const runId = message.message.runId;
		const key = runId ?? `message:${message.message.id}`;
		if (seenRuns.has(key)) continue;
		seenRuns.add(key);
		const exchange = runId
			? conversation.messagesOfRunInTransaction(db, input.conversationId, runId)
			: [message];
		if (
			exchange.length === 0 ||
			exchange.some(
				({ message }) => skipped.has(message.id) || isBlocked(db, message.id),
			)
		)
			continue;
		found++;
		for (const { message } of exchange)
			pins.push({ messageId: message.id, digest: sha256Hex(message.text) });
	}
	return found === 0 ? null : { pins };
}
