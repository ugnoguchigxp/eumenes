import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { SourceRef } from "eumenes-memory";
import {
	buildProjection,
	evaluateConditions,
	planAssertionTransition,
	type Assertion,
	type CanonicalHasher,
	type Condition,
	type ConditionSpec,
	type ProjectionEntry,
} from "eumenes-world-model";
import {
	WriterBusyError,
	type SqliteStore,
} from "../../../infrastructure/sqlite";
import {
	claimTone,
	correctClaimSchema,
	forgetClaimSchema,
	retractClaimSchema,
	type ClaimAdoption,
	type ClaimChange,
	type ClaimContent,
	type ClaimDetail,
	type ClaimEvidenceKind,
	type ClaimList,
	type ClaimRow,
	type EvidenceView,
	type ForgetAccepted,
	type ForgetDisplay,
	type ForgetList,
	type ForgetView,
	type WorldClaimError,
	type WorldClaimsStatus,
} from "../contracts/claims";
import type { WorldApplyResult } from "../contracts";
import type { ForgetListItem, WorldLifecycle } from "./lifecycle-adapter";
import type { WorldService } from "./world-service";

/** Who is asking. Built by trusted host code, never by a request body. */
export type WorldClaimsContext = {
	principal: string;
	/** The Scopes this caller may use. Anything else looks like "not found". */
	scopeKeys: readonly string[];
};

export type WorldClaimsOptions = {
	store: SqliteStore;
	world: WorldService;
	lifecycle: WorldLifecycle;
	/** Host mode and gate (the assembly knows them; World's tables do not). */
	state: () => { mode: "protect" | "on"; gateOpen: boolean };
	/**
	 * The CURRENT source of a confirmed message of the person, or null (unknown,
	 * not theirs, not confirmed, retracted: one answer). Evaluated on the
	 * writer connection of the change.
	 */
	reasonSource: (db: Database, messageId: string) => SourceRef | null;
	/** UTC epoch ms. World never reads a clock itself. Default Date.now. */
	now?: () => number;
	/** AccessContext purposes (the host's SourceAdapters must allow them). */
	readPurpose: string;
	writePurpose: string;
	hasher?: CanonicalHasher;
	/** Told (never the person) when a forget stopped while advancing; it stays pending and is resumed. */
	onForgetAdvanceFailed?: (error: unknown) => void;
};

/** What a call can answer besides its data. Access refusals are all `not_found`. */
export type ClaimFailure =
	| { status: "failed"; code: WorldClaimError }
	/** A request that wrote nothing and needs a person's choice. */
	| { status: "failed"; code: "revision_conflict"; reload: true };
export type ClaimResult<T> = { status: "ok"; value: T } | ClaimFailure;

const fail = (code: WorldClaimError): ClaimFailure =>
	code === "revision_conflict"
		? { status: "failed", code, reload: true }
		: { status: "failed", code };
const ok = <T>(value: T): ClaimResult<T> => ({ status: "ok", value });

/** Thrown inside a writer callback to roll everything back and answer. */
class Abort extends Error {
	constructor(readonly failure: ClaimFailure) {
		super("world_claims_abort");
	}
}

const defaultHasher: CanonicalHasher = (bytes) =>
	createHash("sha256").update(bytes).digest("hex");
/** Condition freshness policy of this surface: no observations are supplied. */
const CONDITION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FORGET_LIMIT = 50;

const adoptionOf = (status: ProjectionEntry["status"]): ClaimAdoption =>
	status === "active" ? "adopted" : status;

function contentOf(assertion: Assertion): ClaimContent {
	const payload = assertion.payload;
	return payload.kind === "relation"
		? {
				kind: "relation",
				relation: payload.relation,
				objectId: payload.objectId,
			}
		: { kind: "value", value: payload.value };
}

function evidenceKindsOf(assertion: Assertion): ClaimEvidenceKind[] {
	return [...new Set(assertion.evidence.map((e) => e.kind))].sort();
}

