import type { Database } from "bun:sqlite";
import {
	MAX_STEPS,
	type AuthoringOutcome,
	type ComponentRecord,
} from "eumenes-pipeline";
import { hash } from "../../capabilities";
import { checkPipelineDefinition, CONTRACT_VERSION } from "../../pipelines";
import type {
	ChildResult,
	ExecutionSource,
	ExecutionReference,
	RoutedPipelineStep,
} from "../../tool-runtime";
import {
	executionRow,
	executionSource,
	executionView,
	type ExecutionRow,
	type ParentState,
} from "../repository/executions";
import type { ExecutionContext } from "./execution-context";
import type { ExecutionOps } from "./execution-store";

function routedStepsAvailable(
	catalog: ComponentRecord[],
	steps: readonly RoutedPipelineStep[],
): boolean {
	return (
		steps.length >= 2 &&
		steps.length <= MAX_STEPS &&
		steps.every(
			(step, index) =>
				step.after.every((i) => Number.isInteger(i) && i >= 0 && i < index) &&
				catalog.some(
					(record) =>
						record.card.entry === step.entry &&
						record.evidence.toolchainRevisionId === step.revisionId &&
						record.enabled &&
						record.support !== "excluded" &&
						record.execution !== "unbound",
				),
		)
	);
}

function initialPipelineState(
	control: { bindingRevisionId: string; instructions: string },
	toolchainRevisionId: string,
	refs: ExecutionReference[],
	catalog: ComponentRecord[],
	steps: readonly RoutedPipelineStep[] | undefined,
): ParentState {
	return {
		version: 1,
		bindingRevisionId: control.bindingRevisionId,
		instructions: control.instructions,
		calls: 0,
		consumed: 0,
		searches: 0,
		children: 0,
		ordinal: 0,
		questions: 0,
		selecting: false,
		offered: [],
		retained: [],
		refs: [...refs],
		notes: [],
		pending: null,
		question: null,
		limits: { parentCalls: 5, childCalls: 8, searches: 0, modelCalls: 101 },
		pipeline: {
			contractVersion: CONTRACT_VERSION,
			toolchainRevisionId,
			catalog,
			...(steps ? { routedSteps: steps } : {}),
			initialRefs: refs.map((r) => r.ref),
			definition: null,
			executionPlan: null,
			cursor: 0,
			children: {},
			results: {},
			repaired: false,
		},
	};
}

