import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { Task } from "../contracts";
import {
	commandBindingV1,
	type Capabilities,
	type Prepared,
	type Owner,
} from "../../capabilities";
import type { ToolRuntime } from "../../tool-runtime";
import { get } from "../repository";

/**
 * One typed operation of a bound command toolchain: the registered adapter operation the
 * binding maps the tool to, and the input already checked against the tool's schema. The agent
 * runtime knows no domain; the adapter behind `adapterRef` executes it.
 */
const actionCommand = z.strictObject({
	bindingRevisionId: z
		.string()
		.regex(/^binding:[a-z][a-z0-9._-]{0,100}@[1-9][0-9]*$/),
	adapterRef: z.string().regex(/^adapter:[a-z][a-z0-9._-]{0,60}@[1-9][0-9]*$/),
	packageRevisionId: z
		.string()
		.regex(/^package:[a-z][a-z0-9._-]{0,100}@[1-9][0-9]*$/),
	toolRevisionId: z
		.string()
		.regex(/^tool:[a-z][a-z0-9._-]{0,100}@[1-9][0-9]*$/),
	operationName: z.string().regex(/^[a-z][a-z0-9._-]{0,80}$/),
	input: z.record(z.string(), z.unknown()),
	/** The logical operation's own request id and decision time, frozen by an interaction. */
	stamp: z
		.strictObject({
			requestId: z.uuid(),
			issuedAt: z.iso.datetime({ offset: true }),
		})
		.optional(),
});
export type ActionCommand = z.infer<typeof actionCommand>;

export function createActionOperation({
	tools,
	capabilities,
	actionPrepared,
	prepared,
	owner,
	ready,
	now,
}: {
	tools: ToolRuntime;
	capabilities: Capabilities;
	actionPrepared: Map<string, Prepared>;
	prepared: Map<string, Prepared>;
	owner: (task: Task) => Owner;
	ready: (
		db: Database,
		task: Task,
		reason?: string | null,
		reportTaskId?: string | null,
	) => void;
	now: () => number;
}) {
	/**
	 * The command must be what its binding says: the adapter, and for the tool the operation.
	 * The binding is the stored, versioned document, not what the caller claims.
	 */
	function checkBinding(db: Database, command: ActionCommand) {
		const stored = capabilities.documentInTransaction(
			db,
			command.bindingRevisionId,
		);
		const binding = commandBindingV1.safeParse(stored?.document);
		if (
			!binding.success ||
			binding.data.adapterRef !== command.adapterRef ||
			binding.data.tools.find(
				(t) => t.toolRevisionId === command.toolRevisionId,
			)?.operationId !== command.operationName
		)
			throw new Error("capability_unavailable");
	}
	return function runAction(
		db: Database,
		t: Task,
		rawCommand: unknown,
		stepId: string,
	) {
		if (t.kind !== "coordinator" || t.phase !== "created")
			throw new Error("capability_unavailable");
		if (!tools.actionsEnabled()) throw new Error("capability_unavailable");
		const parsed = actionCommand.safeParse(rawCommand);
		if (!parsed.success) throw new Error("invalid_action_input");
		const command = parsed.data;
		checkBinding(db, command);
		const actionCapability = actionPrepared.get(t.id);
		if (!actionCapability) throw new Error("required_context_missing");
		// The capability the conversation fixed must still stand, and be the command's package.
		capabilities.validateInTransaction(db, actionCapability);
		if (actionCapability.package.revisionId !== command.packageRevisionId)
			throw new Error("capability_unavailable");
		const preparedAction = capabilities.prepareBoundInTransaction(
			db,
			owner(t),
			command.packageRevisionId,
			command.toolRevisionId,
			command.input,
			{
				hash: actionCapability.package.hash,
				generation: actionCapability.package.generation,
			},
		);
		prepared.set(t.id, preparedAction);
		const bound = tools.bind(owner(t), preparedAction, t.deadline);
		const picked = bound.find(
			(item) => item.tool.revisionId === command.toolRevisionId,
		);
		if (!picked) throw new Error("capability_unavailable");
		const saved = tools.invokeActionInTransaction(
			db,
			owner(t),
			picked.executionRef,
			command.input,
			stepId,
			t.deadline,
			`${t.root_run_id}:${t.cancel_epoch}`,
			{ adapterRef: command.adapterRef, operationName: command.operationName },
			command.stamp,
		);
		db.query(
			`INSERT INTO agent_action_results(task_id,invocation_id,operation_id,receipt_digest,payload_json,created_at)
             VALUES(?,?,?,?,?,?)`,
		).run(
			t.id,
			saved.invocationId,
			saved.operationId,
			saved.receiptDigest,
			JSON.stringify(saved.payload),
			now(),
		);
		ready(db, get(db, t.id)!);
	};
}
