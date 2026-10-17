import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import { packVector, vectorSpaceKey } from "../../../infrastructure/vector";
import type { ConversationService } from "../../conversation";
import {
	type MemoryEmbed,
	type MemoryVectorSpace,
	type TurnRecall,
} from "../contracts";
import { isBlocked, putTurnVector } from "../repository";
import type { WindowPrefetch } from "./context-window";
import { RECALL_MIN_SCORE, type RecallInput } from "./turn-recall";

const log = getLogger("memory");
/** Embedding is best effort: it never holds the job longer than this. */
const EMBED_MS = 10_000;

/** The passage vectors of the turns the agent read (message id, vector). */
export type TurnVectors = {
	space: MemoryVectorSpace;
	items: Array<{ messageId: string; vector: number[] }>;
};
/** The prefetch query as a vector. */
export type QueryVector = { space: MemoryVectorSpace; vector: number[] };

/** A vector of the space's dimension with finite values (anything else would poison the comparison). */
const validVector = (vector: number[] | undefined, space: MemoryVectorSpace) =>
	Array.isArray(vector) &&
	vector.length === space.dimension &&
	vector.every(Number.isFinite);

/**
 * The memory agent's embedding side: turn vectors saved with its settle, and the prefetch the next turn starts
 * from. Nothing here throws into the job: embedding failure costs only the vectors (and a stale prefetch).
 */
export function createAgentVectors(deps: {
	conversation: ConversationService;
	atMs(): number;
	/** Looked up at each use: the application may create the embedder after memory. */
	embed?: (() => MemoryEmbed | undefined) | undefined;
	recall(db: Database, input: RecallInput): TurnRecall | null;
}) {
	const { conversation } = deps;
	async function embedAll(
		texts: string[],
		type: "query" | "passage",
		signal: AbortSignal,
	): Promise<{ vectors: number[][]; space: MemoryVectorSpace } | null> {
		try {
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
		} catch (error) {
			log.warn(
				"memory.agent_embedding_failed",
				{ reason: "embedding_failed", messageCount: texts.length },
				error,
			);
			return null;
		}
	}

	return {
		/** The turns as passages; null when embedding is unavailable or fails. */
		async embedTurns(
			turns: ReadonlyArray<{ messageId: string; text: string }>,
			signal: AbortSignal,
		): Promise<TurnVectors | null> {
			const texts = turns.filter(({ text }) => text.trim() !== "");
			if (texts.length === 0) return null;
			const result = await embedAll(
				texts.map(({ text }) => text),
				"passage",
				signal,
			);
			if (!result) return null;
			return {
				space: result.space,
				items: texts.map(({ messageId }, i) => ({
					messageId,
					vector: result.vectors[i]!,
				})),
			};
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
			const space = vectorSpaceKey(turnVectors.space);
			const createdAt = new Date(deps.atMs()).toISOString();
			db.exec("SAVEPOINT memory_agent_vectors");
			try {
				for (const item of turnVectors.items) {
					const digest = input.digests[item.messageId];
					const found = conversation.messageInTransaction(db, item.messageId);
					// A scheduled prompt is never embedded; a message gone since the read has nothing to stand for.
					if (
						!digest ||
						!found ||
						found.message.conversationId !== input.conversationId ||
						isBlocked(db, item.messageId)
					)
						continue;
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
		/**
		 * The prefetched exchanges for the next turn: what the model's query finds among the exchanges that turn does
		 * not show verbatim. undefined keeps the earlier prefetch.
		 */
		prefetchOf(
			db: Database,
			conversationId: string,
			query: QueryVector | null | undefined,
			/** The most (estimated tokens) the prefetch may take: the memory and history budget. */
			maxTokens: number,
		): WindowPrefetch | undefined {
			if (!query) return undefined;
			try {
				const found = deps.recall(db, {
					conversationId,
					space: query.space,
					vector: query.vector,
					minScore: RECALL_MIN_SCORE,
					maxTokens,
				});
				return found ?? { text: "", pins: [], tokens: 0 };
			} catch (error) {
				log.warn(
					"memory.agent_embedding_failed",
					{ reason: "prefetch_failed" },
					error,
				);
				return undefined;
			}
		},
	};
}
