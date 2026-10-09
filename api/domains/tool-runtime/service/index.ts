import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	bytes,
	hash,
	validators,
	type Capabilities,
	type Owner,
	type FixedDefinition,
	type Prepared,
} from "../../capabilities";
import type { QueueService } from "../../queue";
import type {
	ToolAdapter,
	Invocation,
	Source,
	ToolResult,
	CachedSourceAuthorizationPort,
	CachedRouteGrantInput,
	CandidateImportInput,
} from "../contracts";
import { get, hasSupersededColumn } from "../repository";
export function createToolRuntime(
	store: SqliteStore,
	capabilities: Capabilities,
	queue: QueueService,
	adapter: ToolAdapter,
	now = Date.now,
	cachedSource?: CachedSourceAuthorizationPort,
) {
	type Grant = {
		bindingToken: string;
		exactUrl: string;
		argsDigest: string;
		attemptTimeoutMs?: number;
	};
	const refs = new Map<
		string,
		{
			owner: Owner;
			tool: FixedDefinition;
			prepared: Prepared;
			expires: number;
			grant?: Grant;
		}
	>();
	const vault = new Map<
		string,
		{
			invocationId: string;
			ownerTaskId: string;
			digest: string;
			sources: Source[];
			failures: ToolResult["failures"];
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
	function authorize(
		db: Database,
		owner: Owner,
		prepared: Prepared,
		bindingToken: string,
		exactUrl: string,
	) {
		const decision = cachedSource?.validateInTransaction(db, {
			owner,
			bindingToken,
			packageHash: prepared.package.hash,
			exactUrl,
		});
		if (!decision) throw new Error("cached_source_unavailable");
		if (decision.status !== "allowed")
			throw new Error("cached_source_rejected");
	}
	/**
	 * Host-only: a fresh reference for ONE recipe tool, bound to this owner, binding token and
	 * exact URL. Never copies another owner's reference; the port is re-checked on every use.
	 */
	function issueCachedGrantInTransaction(
		db: Database,
		input: CachedRouteGrantInput,
	) {
		if (input.deadline <= now()) throw new Error("tool_ref_invalid");
		capabilities.validateInTransaction(db, input.prepared);
		authorize(
			db,
			input.owner,
			input.prepared,
			input.bindingToken,
			input.exactUrl,
		);
		const allowed = new Set(input.prepared.package.toolRevisionIds);
		const tool = input.prepared.dependencies.find(
			(d) =>
				d.kind === "tool" && d.id === input.toolId && allowed.has(d.revisionId),
		);
		if (!tool?.schemaKey) throw new Error("invalid_tool_schema");
		const parsed = validators[tool.schemaKey].safeParse(input.arguments);
		if (!parsed.success) throw new Error("invalid_tool_input");
		if (
			input.toolId === "web.read" &&
			(parsed.data as { url: string }).url !== input.exactUrl
		)
			throw new Error("tool_url_out_of_scope");
		reserve(input.owner);
		const executionRef = crypto.randomUUID();
		refs.set(executionRef, {
			owner: input.owner,
			tool,
			prepared: input.prepared,
			expires: Math.min(now() + 300000, input.deadline),
			grant: {
				bindingToken: input.bindingToken,
				exactUrl: input.exactUrl,
				argsDigest: hash(parsed.data),
				attemptTimeoutMs: input.attemptTimeoutMs,
			},
		});
		return { executionRef, tool };
	}
	/** Post-commit memory release of every grant under a binding token (DB revocation is the port's job). */
	function releaseBinding(bindingToken: string) {
		let n = 0;
		for (const [key, ref] of refs)
			if (ref.grant?.bindingToken === bindingToken) {
				refs.delete(key);
				n++;
			}
		return n;
	}
	function invokeInTransaction(
		db: Database,
		owner: Owner,
		executionRef: string,
		args: unknown,
		stepId: string,
		deadline: number,
		parentJobId: string,
		allowedUrls: string[],
		question?: string,
	) {
		const old = db
			.query("SELECT * FROM tool_invocations WHERE step_id=?")
			.get(stepId) as Invocation | null;

		const ref = refs.get(executionRef);
		if (
			!ref ||
			ref.expires <= now() ||
			ownerKey(ref.owner) !== ownerKey(owner) ||
			deadline <= now()
		)
			throw new Error("tool_ref_invalid");
		capabilities.validateInTransaction(db, ref.prepared);
		if (ref.grant)
			authorize(
				db,
				owner,
				ref.prepared,
				ref.grant.bindingToken,
				ref.grant.exactUrl,
			);
		if (!ref.tool.schemaKey) throw new Error("invalid_tool_schema");
		const parsed = validators[ref.tool.schemaKey].safeParse(args);
		if (!parsed.success) throw new Error("invalid_tool_input");
		if (ref.grant) {
			if (hash(parsed.data) !== ref.grant.argsDigest)
				throw new Error(
					ref.tool.id === "web.read"
						? "tool_url_out_of_scope"
						: "invalid_tool_input",
				);
		} else if (
			ref.tool.id === "web.read" &&
			!allowedUrls.includes((parsed.data as { url: string }).url)
		)
			throw new Error("tool_url_out_of_scope");
		if (old) {
			if (
				old.owner_task_id !== owner.taskId ||
				old.root_run_id !== owner.rootRunId ||
				old.tool_revision_id !== ref.tool.revisionId ||
				old.args_digest !== hash(parsed.data)
			)
				throw new Error("idempotency_conflict");
			return old;
		}
		const invocationId = crypto.randomUUID();
		const requestId = crypto.randomUUID();
		const digest = hash(parsed.data);
		const operation = adapter.startInTransaction(db, {
			requestId,
			tool: ref.tool,
			arguments: parsed.data,
			owner,
			deadline,
			parentJobId,
			question,
			...(ref.grant
				? {
						grantedUrl: ref.grant.exactUrl,
						attemptTimeoutMs: ref.grant.attemptTimeoutMs,
					}
				: {}),
		});
		if (!operation?.operationId || !operation.jobId)
			throw new Error("operation_missing");
		db.query(
			"INSERT INTO tool_invocations(id,owner_task_id,root_run_id,tool_revision_id,step_id,request_id,args_json,args_digest,operation_id,job_id,state,deadline,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?)",
		).run(
			invocationId,
			owner.taskId,
			owner.rootRunId,
			ref.tool.revisionId,
			stepId,
			requestId,
			JSON.stringify(parsed.data),
			digest,
			operation.operationId,
			operation.jobId,
			deadline,
			now(),
		);
		return get(db, invocationId)!;
	}
	function resolve(db: Database, ref: string, taskId: string) {
		const entry = vault.get(ref);
		if (!entry || entry.expires <= now()) throw new Error("result_expired");
		const inv = get(db, entry.invocationId);
		if (
			!inv ||
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
				const sources: Source[] = [
					...result.hits.map((h) => ({
						sourceId: crypto.randomUUID(),
						url: h.url,
						title: h.title,
						basis: "snippet" as const,
						fetchedAt: result.observedAt,
						truncated: true,
						body: h.snippet.replaceAll("\r\n", "\n"),
					})),
					...result.documents.map((d) => ({
						sourceId: crypto.randomUUID(),
						url: d.url,
						title: d.title,
						basis: "page" as const,
						fetchedAt: d.fetchedAt,
						truncated: d.truncated,
						body: d.text.replaceAll("\r\n", "\n"),
					})),
				];
				const size = bytes({ sources, failures: result.failures });
				if (
					size > 32768 ||
					vault.size >= 64 ||
					[...vault.values()].reduce((a, e) => a + e.bytes, 0) + size > 2097152
				) {
					state = "failed";
					code = "result_capacity";
				} else {
					ref = crypto.randomUUID();
					digest = hash({ sources, failures: result.failures });
					vault.set(ref, {
						invocationId: inv.id,
						ownerTaskId: inv.owner_task_id,
						digest,
						sources,
						failures: result.failures,
						bytes: size,
						expires: now() + 900000,
					});
					for (const source of sources)
						db.query("INSERT INTO tool_sources VALUES(?,?,?,?,?,?,?,?,?)").run(
							source.sourceId,
							inv.id,
							inv.owner_task_id,
							source.url,
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
		return true;
	}
	function cancelInTransaction(db: Database, taskId: string) {
		const pending = db
			.query(
				"SELECT * FROM tool_invocations WHERE owner_task_id=? AND state='pending'",
			)
			.all(taskId) as Invocation[];
		const jobs = pending.flatMap((inv) =>
			adapter.cancelInTransaction(db, inv.operation_id),
		);
		db.query(
			"UPDATE tool_invocations SET state='cancelled',error_code='cancel_requested',finished_at=? WHERE owner_task_id=? AND state='pending'",
		).run(now(), taskId);
		return jobs;
	}
	/**
	 * Host-only: turn a stored search candidate into an observation owned by THIS owner
	 * (origin candidate-cache, no queue job, no inference/HTTP). It counts as one lookup
	 * allowance through countInTransaction but is excluded from countRealInTransaction.
	 */
	function importSearchCandidatesInTransaction(
		db: Database,
		input: CandidateImportInput,
	) {
		if (input.hits.length < 1 || input.hits.length > 5)
			throw new Error("invalid_candidate_import");
		if (input.deadline <= now()) throw new Error("tool_ref_invalid");
		capabilities.validateInTransaction(db, input.prepared);
		const allowed = new Set(input.prepared.package.toolRevisionIds);
		const lookup = input.prepared.dependencies.find(
			(d) =>
				d.kind === "tool" && d.id === "web.lookup" && allowed.has(d.revisionId),
		);
		if (!lookup) throw new Error("invalid_tool_schema");
		const old = db
			.query("SELECT * FROM tool_invocations WHERE step_id=?")
			.get(input.stepId) as Invocation | null;
		if (old) {
			if (
				old.owner_task_id !== input.owner.taskId ||
				old.root_run_id !== input.owner.rootRunId ||
				old.origin !== "candidate-cache"
			)
				throw new Error("idempotency_conflict");
			return old;
		}
		for (const hit of input.hits)
			authorize(db, input.owner, input.prepared, input.bindingToken, hit.url);
		const id = crypto.randomUUID();
		const args = {
			query: input.query,
			provenanceDigest: input.provenanceDigest,
		};
		db.query(
			"INSERT INTO tool_invocations(id,owner_task_id,root_run_id,tool_revision_id,step_id,request_id,args_json,args_digest,operation_id,job_id,state,deadline,created_at,origin) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?,'candidate-cache')",
		).run(
			id,
			input.owner.taskId,
			input.owner.rootRunId,
			lookup.revisionId,
			input.stepId,
			crypto.randomUUID(),
			JSON.stringify(args),
			hash(args),
			`candidate-cache:${id}`,
			"candidate-cache",
			input.deadline,
			now(),
		);
		const inv = get(db, id)!;
		settleInTransaction(db, inv, {
			state: "succeeded",
			result: {
				observedAt: input.searchedAt,
				hits: input.hits,
				documents: [],
				failures: [],
			},
		});
		return get(db, id)!;
	}
	function release(taskId: string) {
		for (const [key, ref] of refs)
			if (ref.owner.taskId === taskId) refs.delete(key);
		for (const [key, result] of vault)
			if (result.ownerTaskId === taskId) vault.delete(key);
	}
	return {
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
		issueCachedGrantInTransaction,
		importSearchCandidatesInTransaction,
		releaseBinding,
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
		inspect: (inv: Invocation) => adapter.get(inv.operation_id),
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
			db.query(
				"UPDATE tool_invocations SET args_json=NULL,result_ref=NULL WHERE root_run_id=?",
			).run(rootRunId);
		},
		close() {
			refs.clear();
			vault.clear();
		},
	};
}
export type ToolRuntime = ReturnType<typeof createToolRuntime>;
