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
import type { ToolAdapter, Invocation, Source, ToolResult } from "../contracts";
import { get } from "../repository";
export function createToolRuntime(
	store: SqliteStore,
	capabilities: Capabilities,
	queue: QueueService,
	adapter: ToolAdapter,
	now = Date.now,
) {
	const refs = new Map<
		string,
		{ owner: Owner; tool: FixedDefinition; prepared: Prepared; expires: number }
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
	function bind(owner: Owner, prepared: Prepared, deadline: number) {
		const allowed = new Set(prepared.package.toolRevisionIds);
		return prepared.dependencies
			.filter((d) => d.kind === "tool" && allowed.has(d.revisionId))
			.map((tool) => {
				if (
					[...refs.values()].filter(
						(r) => ownerKey(r.owner) === ownerKey(owner),
					).length >= 64
				)
					throw new Error("reference_capacity");
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
		if (!ref.tool.schemaKey) throw new Error("invalid_tool_schema");
		const parsed = validators[ref.tool.schemaKey].safeParse(args);
		if (!parsed.success) throw new Error("invalid_tool_input");
		if (
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
				"SELECT * FROM tool_invocations WHERE owner_task_id=? ORDER BY created_at,id",
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
