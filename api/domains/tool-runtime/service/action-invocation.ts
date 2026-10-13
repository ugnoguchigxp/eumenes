import type { Database } from "bun:sqlite";
import {
	ValidationFailure,
	validationIssues,
} from "../../../infrastructure/validation-log";
import {
	hash,
	validators,
	type Capabilities,
	type Owner,
} from "../../capabilities";
import type { ActionAdapter, ActionEnvelope } from "../contracts";
import type { ReadReference } from "./read-invocation";

const ownerKey = (o: Owner) => JSON.stringify(o);

/** Immediate local actions of agent tasks, executed through a registered domain adapter. */
export function createActionInvocations({
	actions,
	refs,
	now,
	capabilities,
}: {
	actions?: ActionAdapter;
	refs: Map<string, ReadReference>;
	now: () => number;
	capabilities: Capabilities;
}) {
	return {
		readActionInTransaction(db: Database, owner: Owner, invocationId: string) {
			const row = db
				.query("SELECT * FROM tool_action_invocations WHERE id=?")
				.get(invocationId) as {
				owner_task_id: string;
				root_run_id: string;
				cancel_epoch: number;
				operation_id: string;
				receipt_digest: string;
				adapter_ref: string;
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
			const result = actions?.readInTransaction(
				db,
				row.operation_id,
				owner,
				row.adapter_ref,
			);
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
			binding: { adapterRef: string; operationName: string },
			/**
			 * The logical operation's own request id and decision time (a toolchain interaction
			 * froze them); without it the invocation mints both.
			 */
			stamp?: { requestId: string; issuedAt: string },
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
				adapter_ref: string;
				operation_name: string | null;
			} | null;
			if (old) {
				if (
					old.adapter_ref !== binding.adapterRef ||
					old.operation_name !== binding.operationName ||
					old.owner_task_id !== owner.taskId ||
					old.root_run_id !== owner.rootRunId ||
					old.tool_revision_id !== ref.tool.revisionId ||
					old.args_digest !== argsDigest ||
					old.cancel_epoch !== owner.cancelEpoch
				)
					throw new Error("idempotency_conflict");
				const again = actions.readInTransaction(
					db,
					old.operation_id,
					owner,
					old.adapter_ref,
				);
				if (!again || again.receiptDigest !== old.receipt_digest)
					throw new Error("operation_expired");
				return { ...again, invocationId: old.id };
			}
			const requestId = stamp?.requestId ?? crypto.randomUUID();
			const issuedAt = stamp?.issuedAt ?? new Date(now()).toISOString();
			const envelope = actions.executeInTransaction(db, {
				requestId,
				issuedAt,
				tool: ref.tool,
				arguments: parsed.data,
				owner,
				originToken,
				adapterRef: binding.adapterRef,
				operationName: binding.operationName,
			});
			if (
				envelope.kind !== "local_action" ||
				envelope.adapterRef !== binding.adapterRef ||
				envelope.version !== 1 ||
				!envelope.operationId ||
				!envelope.receiptDigest
			)
				throw new Error("invalid_tool_input");
			const invocationId = crypto.randomUUID();
			db.query(
				`INSERT INTO tool_action_invocations(
          id,root_run_id,owner_task_id,cancel_epoch,step_id,tool_revision_id,
          request_id,args_digest,operation_id,receipt_digest,state,created_at,
          adapter_ref,operation_name
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
				binding.adapterRef,
				binding.operationName,
			);
			return { ...envelope, invocationId };
		},
	};
}
