import type { Database } from "bun:sqlite";
import type { Task } from "../contracts";
import {
	timerCommand,
	type Capabilities,
	type Prepared,
	type Owner,
} from "../../capabilities";
import type { ToolRuntime } from "../../tool-runtime";
import { get } from "../repository";
export function createTimerOperation({
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
	return function runTimer(
		db: Database,
		t: Task,
		rawCommand: unknown,
		snapshot: unknown,
		stepId: string,
	) {
		const action = { command: rawCommand };
		if (t.kind !== "coordinator" || t.phase !== "created")
			throw new Error("capability_unavailable");
		if (!tools.actionsEnabled()) throw new Error("capability_unavailable");
		const parsed = timerCommand.safeParse(action.command);
		if (!parsed.success) throw new Error("invalid_timer_input");
		if (
			parsed.data.operation === "cancel" ||
			(parsed.data.operation === "list" && parsed.data.timerId)
		) {
			const targets = snapshot as
				| { items?: Array<{ id: string; revision: number }> }
				| undefined;
			const command = parsed.data;
			if (
				!targets?.items?.some(
					(item) =>
						item.id === command.timerId &&
						(command.operation !== "cancel" ||
							item.revision === command.expectedRevision),
				)
			)
				throw new Error("timer_target_invalid");
		}
		const actionCapability = actionPrepared.get(t.id);
		if (!actionCapability) throw new Error("required_context_missing");
		capabilities.validateInTransaction(db, actionCapability);
		const preparedTimer = capabilities.prepareActiveByIdInTransaction(
			db,
			owner(t),
			"package:timers.manage@1",
			parsed.data,
			{
				hash: actionCapability.package.hash,
				generation: actionCapability.package.generation,
			},
		);
		prepared.set(t.id, preparedTimer);
		const bound = tools.bind(owner(t), preparedTimer, t.deadline);
		const toolId =
			parsed.data.operation === "start"
				? "timer.start"
				: parsed.data.operation === "cancel"
					? "timer.cancel"
					: "timer.list";
		const picked = bound.find((item) => item.tool.id === toolId);
		if (!picked) throw new Error("capability_unavailable");
		const command = parsed.data;
		const args =
			command.operation === "start"
				? {
						durationSeconds: command.durationSeconds,
						...(command.label ? { label: command.label } : {}),
					}
				: command.operation === "cancel"
					? {
							timerId: command.timerId,
							expectedRevision: command.expectedRevision,
						}
					: {
							...(command.timerId ? { timerId: command.timerId } : {}),
							...(command.state ? { state: command.state } : {}),
						};
		const saved = tools.invokeActionInTransaction(
			db,
			owner(t),
			picked.executionRef,
			args,
			stepId,
			t.deadline,
			`${t.root_run_id}:${t.cancel_epoch}`,
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
