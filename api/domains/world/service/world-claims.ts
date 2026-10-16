import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import {
	buildProjection,
	evaluateConditions,
	type CanonicalHasher,
} from "eumenes-world-model";
import { WriterBusyError } from "../../../infrastructure/sqlite";
import type {
	ClaimDetail,
	ClaimList,
	ForgetList,
	WorldClaimsStatus,
} from "../contracts/claims";
import {
	FORGET_LIMIT,
	adoptionOf,
	byClaim,
	conditionText,
	contentOf,
	evidenceViews,
	fail,
	forgetView,
	ok,
	rowOf,
	type ClaimResult,
	type ScopeRead,
	type WorldClaimsContext,
	type WorldClaimsOptions,
} from "./world-claims-shared";

export { conditionText } from "./world-claims-shared";
export type {
	ClaimResult,
	WorldClaimsContext,
	WorldClaimsOptions,
} from "./world-claims-shared";

const defaultHasher: CanonicalHasher = (bytes) => sha256Hex(bytes);
/** Condition freshness policy of this surface: no observations are supplied. */
const CONDITION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The grounded claim list of the owner (P5-02), view only: claims are kept by the
 * memory steward. A read is one bounded World snapshot of a Scope the host
 * granted. Nothing here edits an edge, draws a graph or decides for the person.
 */
