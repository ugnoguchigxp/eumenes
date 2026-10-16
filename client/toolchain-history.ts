import { z } from "zod";
import type {
	Recipe,
	Selection,
	SelectionPageQuery,
	RecipePageQuery,
} from "../api/domains/toolchain-history/contracts";
import { callJson, json, type Transport } from "./transport";

const nullableNumber = z.number().nullable();
const selectionSchema: z.ZodType<Selection> = z.object({
	id: z.string(),
	runId: z.string(),
	conversationId: z.string(),
	utteranceId: z.string().nullable(),
	requestId: z.string().nullable(),
	retrieval: z.enum(["fts", "embedding", "hybrid", "none"]),
	candidates: z.array(
		z.object({
			toolchainId: z.string(),
			revisionId: z.string(),
			functionName: z.string(),
			rank: z.number(),
			ftsRank: nullableNumber,
			similarity: nullableNumber,
			fromHistory: z.boolean(),
		}),
	),
	historyRefs: z.array(z.string()),
	decision: z.enum(["toolchain", "answer", "rejected"]),
	toolchainId: z.string().nullable(),
	toolchainRevisionId: z.string().nullable(),
	functionName: z.string().nullable(),
	request: z.string().nullable(),
	repaired: z.boolean(),
	taskId: z.string().nullable(),
	outcome: z
		.enum([
			"answered",
			"partial",
			"not_found",
			"clarification_required",
			"failed",
			"cancelled",
			"expired",
			"completed",
		])
		.nullable(),
	outcomeCode: z.string().nullable(),
	recipe: z.enum(["matched", "missed", "saved"]).nullable(),
	durationMs: nullableNumber,
	createdAt: z.number(),
	settledAt: nullableNumber,
});
const recipeSchema: z.ZodType<Recipe> = z.object({
	id: z.string(),
	toolchainId: z.string(),
	signature: z.string(),
	url: z.string(),
	readHint: z.string(),
	state: z.enum(["active", "suspended", "disabled"]),
	successes: z.number(),
	failures: z.number(),
	consecutiveFailures: z.number(),
	lastSuccessAt: nullableNumber,
	lastFailureAt: nullableNumber,
	createdAt: z.number(),
	updatedAt: z.number(),
});
const pageOf = <T extends z.ZodType>(item: T) =>
	z.object({
		items: z.array(item),
		total: z.number(),
		pageIndex: z.number(),
		pageSize: z.number(),
	});
const selectionPageSchema = pageOf(selectionSchema);
const recipePageSchema = pageOf(recipeSchema);
const selectionListSchema = z.object({
	items: z.array(selectionSchema),
	nextCursor: z.number().nullable(),
});
const recipeListSchema = z.object({ items: z.array(recipeSchema) });
const okSchema = z.object({ ok: z.literal(true) });
function requestSignal(signal?: AbortSignal) {
	const timeout = AbortSignal.timeout(10_000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
/** Selection traces (which toolchain the conversation chose, and how it ended) and saved procedures. */
export function toolchainHistoryClient(t: Transport) {
	const get = <S extends z.ZodType>(
		schema: S,
		path: string,
		signal?: AbortSignal,
	) => callJson(t, schema, path, { signal: requestSignal(signal) });
	return {
		toolchainSelectionsPage: (
			query: SelectionPageQuery,
			signal?: AbortSignal,
		) => {
			const params = new URLSearchParams(
				Object.entries(query).map(([key, value]) => [key, String(value)]),
			);
			return get(
				selectionPageSchema,
				`/api/toolchain-history/selections/page?${params}`,
				signal,
			);
		},
		toolchainRecipesPage: (query: RecipePageQuery, signal?: AbortSignal) => {
			const params = new URLSearchParams(
				Object.entries(query).map(([key, value]) => [key, String(value)]),
			);
			return get(
				recipePageSchema,
				`/api/toolchain-history/recipes/page?${params}`,
				signal,
			);
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
			return get(
				selectionListSchema,
				`/api/toolchain-history/selections${params.size ? `?${params}` : ""}`,
				signal,
			);
		},
		toolchainSelection: (id: string, signal?: AbortSignal) =>
			get(
				selectionSchema,
				`/api/toolchain-history/selections/${encodeURIComponent(id)}`,
				signal,
			),
		toolchainRecipes: (toolchain?: string, signal?: AbortSignal) =>
			get(
				recipeListSchema,
				`/api/toolchain-history/recipes${toolchain ? `?toolchain=${encodeURIComponent(toolchain)}` : ""}`,
				signal,
			),
		setToolchainRecipeState: async (
			id: string,
			state: "active" | "disabled",
			signal?: AbortSignal,
		) =>
			callJson(
				t,
				okSchema,
				`/api/toolchain-history/recipes/${encodeURIComponent(id)}/state`,
				{ ...json({ state }), signal: requestSignal(signal) },
			),
		deleteToolchainRecipe: (id: string, signal?: AbortSignal) =>
			callJson(
				t,
				okSchema,
				`/api/toolchain-history/recipes/${encodeURIComponent(id)}`,
				{ method: "DELETE", signal: requestSignal(signal) },
			),
	};
}
export {
	selectionPageQuerySchema,
	recipePageQuerySchema,
} from "../api/domains/toolchain-history/contracts";
