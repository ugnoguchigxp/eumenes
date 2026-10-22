import type { Database } from "bun:sqlite";
import { hash } from "../../capabilities";
import {
	executionControl,
	executionReference,
	type ExecutionReference,
	type ExecutionSource,
} from "../../tool-runtime";
import {
	executionRow,
	executionSource,
	executionState,
	executionView,
	isExecutionActive,
	saveExecution,
	type ExecutionRow,
	type ParentState,
} from "../repository/executions";
import type { ExecutionContext } from "./execution-context";

import type { ExecutionOps } from "./execution-store";
export function executionCommands(
	ctx: ExecutionContext,
	ops: ExecutionOps,
	available: (db: Database) => boolean,
) {
	const { queue, now } = ctx;
	function startInTransaction(
		db: Database,
		input: {
			source: ExecutionSource;
			request: string;
			references: ExecutionReference[];
		},
	) {
		if (!available(db)) throw new Error("execution_unavailable");
		if (!ctx.port().validSourceInTransaction(db, input.source))
			throw new Error("execution_source_invalid");
		if (
			new TextEncoder().encode(JSON.stringify(input)).length > 24_576 ||
			!input.request.trim() ||
			input.request.length > 8000 ||
			input.references.length > 32
		)
			throw new Error("execution_input_capacity");
		const refs = input.references.map((r) => executionReference.parse(r));
		if (
			refs.some(
				(r) => !ctx.port().validReferenceInTransaction(db, input.source, r),
			)
		)
			throw new Error("execution_reference_invalid");
		const key = `execute:${input.source.messageId}:${input.source.digest}`;
		const digest = hash(input);
		const prior = db
			.query("SELECT * FROM agent_executions WHERE start_key=?")
			.get(key) as ExecutionRow | null;
		if (prior) {
			if (!prior.source_json) throw new Error("execution_source_expired");
			if (prior.input_digest !== digest) throw new Error("request_conflict");
			return executionView(prior);
		}
		const counts = db
			.query(
				"SELECT conversation_id FROM agent_executions WHERE state IN ('queued','deciding','waiting_child','waiting_user')",
			)
			.all() as Array<{ conversation_id: string }>;
		if (
			counts.length >= 32 ||
			counts.filter((r) => r.conversation_id === input.source.conversationId)
				.length >= 4
		)
			throw new Error("execution_capacity");
		const control = ctx.port().controlInTransaction(db)!;
		const id = crypto.randomUUID();
		const state: ParentState = {
			version: 1,
			planRequired: true,
			bindingRevisionId: control.revisionId,
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
			refs,
			notes: [],
			pending: null,
			question: null,
			limits: control.limits,
		};
		db.query(
			"INSERT INTO agent_executions(id,start_key,input_digest,conversation_id,source_json,request,state,state_json,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?,?,?)",
		).run(
			id,
			key,
			digest,
			input.source.conversationId,
			JSON.stringify(input.source),
			input.request,
			JSON.stringify(state),
			now() + control.runMs,
			now(),
			now(),
		);
		const row = executionRow(db, id)!;
		for (const ref of refs)
			db.query("INSERT INTO agent_execution_refs VALUES(?,?,?)").run(
				id,
				ref.ref,
				JSON.stringify(ref),
			);
		ops.enqueue(db, row, state);
		return executionView(executionRow(db, id)!);
	}
	function controlInTransaction(
		db: Database,
		conversationId: string,
		raw: unknown,
		answerMessageId: string,
	) {
		const input = executionControl.parse(raw);
		const controlSource = ctx
			.port()
			.controlSourceInTransaction(db, conversationId, answerMessageId);
		if (!controlSource) throw new Error("execution_source_invalid");
		const row = executionRow(db, input.workRef);
		if (!row || row.conversation_id !== conversationId)
			throw new Error("execution_not_found");
		if (row.request_revision !== input.expectedRevision)
			throw new Error("revision_conflict");
		const state = executionState(row);
		if (input.action === "status" || !isExecutionActive(row))
			return executionView(row);
		if (!ctx.port().validSourceInTransaction(db, executionSource(row))) {
			ops.fail(db, row, state, "execution_source_invalid");
			return executionView(executionRow(db, row.id)!);
		}
		if (row.deadline <= now()) {
			ops.fail(db, row, state, "deadline_exceeded");
			return executionView(executionRow(db, row.id)!);
		}
		// A pipeline's steps are fixed: a changed request is a new request, not an amendment of this run.
		if (input.action === "amend" && state.pipeline)
			throw new Error("pipeline_amend_unsupported");
		if (input.action === "cancel")
			ops.fail(db, row, state, "cancel_requested", "cancelled");
		else if (input.action === "answer") {
			if (
				!state.question ||
				state.question.id !== input.questionRef ||
				state.question.expiresAt <= now()
			)
				throw new Error("execution_question_closed");
			if (
				state.pending?.result &&
				!ctx
					.port()
					.validateAnswerInTransaction(
						db,
						state.pending.child,
						state.pending.result,
						input.input,
					)
			)
				throw new Error("invalid_answer");
			if (
				!state.pending &&
				(typeof input.input !== "string" ||
					!input.input.trim() ||
					input.input.length > 8000)
			)
				throw new Error("invalid_answer");
			const source = executionSource(row);
			source.responses = [...(source.responses ?? []), controlSource];
			row.source_json = JSON.stringify(source);
			db.query("UPDATE agent_executions SET source_json=? WHERE id=?").run(
				row.source_json,
				row.id,
			);
			db.query(
				"UPDATE agent_execution_questions SET state='answered',answer_json=? WHERE id=? AND state='waiting'",
			).run(JSON.stringify(input.input ?? null), state.question.id);
			if (state.pending) {
				const used = state.pending.result?.modelCalls ?? 0;
				if (used >= state.pending.allocation) {
					ops.fail(db, row, state, "execution_budget_exceeded");
					return executionView(executionRow(db, row.id)!);
				}
				state.pending.child.source = source;
				state.pending.child.usedModelCalls = used;
				state.pending.child.modelCalls = state.pending.allocation - used;
				state.pending.child.dispatchId = crypto.randomUUID();
				state.pending.child.resume = {
					questionId: state.question.id,
					input: input.input,
					previous: {
						earlier: state.pending.child.resume?.previous,
						earlierAnswer: state.pending.child.resume?.input,
						result: state.pending.result?.ref,
						question: state.question.prompt,
					},
					answerMessageId,
				};
				db.query(
					"UPDATE agent_execution_steps SET input_json=?,input_digest=? WHERE id=?",
				).run(
					JSON.stringify(state.pending.child),
					hash(state.pending.child),
					state.pending.child.id,
				);
				state.pending.result = null;
				state.question = null;
				row.state = "waiting_child";
				ops.enqueue(db, row, state, true);
			} else {
				state.notes.push({
					id: state.question.id,
					state: "user_answer",
					question: state.question.prompt,
					summary: JSON.stringify(input.input).slice(0, 2000),
					refs: [],
				});
				state.question = null;
				ops.enqueue(db, row, state);
			}
		} else {
			if (!input.request) throw new Error("execution_request_required");
			const priorJob = row.job_id;
			row.request_revision++;
			row.epoch++;
			row.request = input.request;
			state.planRequired = true;
			const source = executionSource(row);
			if ((source.amendments?.length ?? 0) >= 32)
				throw new Error("execution_source_capacity");
			source.amendments = [...(source.amendments ?? []), controlSource];
			row.source_json = JSON.stringify(source);
			db.query("UPDATE agent_executions SET source_json=? WHERE id=?").run(
				row.source_json,
				row.id,
			);
			if (state.activeRequestId)
				ctx.inference.cancelRequestsInTransaction?.(db, [
					state.activeRequestId,
				]);
			state.activeRequestId = undefined;
			state.question = null;
			state.selecting = false;
			state.offered = state.retained;
			db.query(
				"UPDATE agent_execution_questions SET state='cancelled' WHERE execution_id=? AND state='waiting'",
			).run(row.id);
			if (state.pending) {
				state.amending = true;
				state.pending.result ??= {
					state: "running",
					ref: null,
					summary: "",
					references: [],
					modelCalls: 0,
				};
				row.state = "waiting_child";
				saveExecution(db, row, state, now());
				ctx
					.port()
					.cancelInTransaction(
						db,
						state.pending.child,
						state.pending.result.ref,
					);
			} else ops.enqueue(db, row, state);
			if (priorJob)
				queue.cancelInTransaction(db, priorJob, "execution_amended");
		}
		return executionView(executionRow(db, row.id)!);
	}
	return { startInTransaction, controlInTransaction };
}
