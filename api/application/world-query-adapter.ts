import type { Database } from "bun:sqlite";
import { listEntities } from "eumenes-world-model/sqlite";
import { z } from "zod";
import {
	WORLD_QUERY_TOOL_ID,
	createWorldQuery,
	type WorldQueryContext,
	type WorldQueryResult,
	type WorldService,
} from "../domains/world";
import {
	WORLD_QUERY_MODES,
	worldQueryToolSchema,
} from "../domains/world/contracts/query";
import type { AdapterResult, DomainAdapter } from "../domains/tool-runtime";
import { sha256Hex } from "../infrastructure/digest";
import type { SqliteStore } from "../infrastructure/sqlite";

export const WORLD_QUERY_ADAPTER_REF = "adapter:world-query@1";
const RECEIPT = "domain:world-query.receipt@1";
/** The id of a query is the query itself (below), so its size is bounded. */
const MAX_QUERY_BYTES = 16 * 1024;
/** The answer sees one bounded projection (the agent runtime refuses more than 32 KiB). */
const ANSWER_CONTEXT_BYTES = 30_000;
/** Targets the command sub-agent is shown, so it can name a start point by id. */
const SNAPSHOT_ENTITIES = 50;
const OPERATION_PREFIX = "wq1.";

/** What the tool leaves behind: which query ran. It never carries a claim. */
export const worldQueryReceipt = z.strictObject({
	version: z.literal(1),
	kind: z.literal("world_query"),
	mode: z.enum(WORLD_QUERY_MODES),
	inputDigest: z.string(),
});
type WorldQueryReceipt = z.infer<typeof worldQueryReceipt>;
export const worldQueryDomainSchemas = { [RECEIPT]: worldQueryReceipt };

/** The conversation agent's `world_query`: one read operation, no screen sources. */
export const describeWorldQueryAdapter = () => ({
	owner: "world",
	operations: new Map([
		[
			WORLD_QUERY_TOOL_ID,
			{ inputSchemaRef: "builtin:worldQuery", effect: "read" as const },
		],
	]),
	queries: new Set<string>(),
	inputAdapters: new Map(),
	projections: new Set(["projection:world-query.result@1"]),
	availability: "availability:world-query@1",
});

/** What the adapter reads; the Scope and the purpose are bound by the host, never by the model. */
export type WorldQueryAdapterPorts = {
	/** World is configured, ON and its gate is open. */
	available(db: Database): boolean;
	/** The read side of `world.query`: it never links a Task. */
	queryInTransaction(db: Database, raw: unknown): WorldQueryResult;
	/** Targets the command sub-agent may name as start points (host data). */
	entitiesInTransaction(db: Database): Array<{ id: string; name: string }>;
};
/** Absent while World is not ON: the tool is then not offered. */
export type WorldQueryAdapterPortsLookup = () =>
	| WorldQueryAdapterPorts
	| undefined;

/**
 * The ports from the World service: `world.query` without a Task port (so `linkGaps` could not
 * link anything even if it reached it) and the listing of the Scope's live targets.
 */
export function createWorldQueryPorts(options: {
	store: SqliteStore;
	world: WorldService;
	/** Who asks: bound by the host to the conversation's principal and Scope. */
	context: () => WorldQueryContext;
}): WorldQueryAdapterPorts {
	const { store, world } = options;
	const query = createWorldQuery({ store, world });
	return {
		available: (db) => world.statusInTransaction(db).usable,
		queryInTransaction: (db, raw) =>
			query.queryInTransaction(db, options.context(), raw),
		entitiesInTransaction(db) {
			const ctx = options.context();
			const scopeKey = ctx.scopeKeys[0];
			if (scopeKey === undefined) return [];
			const listed = listEntities(db, {
				contractVersion: 1,
				access: world.accessInTransaction(db, {
					access: {
						principal: ctx.principal,
						scopeKeys: [scopeKey],
						purpose: ctx.purpose ?? "dialogue.read",
					},
				}),
				scopeKey,
				limit: SNAPSHOT_ENTITIES,
			});
			return listed.status === "ready"
				? listed.entities.map((e) => ({ id: e.id, name: e.displayName }))
				: [];
		},
	};
}

const bytesOf = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).length;

type OkResult = Extract<WorldQueryResult, { status: "ok" }>;

/**
 * The projection the answer sees: the result and the claims behind it as reference data. Past the
 * size the agent runtime accepts, the basis is cut first, then the result is left out and said so.
 */
