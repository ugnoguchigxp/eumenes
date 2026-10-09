import {
	WORLD_QUERY_MODES,
	worldQueryToolSchema,
	type WorldQueryContext,
	type WorldQueryResult,
} from "../contracts/query";
import type { WorldQuery } from "./world-query";

export const WORLD_QUERY_TOOL_ID = "world.query";

/**
 * The model-callable definition of `world.query`. It is a DEFINITION only:
 * registering it with the capability catalog and the tool runtime is host
 * wiring that lives in those domains. The model chooses only the enumerated
 * `mode` and its bounded parameters. The Scope it may read comes from
 * `context()`, which trusted host code binds to the current conversation; the
 * model cannot name a principal and cannot ask for Gap -> Task linkage.
 */
export function createWorldQueryTool(deps: {
	query: WorldQuery;
	context: () => WorldQueryContext;
}) {
	return {
		id: WORLD_QUERY_TOOL_ID,
		title: "World照会",
		summary:
			"保存済みの主張から、関連・影響・依存・不足(調査候補)・仮定の比較を根拠と条件つきで調べる。読取り専用で、実行や権限付与はしない",
		modes: WORLD_QUERY_MODES,
		inputSchema: worldQueryToolSchema,
		async run(input: unknown): Promise<WorldQueryResult> {
			// Not part of the model's vocabulary: rejected, never ignored.
			if (typeof input === "object" && input !== null && "linkGaps" in input)
				return { status: "rejected", code: "invalid_request" };
			return deps.query.query(deps.context(), input);
		},
	};
}
export type WorldQueryTool = ReturnType<typeof createWorldQueryTool>;
