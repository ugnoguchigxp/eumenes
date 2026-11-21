import type { SqliteStore } from "../../infrastructure/sqlite";
import { getLogger } from "../../infrastructure/logger";
import type { Capabilities, VectorSpace } from "../../domains/capabilities";
import { vectorSpaceKey } from "../../infrastructure/vector";
import type { Embed } from "../../domains/larm";

export type { Embed };

const log = getLogger("toolchain");
const BATCH = 32;
const QUERY_TIMEOUT_MS = 2500;
const PASSAGE_TIMEOUT_MS = 30_000;

/**
 * Background embedding of toolchain passages, and the
 * per-request query embedding. Vectors are stored with their space; a provider change makes
 * old vectors unused until they are recomputed. Failures never block a conversation.
 */
export function createVectorRefresh(
	store: SqliteStore,
	capabilities: Capabilities,
	embed?: Embed,
) {
	let running: Promise<VectorSpace | undefined> | null = null;
	let lastWarnAt = 0;
	function warn(event: string, error: unknown) {
		if (Date.now() - lastWarnAt < 60_000) return;
		lastWarnAt = Date.now();
		log.warn(event, {
			reason:
				error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
					? error.message
					: "embedding_failed",
		});
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
			if (space && vectorSpaceKey(space) !== vectorSpaceKey(r.space))
				throw new Error("embedding_space_changed");
			if (r.vectors.length !== Math.min(BATCH, texts.length - i))
				throw new Error("invalid_embedding_result");
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
			if (vectorSpaceKey(r.space) !== vectorSpaceKey(space))
				throw new Error("embedding_space_changed");
			await store.write((db) => {
				capabilities.saveToolchainVectorsInTransaction(
					db,
					space,
					toolchains.map((t, i) => ({ ...t, vector: r.vectors[i]! })),
				);
				if (capabilities.pendingToolchainVectorsInTransaction(db, space).length)
					throw new Error("embedding_index_sources_changed");
			});
		}
		if (toolchains.length)
			log.info("toolchain.vectors_refreshed", {
				count: toolchains.length,
			});
		return space;
	}
	function refresh() {
		running ??= run()
			.catch((error) => {
				warn("toolchain.vectors_refresh_failed", error);
				return undefined;
			})
			.finally(() => {
				running = null;
			});
		return running;
	}
	return {
		refresh,
		/** Passages embedded now, for a trial of a draft that is not in the index (undefined without a provider). */
		async embedPassages(texts: string[]) {
			if (!embed || !texts.length) return undefined;
			return passages(texts);
		},
		async embedQuery(
			text: string,
			signal: AbortSignal,
		): Promise<{ space: VectorSpace; vector: number[] } | undefined> {
			if (!embed || !text.trim()) return undefined;
			try {
				const r = await embed(
					[text],
					"query",
					AbortSignal.any([signal, AbortSignal.timeout(QUERY_TIMEOUT_MS)]),
				);
				return { space: r.space, vector: r.vectors[0]! };
			} catch (error) {
				signal.throwIfAborted();
				warn("toolchain.query_embedding_failed", error);
				throw error;
			}
		},
	};
}