/** Adapt the imported plan to the existing parent/child lifecycle, without another execution loop. */
export function executionPipeline(ctx: ExecutionContext, ops: ExecutionOps) {
	function selected(state: ParentState) {
		const p = state.pipeline!;
		return (p.executionPlan?.output.from ?? []).flatMap((id) =>
			p.results[id] ? [p.results[id]!] : [],
		);
	}
	function stop(
		db: Database,
		row: ExecutionRow,
		state: ParentState,
		code: string,
	) {
		const p = state.pipeline!;
		ops.finish(db, row, state, "partial", {
			summary: code,
			fulfilled:
				p.definition?.steps
					.slice(0, p.cursor)
					.map((s) => s.task.slice(0, 200)) ?? [],
			missing: p.definition?.steps
				.slice(p.cursor)
				.map((s) => s.task.slice(0, 200)) ?? [code],
			refs: [],
			code,
		});
	}
	function next(db: Database, row: ExecutionRow, state: ParentState) {
		const p = state.pipeline!,
			plan = p.executionPlan;
		if (!plan) return ops.enqueue(db, row, state);
		const step = plan.steps[p.cursor];
		if (!step) {
			const outputs = selected(state);
			const ids = new Set(
				plan.output.from.map((id) => p.children[id]).filter(Boolean),
			);
			return ops.finish(db, row, state, "completed", {
				summary: [
					...outputs.map((r) => r.summary),
					`配送: ${plan.output.deliver}`,
				]
					.join("\n")
					.slice(0, 2000),
				fulfilled: plan.steps.map((s) => s.task.slice(0, 200)),
				missing: [],
				refs: state.notes.filter((n) => ids.has(n.id)).flatMap((n) => n.refs),
				links: [...new Set(outputs.flatMap((r) => r.links ?? []))],
			});
		}
		const source = executionSource(row);
		const current = ctx
			.port()
			.stepToolchainInTransaction?.(db, step.entry, source);
		if (current !== step.revisionId)
			return stop(db, row, state, "pipeline_component_changed");
		const refs: ExecutionReference[] = [];
		for (const from of step.from) {
			if (from === "request") {
				refs.push(...state.refs.filter((r) => p.initialRefs.includes(r.ref)));
				continue;
			}
			const child = p.children[from],
				result = p.results[from];
			if (!child || result?.state !== "completed")
				return stop(db, row, state, "pipeline_reference_missing");
			const note = state.notes.find((n) => n.id === child);
			if (!note) return stop(db, row, state, "pipeline_reference_missing");
			refs.push(
				...state.refs.filter((r) =>
					source.origin === "workflow"
						? r.ref === `result:${child}`
						: note.refs.includes(r.ref),
				),
			);
		}
		const id = crypto.randomUUID();
		p.children[step.stepId] = id;
		try {
			ops.launch(
				db,
				row,
				state,
				{
					chainRevisionId: step.revisionId,
					...(source.origin === "workflow"
						? { pipelineStepId: step.stepId }
						: {}),
					request: `${step.task}\n期待する結果: ${step.expectedResult}`,
					...(step.arguments !== undefined
						? { arguments: step.arguments }
						: {}),
					refs: [...new Map(refs.map((r) => [r.ref, r])).values()],
				},
				id,
			);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				error.message !== "execution_input_capacity"
			)
				throw error;
			delete p.children[step.stepId];
			stop(db, row, state, error.message);
		}
	}
	function advance(
		db: Database,
		row: ExecutionRow,
		state: ParentState,
		result: ChildResult,
	) {
		const p = state.pipeline!,
			step = p.executionPlan?.steps[p.cursor];
		if (!step) return stop(db, row, state, "pipeline_step_mismatch");
		if (result.state !== "completed")
			return stop(
				db,
				row,
				state,
				result.code ?? `pipeline_child_${result.state}`,
			);
		p.results[step.stepId] = result;
		p.cursor++;
		next(db, row, state);
	}
	ops.setAdvance(advance);
	function composed(
		db: Database,
		row: ExecutionRow,
		state: ParentState,
		outcome: AuthoringOutcome,
	) {
		const p = state.pipeline!;
		if (outcome.status === "needs_input")
			return ops.question(db, row, state, outcome.questions.join("\n"));
		if (outcome.status === "unsupported")
			return ops.finish(db, row, state, "partial", {
				summary: outcome.reasons.join("\n").slice(0, 2000),
				fulfilled: [],
				missing: outcome.reasons,
				refs: [],
				code: "pipeline_unsupported",
			});
		const checked = checkPipelineDefinition(
			outcome.definition,
			p.catalog,
			executionSource(row).request,
		);
		if (!checked.ok) throw new Error("pipeline_definition_invalid");
		p.definition = checked.definition;
		p.executionPlan = checked.plan;
		p.correction = undefined;
		next(db, row, state);
	}
	function startPipelineInTransaction(
		db: Database,
		input: {
			source: ExecutionSource;
			toolchainRevisionId: string;
			deadline?: number;
			references?: ExecutionReference[];
			routedSteps?: readonly RoutedPipelineStep[];
			/** A collaborative draft already reviewed by the user. Revalidated against the current catalog. */
			definition?: unknown;
			requestId?: string;
		},
	) {
		const control = ctx
			.port()
			.pipelineInTransaction?.(db, input.toolchainRevisionId);
		if (!control) throw new Error("pipeline_unavailable");
		if (
			!ctx.port().validSourceInTransaction(db, input.source) ||
			input.source.request.length > 8000 ||
			!input.source.request.length
		)
			throw new Error("execution_source_invalid");
		const refs = input.references ?? [];
		if (
			refs.length > 32 ||
			refs.some(
				(r) => !ctx.port().validReferenceInTransaction(db, input.source, r),
			)
		)
			throw new Error("execution_reference_invalid");
		const workflow =
			input.source.origin === "workflow"
				? ctx.port().workflowPlanInTransaction?.(db, input.source)
				: null;
		if (
			input.source.origin === "workflow" &&
			(!workflow ||
				input.definition !== undefined ||
				input.requestId !== input.source.runId)
		)
			throw new Error("pipeline_workflow_source_required");
		if (
			input.definition !== undefined &&
			(!input.requestId || !input.source.specialistSessionId)
		)
			throw new Error("pipeline_authored_source_required");
		const key = workflow
				? `pipeline-workflow:${input.source.runId}`
				: input.definition !== undefined
					? `pipeline-authored:${input.source.specialistSessionId}:${input.requestId}`
					: `pipeline:${input.source.messageId}:${input.source.digest}`,
			digest = hash(input);
		const prior = db
			.query("SELECT * FROM agent_executions WHERE start_key=?")
			.get(key) as ExecutionRow | null;
		if (prior) {
			if (!prior.source_json) throw new Error("execution_source_expired");
			if (prior.input_digest !== digest) throw new Error("request_conflict");
			return executionView(prior);
		}
		const active = db
			.query(
				"SELECT conversation_id FROM agent_executions WHERE state IN ('queued','deciding','waiting_child','waiting_user')",
			)
			.all() as { conversation_id: string }[];
		if (
			active.length >= 32 ||
			active.filter((r) => r.conversation_id === input.source.conversationId)
				.length >= 4
		)
			throw new Error("execution_capacity");
		const catalog = ctx.port().pipelineCatalogInTransaction?.(db, input.source);
		if (!catalog) throw new Error("pipeline_unavailable");
		const steps = input.routedSteps;
		if (steps && !routedStepsAvailable(catalog, steps))
			throw new Error("pipeline_component_unavailable");
		if (new TextEncoder().encode(JSON.stringify(catalog)).length > 128000)
			throw new Error("pipeline_catalog_capacity");
		const id = crypto.randomUUID();
		const state = initialPipelineState(
			control,
			input.toolchainRevisionId,
			refs,
			catalog,
			steps,
		);
		const definition = workflow ? workflow.definition : input.definition;
		if (definition !== undefined) {
			const checked = checkPipelineDefinition(
				definition,
				catalog,
				input.source.request,
			);
			if (!checked.ok) throw new Error("pipeline_definition_invalid");
			if (
				workflow &&
				(workflow.steps.length !== checked.plan.steps.length ||
					workflow.steps.some((pin, index) => {
						const step = checked.plan.steps[index];
						return (
							pin.stepId !== step?.stepId ||
							pin.toolchainRevisionId !== step.revisionId
						);
					}))
			)
				throw new Error("pipeline_component_changed");
			state.pipeline!.definition = checked.definition;
			state.pipeline!.executionPlan = checked.plan;
		}
		db.query(
			"INSERT INTO agent_executions(id,start_key,input_digest,conversation_id,source_json,request,state,state_json,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?,?,?)",
		).run(
			id,
			key,
			digest,
			input.source.conversationId,
			JSON.stringify(input.source),
			input.source.request,
			JSON.stringify(state),
			Math.min(
				ctx.now() + control.runMs,
				input.deadline ?? Number.POSITIVE_INFINITY,
			),
			ctx.now(),
			ctx.now(),
		);
		for (const ref of refs)
			db.query("INSERT INTO agent_execution_refs VALUES(?,?,?)").run(
				id,
				ref.ref,
				JSON.stringify(ref),
			);
		if (state.pipeline!.executionPlan) next(db, executionRow(db, id)!, state);
		else ops.enqueue(db, executionRow(db, id)!, state);
		return executionView(executionRow(db, id)!);
	}
	return { startPipelineInTransaction, composed, stop };
}
export type ExecutionPipeline = ReturnType<typeof executionPipeline>;
