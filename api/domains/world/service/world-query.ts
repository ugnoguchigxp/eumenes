import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import {
	buildProjection,
	checkDependencies,
	compareScenarios,
	edgesFromEntries,
	explainRelevance,
	findResearchGaps,
	traceInfluence,
	type CanonicalHasher,
	type ProjectionEntry,
	type ResearchGap,
} from "eumenes-world-model";
import {
	WriterBusyError,
	type SqliteStore,
} from "../../../infrastructure/sqlite";
import { goalRevisionOf } from "../../goals";
import {
	WORLD_QUERY_LIMITS,
	WORLD_QUERY_MODES,
	worldQuerySchema,
	type GapTaskLink,
	type GapTaskLinkage,
	type GapTaskPort,
	type ResourceStatePort,
	type WorldQueryBasis,
	type WorldQueryContext,
	type WorldQueryPayload,
	type WorldQueryRejection,
	type WorldQueryRequest,
	type WorldQueryResult,
} from "../contracts/query";
import { getGapTask, putGapTask } from "../repository/gap-task";
import type { WorldService } from "./world-service";

/** AccessContext purpose used when the host names none: the dialogue read purpose. */
export const WORLD_QUERY_DEFAULT_PURPOSE = "dialogue.read";
/** Condition freshness policy of this query surface. No observations are supplied, so conditions with measurements stay unknown. */
const CONDITION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type WorldQueryOptions = {
	store: SqliteStore;
	world: WorldService;
	/** UTC epoch ms. World never reads a clock itself. Default Date.now. */
	now?: () => number;
	purpose?: string;
	hasher?: CanonicalHasher;
	/** Host knowledge about resource availability. Default: none (all unknown). */
	resourceStates?: ResourceStatePort;
	/**
	 * The host's Gap -> Task entry (delegation and budget are checked there).
	 * Omitted: Gaps are displayed only and Task linkage is `not_accepted`.
	 */
	gapTasks?: GapTaskPort;
};

const defaultHasher: CanonicalHasher = (bytes) => sha256Hex(bytes);

/**
 * Stable per (principal, scope, Gap): the same Gap is the same key for ever, so
 * it can never open a second Task. Contains no claim text.
 */
export function gapTaskKey(
	scope: { principal: string; scopeKey: string },
	gapKey: string,
): string {
	return `gap:${sha256Hex(
		JSON.stringify(["world-gap/1", scope.principal, scope.scopeKey, gapKey]),
	)}`;
}

/**
 * A UUID derived from the dedupe key, for hosts whose Task entry wants a UUID
 * request id: the same key always yields the same id.
 */
export function gapTaskRequestId(dedupeKey: string): string {
	const hex = sha256Hex(dedupeKey);
	const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(
		16,
	);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const reject = (code: WorldQueryRejection): WorldQueryResult => ({
	status: "rejected",
	code,
});
const NOT_AVAILABLE = reject("not_available");
const UNAVAILABLE: WorldQueryResult = {
	status: "blocked",
	code: "world_unavailable",
};
const bytesOf = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).length;

/** Request shape and size, before anything touches the database. */
export function parseWorldQuery(
	raw: unknown,
):
	| { ok: true; request: WorldQueryRequest }
	| { ok: false; code: WorldQueryRejection } {
	let size: number;
	try {
		size = bytesOf(raw);
	} catch {
		return { ok: false, code: "invalid_request" };
	}
	if (!Number.isFinite(size)) return { ok: false, code: "invalid_request" };
	if (size > WORLD_QUERY_LIMITS.requestBytes)
		return { ok: false, code: "limit_exceeded" };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		return { ok: false, code: "invalid_request" };
	const mode = (raw as { mode?: unknown }).mode;
	if (
		typeof mode !== "string" ||
		!(WORLD_QUERY_MODES as readonly string[]).includes(mode)
	)
		return { ok: false, code: "unknown_mode" };
	const parsed = worldQuerySchema.safeParse(raw);
	if (parsed.success) return { ok: true, request: parsed.data };
	// A value above one of the published bounds is a limit, not a typo.
	const overLimit = parsed.error.issues.some(
		(issue) => issue.code === "too_big",
	);
	return { ok: false, code: overLimit ? "limit_exceeded" : "invalid_request" };
}

