import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import { getLogger } from "../../../infrastructure/logger";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	toolchainActionEventV1,
	type ActionRequestView,
	type AdapterRegistry,
	type DomainAdapter,
	type ExecutionResultV1,
	type FieldError,
	type ToolchainActionEventV1,
} from "../contracts";
import {
	artifactView,
	readSource,
	resolveArtifact,
	targetProblem,
	usableArtifacts,
	type ResolvedArtifact,
} from "./action-artifacts";
import {
	hasRoom,
	purge,
	recordConflict,
	rowOf,
	unsettledRows,
	viewOf,
} from "./action-ledger";
import {
	ACTION_POLICY,
	ActionRequestError,
	canonical,
	codePattern,
	fieldErrors,
	isCancel,
	isRecord,
	iso,
	programmerErrors,
	type ActionRequestErrorStatus,
	type ArtifactListEntry,
	type ArtifactView,
	type CapabilityReads,
	type LedgerContext,
	type SourceView,
	type SubmitResult,
} from "./action-types";

const log = getLogger("tool-runtime.action-requests");

type Outcome =
	| {
			kind: "ok";
			request: ActionRequestView;
			replay: boolean;
			commit?: () => void;
			/** Logging of the settled request; runs only once the write has committed. */
			logged?: () => void;
	  }
	| { kind: "error"; error: ActionRequestError };
const fail = (
	code: string,
	status: ActionRequestErrorStatus,
	errors?: FieldError[],
): Outcome => ({
	kind: "error",
	error: new ActionRequestError(code, status, errors),
});
const invalidType = () =>
	fail("invalid_input", 422, [{ field: "input", message: "invalid_type" }]);

/** Everything a new request resolved from the registered artifact before any input is read. */
type Plan = ResolvedArtifact & {
	event: ToolchainActionEventV1;
	digest: string;
	t: number;
	action: ResolvedArtifact["doc"]["document"]["actionBindings"][number] & {
		operationId: string;
	};
	source: ResolvedArtifact["doc"]["document"]["sourceBindings"][number];
	operation: { inputSchemaRef: string; effect: "read" | "write" };
	described: ReturnType<DomainAdapter["describe"]>;
	bindingDigest: string;
};

/** Send window and scope of a request that has no stored acceptance yet. */
function checkWindow(
	ctx: LedgerContext,
	event: ToolchainActionEventV1,
): Outcome | undefined {
	const t = ctx.now();
	const created = Date.parse(event.eventCreatedAt);
	const expires = Date.parse(event.eventExpiresAt);
	if (
		expires <= created ||
		expires - created > ACTION_POLICY.windowMs ||
		created > t + ACTION_POLICY.futureMs
	)
		return fail("event_time_invalid", 400);
	if (t - created > ACTION_POLICY.windowMs || t >= expires)
		return fail("event_expired", 410);
	if (event.scopeRef !== ctx.scopeRef) return fail("scope_mismatch", 403);
	return undefined;
}

/** The registered artifact, action, source and operation the event names (no forged references). */
function plan(
	ctx: LedgerContext,
	db: Database,
	event: ToolchainActionEventV1,
	digest: string,
): Plan | Outcome {
	const resolved = resolveArtifact(ctx, db, event.artifactRevisionId);
	if (resolved instanceof ActionRequestError)
		return { kind: "error", error: resolved };
	const { entry, doc, adapter } = resolved;
	const definition = doc.document;
	const action = definition.actionBindings.find(
		(a) => a.actionId === event.actionId,
	);
	if (!action) return fail("action_not_found", 404);
	if (action.source !== event.source)
		return fail("action_source_mismatch", 400);
	if (action.effect === "local") return fail("local_action", 400);
	if (action.answer) return fail("use_interaction_answer", 400);
	if (!action.operationId) return fail("action_unbound", 400);
	const source = definition.sourceBindings.find(
		(s) => s.source === action.source,
	);
	if (!source) return fail("source_not_found", 404);
	if (source.adapterRef !== entry.adapterRef)
		return fail("artifact_unavailable", 503);
	const described = adapter.describe();
	const operation = described.operations.get(action.operationId);
	if (!operation) return fail("operation_unavailable", 503);
	if (operation.effect !== action.effect) return fail("effect_mismatch", 503);
	if (!described.queries.has(source.query))
		return fail("query_unavailable", 503);
	const problem = targetProblem(source.target, event.targetRef);
	if (problem) return { kind: "error", error: problem };
	return {
		...resolved,
		event,
		digest,
		t: ctx.now(),
		action: { ...action, operationId: action.operationId },
		source,
		operation,
		described,
		bindingDigest: sha256Hex(
			canonical({
				artifact: doc.digest,
				action,
				source,
				operation,
				adapterRef: entry.adapterRef,
			}),
		),
	};
}