export function createWorldClaims(options: WorldClaimsOptions) {
	const { store, world, lifecycle } = options;
	const now = options.now ?? Date.now;
	const hasher = options.hasher ?? defaultHasher;

	function resolveScope(
		ctx: WorldClaimsContext,
		requested: string | undefined,
	): string | null {
		const keys = Array.isArray(ctx.scopeKeys) ? ctx.scopeKeys : [];
		if (typeof ctx.principal !== "string" || ctx.principal === "") return null;
		if (requested !== undefined)
			return keys.includes(requested) ? requested : null;
		return keys.length === 1 ? (keys[0] ?? null) : null;
	}

	const accessOf = (
		ctx: WorldClaimsContext,
		scopeKey: string,
		purpose: string,
	) => ({ principal: ctx.principal, scopeKeys: [scopeKey], purpose });

	/** One bounded snapshot of the Scope. Every refusal of access is `not_found`. */
	function readScope(
		db: Database,
		ctx: WorldClaimsContext,
		scopeKey: string,
		purpose: string,
	): ClaimResult<ScopeRead> {
		const status = world.statusInTransaction(db);
		if (!status.enabled) return fail("world_disabled");
		if (!status.usable) return fail("world_unavailable");
		const asOf = now();
		const read = world.readSnapshot(db, {
			access: accessOf(ctx, scopeKey, purpose),
			scope: { principal: ctx.principal, scopeKey },
			asOf,
		});
		if (read.status === "blocked" && read.reasonCode === "WORLD_DISABLED")
			return fail("world_disabled");
		if (read.status !== "ready")
			return read.status === "blocked" &&
				["WORLD_RECOVERY_REQUIRED", "STORE_CLOSING"].includes(read.reasonCode)
				? fail("world_unavailable")
				: fail("not_found");
		const projection = buildProjection(
			{ contractVersion: 1, snapshot: read.snapshot },
			hasher,
		);
		if (!projection.ok) return fail("world_unavailable");
		return ok({
			entries: projection.value.entries,
			assertions: read.snapshot.assertions,
			sources: read.snapshot.sources,
			complete: !read.coverage.partial && read.snapshot.complete,
			stopped: projection.value.excluded.filter(
				(x) => x.reason === "SOURCE_NOT_CURRENT",
			).length,
			asOf,
		});
	}

	function scopesOf(ctx: WorldClaimsContext) {
		return [...new Set(ctx.scopeKeys)].map((scopeKey) => ({ scopeKey }));
	}

	function typed<T>(run: () => ClaimResult<T>): ClaimResult<T> {
		try {
			return run();
		} catch (error) {
			if (error instanceof WriterBusyError) return fail("world_unavailable");
			if (error instanceof Error && error.message === "database_closing")
				return fail("world_unavailable");
			throw error;
		}
	}

	// --- reads ---------------------------------------------------------------

	function status(ctx: WorldClaimsContext): WorldClaimsStatus {
		const host = options.state();
		const world_ = store.readSnapshot((db) => world.statusInTransaction(db));
		return {
			mode: host.mode,
			enabled: world_.enabled,
			usable: world_.usable,
			gateOpen: host.gateOpen,
			scopes: scopesOf(ctx),
		};
	}

	function list(
		ctx: WorldClaimsContext,
		request: { scopeKey?: string } = {},
	): ClaimResult<ClaimList> {
		const scopeKey = resolveScope(ctx, request.scopeKey);
		if (scopeKey === null) return fail("not_found");
		return typed(() =>
			store.readSnapshot((db) => {
				const read = readScope(db, ctx, scopeKey, options.readPurpose);
				if (read.status !== "ok") return read;
				return ok({
					scopeKey,
					scopes: scopesOf(ctx),
					asOf: read.value.asOf,
					complete: read.value.complete,
					stopped: read.value.stopped,
					items: read.value.entries.map(rowOf).sort(byClaim),
				});
			}),
		);
	}

	function detail(
		ctx: WorldClaimsContext,
		request: { scopeKey?: string; claimId: string },
	): ClaimResult<ClaimDetail> {
		const scopeKey = resolveScope(ctx, request.scopeKey);
		if (scopeKey === null || typeof request.claimId !== "string")
			return fail("not_found");
		return typed(() =>
			store.readSnapshot((db) => {
				const read = readScope(db, ctx, scopeKey, options.readPurpose);
				if (read.status !== "ok") return read;
				const entry = read.value.entries.find((e) => e.id === request.claimId);
				if (!entry) return fail("not_found");
				const assertion = entry.assertion;
				const evaluation = evaluateConditions({
					contractVersion: 1,
					asOf: read.value.asOf,
					authorized: true,
					maxAgeMs: CONDITION_MAX_AGE_MS,
					condition: assertion.condition,
					...(assertion.validTime === undefined
						? {}
						: { validTime: assertion.validTime }),
					observations: [],
				});
				const history = world.readHistory(db, {
					access: accessOf(ctx, scopeKey, options.readPurpose),
					scope: { principal: ctx.principal, scopeKey },
					assertionId: entry.id,
				});
				if (history.status === "blocked") {
					return fail(
						history.reasonCode === "WORLD_DISABLED"
							? "world_disabled"
							: "world_unavailable",
					);
				}
				if (history.status !== "ready") return fail("not_found");
				const states = new Map(
					read.value.sources.map((s) => [
						`${s.namespace}\u0000${s.kind}\u0000${s.id}\u0000${s.representation ?? ""}`,
						s,
					]),
				);
				const byId = new Map(read.value.entries.map((e) => [e.id, e]));
				const row = rowOf(entry);
				return ok({
					claim: row,
					scopeKey,
					asOf: read.value.asOf,
					recordedAt: assertion.recordedAt,
					condition: {
						kind: assertion.condition.kind,
						text: conditionText(assertion.condition),
						evaluation: evaluation.ok ? evaluation.value.result : "unknown",
						reasons: evaluation.ok ? [...evaluation.value.reasons] : [],
					},
					supports: evidenceViews(assertion).filter(
						(e) => e.stance === "supports",
					),
					refutations: {
						evidence: evidenceViews(assertion).filter(
							(e) => e.stance === "refutes",
						),
						claims: entry.refutations.map((ref) => {
							const other = byId.get(ref.id);
							return {
								id: ref.id,
								revision: ref.revision,
								...(other
									? {
											subjectId: other.subjectId,
											predicate: other.predicate,
											adoption: adoptionOf(other.status),
										}
									: {}),
							};
						}),
					},
					sources: entry.sources.map((ref) => {
						const state = states.get(
							`${ref.namespace}\u0000${ref.kind}\u0000${ref.id}\u0000${ref.representation ?? ""}`,
						);
						return {
							namespace: ref.namespace,
							kind: ref.kind,
							id: ref.id,
							citedRevision: ref.revision,
							state:
								state?.status === "available" && state.revision === ref.revision
									? ("current" as const)
									: state?.status === "changed" ||
										  (state?.status === "available" &&
												state.revision !== ref.revision)
										? ("changed" as const)
										: ("unavailable" as const),
						};
					}),
					history: history.revisions.map((r) => ({
						revision: r.revision,
						lifecycle: r.lifecycle,
						origin: r.origin,
						recordedAt: r.recordedAt,
						content: contentOf(r),
					})),
					historyTruncated: history.truncated,
				});
			}),
		);
	}

	/** Forgets of the Scope: durable, independent of ON/OFF and of the Scope gate. */
	function forgets(
		ctx: WorldClaimsContext,
		request: { scopeKey?: string } = {},
	): ClaimResult<ForgetList> {
		const scopeKey = resolveScope(ctx, request.scopeKey);
		if (scopeKey === null) return fail("not_found");
		return typed(() =>
			ok({
				scopeKey,
				forgets: lifecycle
					.listForgets({ principal: ctx.principal, scopeKey }, FORGET_LIMIT)
					.map(forgetView),
			}),
		);
	}

	return { status, list, detail, forgets };
}
export type WorldClaims = ReturnType<typeof createWorldClaims>;