function basisOf(entry: ProjectionEntry): WorldQueryBasis {
	const payload = entry.assertion.payload;
	return {
		id: entry.id,
		revision: entry.revision,
		subjectId: entry.subjectId,
		predicate: entry.predicate,
		...(payload.kind === "relation"
			? { relation: { kind: payload.relation, objectId: payload.objectId } }
			: { value: payload.value }),
		status: entry.status,
		freshness: entry.freshness,
		origin: entry.origin,
		causalEligible: entry.causalEligible,
		condition: entry.assertion.condition,
		refutations: entry.refutations.map((ref) => ({
			id: ref.id,
			revision: ref.revision,
		})),
		sources: entry.sources.map((source) => ({
			namespace: source.namespace,
			kind: source.kind,
			id: source.id,
			revision: source.revision,
		})),
	};
}

/** Whole items from the front while they fit; the rest is reported as cut. */
function fitItems<T>(items: readonly T[], maxBytes: number) {
	const kept: T[] = [];
	let used = 2;
	for (const item of items) {
		const size = bytesOf(item) + 1;
		if (used + size > maxBytes) break;
		used += size;
		kept.push(item);
	}
	return { kept, truncated: kept.length < items.length };
}

type EdgeRef = { id: string; revision?: number };
/** The claims a reasoning result stands on, to attach their evidence and conditions. */
function referencedEdges(payload: WorldQueryPayload): EdgeRef[] {
	const refs: EdgeRef[] = [];
	const influence = (result: {
		paths: readonly { edges: readonly { id: string; revision: number }[] }[];
		skipped: readonly { edgeId: string }[];
	}) => {
		for (const path of result.paths)
			for (const edge of path.edges)
				refs.push({ id: edge.id, revision: edge.revision });
		for (const skipped of result.skipped) refs.push({ id: skipped.edgeId });
	};
	switch (payload.mode) {
		case "snapshot":
			break;
		case "relevance":
			for (const relation of payload.relevance.relations)
				refs.push({ id: relation.edgeId, revision: relation.revision });
			break;
		case "influence":
			influence(payload.influence);
			break;
		case "dependencies":
			for (const item of payload.dependencies.dependencies)
				refs.push({ id: item.viaEdgeId });
			break;
		case "scenarios":
			influence(payload.scenarios.baseline);
			for (const overlay of payload.scenarios.overlays)
				influence(overlay.influence);
			break;
		case "gaps":
			for (const gap of payload.gaps.gaps) refs.push({ id: gap.edgeId });
			break;
	}
	return refs;
}

const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * `world.query`: enumerated, bounded, read-only reasoning over one permitted
 * Scope. It validates the request, reads ONE bounded World snapshot through the
 * host's World service (which re-checks access, source versions and epochs),
 * and hands the result to World's pure reasoning API. It writes nothing except,
 * on an explicit `linkGaps` request, the Gap -> Task record, and only after the
 * host's Task port approved.
 */