/** Raw input -> registered input adapter -> host target fields -> the operation's schema. */
function prepareInput(
	ctx: LedgerContext,
	db: Database,
	p: Plan,
): { value: unknown } | Outcome {
	const { event, action, source, operation, described } = p;
	const rawSchema = ctx.capabilities.schemaInTransaction(
		db,
		action.inputSchemaRef,
	);
	if (!rawSchema) return fail("schema_unavailable", 503);
	const raw = rawSchema.safeParse(event.input);
	if (!raw.success) return fail("invalid_input", 422, fieldErrors(raw.error));
	let value: unknown = raw.data;
	if (action.inputAdapterRef) {
		const convert = described.inputAdapters.get(action.inputAdapterRef);
		if (!convert) return fail("input_adapter_unavailable", 503);
		if (!isRecord(value)) return invalidType();
		const converted = convert(value);
		if (!converted.ok)
			return fail("invalid_input", 422, converted.errors.slice(0, 20));
		value = converted.value;
	}
	if (event.targetRef !== undefined) {
		if (!isRecord(value)) return invalidType();
		value = {
			...value,
			...p.adapter.targetInput(
				source.query,
				event.targetRef,
				event.sourceRevision,
			),
		};
	}
	const operationSchema = ctx.capabilities.schemaInTransaction(
		db,
		operation.inputSchemaRef,
	);
	if (operationSchema) {
		const parsed = operationSchema.safeParse(value);
		if (!parsed.success)
			return fail("invalid_input", 422, fieldErrors(parsed.error));
		value = parsed.data;
	} else if (!operation.inputSchemaRef.startsWith("domain:"))
		return fail("schema_unavailable", 503);
	return { value };
}

function insertPending(ctx: LedgerContext, db: Database, p: Plan) {
	const { event } = p;
	db.query(
		`INSERT INTO tool_action_requests(
          event_id,scope,owner_kind,artifact_revision_id,source,source_revision,target_ref,
          action_id,adapter_ref,operation_name,request_id,issued_at,canonical_input_json,
          input_digest,binding_digest,event_created_at,event_expires_at,authority_epoch,
          status,created_at
        ) VALUES(?,?,'ui',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`,
	).run(
		event.eventId,
		ctx.scope,
		event.artifactRevisionId,
		event.source,
		event.sourceRevision,
		event.targetRef ?? null,
		event.actionId,
		p.entry.adapterRef,
		p.action.operationId,
		event.eventId,
		// Host time of the first acceptance; a resend reuses the stored value.
		iso(p.t),
		canonical(event.input ?? null),
		p.digest,
		p.bindingDigest,
		event.eventCreatedAt,
		event.eventExpiresAt,
		ctx.epoch(),
		p.t,
	);
}

const envelope = (
	p: Plan,
	extra: Partial<ExecutionResultV1>,
): ExecutionResultV1 => ({
	version: 1,
	executionId: p.event.eventId,
	chainRevisionId: p.entry.toolchainRevisionId,
	artifactRevisionId: p.event.artifactRevisionId,
	outcome: "completed",
	resultRefs: [],
	artifactRefs: [],
	...extra,
});

