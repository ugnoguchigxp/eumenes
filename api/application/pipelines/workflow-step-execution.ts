import type { Database } from "bun:sqlite";
import type { z } from "zod";
import type { AgentRuntime } from "../../domains/agent-runtime";
import type { ChildExecution, ChildResult } from "../../domains/tool-runtime";
import type { WorkflowExecutionAuthority } from "./workflow-execution-source";

type OperationInput = {
	request?: Record<string, unknown>;
	scheduledAtMs: number | null;
	predecessors: Record<string, unknown>;
	task?: string;
};

export type WorkflowOperation = {
	usesModel?: boolean;
	prepare(db: Database, input: OperationInput, child: ChildExecution): unknown;
	execute(prepared: unknown, signal: AbortSignal): Promise<ChildResult>;
	current(db: Database, child: ChildExecution, ref: unknown): ChildResult;
	adopt?(db: Database, result: ChildResult): boolean;
	verify?(db: Database, result: ChildResult): boolean;
	cancel?(db: Database, child: ChildExecution, ref: unknown): void;
};

export function createWorkflowStepExecution(deps: {
	authority: WorkflowExecutionAuthority;
	agents: Pick<AgentRuntime["executions"], "resultReferenceInTransaction">;
	operations: ReadonlyMap<string, WorkflowOperation>;
	schema(db: Database, child: ChildExecution, ref: string): z.ZodType | null;
}) {
	function context(db: Database, child: ChildExecution, stopping = false) {
		const resolved = deps.authority.runInTransaction(
			db,
			child.source,
			stopping,
		);
		const stepId = child.pipelineStepId;
		const pin = resolved?.saved.value.pins.find(
			(value) => value.stepId === stepId,
		);
		const step = resolved?.saved.value.definition.pipeline.steps.find(
			(value) => value.id === stepId,
		);
		const operation = pin ? deps.operations.get(pin.operationRef) : null;
		if (
			!resolved ||
			!pin ||
			!step ||
			!operation ||
			pin.toolchainRevisionId !== child.chainRevisionId
		)
			throw new Error("workflow_step_unavailable");
		return { ...resolved, pin, step, operation };
	}
	function prepare(db: Database, child: ChildExecution) {
		const { run, saved, step, operation } = context(db, child);
		const expected = new Set(step.from.filter((id) => id !== "request"));
		const predecessors: Record<string, unknown> = Object.create(null);
		for (const ref of child.refs) {
			const result = deps.agents.resultReferenceInTransaction(
				db,
				child.source.conversationId,
				ref,
			);
			const id = result?.child.pipelineStepId;
			const pin = saved.value.pins.find((value) => value.stepId === id);
			const schema = pin ? deps.schema(db, child, pin.outputSchemaRef) : null;
			if (
				!result ||
				!id ||
				!expected.delete(id) ||
				!schema ||
				result.child.executionId !== child.executionId ||
				result.child.source.runId !== child.source.runId ||
				result.result.state !== "completed"
			)
				throw new Error("workflow_step_reference_invalid");
			predecessors[id] = schema.parse(result.result.output);
		}
		if (expected.size) throw new Error("workflow_step_reference_invalid");
		const input = {
			...(step.from.includes("request") ? { request: run.inputs } : {}),
			scheduledAtMs: run.scheduledAtMs,
			predecessors,
			...(operation.usesModel ? { task: step.task } : {}),
		};
		return { operation, prepared: operation.prepare(db, input, child) };
	}
	return {
		prepare,
		async execute(raw: unknown, signal: AbortSignal) {
			const { operation, prepared } = raw as ReturnType<typeof prepare>;
			return operation.execute(prepared, signal);
		},
		current(db: Database, child: ChildExecution, ref: unknown) {
			return context(db, child).operation.current(db, child, ref);
		},
		verify(db: Database, child: ChildExecution, result: ChildResult) {
			const { pin, operation } = context(db, child);
			return (
				result.state === "completed" &&
				(!operation.verify || operation.verify(db, result)) &&
				(deps.schema(db, child, pin.outputSchemaRef)?.safeParse(result.output)
					.success ??
					false)
			);
		},
		adopt(db: Database, child: ChildExecution, result: ChildResult) {
			const { pin, operation } = context(db, child);
			if (result.state === "waiting_input" || result.references.length !== 0)
				return false;
			if (result.state !== "completed") return true;
			if (operation.adopt && !operation.adopt(db, result)) return false;
			return (
				deps.schema(db, child, pin.outputSchemaRef)?.safeParse(result.output)
					.success ?? false
			);
		},
		cancel(db: Database, child: ChildExecution, ref: unknown) {
			const resolved = deps.authority.runInTransaction(db, child.source, true);
			const pin = resolved?.saved.value.pins.find(
				(value) => value.stepId === child.pipelineStepId,
			);
			if (pin?.toolchainRevisionId === child.chainRevisionId)
				deps.operations.get(pin.operationRef)?.cancel?.(db, child, ref);
		},
	};
}

export type WorkflowStepExecution = ReturnType<
	typeof createWorkflowStepExecution
>;