export function createWorldQuery(options: WorldQueryOptions) {
	const { store, world } = options;
	const now = options.now ?? Date.now;
	const purpose = options.purpose ?? WORLD_QUERY_DEFAULT_PURPOSE;
	const hasher = options.hasher ?? defaultHasher;

	function resolveScope(ctx: WorldQueryContext, request: WorldQueryRequest) {
		const keys = Array.isArray(ctx.scopeKeys) ? ctx.scopeKeys : [];
		if (typeof ctx.principal !== "string" || ctx.principal === "") return null;
		if (request.scopeKey !== undefined)
			return keys.includes(request.scopeKey) ? request.scopeKey : null;
		return keys.length === 1 ? (keys[0] ?? null) : null;
	}

	function linkGaps(
		db: Database,
		ctx: WorldQueryContext,
		scopeKey: string,
		gaps: readonly ResearchGap[],
		port: GapTaskPort,
		nowMs: number,
	): GapTaskLinkage {
		const scope = { principal: ctx.principal, scopeKey };
		const links: GapTaskLink[] = [];
		const seen = new Set<string>();
		let attempted = 0;
		for (const gap of gaps) {
			const dedupeKey = gapTaskKey(scope, gap.gapKey);
			if (seen.has(dedupeKey)) continue;
			seen.add(dedupeKey);
			const base = { gapKey: gap.gapKey, dedupeKey };
			if (attempted >= WORLD_QUERY_LIMITS.gapLinks) {
				links.push({ ...base, status: "skipped", reason: "link_limit" });
				continue;
			}
			attempted++;
			// The same Gap never reaches the port twice.
			if (getGapTask(db, scope.principal, scopeKey, dedupeKey)) {
				links.push({ ...base, status: "linked" });
				continue;
			}
			const decision = port.linkInTransaction(db, {
				principal: scope.principal,
				scopeKey,
				dedupeKey,
				gap,
				origin: ctx.origin,
			});
			if (
				decision?.status === "created" &&
				typeof decision.taskRef === "string" &&
				decision.taskRef !== "" &&
				decision.taskRef.length <= 200
			) {
				putGapTask(
					db,
					scope.principal,
					scopeKey,
					dedupeKey,
					decision.taskRef,
					nowMs,
				);
				links.push({ ...base, status: "created" });
			} else {
				const reason =
					decision?.status === "denied" && REASON_CODE.test(decision.reason)
						? decision.reason
						: "denied";
				links.push({ ...base, status: "denied", reason });
			}
		}
		return { status: "attempted", links };
	}

	function execute(
		db: Database,
		ctx: WorldQueryContext,
		request: WorldQueryRequest,
		link: boolean,
	): WorldQueryResult {
		if (!db.inTransaction) throw new Error("world_query_transaction_required");
		const status = world.statusInTransaction(db);
		if (!status.enabled) return { status: "disabled", code: "world_disabled" };
		if (!status.usable) return UNAVAILABLE;
		const scopeKey = resolveScope(ctx, request);
		if (scopeKey === null) return NOT_AVAILABLE;
		const scope = { principal: ctx.principal, scopeKey };
		const access = {
			principal: ctx.principal,
			scopeKeys: [scopeKey],
			purpose: ctx.purpose ?? purpose,
		};
		const asOf = now();

		// Goal: an adopted Goal of THIS scope, or a withdrawn one that blocks nothing.
		let goal:
			| { goalId: string; revision: number; status: "adopted" | "retracted" }
			| undefined;
		if (request.mode === "gaps" && request.goalId !== undefined) {
			let found: ReturnType<typeof goalRevisionOf> = null;
			try {
				found = goalRevisionOf(db, request.goalId, access);
			} catch {
				return NOT_AVAILABLE;
			}
			if (
				found === null ||
				found.scopeKey !== scopeKey ||
				found.principal !== ctx.principal
			)
				return NOT_AVAILABLE;
			if (found.status === "adopted")
				goal = {
					goalId: found.goalId,
					revision: found.revision,
					status: "adopted",
				};
			else if (found.status === "withdrawn")
				goal = {
					goalId: found.goalId,
					revision: found.revision,
					status: "retracted",
				};
			else return NOT_AVAILABLE;
		}

		// Budgets: a request value above the published bound was rejected at parse time.
		const budget = request.budget ?? {};
		const starts =
			"entityId" in request
				? [request.entityId]
				: "entityIds" in request
					? request.entityIds
					: undefined;
		const depth =
			request.mode === "snapshot"
				? (request.depth ?? 1)
				: request.mode === "influence" || request.mode === "scenarios"
					? (budget.causalDepth ?? WORLD_QUERY_LIMITS.budget.causalDepth)
					: Math.min(
							WORLD_QUERY_LIMITS.focusDepth,
							budget.relevanceDepth ?? WORLD_QUERY_LIMITS.budget.relevanceDepth,
						);
		const read = world.readSnapshot(db, {
			access,
			scope,
			asOf,
			...(starts === undefined
				? {}
				: { focus: { subjectIds: [...starts], depth } }),
			...(budget.candidates === undefined && budget.expansions === undefined
				? {}
				: {
						budget: {
							...(budget.candidates === undefined
								? {}
								: { candidates: budget.candidates }),
							...(budget.expansions === undefined
								? {}
								: { expansions: budget.expansions }),
						},
					}),
		});
		if (read.status === "blocked" && read.reasonCode === "WORLD_DISABLED")
			return { status: "disabled", code: "world_disabled" };
		// Tombstoned, closed gate, wrong access, policy change... all look the same.
		if (read.status !== "ready")
			return read.status === "blocked" &&
				["WORLD_RECOVERY_REQUIRED", "STORE_CLOSING"].includes(read.reasonCode)
				? UNAVAILABLE
				: NOT_AVAILABLE;

		const projection = buildProjection(
			{ contractVersion: 1, snapshot: read.snapshot },
			hasher,
		);
		if (!projection.ok) return UNAVAILABLE;
		const entries = projection.value.entries;
		const retrieval = {
			partial: read.coverage.partial || !read.snapshot.complete,
			reasons: [
				...read.coverage.reasons,
				...(read.snapshot.complete ? [] : ["SNAPSHOT_INCOMPLETE"]),
			],
			fetchedRows: read.coverage.fetchedRows,
			expandedRows: read.coverage.expandedRows,
		};
		const envelope = {
			status: "ok" as const,
			mode: request.mode,
			scopeKey,
			asOf,
			retrieval,
			referenceOnly: true as const,
			executionPermission: "none" as const,
		};

		if (request.mode === "snapshot") {
			const all = entries.map(basisOf);
			const fit = fitItems(all, WORLD_QUERY_LIMITS.snapshotBytes);
			const reasons = [
				...retrieval.reasons,
				...(fit.truncated ? ["PRESENTATION_BUDGET"] : []),
			];
			return {
				...envelope,
				completeness: reasons.length > 0 ? "partial" : "complete",
				reasons: [...new Set(reasons)].sort(),
				result: { mode: "snapshot", entries: fit.kept },
				basis: [],
				basisTruncated: false,
			};
		}

		const graph = {
			contractVersion: 1,
			scope,
			// The read above verified access, gate, source and tombstone checks.
			authorized: true,
			edges: edgesFromEntries(entries),
			asOf,
			maxAgeMs: CONDITION_MAX_AGE_MS,
			observations: [],
			budget,
		};
		let payload: WorldQueryPayload;
		let reasoning: { status: string; reasons: readonly string[] };
		let gaps: readonly ResearchGap[] = [];
		const failed = (code: string): WorldQueryResult =>
			reject(code === "LIMIT_EXCEEDED" ? "limit_exceeded" : "invalid_request");
		switch (request.mode) {
			case "relevance": {
				const result = explainRelevance({
					...graph,
					entityId: request.entityId,
				});
				if (!result.ok) return failed(result.code);
				payload = { mode: "relevance", relevance: result.value };
				reasoning = result.value;
				break;
			}
			case "influence": {
				const result = traceInfluence({
					...graph,
					entityId: request.entityId,
					direction: request.direction ?? "forward",
				});
				if (!result.ok) return failed(result.code);
				payload = { mode: "influence", influence: result.value };
				reasoning = result.value;
				break;
			}
			case "dependencies": {
				const result = checkDependencies({
					...graph,
					entityId: request.entityId,
					resourceStates: options.resourceStates?.(db, scope) ?? [],
				});
				if (!result.ok) return failed(result.code);
				payload = { mode: "dependencies", dependencies: result.value };
				reasoning = result.value;
				break;
			}
			case "scenarios": {
				const result = compareScenarios({
					...graph,
					entityId: request.entityId,
					direction: request.direction ?? "forward",
					overlays: request.overlays,
				});
				if (!result.ok) return failed(result.code);
				payload = {
					mode: "scenarios",
					scenarios: result.value,
					hypothetical: true,
				};
				reasoning = {
					status: result.value.status,
					reasons: [
						...result.value.reasons,
						...result.value.baseline.reasons,
						...result.value.overlays.flatMap((o) => o.influence.reasons),
					],
				};
				break;
			}
			case "gaps": {
				const result = findResearchGaps({
					...graph,
					resourceStates: options.resourceStates?.(db, scope) ?? [],
					...(goal === undefined ? {} : { goal }),
				});
				if (!result.ok) return failed(result.code);
				payload = { mode: "gaps", gaps: result.value };
				reasoning = result.value;
				gaps = result.value.gaps;
				break;
			}
			default:
				return reject("unknown_mode");
		}

		// Evidence and conditions of the claims the result names, whole items only.
		const byKey = new Map(
			entries.map((e) => [`${e.id}\u0000${e.revision}`, e]),
		);
		const byId = new Map(entries.map((e) => [e.id, e]));
		const wanted = new Map<string, ProjectionEntry>();
		for (const ref of referencedEdges(payload)) {
			const entry =
				ref.revision === undefined
					? byId.get(ref.id)
					: byKey.get(`${ref.id}\u0000${ref.revision}`);
			if (entry) wanted.set(`${entry.id}\u0000${entry.revision}`, entry);
		}
		const fit = fitItems(
			[...wanted.values()].map(basisOf),
			WORLD_QUERY_LIMITS.basisBytes,
		);

		const reasons = [
			...new Set([...retrieval.reasons, ...reasoning.reasons]),
		].sort();
		const taskLinkage: GapTaskLinkage | undefined =
			request.mode !== "gaps" || request.linkGaps !== true
				? undefined
				: link && options.gapTasks
					? linkGaps(db, ctx, scopeKey, gaps, options.gapTasks, asOf)
					: { status: "not_accepted" };
		return {
			...envelope,
			completeness:
				retrieval.partial || reasoning.status !== "complete"
					? "partial"
					: "complete",
			reasons,
			result: payload,
			basis: fit.kept,
			basisTruncated: fit.truncated,
			...(taskLinkage === undefined ? {} : { taskLinkage }),
		};
	}

	function typedFailure(error: unknown): WorldQueryResult {
		if (error instanceof WriterBusyError) return UNAVAILABLE;
		if (error instanceof Error && error.message === "database_closing")
			return UNAVAILABLE;
		throw error;
	}

	return {
		/** Read side only: never links Tasks. For a caller already inside a snapshot. */
		queryInTransaction(
			db: Database,
			ctx: WorldQueryContext,
			raw: unknown,
		): WorldQueryResult {
			const parsed = parseWorldQuery(raw);
			if (!parsed.ok) return reject(parsed.code);
			return execute(db, ctx, parsed.request, false);
		},
		/**
		 * One query. A read on the readonly snapshot, except an explicit
		 * `linkGaps` with a Task port: then the read and the linkage share one
		 * writer transaction, so a Task is never created for a Scope that was
		 * forgotten in between.
		 */
		async query(
			ctx: WorldQueryContext,
			raw: unknown,
		): Promise<WorldQueryResult> {
			const parsed = parseWorldQuery(raw);
			if (!parsed.ok) return reject(parsed.code);
			const request = parsed.request;
			try {
				if (
					request.mode === "gaps" &&
					request.linkGaps === true &&
					options.gapTasks !== undefined
				)
					return await store.write((db) => execute(db, ctx, request, true));
				return store.readSnapshot((db) => execute(db, ctx, request, false));
			} catch (error) {
				return typedFailure(error);
			}
		},
	};
}
export type WorldQuery = ReturnType<typeof createWorldQuery>;
