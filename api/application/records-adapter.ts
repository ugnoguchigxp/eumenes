import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
	usagePageQuerySchema,
	type UsagePageQuery,
} from "../domains/inference/contracts";
import {
	recipePageQuerySchema,
	selectionPageQuerySchema,
	type ToolchainHistory,
} from "../domains/toolchain-history";
import type { AdapterResult, DomainAdapter } from "../domains/tool-runtime";

export const RECORDS_ADAPTER_REF = "adapter:records@1";
const USAGE = "query:records.usage@1";
const SELECTIONS = "query:records.selections@1";
const RECIPES = "query:records.recipes@1";
const DIAGNOSTICS = "query:records.diagnostics@1";
const EXPORT = "query:records.export@1";

const recipeId = z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/);
const recipeState = z.strictObject({ id: recipeId, enabled: z.boolean() });
const recipeDelete = z.strictObject({ id: recipeId });

/** What the records adapter reads and changes; each is a domain's public operation. */
export type RecordsPorts = {
	usagePage(query: UsagePageQuery): unknown;
	usage(): unknown;
	/** The LARM connection details of the inference domain (`inspect`). */
	larm(): unknown;
	/** The settings domain's diagnostics (key state, connection credential state). */
	diagnostics(): unknown;
	history: () => Pick<
		ToolchainHistory,
		| "selectionPage"
		| "recipePage"
		| "setRecipeStateInTransaction"
		| "deleteRecipeInTransaction"
	>;
};

const sha256 = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** What the records adapter offers, without domain services (bundle checks, evaluation). */
export const describeRecordsAdapter = () => ({
	owner: "records",
	operations: new Map([
		[
			"records.recipe-state",
			{
				inputSchemaRef: "schema:records-recipe-state@1",
				effect: "write" as const,
			},
		],
		[
			"records.recipe-delete",
			{
				inputSchemaRef: "schema:records-recipe-delete@1",
				effect: "write" as const,
			},
		],
	]),
	queries: new Set([USAGE, SELECTIONS, RECIPES, DIAGNOSTICS, EXPORT]),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:records@1",
});

/**
 * The typed records adapter: AI usage, toolchain selection and fetch-procedure pages (read with page parameters), the
 * diagnostics bundle, and the two procedure operations. Reads go through the domains' page
 * readers and procedures change through toolchain-history's transaction operations.
 */
export function createRecordsAdapter(ports: RecordsPorts): DomainAdapter {
	function done(
		receipt: Record<string, unknown>,
		requestId: string,
		resultRefs: AdapterResult["resultRefs"] = [],
	): AdapterResult {
		return {
			receipt,
			receiptRef: {
				owner: "records",
				operationId: requestId,
				digest: sha256(receipt),
			},
			resultRefs,
			replay: false,
		};
	}
	return {
		ref: RECORDS_ADAPTER_REF,
		describe: describeRecordsAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: () => ({ items: [] }),
		invokeInTransaction(tx: Database, request) {
			if (request.origin.kind !== "ui")
				throw new Error("capability_unavailable");
			switch (request.operationName) {
				case "records.recipe-state": {
					const input = recipeState.safeParse(request.input);
					if (!input.success) throw new Error("invalid_input");
					const state = input.data.enabled ? "active" : "disabled";
					ports.history().setRecipeStateInTransaction(tx, input.data.id, state);
					return done(
						{ version: 1, kind: "recipe-state", id: input.data.id, state },
						request.requestId,
						[recipeRef(input.data.id)],
					);
				}
				case "records.recipe-delete": {
					const input = recipeDelete.safeParse(request.input);
					if (!input.success) throw new Error("invalid_input");
					ports.history().deleteRecipeInTransaction(tx, input.data.id);
					return done(
						{ version: 1, kind: "recipe-delete", id: input.data.id },
						request.requestId,
						[recipeRef(input.data.id)],
					);
				}
				default:
					throw new Error("capability_unavailable");
			}
		},
		// Procedure operations leave no body to reload: the screen reads the page again.
		readInTransaction: () => null,
		sourceInTransaction(_tx, query, _target, params) {
			// `params` passed the source binding's page schema; the table's own schema adds defaults.
			const page = <T>(schema: z.ZodType<T>) => {
				const parsed = schema.safeParse(params ?? {});
				if (!parsed.success) throw new Error("invalid_input");
				return parsed.data;
			};
			if (query === USAGE)
				return {
					revision: 0,
					data: ports.usagePage(page(usagePageQuerySchema)),
				};
			if (query === SELECTIONS)
				return {
					revision: 0,
					data: ports.history().selectionPage(page(selectionPageQuerySchema)),
				};
			if (query === RECIPES)
				return {
					revision: 0,
					data: ports.history().recipePage(page(recipePageQuerySchema)),
				};
			if (query === DIAGNOSTICS)
				return { revision: 0, data: ports.diagnostics() };
			if (query === EXPORT)
				return {
					revision: 0,
					data: {
						diagnostics: ports.diagnostics(),
						larm: ports.larm(),
						usage: ports.usage(),
					},
				};
			return null;
		},
		targetInput: () => ({}),
	};
}

const recipeRef = (id: string): AdapterResult["resultRefs"][number] => ({
	owner: "toolchain-history",
	kind: "recipe",
	id,
	schemaRef: "domain:records.recipe@1",
});
