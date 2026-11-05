import type { Database } from "bun:sqlite";
import type { BestV2Memory, Card } from "eumenes_router";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { getLogger } from "../../infrastructure/logger";
import type { Capabilities, VectorSpace } from "../../domains/capabilities";
import type { ToolchainHistory } from "../../domains/toolchain-history";

/** The LARM embedding provider, as the application binds it to the saved connection. */
export type Embed = (
	texts: string[],
	type: "query" | "passage",
	signal: AbortSignal,
) => Promise<{ vectors: number[][]; space: VectorSpace }>;

const log = getLogger("toolchain");
const BATCH = 32;
const QUERY_TIMEOUT_MS = 2500;
const PASSAGE_TIMEOUT_MS = 30_000;

/**
 * Background embedding of toolchain passages and saved procedure signatures, and the
 * per-request query embedding. Vectors are stored with their space; a provider change makes
 * old vectors unused until they are recomputed. Failures never block a conversation.
 */
export function createVectorRefresh(
	store: SqliteStore,
	capabilities: Capabilities,
	history: ToolchainHistory,
	embed?: Embed,
	/** The router package's cards (spec router-package-integration 2026-11-04 §1 #7), synced on every refresh. */
	routerCards?: (db: Database) => Card[],
) {
	let running: Promise<void> | null = null;
	let lastWarnAt = 0;
	function warn(event: string, error: unknown) {
		if (Date.now() - lastWarnAt < 60_000) return;
		lastWarnAt = Date.now();
		log.warn(
			event,
			{
				reason:
					error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
						? error.message
						: "embedding_failed",
			},
			error,
		);
	}
	async function passages(texts: string[]) {
		const out: number[][] = [];
		let space: VectorSpace | undefined;
		for (let i = 0; i < texts.length; i += BATCH) {
			const r = await embed!(
				texts.slice(i, i + BATCH),
				"passage",
				AbortSignal.timeout(PASSAGE_TIMEOUT_MS),
			);
			space = r.space;
			out.push(...r.vectors);
		}
		return { vectors: out, space: space! };
	}
	async function run() {
		if (!embed) return;
		// The provider's current space decides which vectors are missing.
		const probe = await embed(
			["toolchain"],
			"passage",
			AbortSignal.timeout(PASSAGE_TIMEOUT_MS),
		);
		const space = probe.space;
		const toolchains = store.read((db) =>
			capabilities.pendingToolchainVectorsInTransaction(db, space),
		);
		if (toolchains.length) {
			const r = await passages(toolchains.map((t) => t.text));
			await store.write((db) =>
				capabilities.saveToolchainVectorsInTransaction(
					db,
					r.space,
					toolchains.map((t, i) => ({ ...t, vector: r.vectors[i]! })),
				),
			);
		}
		const recipes = store.read((db) =>
			history.pendingRecipeVectorsInTransaction(db, space),
		);
		if (recipes.length) {
			const r = await passages(recipes.map((t) => t.text));
			await store.write((db) =>
				history.saveRecipeVectorsInTransaction(
					db,
					r.space,
					recipes.map((t, i) => ({ ...t, vector: r.vectors[i]! })),
				),
			);
		}
		// The router package's cards, and the vectors of their passages it misses in this space.
		const cards = routerCards ? store.read((db) => routerCards(db)) : [];
		const pending = cards.length
			? await store.write((db) =>
					history.syncRouterCardsInTransaction(db, cards, space),
				)
			: [];
		if (pending.length) {
			const r = await passages(pending.map((p) => p.text));
			await store.write((db) =>
				history.saveRouterVectorsInTransaction(
					db,
					r.space,
					pending.map((p, i) => ({ ...p, vector: r.vectors[i]! })),
				),
			);
		}
		if (toolchains.length || recipes.length || pending.length)
			log.info("toolchain.vectors_refreshed", {
				count: toolchains.length + recipes.length + pending.length,
			});
	}
	function refresh() {
		running ??= run()
			.catch((error) => warn("toolchain.vectors_refresh_failed", error))
			.finally(() => {
				running = null;
			});
		return running;
	}
	return {
		refresh,
		/**
		 * The router's embedding of the texts it routes (the eumenes_router package's `embed`): passages, as its cards'
		 * and its memory's were made. A failure is thrown: the turn goes on without the router.
		 */
		async embedRouter(texts: readonly string[], signal: AbortSignal) {
			if (!embed) throw new Error("embedding_unavailable");
			return embed(
				texts.map((text) => text.slice(0, 2000)),
				"passage",
				AbortSignal.any([signal, AbortSignal.timeout(QUERY_TIMEOUT_MS)]),
			);
		},
		/** Stores best-v2's memory in the provider's current space (the host brings it: it is not in Git). */
		async importRouterMemory(memory: BestV2Memory) {
			if (!embed) throw new Error("embedding_unavailable");
			const { space } = await embed(
				["toolchain"],
				"passage",
				AbortSignal.timeout(PASSAGE_TIMEOUT_MS),
			);
			const count = await store.write((db) =>
				history.importRouterMemoryInTransaction(db, memory, space),
			);
			void refresh();
			return { count, source: memory.source };
		},
		/** Passages embedded now, for a trial of a draft that is not in the index (undefined without a provider). */
		async embedPassages(texts: string[]) {
			if (!embed) return undefined;
			try {
				return await passages(texts);
			} catch (error) {
				warn("toolchain.passage_embedding_failed", error);
				return undefined;
			}
		},
		async embedQuery(
			text: string,
			signal: AbortSignal,
		): Promise<{ space: VectorSpace; vector: number[] } | undefined> {
			if (!embed || !text.trim()) return undefined;
			try {
				const r = await embed(
					[text.slice(0, 2000)],
					"query",
					AbortSignal.any([signal, AbortSignal.timeout(QUERY_TIMEOUT_MS)]),
				);
				return { space: r.space, vector: r.vectors[0]! };
			} catch (error) {
				signal.throwIfAborted();
				warn("toolchain.query_embedding_failed", error);
				return undefined;
			}
		},
	};
}
