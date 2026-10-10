import type { Database } from "bun:sqlite";
import {
	hash,
	validators,
	type Owner,
	type Prepared,
	type FixedDefinition,
	type Capabilities,
} from "../../capabilities";
import {
	ValidationFailure,
	validationIssues,
} from "../../../infrastructure/validation-log";
import type { Invocation, ToolAdapter, AdapterOperation } from "../contracts";
import { get, hasReadMetadata } from "../repository";
import { operationFingerprint } from "./source-results";
export type ReadReference = {
	owner: Owner;
	tool: FixedDefinition;
	prepared: Prepared;
	expires: number;
	grant?: {
		bindingToken: string;
		exactUrl: string;
		argsDigest: string;
		attemptTimeoutMs?: number;
	};
};
const ownerKey = (o: Owner) => JSON.stringify(o);
export function createReadInvocation({
	refs,
	localOperations,
	now,
	capabilities,
	adapter,
	authorize,
}: {
	refs: Map<string, ReadReference>;
	localOperations: Map<string, AdapterOperation>;
	now: () => number;
	capabilities: Capabilities;
	adapter: ToolAdapter;
	authorize: (
		db: Database,
		owner: Owner,
		prepared: Prepared,
		bindingToken: string,
		exactUrl: string,
	) => void;
}) {
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
		if (!parsed.success) {
			const bothPositions =
				ref.tool.schemaKey === "readSaved" &&
				args !== null &&
				typeof args === "object" &&
				"cursor" in args &&
				"start" in args &&
				typeof args.cursor === "string" &&
				args.start === "head";
			throw new ValidationFailure(
				"invalid_tool_input",
				validationIssues(parsed.error, args, ["arguments"]).map((issue) =>
					bothPositions && issue.validationCode === "custom"
						? {
								...issue,
								validationPath: "arguments.start",
								validationCode: "omit_start_with_cursor",
							}
						: issue,
				),
				parsed.error.issues.length,
			);
		}
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
		const fingerprint =
			adapter.operationFingerprintInTransaction?.(db, {
				tool: ref.tool,
				arguments: parsed.data,
				owner,
			}) ?? operationFingerprint(ref.tool.id, parsed.data);
		const successful = db
			.query(
				`SELECT id,tool_revision_id,args_json,${hasReadMetadata(db) ? "operation_fingerprint" : "NULL AS operation_fingerprint"} FROM tool_invocations WHERE owner_task_id=? AND state IN ('succeeded','partial')`,
			)
			.all(owner.taskId) as Array<{
			id: string;
			tool_revision_id: string;
			operation_fingerprint: string | null;
			args_json: string | null;
		}>;
		const replay = successful.find(
			(i) =>
				i.operation_fingerprint === fingerprint ||
				(i.args_json &&
					operationFingerprint(
						i.tool_revision_id.split(":").slice(1).join(":").split("@")[0]!,
						JSON.parse(i.args_json),
					) === fingerprint),
		);
		if (replay) {
			const existing = get(db, replay.id)!;
			if (
				existing.deadline <= now() ||
				existing.cancel_epoch !== owner.cancelEpoch
			)
				throw new Error("tool_ref_invalid");
			return existing;
		}
		const isLocal = [
			"web.find",
			"web.read_saved",
			"history.search",
			"history.read",
		].includes(ref.tool.id);
		const localId = crypto.randomUUID();
		const operation = isLocal
			? { operationId: `local:${localId}`, jobId: parentJobId }
			: adapter.startInTransaction(db, {
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
		if (isLocal) {
			if (!adapter.localInTransaction)
				throw new Error("local_read_unavailable");
			for (const id of localOperations.keys()) {
				const current = db
					.query("SELECT state FROM tool_invocations WHERE operation_id=?")
					.get(id) as { state: string } | null;
				if (!current || current.state !== "pending") localOperations.delete(id);
			}
			if (localOperations.size >= 64) throw new Error("result_capacity");
			let result;
			try {
				result = adapter.localInTransaction(db, {
					tool: ref.tool,
					arguments: parsed.data,
					owner,
					deadline,
				});
			} catch (e) {
				result = {
					state: "failed" as const,
					errorCode:
						e instanceof Error && /^[a-z_]+$/.test(e.message)
							? e.message
							: "local_read_failed",
				};
			}
			localOperations.set(operation.operationId, result);
		}

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
		if (hasReadMetadata(db))
			db.query(
				"UPDATE tool_invocations SET cancel_epoch=?,operation_fingerprint=? WHERE id=?",
			).run(owner.cancelEpoch, fingerprint, invocationId);
		return get(db, invocationId)!;
	}

	return invokeInTransaction;
}