function rowOf(entry: ProjectionEntry): ClaimRow {
	const adoption = adoptionOf(entry.status);
	const evidenceKinds = evidenceKindsOf(entry.assertion);
	return {
		id: entry.id,
		revision: entry.revision,
		target: { subjectId: entry.subjectId },
		claim: { predicate: entry.predicate, content: contentOf(entry.assertion) },
		adoption,
		origin: entry.origin,
		evidenceKinds,
		freshness: entry.freshness,
		tone: claimTone(adoption, entry.origin, evidenceKinds),
	};
}

const byClaim = (a: ClaimRow, b: ClaimRow) =>
	a.target.subjectId.localeCompare(b.target.subjectId) ||
	a.claim.predicate.localeCompare(b.claim.predicate) ||
	a.id.localeCompare(b.id);

const evidenceViews = (assertion: Assertion): EvidenceView[] =>
	assertion.evidence.map((e) => ({
		evidenceId: e.evidenceId,
		kind: e.kind,
		stance: e.stance,
		source: {
			namespace: e.source.namespace,
			kind: e.source.kind,
			id: e.source.id,
			revision: e.source.revision,
		},
		rootEvidenceId: e.rootEvidenceId,
		...(e.seriesId === undefined ? {} : { seriesId: e.seriesId }),
	}));

const valueText = (value: unknown): string => {
	const v = value as {
		kind: string;
		value?: unknown;
		unit?: string;
		entityId?: string;
	};
	if (v.kind === "entity") return `対象:${v.entityId}`;
	if (v.kind === "number") return `${String(v.value)} ${v.unit ?? ""}`.trim();
	return JSON.stringify(v.value);
};
const OPS = {
	eq: "=",
	ne: "≠",
	lt: "<",
	lte: "≤",
	gt: ">",
	gte: "≥",
} as const;
/** A bounded plain-text form of a condition (no evaluation). */
export function conditionText(spec: ConditionSpec): string {
	if (spec.kind === "unspecified") return "条件は記述されていません";
	if (spec.kind === "explicitly_unconditional") return "無条件（明示）";
	const walk = (c: Condition): string => {
		switch (c.kind) {
			case "compare":
				return `${c.key} ${OPS[c.op as keyof typeof OPS] ?? c.op} ${valueText(c.value)}`;
			case "all":
				return `(${c.items.map(walk).join(" かつ ")})`;
			case "any":
				return `(${c.items.map(walk).join(" または ")})`;
			case "not":
				return `ではない(${walk(c.item)})`;
			default:
				return "表現できない条件";
		}
	};
	return walk(spec.expression);
}

type Target = { claimId: string } | { subjectId: string; predicate: string };
type Located =
	| { kind: "one"; entry: ProjectionEntry }
	| { kind: "none" }
	| { kind: "many"; entries: ProjectionEntry[] };
function locate(entries: readonly ProjectionEntry[], target: Target): Located {
	const found =
		"claimId" in target
			? entries.filter((e) => e.id === target.claimId)
			: entries.filter(
					(e) =>
						e.subjectId === target.subjectId &&
						e.predicate === target.predicate,
				);
	if (found.length === 0) return { kind: "none" };
	if (found.length === 1) return { kind: "one", entry: found[0]! };
	return { kind: "many", entries: found };
}

/** Maps a refusal of World / the host to the one error vocabulary. */
function failureOf(result: WorldApplyResult): ClaimFailure {
	if (!("reasonCode" in result)) return fail("invalid_world_request");
	switch (result.reasonCode) {
		case "REVISION_CONFLICT":
		case "STALE_REVISION":
			return fail("revision_conflict");
		case "WORLD_DISABLED":
			return fail("world_disabled");
		case "WORLD_RECOVERY_REQUIRED":
		case "WRITER_BUSY":
		case "STORE_CLOSING":
		case "MEMORY_UNAVAILABLE":
		case "SCHEMA_INCOMPATIBLE":
			return fail("world_unavailable");
		case "SOURCE_NOT_AVAILABLE":
		case "SOURCE_VERSION_MISMATCH":
		case "MEMORY_TOMBSTONED":
			return fail("reason_source_unavailable");
		case "TERMINAL_STATE":
		case "TRANSITION_NOT_ALLOWED":
			return fail("claim_not_changeable");
		case "SCOPE_NOT_PERMITTED":
		case "SCOPE_MISMATCH":
		case "POLICY_CHANGED":
		case "TOMBSTONED":
		case "GATE_CLOSED":
		case "MEMORY_SCOPE_NOT_PERMITTED":
			return fail("not_found");
		default:
			return fail("invalid_world_request");
	}
}