function settleRejected(
	ctx: LedgerContext,
	db: Database,
	p: Plan,
	code: string,
): Outcome {
	const result = envelope(p, {
		outcome: "failed",
		error: { code, retry: "user_resubmit" },
	});
	db.query(
		"UPDATE tool_action_requests SET status='rejected',error_code=?,result_json=?,settled_at=? WHERE event_id=?",
	).run(code, JSON.stringify(result), p.t, p.event.eventId);
	return {
		kind: "ok",
		request: viewOf(ctx, db, rowOf(db, p.event.eventId)!),
		replay: false,
		logged: () =>
			log.info("action_request.rejected", {
				requestId: p.event.eventId,
				reason: code,
			}),
	};
}

/** The UI refs a confirmed result points at: the acted target and what the domain returned. */
function sourceRefsOf(
	p: Plan,
	resultRefs: Array<{ id: string }>,
): Array<{ source: string; targetRef?: string }> {
	const refs = new Map<string, { source: string; targetRef?: string }>();
	const add = (targetRef?: string) => {
		if (targetRef !== undefined && !/^[A-Za-z0-9-]{1,64}$/.test(targetRef))
			return;
		refs.set(targetRef ?? "", {
			source: p.event.source,
			...(targetRef !== undefined ? { targetRef } : {}),
		});
	};
	if (p.event.targetRef !== undefined) add(p.event.targetRef);
	for (const ref of resultRefs) add(ref.id);
	if (!refs.size) add(undefined);
	return [...refs.values()];
}

/**
 * The domain runs in a savepoint: a known rejection rolls back its writes but keeps the
 * acceptance row; an unknown failure propagates and aborts the whole transaction.
 */
function execute(
	ctx: LedgerContext,
	db: Database,
	p: Plan,
	value: unknown,
): Outcome {
	const { event, adapter } = p;
	db.exec("SAVEPOINT tool_action_request");
	try {
		const result = adapter.invokeInTransaction(db, {
			operationName: p.action.operationId,
			input: value,
			requestId: event.eventId,
			issuedAt: iso(p.t),
			origin: { kind: "ui", scope: ctx.scope, actionRequestId: event.eventId },
		});
		if (
			!result?.receiptRef?.owner ||
			!result.receiptRef.operationId ||
			!result.receiptRef.digest
		)
			throw new Error("invalid_adapter_result");
		db.exec("RELEASE tool_action_request");
		const stored = envelope(p, {
			receiptRef: result.receiptRef,
			resultRefs: result.resultRefs,
			artifactRefs: [
				{
					artifactRevisionId: event.artifactRevisionId,
					sourceRefs: sourceRefsOf(p, result.resultRefs),
				},
			],
		});
		db.query(
			`UPDATE tool_action_requests SET status='accepted',receipt_owner=?,receipt_operation_id=?,
         receipt_digest=?,result_json=?,settled_at=? WHERE event_id=?`,
		).run(
			result.receiptRef.owner,
			result.receiptRef.operationId,
			result.receiptRef.digest,
			JSON.stringify(stored),
			p.t,
			event.eventId,
		);
		const operationId = result.receiptRef.operationId;
		return {
			kind: "ok",
			request: viewOf(ctx, db, rowOf(db, event.eventId)!),
			replay: result.replay,
			commit: () => adapter.afterCommit?.(),
			logged: () =>
				log.info("action_request.accepted", {
					requestId: event.eventId,
					operationId,
				}),
		};
	} catch (error) {
		const code = error instanceof Error ? error.message : "";
		if (
			!(error instanceof Error) ||
			programmerErrors.some((e) => error instanceof e) ||
			!codePattern.test(code) ||
			code === "invalid_adapter_result"
		)
			throw error;
		db.exec("ROLLBACK TO tool_action_request");
		db.exec("RELEASE tool_action_request");
		return settleRejected(ctx, db, p, code);
	}
}

