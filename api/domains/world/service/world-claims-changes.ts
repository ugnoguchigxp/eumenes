import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import {
	planAssertionTransition,
	type Assertion,
	type ProjectionEntry,
} from "eumenes-world-model";
import { WriterBusyError } from "../../../infrastructure/sqlite";
import {
	correctClaimSchema,
	forgetClaimSchema,
	retractClaimSchema,
	type ClaimChange,
	type ForgetAccepted,
	type ForgetClaim,
	type ForgetView,
} from "../contracts/claims";
import type { WorldApplyResult } from "../contracts";
import {
	Abort,
	FORGET_LIMIT,
	byClaim,
	fail,
	failureOf,
	forgetView,
	locate,
	ok,
	rowOf,
	type ClaimFailure,
	type ClaimResult,
	type ScopeRead,
	type Target,
	type WorldClaimsContext,
	type WorldClaimsOptions,
} from "./world-claims-shared";

/** What the changes borrow from the claims they belong to. */
export type ClaimChangeDeps = {
	options: WorldClaimsOptions;
	now: () => number;
	resolveScope(
		ctx: WorldClaimsContext,
		requested: string | undefined,
	): string | null;
	readScope(
		db: Database,
		ctx: WorldClaimsContext,
		scopeKey: string,
		purpose: string,
	): ClaimResult<ScopeRead>;
	typed<T>(run: () => ClaimResult<T>): ClaimResult<T>;
};

/** A prelude failure, or the work to run once a writer connection is at hand. */
type Plan<T> = ClaimFailure | ((db: Database) => ClaimResult<T>);