export function worldQueryAnswerContext(result: OkResult) {
	const head = {
		version: 1,
		kind: "world_query",
		mode: result.mode,
		scopeKey: result.scopeKey,
		asOf: result.asOf,
		referenceOnly: result.referenceOnly,
		executionPermission: result.executionPermission,
	} as const;
	let basis = result.basis;
	let basisTruncated = result.basisTruncated;
	const build = () => ({
		...head,
		completeness: result.completeness,
		reasons: result.reasons,
		result: result.result,
		basis,
		basisTruncated,
	});
	while (bytesOf(build()) > ANSWER_CONTEXT_BYTES && basis.length > 0) {
		basis = basis.slice(0, Math.floor(basis.length / 2));
		basisTruncated = true;
	}
	if (bytesOf(build()) <= ANSWER_CONTEXT_BYTES) return build();
	return {
		...head,
		completeness: "partial" as const,
		reasons: [...result.reasons, "result_omitted_by_size"],
		result: null,
		basis: [],
		basisTruncated: true,
	};
}

/** The failure a query that gave no result reports (a content-free machine code). */
const failureCode = (result: Exclude<WorldQueryResult, { status: "ok" }>) =>
	result.code;

export function createWorldQueryAdapter(
	lookup: WorldQueryAdapterPortsLookup,
): DomainAdapter {
	const need = (): WorldQueryAdapterPorts => {
		const ports = lookup();
		if (!ports) throw new Error("capability_unavailable");
		return ports;
	};

	/** The operation id is the validated query: the ledger keeps only ids and digests, so a read later re-asks. */
	const operationIdOf = (input: unknown) => {
		const json = JSON.stringify(input);
		if (new TextEncoder().encode(json).length > MAX_QUERY_BYTES)
			throw new Error("limit_exceeded");
		return OPERATION_PREFIX + Buffer.from(json, "utf8").toString("base64url");
	};
	const inputOf = (operationId: string) => {
		if (!operationId.startsWith(OPERATION_PREFIX)) return null;
		try {
			const raw: unknown = JSON.parse(
				Buffer.from(
					operationId.slice(OPERATION_PREFIX.length),
					"base64url",
				).toString("utf8"),
			);
			const parsed = worldQueryToolSchema.safeParse(raw);
			return parsed.success ? parsed.data : null;
		} catch {
			return null;
		}
	};

	function result(
		operationId: string,
		query: z.infer<typeof worldQueryToolSchema>,
		answered: OkResult,
		replay: boolean,
	): AdapterResult {
		const receipt: WorldQueryReceipt = {
			version: 1,
			kind: "world_query",
			mode: query.mode,
			inputDigest: sha256Hex(JSON.stringify(query)),
		};
		return {
			receipt,
			receiptRef: {
				owner: "world",
				operationId,
				digest: sha256Hex(JSON.stringify(receipt)),
			},
			resultRefs: [],
			replay,
			answerContext: worldQueryAnswerContext(answered),
		};
	}

	return {
		ref: WORLD_QUERY_ADAPTER_REF,
		describe: describeWorldQueryAdapter,
		availableInTransaction: (tx) => lookup()?.available(tx) ?? false,
		snapshotInTransaction: (tx) => ({
			entities: lookup()?.entitiesInTransaction(tx) ?? [],
		}),
		invokeInTransaction(tx, request) {
			if (request.operationName !== WORLD_QUERY_TOOL_ID)
				throw new Error("unsupported_operation");
			// A query is the conversation agent's: no screen makes one.
			if (request.origin.kind !== "conversation")
				throw new Error("unsupported_origin");
			const ports = need();
			// The model's vocabulary: `linkGaps` is an unknown key here and is refused, never ignored.
			const parsed = worldQueryToolSchema.safeParse(request.input);
			if (!parsed.success) throw new Error("invalid_input");
			const operationId = operationIdOf(parsed.data);
			const answered = ports.queryInTransaction(tx, parsed.data);
			if (answered.status !== "ok") throw new Error(failureCode(answered));
			return result(operationId, parsed.data, answered, false);
		},
		readInTransaction(tx, operationId) {
			const query = inputOf(operationId);
			const ports = lookup();
			if (!query || !ports) return null;
			const answered = ports.queryInTransaction(tx, query);
			return answered.status === "ok"
				? result(operationId, query, answered, true)
				: null;
		},
		sourceInTransaction: () => null,
		targetInput: () => ({}),
	};
}
