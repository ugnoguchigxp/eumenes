import { createReadInvocation, type ReadReference } from "./read-invocation";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	ValidationFailure,
	validationIssues,
} from "../../../infrastructure/validation-log";
import {
	bytes,
	hash,
	validators,
	type Capabilities,
	type Owner,
	type Prepared,
} from "../../capabilities";
import type { QueueService } from "../../queue";
import type {
	ToolAdapter,
	Invocation,
	Source,
	ToolResult,
	ActionAdapter,
	ActionEnvelope,
} from "../contracts";
import { resultSources } from "./source-results";
import { get, hasReadMetadata, hasSupersededColumn } from "../repository";
export function createToolRuntime(
	store: SqliteStore,
	capabilities: Capabilities,
	queue: QueueService,
	adapter: ToolAdapter,
	now = Date.now,
	actions?: ActionAdapter,
) {
	const localOperations = new Map<
		string,
		import("../contracts").AdapterOperation
	>();
	const refs = new Map<string, ReadReference>();
	const vault = new Map<
		string,
		{
			invocationId: string;
			ownerTaskId: string;
			digest: string;
			sources: Source[];
			failures: ToolResult["failures"];
			notes?: unknown;
			bytes: number;
			expires: number;
		}
	>();
	const ownerKey = (o: Owner) => JSON.stringify(o);
	function reserve(owner: Owner) {
		if (
			[...refs.values()].filter((r) => ownerKey(r.owner) === ownerKey(owner))
				.length >= 64
		)
			throw new Error("reference_capacity");
	}
	function bind(owner: Owner, prepared: Prepared, deadline: number) {
		const allowed = new Set(prepared.package.toolRevisionIds);
		return prepared.dependencies
			.filter((d) => d.kind === "tool" && allowed.has(d.revisionId))
			.map((tool) => {
				reserve(owner);
				const executionRef = crypto.randomUUID();
				refs.set(executionRef, {
					owner,
					tool,
					prepared,
					expires: Math.min(now() + 300000, deadline),
				});
				return { executionRef, tool };
			});
	}
	const invokeInTransaction = createReadInvocation({
		refs,
		localOperations,
		now,
		capabilities,
		adapter,
	});
	function resolve(db: Database, ref: string, taskId: string) {
		const entry = vault.get(ref);
		if (!entry || entry.expires <= now()) throw new Error("result_expired");
		const inv = get(db, entry.invocationId);
		if (
			!inv ||
			inv.superseded ||
			inv.owner_task_id !== taskId ||
			!["succeeded", "partial"].includes(inv.state) ||
			inv.result_digest !== entry.digest ||
			inv.deadline <= now()
		)
			throw new Error("result_expired");
		return entry;
	}
	function observations(db: Database, taskId: string) {
		const invocations = db
			.query(
				`SELECT * FROM tool_invocations WHERE owner_task_id=?${hasSupersededColumn(db) ? " AND superseded=0" : ""} ORDER BY created_at,id`,
			)
			.all(taskId) as Invocation[];
		return invocations.map((inv) =>
			inv.result_ref
				? { state: inv.state, ...resolve(db, inv.result_ref, taskId) }
				: {
						invocationId: inv.id,
						state: inv.state,
						errorCode: inv.error_code,
						sources: [] as Source[],
						failures: [],
					},
		);
	}
	function settleInTransaction(
		db: Database,
		inv: Invocation,
		operation: ReturnType<ToolAdapter["get"]>,
	) {
		const current = get(db, inv.id);
		if (current?.state !== "pending") return false;
		let state = operation?.state ?? "failed",
			code = operation?.errorCode ?? (operation ? null : "operation_missing"),
			ref: string | null = null,
			digest: string | null = null;
		if (inv.deadline <= now()) {
			state = "failed";
			code = "deadline_exceeded";
		}
		if (state === "pending") {
			const job = queue.getInTransaction(db, inv.job_id);
			if (
				!job ||
				["failed", "expired", "interrupted", "cancelled", "completed"].includes(
					job.state,
				)
			) {
				state = "failed";
				code = job?.errorCode ?? "operation_missing";
			} else return false;
		}
		if (state === "succeeded" || state === "partial") {
			if (!operation?.result) {
				state = "failed";
				code = "result_expired";
			} else {
				for (const [key, entry] of vault) {
					const committed = get(db, entry.invocationId);
					if (
						entry.expires <= now() ||
						!committed ||
						!["succeeded", "partial"].includes(committed.state) ||
						committed.result_digest !== entry.digest ||
						committed.deadline <= now()
					)
						vault.delete(key);
				}
				const result = operation.result;
				const prepared = adapter.prepareSourcesInTransaction?.(db, inv, result);
				const sources = prepared?.sources ?? resultSources(result);
				const failures = prepared?.failures ?? result.failures;
				const size = bytes({
					sources,
					failures,
					notes: result.notes,
				});
				const mine = [...vault.values()].filter(
					(e) => e.ownerTaskId === inv.owner_task_id,
				);
				if (
					size > 32768 ||
					vault.size >= 64 ||
					mine.length >= 16 ||
					mine.reduce((a, e) => a + e.bytes, 0) + size > 524288 ||
					[...vault.values()].reduce((a, e) => a + e.bytes, 0) + size > 2097152
				) {
					state = "failed";
					code = "result_capacity";
				} else {
					ref = crypto.randomUUID();
					digest = hash({
						sources,
						failures,
						notes: result.notes,
					});
					vault.set(ref, {
						invocationId: inv.id,
						ownerTaskId: inv.owner_task_id,
						digest,
						sources,
						failures,
						notes: result.notes,
						bytes: size,
						expires: now() + 900000,
					});
					if (hasReadMetadata(db)) {
						for (const proof of result.proofs ?? [])
							db.query(
								"INSERT INTO tool_read_proofs(invocation_id,proof_json) VALUES(?,?)",
							).run(inv.id, JSON.stringify(proof));
						for (const source of sources.filter((s) => s.viewId)) {
							const { body: _body, ...metadata } = source;
							db.query(
								"INSERT INTO tool_views(view_id,invocation_id,metadata_json) VALUES(?,?,?)",
							).run(source.viewId!, inv.id, JSON.stringify(metadata));
						}
					}
					for (const source of sources.filter(
						(s) => s.kind !== "conversation_source",
					))
						db.query(
							"INSERT OR IGNORE INTO tool_sources VALUES(?,?,?,?,?,?,?,?,?)",
						).run(
							source.sourceId,
							inv.id,
							inv.owner_task_id,
							source.url ?? "",
							source.title,
							source.basis,
							source.fetchedAt,
							hash(source.body),
							source.truncated ? 1 : 0,
						);
				}
			}
		}
		if (
			db
				.query(
					"UPDATE tool_invocations SET state=?,error_code=?,result_ref=?,result_digest=?,finished_at=? WHERE id=? AND state='pending'",
				)
				.run(state, code, ref, digest, now(), inv.id).changes !== 1
		)
			throw new Error("invocation_changed");
		void Promise.resolve()
			.then(() => {
				const row = store.read((db) => get(db, inv.id));
				if (row?.state !== "pending") localOperations.delete(inv.operation_id);
			})
			.catch(() => {});
		return true;
	}
	function cancelInTransaction(db: Database, taskId: string) {
		const pending = db
			.query(
				"SELECT * FROM tool_invocations WHERE owner_task_id=? AND state='pending'",
			)
			.all(taskId) as Invocation[];
		const jobs = pending.flatMap((inv) =>
			inv.operation_id.startsWith("local:")
				? []
				: adapter.cancelInTransaction(db, inv.operation_id),
		);
		db.query(
			"UPDATE tool_invocations SET state='cancelled',error_code='cancel_requested',finished_at=? WHERE owner_task_id=? AND state='pending'",
		).run(now(), taskId);
		return jobs;
	}
	function release(taskId: string) {
		adapter.releaseTask?.(taskId);
		for (const [key, ref] of refs)
			if (ref.owner.taskId === taskId) refs.delete(key);
		for (const [key, result] of vault)
			if (result.ownerTaskId === taskId) vault.delete(key);
	}
	return {
		validateEvidenceInTransaction(
			db: Database,
			owner: Owner,
			sources: import("../contracts").SourceMetadata[],
		) {
			const proofs = hasReadMetadata(db)
				? (
						db
							.query(
								`SELECT p.proof_json FROM tool_read_proofs p JOIN tool_invocations i ON i.id=p.invocation_id WHERE i.owner_task_id=? AND i.root_run_id=? AND i.state IN ('succeeded','partial') AND i.cancel_epoch=?${hasSupersededColumn(db) ? " AND i.superseded=0" : ""} ORDER BY i.created_at,i.rowid`,
							)
							.all(owner.taskId, owner.rootRunId, owner.cancelEpoch) as Array<{
							proof_json: string;
						}>
					).map(
						(p) =>
							JSON.parse(p.proof_json) as {
								kind: "conversation_source";
								scopeRef: string;
							},
					)
				: [];
			const scopes = new Set(
				sources
					.filter((s) => s.kind === "conversation_source")
					.map((s) => s.scopeRef),
			);
			const selectedProofs = scopes.size
				? proofs.filter((p) => scopes.has(p.scopeRef))
				: proofs.slice(-1);
			if (!sources.some((s) => s.viewId) && !selectedProofs.length) return true;
			if (
				!hasReadMetadata(db) ||
				sources
					.filter((s) => s.viewId)
					.some(
						(s) =>
							!db
								.query(
									`SELECT 1 FROM tool_views v JOIN tool_invocations i ON i.id=v.invocation_id WHERE v.view_id=? AND i.owner_task_id=? AND i.root_run_id=? AND i.cancel_epoch=? AND i.state IN ('succeeded','partial')${hasSupersededColumn(db) ? " AND i.superseded=0" : ""}`,
								)
								.get(
									s.viewId!,
									owner.taskId,
									owner.rootRunId,
									owner.cancelEpoch,
								),
					)
			)
				return false;
			return (
				adapter.validateEvidenceInTransaction?.(
					db,
					owner,
					sources,
					selectedProofs,
				) ?? false
			);
		},
		summaryInTransaction(db: Database, taskId: string) {
			return db
				.query(
					"SELECT i.tool_revision_id AS toolRevisionId,i.state,i.error_code AS errorCode,(SELECT COUNT(*) FROM tool_sources s WHERE s.invocation_id=i.id) AS sourceCount FROM tool_invocations i WHERE owner_task_id=? ORDER BY created_at,id",
				)
				.all(taskId) as Array<{
				toolRevisionId: string;
				state: string;
				errorCode: string | null;
				sourceCount: number;
			}>;
		},
		bind,
		invokeInTransaction,
		observationsInTransaction: observations,
		settleInTransaction,
		cancelInTransaction,
		release,
		countInTransaction: (
			db: Database,
			taskId: string,
			toolRevisionId: string,
		) =>
			(
				db
					.query(
						"SELECT COUNT(*) AS n FROM tool_invocations WHERE owner_task_id=? AND tool_revision_id=?",
					)
					.get(taskId, toolRevisionId) as { n: number }
			).n,
		/** Real executions only (excludes candidate-cache imports). Needs routeGrantMigration. */
		countRealInTransaction: (
			db: Database,
			taskId: string,
			toolRevisionId: string,
		) =>
			(
				db
					.query(
						"SELECT COUNT(*) AS n FROM tool_invocations WHERE owner_task_id=? AND tool_revision_id=? AND origin='tool'",
					)
					.get(taskId, toolRevisionId) as { n: number }
			).n,
		/** Every invocation of the task (including superseded ones) for budget/provenance checks. */
		invocationsInTransaction: (db: Database, taskId: string) =>
			(
				db
					.query(
						"SELECT * FROM tool_invocations WHERE owner_task_id=? ORDER BY created_at,id",
					)
					.all(taskId) as Array<Invocation & { superseded?: number }>
			).map((r) => ({
				id: r.id,
				arguments: r.args_json
					? (JSON.parse(r.args_json) as unknown)
					: undefined,
				operationFingerprint: r.operation_fingerprint ?? null,
				toolRevisionId: r.tool_revision_id,
				stepId: r.step_id,
				argsDigest: r.args_digest,
				state: r.state,
				origin: (r.origin ?? "tool") as "tool" | "candidate-cache",
				superseded: !!r.superseded,
			})),
		/**
		 * Hide the task's current invocations from observations (so their sources grant no
		 * reads) while countInTransaction/countRealInTransaction keep counting them.
		 * Needs supersedeMigration; returns the number of rows affected.
		 */
		supersedeInvocationsInTransaction: (db: Database, taskId: string) => {
			if (!hasSupersededColumn(db)) throw new Error("supersede_unavailable");
			return db
				.query(
					"UPDATE tool_invocations SET superseded=1 WHERE owner_task_id=? AND superseded=0",
				)
				.run(taskId).changes;
		},
		pending: (cursor = "", limit = 100) =>
			store.read(
				(db) =>
					db
						.query(
							"SELECT * FROM tool_invocations WHERE state='pending' AND id>? ORDER BY id LIMIT ?",
						)
						.all(cursor, Math.min(100, Math.max(1, limit))) as Invocation[],
			),
		inspect: (inv: Invocation) =>
			inv.operation_id.startsWith("local:")
				? (localOperations.get(inv.operation_id) ?? null)
				: adapter.get(inv.operation_id),
		getInTransaction: get,
		purgeMetadataInTransaction(db: Database, rootRunId: string) {
			db.query(
				"DELETE FROM tool_sources WHERE invocation_id IN (SELECT id FROM tool_invocations WHERE root_run_id=?)",
			).run(rootRunId);
			db.query("DELETE FROM tool_invocations WHERE root_run_id=?").run(
				rootRunId,
			);
		},
		deleteDataInTransaction(db: Database, rootRunId: string) {
			void Promise.resolve()
				.then(() => {
					const retained = store.read((db) =>
						db
							.query(
								"SELECT COUNT(*) AS n FROM tool_invocations WHERE root_run_id=? AND (args_json IS NOT NULL OR result_ref IS NOT NULL)",
							)
							.get(rootRunId),
					) as { n: number };
					if (!retained.n) adapter.releaseRoot?.(rootRunId);
				})
				.catch(() => {});
			db.query(
				"UPDATE tool_invocations SET args_json=NULL,result_ref=NULL WHERE root_run_id=?",
			).run(rootRunId);
		},
		close() {
			refs.clear();
			vault.clear();
			localOperations.clear();
		},
		actionsEnabled: () => !!actions,
		actionContextInTransaction: (db: Database, owner: Owner) =>
			actions?.contextInTransaction?.(db, owner) ?? null,
		readActionInTransaction(db: Database, owner: Owner, invocationId: string) {
			const row = db
				.query("SELECT * FROM tool_action_invocations WHERE id=?")
				.get(invocationId) as {
				owner_task_id: string;
				root_run_id: string;
				cancel_epoch: number;
				operation_id: string;
				receipt_digest: string;
				state: string;
			} | null;
			if (
				!row ||
				row.state !== "committed" ||
				row.owner_task_id !== owner.taskId ||
				row.root_run_id !== owner.rootRunId ||
				row.cancel_epoch !== owner.cancelEpoch
			)
				throw new Error("action_invalidated");
			const result = actions?.readInTransaction(db, row.operation_id, owner);
			if (!result || result.receiptDigest !== row.receipt_digest)
				throw new Error("operation_expired");
			return result;
		},
		invokeActionInTransaction(
			db: Database,
			owner: Owner,
			executionRef: string,
			args: unknown,
			stepId: string,
			deadline: number,
			originToken: string,
		): ActionEnvelope & { invocationId: string } {
			if (!actions) throw new Error("capability_unavailable");
			const ref = refs.get(executionRef);
			if (
				!ref ||
				ref.expires <= now() ||
				ownerKey(ref.owner) !== ownerKey(owner) ||
				deadline <= now()
			)
				throw new Error("tool_ref_invalid");
			capabilities.validateInTransaction(db, ref.prepared);
			if (!ref.tool.schemaKey) throw new Error("invalid_tool_schema");
			const parsed = validators[ref.tool.schemaKey].safeParse(args);
			if (!parsed.success)
				throw new ValidationFailure(
					"invalid_tool_input",
					validationIssues(parsed.error, args, ["arguments"]),
					parsed.error.issues.length,
				);
			const argsDigest = hash(parsed.data);
			const old = db
				.query("SELECT * FROM tool_action_invocations WHERE step_id=?")
				.get(stepId) as {
				id: string;
				owner_task_id: string;
				root_run_id: string;
				tool_revision_id: string;
				args_digest: string;
				operation_id: string;
				receipt_digest: string;
				cancel_epoch: number;
			} | null;
			if (old) {
				if (
					old.owner_task_id !== owner.taskId ||
					old.root_run_id !== owner.rootRunId ||
					old.tool_revision_id !== ref.tool.revisionId ||
					old.args_digest !== argsDigest ||
					old.cancel_epoch !== owner.cancelEpoch
				)
					throw new Error("idempotency_conflict");
				const again = actions.readInTransaction(db, old.operation_id, owner);
				if (!again || again.receiptDigest !== old.receipt_digest)
					throw new Error("operation_expired");
				return { ...again, invocationId: old.id };
			}
			const requestId = crypto.randomUUID();
			const issuedAt = new Date(now()).toISOString();
			const envelope = actions.executeInTransaction(db, {
				requestId,
				issuedAt,
				tool: ref.tool,
				arguments: parsed.data,
				owner,
				originToken,
			});
			if (
				envelope.kind !== "local_action" ||
				envelope.version !== 1 ||
				!envelope.operationId ||
				!envelope.receiptDigest
			)
				throw new Error("invalid_tool_input");
			const invocationId = crypto.randomUUID();
			db.query(
				`INSERT INTO tool_action_invocations(
          id,root_run_id,owner_task_id,cancel_epoch,step_id,tool_revision_id,
          request_id,args_digest,operation_id,receipt_digest,state,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
			).run(
				invocationId,
				owner.rootRunId,
				owner.taskId,
				owner.cancelEpoch,
				stepId,
				ref.tool.revisionId,
				requestId,
				argsDigest,
				envelope.operationId,
				envelope.receiptDigest,
				"committed",
				now(),
			);
			return { ...envelope, invocationId };
		},
	};
}
export type ToolRuntime = ReturnType<typeof createToolRuntime>;
