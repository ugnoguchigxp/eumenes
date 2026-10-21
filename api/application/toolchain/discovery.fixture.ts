import type { SqliteStore } from "../../infrastructure/sqlite";
import {
	toolchainPassages,
	type Capabilities,
	type VectorSpace,
} from "../../domains/capabilities";

/** Deterministic retrieval for integration fixtures, replacing their former all-catalog fallback. */
export function fixtureDiscovery(
	store: SqliteStore,
	capabilities: Capabilities,
	target: (query: string) => string,
) {
	const space: VectorSpace = {
		modelId: "fixture-discovery",
		revision: "1",
		artifactDigest: "fixture",
		dimension: 2,
	};
	return async (query: string) => {
		await store.write((db) => {
			const active = capabilities.toolchainsInTransaction(db);
			capabilities.saveToolchainVectorsInTransaction(
				db,
				space,
				active.flatMap((chain) =>
					toolchainPassages(chain).map((text, item) => ({
						revisionId: chain.revisionId,
						item,
						text,
						vector: chain.functionName === target(query) ? [1, 0] : [0, 1],
					})),
				),
			);
		});
		return { space, vector: [1, 0] };
	};
}
