import type { Database } from "bun:sqlite";
import type { AgentRuntime, SearchReportHook } from "../domains/agent-runtime";
import {
	packageRuntimeOf,
	type FixedDefinition,
	type Owner,
} from "../domains/capabilities";
import type { AdapterOperation, ToolRuntime } from "../domains/tool-runtime";
import type { ToolchainHistory } from "../domains/toolchain-history";

/** The toolchain whose procedures a run uses: the conversation's choice, else web search. */
const DEFAULT_RECIPE_TOOLCHAIN = "web.search";

/**
 * Saved fetch procedures as a host-local tool of the web_search toolchain, and their upkeep
 * when a search report is accepted. Matching a request to a procedure is the sub-agent's
 * judgement; the host only finds candidates, counts URL results and checks proposals.
 */
export function createRecipePorts(
	history: ToolchainHistory,
	runtime: () => AgentRuntime,
	tools: () => ToolRuntime,
) {
	function toolchainOf(db: Database, rootRunId: string) {
		return (
			history.toolchainOfRunInTransaction(db, rootRunId) ??
			DEFAULT_RECIPE_TOOLCHAIN
		);
	}
	function findInTransaction(
		db: Database,
		r: { tool: FixedDefinition; arguments: unknown; owner: Owner },
	): AdapterOperation {
		runtime().authorizeReadOwnerInTransaction(db, r.owner, "read");
		const { query } = r.arguments as { query: string };
		const found = history.findRecipesInTransaction(db, {
			toolchainId: toolchainOf(db, r.owner.rootRunId),
			text: query,
			runId: r.owner.rootRunId,
		});
		return {
			state: "succeeded",
			result: {
				observedAt: new Date().toISOString(),
				// A procedure's URL becomes an observed URL the sub-agent may read again.
				hits: found.map((x) => ({
					url: x.url,
					title: x.signature,
					snippet: `保存済みの取得手順: ${x.signature}\n読む箇所: ${x.readHint}`,
				})),
				documents: [],
				failures: [],
			},
		};
	}
	const onSearchReport: SearchReportHook = (db, input) => {
		if (packageRuntimeOf(input.packageId)?.budget !== "recipe") return;
		const toolchainId = toolchainOf(db, input.rootRunId);
		const invocations = tools()
			.invocationsInTransaction(db, input.taskId)
			.filter((i) => !i.superseded);
		const finds = new Set(
			invocations
				.filter((i) => i.toolRevisionId.startsWith("tool:recipe.find@"))
				.map((i) => i.id),
		);
		const offered = new Set(
			tools()
				.observationsInTransaction(db, input.taskId)
				.filter((o) => finds.has(o.invocationId))
				.flatMap((o) => o.sources.flatMap((s) => (s.url ? [s.url] : []))),
		);
		// The rules (what counts, what is kept) belong to the toolchain-history domain.
		history.settleRecipesInTransaction(db, {
			toolchainId,
			runId: input.rootRunId,
			lookedUp: finds.size > 0,
			offeredUrls: [...offered],
			reads: invocations
				.filter((i) => i.toolRevisionId.startsWith("tool:web.read@"))
				.flatMap((i) => {
					const url = (i.arguments as { url?: string } | undefined)?.url;
					return url ? [{ url, state: i.state }] : [];
				}),
			citedPages: input.report.sources.flatMap((s) =>
				s.url && s.basis === "page" ? [s.url] : [],
			),
			answered:
				input.report.version === 2 && input.report.outcome === "answered",
			proposal: input.recipe,
		});
	};
	return { findInTransaction, onSearchReport };
}
