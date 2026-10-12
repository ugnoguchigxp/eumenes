import type { SqliteStore } from "../infrastructure/sqlite";
import { getLogger } from "../infrastructure/logger";
import type { Capabilities, VectorSpace } from "../domains/capabilities";
import type { ToolchainHistory } from "../domains/toolchain-history";

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
		if (toolchains.length || recipes.length)
			log.info("toolchain.vectors_refreshed", {
				count: toolchains.length + recipes.length,
			});
	}
	return {
		refresh() {
			running ??= run()
				.catch((error) => warn("toolchain.vectors_refresh_failed", error))
				.finally(() => {
					running = null;
				});
			return running;
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