function forgetView(item: ForgetListItem): ForgetView {
	const abandoned = item.abandoned.parts > 0 || item.abandoned.roots > 0;
	const display: ForgetDisplay = abandoned
		? "abandoned"
		: item.complete
			? "complete"
			: item.state === "world_applied" || item.state === "memory_confirmed"
				? "awaiting_confirmation"
				: "pending";
	return {
		forgetId: item.forgetId,
		display,
		state: item.state,
		blocked: item.blocked,
		abandoned: item.abandoned,
		origin: item.origin,
		rootCount: item.rootCount,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	};
}

/**
 * The grounded claim list and the explicit correction / retraction / forget
 * of the owner (P5-02). A read is one bounded World snapshot of a Scope the
 * host granted; a change carries the revision the person saw and becomes a
 * World operation in the host's writer transaction. Nothing here edits an
 * edge, draws a graph or decides for the person.
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

	type Read = {
		entries: readonly ProjectionEntry[];
		assertions: readonly Assertion[];
		sources: readonly {
			namespace: string;
			kind: string;
			id: string;
			representation?: string;
			revision: string;
			status: string;
		}[];
		complete: boolean;
		stopped: number;
		asOf: number;
	};
	/** One bounded snapshot of the Scope. Every refusal of access is `not_found`. */
	function readScope(
		db: Database,
		ctx: WorldClaimsContext,
		scopeKey: string,
		purpose: string,
	): ClaimResult<Read> {
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

	// --- changes ---------------------------------------------------------------

	const parse = <T>(
		schema: {
			safeParse: (
				v: unknown,
			) => { success: true; data: T } | { success: false };
		},
		raw: unknown,
	): T | null => {
		const parsed = schema.safeParse(raw);
		return parsed.success ? parsed.data : null;
	};

	const unresolved = (entries: readonly ProjectionEntry[]): ClaimChange => ({
		status: "unresolved",
		candidates: entries.map(rowOf).sort(byClaim),
	});

	/**
	 * Locate the target on the writer connection and check the revision. A
	 * return value is the answer; `entry` means "go on".
	 */
	function resolveTarget(
		db: Database,
		ctx: WorldClaimsContext,
		scopeKey: string,
		target: Target,
		expectedRevision: number,
	):
		| { entry: ProjectionEntry }
		| { answer: ClaimResult<ClaimChange | ForgetAccepted> } {
		const read = readScope(db, ctx, scopeKey, options.writePurpose);
		if (read.status !== "ok") return { answer: read };
		const located = locate(read.value.entries, target);
		if (located.kind === "none") return { answer: fail("not_found") };
		if (located.kind === "many")
			return { answer: ok(unresolved(located.entries)) };
		if (located.entry.revision !== expectedRevision)
			return { answer: fail("revision_conflict") };
		return { entry: located.entry };
	}

	function applyOrAbort(
		db: Database,
		ctx: WorldClaimsContext,
		scopeKey: string,
		operationKey: string,
		operation: unknown,
	): void {
		let result: WorldApplyResult;
		try {
			result = world.applyInWriter(db, {
				access: {
					principal: ctx.principal,
					scopeKeys: [scopeKey],
					purpose: options.writePurpose,
				},
				scope: { principal: ctx.principal, scopeKey },
				operationKey,
				clock: now(),
				operation: operation as never,
			});
		} catch (error) {
			const typedResult = world.typedFailure(error);
			throw new Abort(failureOf(typedResult));
		}
		if (result.status !== "applied" && result.status !== "no_op")
			throw new Abort(failureOf(result));
	}

	function transitionPlan(
		scopeKey: string,
		ctx: WorldClaimsContext,
		entry: ProjectionEntry,
		revision: number,
		lifecycle_: Assertion["lifecycle"],
		request: unknown,
	) {
		const scope = { principal: ctx.principal, scopeKey };
		const planned = planAssertionTransition({
			contractVersion: 1,
			scope,
			current: {
				id: entry.id,
				revision,
				scope,
				lifecycle: lifecycle_,
				origin: entry.origin,
			},
			expectedRevision: revision,
			request,
			registeredAdoptionRules: [],
		});
		if (!planned.ok) throw new Abort(fail("invalid_world_request"));
		if (planned.value.status !== "planned")
			throw new Abort(
				planned.value.reasonCode === "REVISION_CONFLICT"
					? fail("revision_conflict")
					: fail("claim_not_changeable"),
			);
		return planned.value.plan;
	}

	function change<T>(
		run: (db: Database) => ClaimResult<T>,
	): Promise<ClaimResult<T>> {
		return store
			.write((db) => run(db))
			.catch((error: unknown) => {
				if (error instanceof Abort) return error.failure;
				if (error instanceof WriterBusyError) return fail("world_unavailable");
				if (error instanceof Error && error.message === "database_closing")
					return fail("world_unavailable");
				throw error;
			});
	}

	function correct(
		ctx: WorldClaimsContext,
		raw: unknown,
	): Promise<ClaimResult<ClaimChange>> {
		const body = parse(correctClaimSchema, raw);
		if (!body) return Promise.resolve(fail("invalid_world_request"));
		const scopeKey = resolveScope(ctx, body.scopeKey);
		if (scopeKey === null) return Promise.resolve(fail("not_found"));
		return change((db) => {
			const found = resolveTarget(
				db,
				ctx,
				scopeKey,
				body.target,
				body.expectedRevision,
			);
			if ("answer" in found) return found.answer as ClaimResult<ClaimChange>;
			const entry = found.entry;
			const old = entry.assertion;
			// A relation is changed by a new relation, not by a typed value.
			if (old.payload.kind !== "value") return fail("claim_not_changeable");
			const reason = options.reasonSource(db, body.reasonMessageId);
			if (!reason) return fail("reason_source_unavailable");
			const scope = { principal: ctx.principal, scopeKey };
			const next = body.expectedRevision + 1;
			const rootId = `ui-root-${createHash("sha256").update(`${reason.id}`).digest("hex").slice(0, 32)}`;
			const replacement = {
				id: entry.id,
				revision: next,
				scope,
				subjectId: old.subjectId,
				predicate: old.predicate,
				payload: { kind: "value", value: body.value },
				evidence: [
					{
						evidenceId: `ui-ev-${body.requestId}`,
						kind: "user_statement",
						stance: "supports",
						source: reason,
						rootEvidenceId: rootId,
					},
				],
				inputManifest: [reason],
				origin: "user_report",
				recordedAt: now(),
				freshnessPolicy: old.freshnessPolicy,
				condition: old.condition,
				...(old.validTime === undefined ? {} : { validTime: old.validTime }),
				supersedes: [{ id: entry.id, revision: body.expectedRevision }],
				contradicts: [],
				interpretationVersion: old.interpretationVersion,
				lifecycle: "candidate",
				rootEvidenceIds: [rootId],
			};
			const supersede = transitionPlan(
				scopeKey,
				ctx,
				entry,
				body.expectedRevision,
				old.lifecycle,
				{ action: "supersede", replacementRevision: next },
			);
			applyOrAbort(db, ctx, scopeKey, `ui-correct-${body.requestId}`, {
				kind: "assertion.transition",
				plan: supersede,
				replacement,
			});
			// The person stated the new value themselves: that statement is the
			// explicit adoption. Both steps commit together or not at all.
			const adopt = transitionPlan(scopeKey, ctx, entry, next, "candidate", {
				action: "adopt",
				adoption: {
					kind: "explicit",
					operationId: `ui-adopt-${body.requestId}`,
				},
				subjectConfirmedByHost: true,
			});
			applyOrAbort(db, ctx, scopeKey, `ui-adopt-${body.requestId}`, {
				kind: "assertion.transition",
				plan: adopt,
			});
			return ok({ status: "applied" as const, claimId: entry.id });
		});
	}

	function retract(
		ctx: WorldClaimsContext,
		raw: unknown,
	): Promise<ClaimResult<ClaimChange>> {
		const body = parse(retractClaimSchema, raw);
		if (!body) return Promise.resolve(fail("invalid_world_request"));
		const scopeKey = resolveScope(ctx, body.scopeKey);
		if (scopeKey === null) return Promise.resolve(fail("not_found"));
		return change((db) => {
			const found = resolveTarget(
				db,
				ctx,
				scopeKey,
				body.target,
				body.expectedRevision,
			);
			if ("answer" in found) return found.answer as ClaimResult<ClaimChange>;
			const entry = found.entry;
			const reason = options.reasonSource(db, body.reasonMessageId);
			if (!reason) return fail("reason_source_unavailable");
			const plan = transitionPlan(
				scopeKey,
				ctx,
				entry,
				body.expectedRevision,
				entry.assertion.lifecycle,
				{ action: "retract", reasonSource: reason },
			);
			applyOrAbort(db, ctx, scopeKey, `ui-retract-${body.requestId}`, {
				kind: "assertion.transition",
				plan,
			});
			return ok({ status: "applied" as const, claimId: entry.id });
		});
	}

	async function forget(
		ctx: WorldClaimsContext,
		raw: unknown,
	): Promise<ClaimResult<ForgetAccepted>> {
		const body = parse(forgetClaimSchema, raw);
		if (!body) return fail("invalid_world_request");
		const scopeKey = resolveScope(ctx, body.scopeKey);
		if (scopeKey === null) return fail("not_found");
		const scope = { principal: ctx.principal, scopeKey };
		type Plan = { id: string; revisions: number };
		const located = typed<Plan | ForgetAccepted>(() =>
			store.readSnapshot((db) => {
				const found = resolveTarget(
					db,
					ctx,
					scopeKey,
					body.target,
					body.expectedRevision,
				);
				if ("answer" in found)
					return found.answer as ClaimResult<ForgetAccepted>;
				// Every revision of the claim goes: older ones keep its content too.
				return ok({ id: found.entry.id, revisions: found.entry.revision });
			}),
		);
		if (located.status !== "ok") return located;
		if ("status" in located.value) return ok(located.value);
		const plan = located.value;
		const forgetId = `ui-forget-${body.requestId}`;
		const roots = Array.from({ length: plan.revisions }, (_, i) => ({
			kind: "assertion" as const,
			id: plan.id,
			revision: i + 1,
		}));
		let accepted: Awaited<ReturnType<typeof lifecycle.acceptForget>>;
		try {
			accepted = await lifecycle.acceptForget({
				forgetId,
				scope,
				reasonCode: "FORGET_REQUESTED",
				roots,
				origin: "request",
			});
		} catch (error) {
			// The intake is durable before the forget advances. A failure while it
			// advances therefore leaves a PENDING forget that the host resumes: say
			// exactly that, not "failed".
			const left = lifecycle
				.listForgets(scope, FORGET_LIMIT)
				.find((f) => f.forgetId === forgetId);
			if (left) {
				options.onForgetAdvanceFailed?.(error);
				return ok({ status: "accepted", forget: forgetView(left) });
			}
			if (error instanceof WriterBusyError) return fail("world_unavailable");
			if (error instanceof Error && error.message === "database_closing")
				return fail("world_unavailable");
			throw error;
		}
		if ("status" in accepted && accepted.status === "rejected")
			return fail("invalid_world_request");
		const item = lifecycle
			.listForgets(scope, FORGET_LIMIT)
			.find((f) => f.forgetId === forgetId);
		if (!item) return fail("world_unavailable");
		return ok({ status: "accepted", forget: forgetView(item) });
	}

	return { status, list, detail, forgets, correct, retract, forget };
}
export type WorldClaims = ReturnType<typeof createWorldClaims>;
