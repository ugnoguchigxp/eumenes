import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { recipeProposal } from "../contracts";
import { createRecipes, recipe } from "./recipes";
import { createSelections, selection } from "./selections";
import { createHistoryPages } from "./record-pages";

/**
 * Selection traces (what the conversation model was offered, what it chose, how it ended) and
 * the saved fetch procedures of toolchains. Writers call the `...InTransaction` operations from
 * their own single-writer transaction; the rest is the management API.
 */
export function createToolchainHistory(
	store: SqliteStore,
	now: () => number = Date.now,
) {
	const selections = createSelections(store, now);
	const recipes = createRecipes(store, now, selections.queryOfRunInTransaction);
	/**
	 * The upkeep of procedures when a sub-agent's report is accepted. A read of an offered URL
	 * counts as a success only when the answer cites that page; a failed read counts as a
	 * failure. A proposal is kept only for an answered report that cites the page it names,
	 * and a reused procedure is counted once.
	 */
	function settleRecipesInTransaction(
		db: Database,
		input: {
			toolchainId: string;
			runId: string;
			/** `recipe.find` ran in this task, and the URLs it returned. */
			lookedUp: boolean;
			offeredUrls: readonly string[];
			/** Page reads of this task. */
			reads: ReadonlyArray<{ url: string; state: string }>;
			/** URLs of read pages the accepted report cites. */
			citedPages: readonly string[];
			answered: boolean;
			proposal: unknown;
		},
	) {
		const offered = new Set(input.offeredUrls);
		const cited = new Set(input.citedPages);
		const reused = new Set<string>();
		for (const read of input.reads) {
			if (!offered.has(read.url)) continue;
			const ok =
				["succeeded", "partial"].includes(read.state) && cited.has(read.url);
			const failed = ["failed", "cancelled", "interrupted"].includes(
				read.state,
			);
			if (!ok && !failed) continue;
			for (const id of recipes.recipesByUrlInTransaction(
				db,
				input.toolchainId,
				read.url,
			))
				recipes.recordRecipeResultInTransaction(db, id, ok);
			if (ok) reused.add(read.url);
		}
		if (input.lookedUp)
			selections.markRecipeInTransaction(
				db,
				input.runId,
				reused.size ? "matched" : "missed",
			);
		const proposal = recipeProposal.safeParse(input.proposal);
		if (
			proposal.success &&
			input.answered &&
			cited.has(proposal.data.url) &&
			!reused.has(proposal.data.url)
		) {
			recipes.saveRecipeInTransaction(db, input.toolchainId, proposal.data);
			if (!reused.size)
				selections.markRecipeInTransaction(db, input.runId, "saved");
		}
	}
	return {
		...selections,
		...recipes,
		...createHistoryPages(store, selection, recipe),
		settleRecipesInTransaction,
	};
}
export type ToolchainHistory = ReturnType<typeof createToolchainHistory>;