function accept(
	ctx: LedgerContext,
	db: Database,
	event: ToolchainActionEventV1,
	digest: string,
): Outcome {
	const existing = rowOf(db, event.eventId);
	if (existing) {
		// Owner and digest first: a legitimate resend never fails on the send window.
		if (existing.scope !== ctx.scope || existing.input_digest !== digest) {
			recordConflict(ctx, db, event.eventId, digest);
			return fail("request_conflict", 409);
		}
		return { kind: "ok", request: viewOf(ctx, db, existing), replay: true };
	}
	const late = checkWindow(ctx, event);
	if (late) return late;
	const planned = plan(ctx, db, event, digest);
	if ("kind" in planned) return planned;
	const p = planned;
	const cancel = isCancel(p.action.operationId);

	if (event.targetRef !== undefined) {
		const current = p.adapter.sourceInTransaction(
			db,
			p.source.query,
			event.targetRef,
		);
		if (!current) return fail("target_not_found", 404);
		if (current.revision !== event.sourceRevision) {
			if (!hasRoom(ctx, db, cancel)) return fail("action_capacity", 503);
			insertPending(ctx, db, p);
			return settleRejected(ctx, db, p, "revision_conflict");
		}
	}
	const input = prepareInput(ctx, db, p);
	if ("kind" in input) return input;
	if (!hasRoom(ctx, db, cancel)) return fail("action_capacity", 503);
	insertPending(ctx, db, p);
	return execute(ctx, db, p, input.value);
}

export function createActionRequests(deps: {
	store: SqliteStore;
	capabilities: CapabilityReads;
	registry: AdapterRegistry;
	now?: () => number;
	/** The host scope every request here belongs to (never taken from the client). */
	scope: string;
	/**
	 * The host's current authority epoch, stored with each acceptance (default 0: one owner, no
	 * revocation yet). It is the host's epoch, never one the client sends.
	 */
	authorityEpoch?: () => number;
}) {
	const { store, scope } = deps;
	const ctx: LedgerContext = {
		capabilities: deps.capabilities,
		registry: deps.registry,
		scope,
		scopeRef: `scope:${sha256Hex(scope).slice(0, 24)}`,
		now: deps.now ?? Date.now,
		epoch: deps.authorityEpoch ?? (() => 0),
	};
	return {
		scopeRef: ctx.scopeRef,
		/** Accept one UI action; throws ActionRequestError for every refusal that settles nothing. */
		async submit(raw: unknown): Promise<SubmitResult> {
			const parsed = toolchainActionEventV1.safeParse(raw);
			if (!parsed.success) {
				const tooLarge = parsed.error.issues.some(
					(i) => i.message === "payload_too_large",
				);
				throw new ActionRequestError(
					tooLarge ? "payload_too_large" : "invalid_action_event",
					tooLarge ? 413 : 400,
				);
			}
			const event = parsed.data;
			const digest = sha256Hex(
				canonical({
					artifactRevisionId: event.artifactRevisionId,
					source: event.source,
					sourceRevision: event.sourceRevision,
					targetRef: event.targetRef ?? null,
					actionId: event.actionId,
					scopeRef: event.scopeRef,
					input: event.input ?? null,
				}),
			);
			const outcome = await store.write((db) => accept(ctx, db, event, digest));
			if (outcome.kind === "error") throw outcome.error;
			outcome.logged?.();
			try {
				outcome.commit?.();
			} catch {
				log.warn("action_request.after_commit_failed", {
					requestId: event.eventId,
				});
			}
			return { request: outcome.request, replay: outcome.replay };
		},
		get(eventId: string): ActionRequestView | null {
			return store.read((db) => {
				const row = rowOf(db, eventId);
				return row && row.scope === scope ? viewOf(ctx, db, row) : null;
			});
		},
		/** Accepted-but-not-settled and indeterminate requests, for reconnecting clients. */
		unsettled(): ActionRequestView[] {
			return store.read((db) => unsettledRows(ctx, db));
		},
		/** Launcher entries: one per active artifact whose adapter is usable now. */
		artifacts(): ArtifactListEntry[] {
			return store.read((db) => usableArtifacts(ctx, db));
		},
		artifact(artifactRevisionId: string): ArtifactView {
			return store.read((db) => artifactView(ctx, db, artifactRevisionId));
		},
		source(
			artifactRevisionId: string,
			source: string,
			targetRef?: string,
		): SourceView {
			return store.read((db) =>
				readSource(ctx, db, artifactRevisionId, source, targetRef),
			);
		},
		/** Delete old bodies and tombstones (30 days each). */
		maintenance() {
			return store.write((db) => purge(ctx, db));
		},
	};
}
export type ActionRequests = ReturnType<typeof createActionRequests>;
