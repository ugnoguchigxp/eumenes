import type { Database } from "bun:sqlite";
import { hash } from "../../domains/capabilities";
import {
	workflowRevisionInTransaction,
	workflowRunInTransaction,
} from "../../domains/pipelines";
import type {
	ExecutionSource,
	ToolchainExecutionPort,
} from "../../domains/tool-runtime";

type Saved = NonNullable<ReturnType<typeof workflowRevisionInTransaction>>;
type Run = NonNullable<ReturnType<typeof workflowRunInTransaction>>;

export function createWorkflowExecutionAuthority(deps: {
	now(): number;
	authorized(db: Database, saved: Saved, run: Run): boolean;
}) {
	function resolve(
		db: Database,
		scope: string,
		runId: string,
		stopping = false,
	) {
		const run = workflowRunInTransaction(db, scope, runId);
		if (
			!run ||
			(!stopping &&
				(!["accepted", "running", "publishing"].includes(run.state) ||
					run.deadlineMs <= deps.now()))
		)
			return null;
		const saved = workflowRevisionInTransaction(
			db,
			scope,
			run.workflowId,
			run.revision,
		);
		if (!saved?.value.grant || (!stopping && !deps.authorized(db, saved, run)))
			return null;
		const source: ExecutionSource = {
			origin: "workflow",
			workflow: {
				scope,
				definitionId: run.workflowId,
				revision: saved.revision,
			},
			conversationId: saved.value.grant.conversationId,
			messageId: null,
			runId,
			request: saved.value.definition.pipeline.request,
			digest: run.inputDigest,
		};
		return { source, saved, run };
	}
	function runInTransaction(
		db: Database,
		source: ExecutionSource,
		stopping = false,
	) {
		if (source.origin !== "workflow" || !source.workflow) return null;
		const resolved = resolve(db, source.workflow.scope, source.runId, stopping);
		return resolved && hash(source) === hash(resolved.source) ? resolved : null;
	}

	const planInTransaction: NonNullable<
		ToolchainExecutionPort["workflowPlanInTransaction"]
	> = (db, source) => {
		const resolved = runInTransaction(db, source);
		if (!resolved) return null;
		return {
			definition: resolved.saved.value.definition.pipeline,
			steps: resolved.saved.value.pins,
		};
	};
	return {
		runInTransaction,
		sourceInTransaction: (db: Database, scope: string, runId: string) =>
			resolve(db, scope, runId)?.source ?? null,
		planInTransaction,
	};
}

export type WorkflowExecutionAuthority = ReturnType<
	typeof createWorkflowExecutionAuthority
>;
