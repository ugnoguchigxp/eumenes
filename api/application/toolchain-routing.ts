import { toolchainRuntimeOf, type Capabilities } from "../domains/capabilities";
import type { ToolchainHistory } from "../domains/toolchain-history";
import type { ToolchainRoutingPort } from "../domains/dialogue";

/**
 * Dialogue's view of the toolchain registry and selection history. Retrieval merges
 * full-text, vector and past-selection ranks; it never decides for the conversation model.
 */
export function createToolchainRouting(
	capabilities: Capabilities,
	history: ToolchainHistory,
	embedQuery: ToolchainRoutingPort["embedQuery"],
): ToolchainRoutingPort {
	return {
		embedQuery,
		routeInTransaction(db, input) {
			const active = capabilities
				.toolchainsInTransaction(db)
				.filter((d) => input.available.has(d.id));
			const past = input.query
				? history.similarSelectionsInTransaction(db, {
						space: input.query.space,
						vector: input.query.vector,
						activeRevisionIds: new Set(active.map((d) => d.revisionId)),
						excludeRunId: input.runId,
					})
				: [];
			const fromHistory = past.flatMap((p) => {
				const d = active.find((x) => x.functionName === p.functionName);
				return d ? [d.id] : [];
			});
			const cards = capabilities.toolchainCandidatesInTransaction(db, {
				text: input.text,
				vector: input.query
					? { space: input.query.space, values: input.query.vector }
					: undefined,
				available: (id) => input.available.has(id),
				fromHistory,
			});
			const fts = cards.some((c) => c.score.ftsRank !== null);
			const vector = cards.some((c) => c.score.similarity !== null);
			return {
				cards,
				past,
				retrieval:
					fts && vector
						? "hybrid"
						: vector
							? "embedding"
							: fts
								? "fts"
								: "none",
			};
		},
		resolveInTransaction(db, revisionId) {
			const resolved = capabilities.resolveToolchainInTransaction(
				db,
				revisionId,
			);
			const runtime = toolchainRuntimeOf(resolved.toolchain.id);
			if (!runtime) throw new Error("toolchain_unavailable");
			return { ...resolved, runtime };
		},
		commandSetInTransaction(db, revisionId) {
			const set = capabilities.toolchainSetInTransaction(db, revisionId);
			return {
				backend: set.package.backend,
				profile: set.profile,
				skills: set.skills,
				tools: set.tools as Array<{
					id: string;
					revisionId: string;
					summary: string;
					schema: Record<string, unknown> | null;
				}>,
			};
		},
		recordSelectionInTransaction: history.recordSelectionInTransaction,
		linkTaskInTransaction: history.linkTaskInTransaction,
		settleSelectionInTransaction: history.settleSelectionInTransaction,
		requestOfRunInTransaction: history.requestOfRunInTransaction,
	};
}