const parse = <T>(
	schema: {
		safeParse: (v: unknown) => { success: true; data: T } | { success: false };
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
	deps: ClaimChangeDeps,
	db: Database,
	ctx: WorldClaimsContext,
	scopeKey: string,
	target: Target,
	expectedRevision: number,
):
	| { entry: ProjectionEntry }
	| { answer: ClaimResult<ClaimChange | ForgetAccepted> } {
	const read = deps.readScope(db, ctx, scopeKey, deps.options.writePurpose);
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
	deps: ClaimChangeDeps,
	db: Database,
	ctx: WorldClaimsContext,
	scopeKey: string,
	operationKey: string,
	operation: unknown,
): void {
	const { world, writePurpose } = deps.options;
	let result: WorldApplyResult;
	try {
		result = world.applyInWriter(db, {
			access: {
				principal: ctx.principal,
				scopeKeys: [scopeKey],
				purpose: writePurpose,
			},
			scope: { principal: ctx.principal, scopeKey },
			operationKey,
			clock: deps.now(),
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

/** The host's single writer: a failure rolls the whole change back and answers. */
function change<T>(
	deps: ClaimChangeDeps,
	plan: Plan<T>,
): Promise<ClaimResult<T>> {
	if (typeof plan !== "function") return Promise.resolve(plan);
	return deps.options.store
		.write((db) => plan(db))
		.catch((error: unknown) => {
			if (error instanceof Abort) return error.failure;
			if (error instanceof WriterBusyError) return fail("world_unavailable");
			if (error instanceof Error && error.message === "database_closing")
				return fail("world_unavailable");
			throw error;
		});
}

/**
 * The same work inside a transaction the caller owns: any answer other than ok (and any
 * thrown refusal) leaves nothing of it behind, so a change is never half applied.
 */
function atomic<T>(db: Database, plan: Plan<T>): ClaimResult<T> {
	if (typeof plan !== "function") return plan;
	db.exec("SAVEPOINT world_claim_change");
	const undo = () => {
		db.exec("ROLLBACK TO world_claim_change");
		db.exec("RELEASE world_claim_change");
	};
	try {
		const result = plan(db);
		if (result.status !== "ok") undo();
		else db.exec("RELEASE world_claim_change");
		return result;
	} catch (error) {
		undo();
		if (error instanceof Abort) return error.failure;
		throw error;
	}
}

function planCorrect(
	deps: ClaimChangeDeps,
	ctx: WorldClaimsContext,
	raw: unknown,
): Plan<ClaimChange> {
	const body = parse(correctClaimSchema, raw);
	if (!body) return fail("invalid_world_request");
	const scopeKey = deps.resolveScope(ctx, body.scopeKey);
	if (scopeKey === null) return fail("not_found");
	return (db) => {
		const found = resolveTarget(
			deps,
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
		const reason = deps.options.reasonSource(db, body.reasonMessageId);
		if (!reason) return fail("reason_source_unavailable");
		const scope = { principal: ctx.principal, scopeKey };
		const next = body.expectedRevision + 1;
		const rootId = `ui-root-${sha256Hex(`${reason.id}`).slice(0, 32)}`;
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
			recordedAt: deps.now(),
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
		applyOrAbort(deps, db, ctx, scopeKey, `ui-correct-${body.requestId}`, {
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
		applyOrAbort(deps, db, ctx, scopeKey, `ui-adopt-${body.requestId}`, {
			kind: "assertion.transition",
			plan: adopt,
		});
		return ok({ status: "applied" as const, claimId: entry.id });
	};
}

function planRetract(
	deps: ClaimChangeDeps,
	ctx: WorldClaimsContext,
	raw: unknown,
): Plan<ClaimChange> {
	const body = parse(retractClaimSchema, raw);
	if (!body) return fail("invalid_world_request");
	const scopeKey = deps.resolveScope(ctx, body.scopeKey);
	if (scopeKey === null) return fail("not_found");
	return (db) => {
		const found = resolveTarget(
			deps,
			db,
			ctx,
			scopeKey,
			body.target,
			body.expectedRevision,
		);
		if ("answer" in found) return found.answer as ClaimResult<ClaimChange>;
		const entry = found.entry;
		const reason = deps.options.reasonSource(db, body.reasonMessageId);
		if (!reason) return fail("reason_source_unavailable");
		const plan = transitionPlan(
			scopeKey,
			ctx,
			entry,
			body.expectedRevision,
			entry.assertion.lifecycle,
			{ action: "retract", reasonSource: reason },
		);
		applyOrAbort(deps, db, ctx, scopeKey, `ui-retract-${body.requestId}`, {
			kind: "assertion.transition",
			plan,
		});
		return ok({ status: "applied" as const, claimId: entry.id });
	};
}

/** The forget id of one request: a double submit is the same forget. */
const forgetIdOf = (requestId: string) => `ui-forget-${requestId}`;

type ForgetBody = { body: ForgetClaim; scopeKey: string };
function parseForget(
	deps: ClaimChangeDeps,
	ctx: WorldClaimsContext,
	raw: unknown,
): ForgetBody | ClaimFailure {
	const body = parse(forgetClaimSchema, raw);
	if (!body) return fail("invalid_world_request");
	const scopeKey = deps.resolveScope(ctx, body.scopeKey);
	return scopeKey === null ? fail("not_found") : { body, scopeKey };
}

/** Where a forget starts: the claim with every revision it had (older ones keep its content too). */
function locateForget(
	deps: ClaimChangeDeps,
	db: Database,
	ctx: WorldClaimsContext,
	{ body, scopeKey }: ForgetBody,
): ClaimResult<{ id: string; revisions: number } | ForgetAccepted> {
	const found = resolveTarget(
		deps,
		db,
		ctx,
		scopeKey,
		body.target,
		body.expectedRevision,
	);
	if ("answer" in found) return found.answer as ClaimResult<ForgetAccepted>;
	return ok({ id: found.entry.id, revisions: found.entry.revision });
}

function forgetRequest(
	ctx: WorldClaimsContext,
	{ body, scopeKey }: ForgetBody,
	claim: { id: string; revisions: number },
) {
	return {
		forgetId: forgetIdOf(body.requestId),
		scope: { principal: ctx.principal, scopeKey },
		reasonCode: "FORGET_REQUESTED" as const,
		roots: Array.from({ length: claim.revisions }, (_, i) => ({
			kind: "assertion" as const,
			id: claim.id,
			revision: i + 1,
		})),
		origin: "request" as const,
	};
}

async function forget(
	deps: ClaimChangeDeps,
	ctx: WorldClaimsContext,
	raw: unknown,
): Promise<ClaimResult<ForgetAccepted>> {
	const { store, lifecycle } = deps.options;
	const parsed = parseForget(deps, ctx, raw);
	if ("status" in parsed) return parsed;
	const located = deps.typed(() =>
		store.readSnapshot((db) => locateForget(deps, db, ctx, parsed)),
	);
	if (located.status !== "ok") return located;
	if ("status" in located.value) return ok(located.value);
	const request = forgetRequest(ctx, parsed, located.value);
	const scope = request.scope;
	let accepted: Awaited<ReturnType<typeof lifecycle.acceptForget>>;
	try {
		accepted = await lifecycle.acceptForget(request);
	} catch (error) {
		// The intake is durable before the forget advances. A failure while it
		// advances therefore leaves a PENDING forget that the host resumes: say
		// exactly that, not "failed".
		const left = lifecycle
			.listForgets(scope, FORGET_LIMIT)
			.find((f) => f.forgetId === request.forgetId);
		if (left) {
			deps.options.onForgetAdvanceFailed?.(error);
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
		.find((f) => f.forgetId === request.forgetId);
	if (!item) return fail("world_unavailable");
	return ok({ status: "accepted", forget: forgetView(item) });
}

/**
 * Only the intake: it is durable with the caller's transaction and the forget advances after
 * it commits (the caller resumes it), so `accepted` is never `complete`.
 */
function forgetInTransaction(
	deps: ClaimChangeDeps,
	db: Database,
	ctx: WorldClaimsContext,
	raw: unknown,
): ClaimResult<ForgetAccepted> {
	const parsed = parseForget(deps, ctx, raw);
	if ("status" in parsed) return parsed;
	return atomic(db, (writer) => {
		const located = locateForget(deps, writer, ctx, parsed);
		if (located.status !== "ok") return located;
		if ("status" in located.value) return ok(located.value);
		const accepted = deps.options.lifecycle.acceptForgetInTransaction(
			writer,
			forgetRequest(ctx, parsed, located.value),
		);
		if ("status" in accepted) return fail("invalid_world_request");
		return ok({ status: "accepted" as const, forget: forgetView(accepted) });
	});
}

/** The forget a request started, as it stands on this connection now. */
function forgetStatusInTransaction(
	deps: ClaimChangeDeps,
	db: Database,
	ctx: WorldClaimsContext,
	requestId: string,
): ForgetView | null {
	const scopeKey = deps.resolveScope(ctx, undefined);
	if (scopeKey === null) return null;
	const item = deps.options.lifecycle.forgetItemInTransaction(
		db,
		{ principal: ctx.principal, scopeKey },
		forgetIdOf(requestId),
	);
	return item ? forgetView(item) : null;
}

/**
 * Explicit correction, retraction and forget of the owner. Each exists twice: on the host's
 * writer queue, and `...InTransaction` inside a transaction the caller (the UI action ledger)
 * already holds. The latter reports every refusal as a result and leaves nothing behind.
 */
export function createClaimChanges(deps: ClaimChangeDeps) {
	return {
		correct: (ctx: WorldClaimsContext, raw: unknown) =>
			change(deps, planCorrect(deps, ctx, raw)),
		retract: (ctx: WorldClaimsContext, raw: unknown) =>
			change(deps, planRetract(deps, ctx, raw)),
		forget: (ctx: WorldClaimsContext, raw: unknown) => forget(deps, ctx, raw),
		correctInTransaction: (
			db: Database,
			ctx: WorldClaimsContext,
			raw: unknown,
		) => atomic(db, planCorrect(deps, ctx, raw)),
		retractInTransaction: (
			db: Database,
			ctx: WorldClaimsContext,
			raw: unknown,
		) => atomic(db, planRetract(deps, ctx, raw)),
		forgetInTransaction: (
			db: Database,
			ctx: WorldClaimsContext,
			raw: unknown,
		) => forgetInTransaction(deps, db, ctx, raw),
		forgetStatusInTransaction: (
			db: Database,
			ctx: WorldClaimsContext,
			requestId: string,
		) => forgetStatusInTransaction(deps, db, ctx, requestId),
	};
}
