import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import { getLogger } from "../../../infrastructure/logger";
import { packVector, vectorSpaceKey } from "../../../infrastructure/vector";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { textChunks } from "../../../infrastructure/text-chunks";
import type { ConversationService } from "../../conversation";
import { type MemoryEmbed, type MemoryVectorSpace } from "../contracts";
import { isBlocked, putTurnVector, deleteTurnVectors } from "../repository";
import {
	outdatedTurnVectors,
	turnVectorStillCurrent,
} from "../repository/turn-vector";

const log = getLogger("memory");
/** Embedding is best effort: it never holds the job longer than this. */
const EMBED_MS = 10_000;
const BATCH = 32;
export const turnSpaceKey = (space: MemoryVectorSpace) =>
	vectorSpaceKey(space, "conversation-message/v1");

/** The passage vectors of the turns the agent read (message id, vector). */
export type TurnVectors = {
	space: MemoryVectorSpace;
	items: Array<{ messageId: string; vector: number[] }>;
};
/** A search query as a vector. */
export type QueryVector = { space: MemoryVectorSpace; vector: number[] };

/** A vector of the space's dimension with finite values (anything else would poison the comparison). */
const validVector = (vector: number[] | undefined, space: MemoryVectorSpace) =>
	Array.isArray(vector) &&
	vector.length === space.dimension &&
	vector.every(Number.isFinite);

/**
 * The memory agent's embedding side: turn vectors saved with its settle, and query vectors for its searches.
 * Indexing is best effort; a search failure is reported to its caller.
 */
export function createAgentVectors(deps: {
	conversation: ConversationService;
	store: SqliteStore;
	atMs(): number;
	/** Looked up at each use: the application may create the embedder after memory. */
	embed?: (() => MemoryEmbed | undefined) | undefined;
}) {
	const { conversation } = deps;
	async function embedAll(
		texts: string[],
		type: "query" | "passage",
		signal: AbortSignal,
	): Promise<{ vectors: number[][]; space: MemoryVectorSpace } | null> {
		const embed = deps.embed?.();
		if (!embed) return null;
		const result = await embed(
			texts,
			type,
			AbortSignal.any([signal, AbortSignal.timeout(EMBED_MS)]),
		);
		if (
			result.vectors.length !== texts.length ||
			!result.vectors.every((vector) => validVector(vector, result.space))
		)
			throw new Error("embedding_invalid");
		return result;
	}
	async function embedTurns(
		turns: ReadonlyArray<{ messageId: string; text: string }>,
		signal: AbortSignal,
	): Promise<TurnVectors | null> {
		const passages = turns.flatMap(({ messageId, text }) =>
			textChunks(text).map((chunk) => ({ messageId, text: chunk })),
		);
		let space: MemoryVectorSpace | undefined;
		const vectors = new Map<string, number[]>();
		for (let i = 0; i < passages.length; i += BATCH) {
			const batch = passages.slice(i, i + BATCH);
			const result = await embedAll(
				batch.map(({ text }) => text),
				"passage",
				signal,
			);
			if (!result) return null;
			if (space && turnSpaceKey(space) !== turnSpaceKey(result.space))
				throw new Error("embedding_space_changed");
			space = result.space;
			batch.forEach(({ messageId }, index) => {
				const vector = vectors.get(messageId);
				if (vector) vector.push(...result.vectors[index]!);
				else vectors.set(messageId, [...result.vectors[index]!]);
			});
		}
		return space
			? {
					space,
					items: [...vectors].map(([messageId, vector]) => ({
						messageId,
						vector,
					})),
				}
			: null;
	}
	function source(
		db: Database,
		row: { messageId: string; conversationId: string; digest: string },
	) {
		const found = conversation.messageInTransaction(db, row.messageId);
		return found &&
			found.message.conversationId === row.conversationId &&
			!isBlocked(db, row.messageId) &&
			sha256Hex(found.message.text) === row.digest
			? found
			: null;
	}
	return {
		async embedTurns(...args: Parameters<typeof embedTurns>) {
			try {
				return await embedTurns(...args);
			} catch {
				log.warn("memory.agent_embedding_failed", {
					reason: "embedding_failed",
					messageCount: args[0].length,
				});
				return null;
			}
		},
		/** Replace only vectors whose original, still-visible source can be rebuilt. */
		async refreshTurns(space: MemoryVectorSpace, signal: AbortSignal) {
			if (!space.embeddingSpace) return 0;
			const key = turnSpaceKey(space);
			const { pending, turns } = deps.store.read((db) => {
				const pending = outdatedTurnVectors(db, key, BATCH);
				const turns = pending.flatMap((row) => {
					const found = source(db, row);
					return found?.message.text.trim()
						? [{ messageId: row.messageId, text: found.message.text }]
						: [];
				});
				return { pending, turns };
			});
			if (!pending.length) return 0;
			const result = await embedTurns(turns, signal);
			if (turns.length && (!result || turnSpaceKey(result.space) !== key))
				throw new Error("embedding_space_changed");
			const byMessage = new Map(
				result?.items.map((item) => [item.messageId, item.vector]),
			);
			const count = await deps.store.write((db) => {
				signal.throwIfAborted();
				let count = 0;
				for (const row of pending) {
					if (!turnVectorStillCurrent(db, row)) continue;
					const found = source(db, row);
					if (!found?.message.text.trim()) {
						deleteTurnVectors(db, [row.messageId]);
						continue;
					}
					const vector = byMessage.get(row.messageId);
					if (!vector) continue;
					putTurnVector(db, {
						...row,
						space: key,
						vector: packVector(vector),
						ordinal: found.ordinal,
						createdAt: new Date(deps.atMs()).toISOString(),
					});
					count++;
				}
				return count;
			});
			if (count) log.info("memory.turn_vectors_refreshed", { count });
			return pending.length;
		},
		async embedQuery(
			query: string,
			signal: AbortSignal,
		): Promise<QueryVector | null> {
			const result = await embedAll([query], "query", signal);
			return result
				? { space: result.space, vector: result.vectors[0]! }
				: null;
		},
		/** Stores the turns' vectors (best effort: a failure here costs only the vectors). */
		saveTurnVectors(
			db: Database,
			input: { conversationId: string; digests: Record<string, string> },
			turnVectors: TurnVectors | null,
		) {
			if (!turnVectors) return;
			const space = turnSpaceKey(turnVectors.space);
			const createdAt = new Date(deps.atMs()).toISOString();
			db.exec("SAVEPOINT memory_agent_vectors");
			try {
				for (const item of turnVectors.items) {
					const digest = input.digests[item.messageId];
					const found =
						digest &&
						source(db, {
							messageId: item.messageId,
							conversationId: input.conversationId,
							digest,
						});
					// A scheduled prompt is never embedded; a message gone since the read has nothing to stand for.
					if (!digest || !found) continue;
					putTurnVector(db, {
						messageId: item.messageId,
						conversationId: input.conversationId,
						ordinal: found.ordinal,
						space,
						vector: packVector(item.vector),
						digest,
						createdAt,
					});
				}
				db.exec("RELEASE memory_agent_vectors");
			} catch (error) {
				db.exec("ROLLBACK TO memory_agent_vectors");
				db.exec("RELEASE memory_agent_vectors");
				log.warn(
					"memory.agent_embedding_failed",
					{ reason: "vector_store_failed" },
					error,
				);
			}
		},
	};
}
