import type {
	Recipe,
	Selection,
	SelectionPageQuery,
	RecipePageQuery,
} from "../api/domains/toolchain-history/contracts";
import { json, type Transport } from "./transport";
function requestSignal(signal?: AbortSignal) {
	const timeout = AbortSignal.timeout(10_000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
/** Selection traces (which toolchain the conversation chose, and how it ended) and saved procedures. */
export function toolchainHistoryClient(t: Transport) {
	const get = async <T>(path: string, signal?: AbortSignal) =>
		(
			await t.call(path, { signal: requestSignal(signal) })
		).json() as Promise<T>;
	return {
		toolchainSelectionsPage: (
			query: SelectionPageQuery,
			signal?: AbortSignal,
		) => {
			const params = new URLSearchParams(
				Object.entries(query).map(([key, value]) => [key, String(value)]),
			);
			return get<{
				items: Selection[];
				total: number;
				pageIndex: number;
				pageSize: number;
			}>(`/api/toolchain-history/selections/page?${params}`, signal);
		},
		toolchainRecipesPage: (query: RecipePageQuery, signal?: AbortSignal) => {
			const params = new URLSearchParams(
				Object.entries(query).map(([key, value]) => [key, String(value)]),
			);
			return get<{
				items: Recipe[];
				total: number;
				pageIndex: number;
				pageSize: number;
			}>(`/api/toolchain-history/recipes/page?${params}`, signal);
		},
		toolchainSelections: (
			query: {
				runId?: string;
				toolchain?: string;
				since?: number;
				cursor?: number;
				limit?: number;
			} = {},
			signal?: AbortSignal,
		) => {
			const params = new URLSearchParams();
			for (const [key, value] of Object.entries(query))
				if (value !== undefined) params.set(key, String(value));
			return get<{ items: Selection[]; nextCursor: number | null }>(
				`/api/toolchain-history/selections${params.size ? `?${params}` : ""}`,
				signal,
			);
		},
		toolchainSelection: (id: string, signal?: AbortSignal) =>
			get<Selection>(
				`/api/toolchain-history/selections/${encodeURIComponent(id)}`,
				signal,
			),
		toolchainRecipes: (toolchain?: string, signal?: AbortSignal) =>
			get<{ items: Recipe[] }>(
				`/api/toolchain-history/recipes${toolchain ? `?toolchain=${encodeURIComponent(toolchain)}` : ""}`,
				signal,
			),
		setToolchainRecipeState: async (
			id: string,
			state: "active" | "disabled",
			signal?: AbortSignal,
		) =>
			(
				await t.call(
					`/api/toolchain-history/recipes/${encodeURIComponent(id)}/state`,
					{ ...json({ state }), signal: requestSignal(signal) },
				)
			).json() as Promise<{ ok: true }>,
		deleteToolchainRecipe: async (id: string, signal?: AbortSignal) =>
			(
				await t.call(
					`/api/toolchain-history/recipes/${encodeURIComponent(id)}`,
					{
						method: "DELETE",
						signal: requestSignal(signal),
					},
				)
			).json() as Promise<{ ok: true }>,
	};
}
export {
	selectionPageQuerySchema,
	recipePageQuerySchema,
} from "../api/domains/toolchain-history/contracts";
