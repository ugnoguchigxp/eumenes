import type { Database } from "bun:sqlite";
import { hash } from "../../capabilities";
import { expand, expandValue, startInputs, stepFault } from "../../pipelines";
import type { ChildResult, ExecutionSource } from "../../tool-runtime";
import {
	executionRow,
	executionSource,
	executionView,
	type ExecutionRow,
	type ParentState,
} from "../repository/executions";
import { PIPELINE_EXTRACT, type ExecutionContext } from "./execution-context";
import type { ExecutionOps } from "./execution-store";

type Pipeline = NonNullable<ParentState["pipeline"]>;

/**
 * A task pipeline's run on the parent execution (spec task-pipeline-design 2026-10-22 §13.4). The host takes the
 * steps in order: a toolchain step is a child of the run, an extract step one inference of its own. A step that
 * does not pass stops the run with what was done so far. Meaning is never judged here.
 */
export function executionPipeline(ctx: ExecutionContext, ops: ExecutionOps) {
	const { now } = ctx;
	const titles = (p: Pipeline, from: number, to = p.definition.steps.length) =>
		p.definition.steps
			.slice(from, to)
			.filter((s) => s.kind === "toolchain")
			.map((s) => s.title);
	const summaries = (p: Pipeline) =>
		p.definition.steps
			.slice(0, p.cursor)
			.flatMap((s) => {
				const v = p.values[s.id];
				return s.kind === "toolchain" && v?.summary
					? [`${s.title}: ${v.summary}`]
					: [];
			})
			.join("\n")
			.slice(0, 2000);
	const refs = (state: ParentState) =>
		[...new Set(state.notes.flatMap((n) => n.refs))].slice(0, 8);

	function stop(
		db: Database,
		row: ExecutionRow,
		state: ParentState,
		code: string,
	) {
		const p = state.pipeline!;
		ops.finish(db, row, state, "partial", {
			summary: summaries(p) || code,
			fulfilled: titles(p, 0, p.cursor),
			missing: titles(p, p.cursor),
			refs: refs(state),
			code,
		});
	}
	function complete(db: Database, row: ExecutionRow, state: ParentState) {
		const p = state.pipeline!;
		let summary = summaries(p);
		if (p.definition.answer)
			try {
				summary = expand(p.definition.answer, {
					inputs: p.inputs,
					steps: p.values,
				});
			} catch {
				// The answer's template names a value no step gave: the steps' own results stand for it.
			}
		ops.finish(db, row, state, "completed", {
			summary: summary.slice(0, 2000) || p.definition.title,
			fulfilled: titles(p, 0),
			missing: [],
			refs: refs(state),
		});
	}
	/** The step at the cursor: a child for a toolchain step, the extract job for an extract step, or the end. */
	function next(db: Database, row: ExecutionRow, state: ParentState) {
		const p = state.pipeline!;
		const step = p.definition.steps[p.cursor];
		if (!step) return complete(db, row, state);
		if (step.kind === "extract")
			return ops.enqueue(db, row, state, false, PIPELINE_EXTRACT);
		const chain = ctx
			.port()
			.stepToolchainInTransaction?.(db, step.toolchain, executionSource(row));
		if (!chain) return stop(db, row, state, "pipeline_toolchain_unavailable");
		const scope = { inputs: p.inputs, steps: p.values };
		let request: string;
		let args: Record<string, unknown> | undefined;
		try {
			request = expand(step.request, scope).slice(0, 8000);
			args = step.arguments
				? Object.fromEntries(
						Object.entries(step.arguments).map(([k, v]) => [
							k,
							expandValue(v, scope),
						]),
					)
				: undefined;
		} catch {
			return stop(db, row, state, "pipeline_reference_missing");
		}
		const used = new Set(
			(step.uses ?? []).map((id) => `result:${p.children[id]}`),
		);
		const id = crypto.randomUUID();
		p.children[step.id] = id;
		ops.launch(
			db,
			row,
			state,
			{
				chainRevisionId: chain,
				request,
				...(args ? { arguments: args } : {}),
				refs: state.refs.filter((r) => used.has(r.ref)),
			},
			id,
		);
	}
	/** A settled child: the step passes with its result, or the run stops. */
	function advance(
		db: Database,
		row: ExecutionRow,
		state: ParentState,
		result: ChildResult,
	) {
		const p = state.pipeline!;
		const step = p.definition.steps[p.cursor];
		if (step?.kind !== "toolchain")
			return stop(db, row, state, "pipeline_step_mismatch");
		const fault = stepFault(step, result);
		if (fault) return stop(db, row, state, fault);
		p.values[step.id] = { summary: result.summary, output: result.output };
		p.cursor++;
		next(db, row, state);
	}
	/** An extract step's checked value. */
	function extracted(
		db: Database,
		row: ExecutionRow,
		state: ParentState,
		value: unknown,
	) {
		const p = state.pipeline!;
		const step = p.definition.steps[p.cursor]!;
		p.values[step.id] = { value };
		p.correction = undefined;
		p.cursor++;
		next(db, row, state);
	}
	ops.setAdvance(advance);

	function startPipelineInTransaction(
		db: Database,
		input: {
			source: ExecutionSource;
			toolchainRevisionId: string;
			inputs: Record<string, unknown>;
		},
	) {
		const published = ctx
			.port()
			.pipelineInTransaction?.(db, input.toolchainRevisionId);
		if (!published) throw new Error("pipeline_unavailable");
		if (!ctx.port().validSourceInTransaction(db, input.source))
			throw new Error("execution_source_invalid");
		const key = `pipeline:${input.source.messageId}:${input.source.digest}`;
		const digest = hash(input);
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
			.all() as Array<{ conversation_id: string }>;
		if (
			active.length >= 32 ||
			active.filter((r) => r.conversation_id === input.source.conversationId)
				.length >= 4
		)
			throw new Error("execution_capacity");
		const { tests: _, ...definition } = published.definition;
		const steps = definition.steps.filter((s) => s.kind === "toolchain").length;
		const extracts = definition.steps.length - steps;
		const id = crypto.randomUUID();
		const state: ParentState = {
			version: 1,
			bindingRevisionId: published.bindingRevisionId,
			instructions: "",
			calls: 0,
			consumed: 0,
			searches: 0,
			children: 0,
			ordinal: 0,
			questions: 0,
			selecting: false,
			offered: [],
			retained: [],
			refs: [],
			notes: [],
			pending: null,
			question: null,
			// Each extract may take its one repair; each child may take the most a child is allotted.
			limits: {
				parentCalls: extracts * 2 + 1,
				childCalls: steps,
				searches: 0,
				modelCalls: steps * 12 + extracts * 2 + 1,
			},
			pipeline: {
				toolchainRevisionId: input.toolchainRevisionId,
				definition,
				inputs: startInputs(published.definition, input.inputs),
				values: {},
				cursor: 0,
				children: {},
			},
		};
		db.query(
			"INSERT INTO agent_executions(id,start_key,input_digest,conversation_id,source_json,request,state,state_json,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?,?,?)",
		).run(
			id,
			key,
			digest,
			input.source.conversationId,
			JSON.stringify(input.source),
			definition.title,
			JSON.stringify(state),
			now() + published.runMs,
			now(),
			now(),
		);
		next(db, executionRow(db, id)!, state);
		return executionView(executionRow(db, id)!);
	}
	return { startPipelineInTransaction, extracted, stop };
}
export type ExecutionPipeline = ReturnType<typeof executionPipeline>;
