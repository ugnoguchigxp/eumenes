import type { Database } from "bun:sqlite";
import { hash } from "../../capabilities";
import {
	executionReference,
	type ChildResult,
	type ExecutionResult,
	type ExecutionStatus,
} from "../../tool-runtime";
import {
	executionRow,
	executionSource,
	executionState,
	isExecutionActive,
	saveExecution,
	type ExecutionRow,
	type ParentState,
} from "../repository/executions";
import {
	CHILD_STEP,
	PARENT_STEP,
	type ExecutionContext,
} from "./execution-context";
import { plannedInvocation } from "./execution-invocation";

export function createExecutionStore(ctx: ExecutionContext) {
	const { queue, now } = ctx;
	/** A pipeline's next step after a settled child (spec task-pipeline-design §13.4); set by its module. */
	let advance:
		| ((db: Database, r: ExecutionRow, s: ParentState, c: ChildResult) => void)
		| null = null;
	function event(db: Database, row: ExecutionRow, kind: string) {
		db.query(
			"INSERT OR IGNORE INTO agent_execution_events(id,execution_id,kind) VALUES(?,?,?)",
		).run(`execution:${row.id}:${kind}`, row.id, kind);
	}
	function enqueue(
		db: Database,
		row: ExecutionRow,
		state: ParentState,
		child = false,
		kind = child ? CHILD_STEP : PARENT_STEP,
	) {
		state.ordinal++;
		const { job } = queue.enqueueInTransaction(db, {
			scope: "agent",
			kind,
			dedupeKey: `execution:${row.id}:${row.epoch}:${state.ordinal}`,
			payload: { id: row.id, epoch: row.epoch, ordinal: state.ordinal },
			subjectRef: row.id,
			lane: "background",
			resourceKey: "inference.llm",
			concurrencyKey: `execution:${row.id}`,
			maxAttempts: 1,
			deadlineAtMs: row.deadline,
		});
		row.job_id = job.id;
		if (!child) row.state = "queued";
		saveExecution(db, row, state, now());
	}
	function finish(
		db: Database,
		row: ExecutionRow,
		state: ParentState,
		status: ExecutionStatus,
		result: Omit<ExecutionResult, "status">,
	) {
		if (!isExecutionActive(row)) return;
		const body = JSON.stringify({ ...result, status });
		if (new TextEncoder().encode(body).length > 16_384)
			throw new Error("execution_result_capacity");
		state.question = null;
		db.query(
			"UPDATE agent_execution_questions SET state='cancelled' WHERE execution_id=? AND state='waiting'",
		).run(row.id);
		row.state = status;
		row.epoch++;
		row.result_json = body;
		saveExecution(db, row, state, now());
		if (state.activeRequestId)
			ctx.inference.cancelRequestsInTransaction?.(db, [state.activeRequestId]);
		if (state.pending)
			ctx
				.port()
				.cancelInTransaction(
					db,
					state.pending.child,
					state.pending.result?.ref ?? null,
				);
		if (row.job_id)
			queue.cancelInTransaction(db, row.job_id, "execution_ended");
		event(db, row, `finished:${row.request_revision}`);
	}
	function fail(
		db: Database,
		row: ExecutionRow,
		state: ParentState,
		code: string,
		status: ExecutionStatus = "partial",
	) {
		finish(db, row, state, status, {
			summary: code,
			fulfilled: [],
			missing: [code],
			refs: state.notes.flatMap((n) => n.refs),
			code,
		});
	}
	function question(
		db: Database,
		row: ExecutionRow,
		state: ParentState,
		prompt: string,
		inputSchema: Record<string, unknown> = {
			type: "string",
			minLength: 1,
			maxLength: 8000,
		},
		deadline = row.deadline,
	) {
		if (state.questions >= 3)
			return fail(db, row, state, "execution_question_limit");
		const q = {
			id: crypto.randomUUID(),
			prompt,
			expiresAt: Math.min(row.deadline, deadline),
			inputSchema,
		};
		state.questions++;
		state.question = q;
		row.state = "waiting_user";
		db.query(
			"INSERT INTO agent_execution_questions(id,execution_id,request_revision,prompt,state,expires_at) VALUES(?,?,?,?,'waiting',?)",
		).run(q.id, row.id, row.request_revision, prompt, q.expiresAt);
		saveExecution(db, row, state, now());
		event(db, row, `question:${q.id}`);
	}
	function addReferences(
		db: Database,
		row: ExecutionRow,
		state: ParentState,
		result: ChildResult,
	) {
		for (const raw of result.references) {
			const ref = executionReference.parse(raw);
			if (state.refs.some((r) => r.ref === ref.ref)) continue;
			if (state.refs.length >= 32)
				throw new Error("execution_reference_capacity");
			state.refs.push(ref);
			db.query("INSERT INTO agent_execution_refs VALUES(?,?,?)").run(
				row.id,
				ref.ref,
				JSON.stringify(ref),
			);
		}
	}
	function adoptChild(
		db: Database,
		row: ExecutionRow,
		state: ParentState,
		result: ChildResult,
	) {
		const pending = state.pending;
		if (!pending) throw new Error("execution_child_missing");
		if (!ctx.port().adoptInTransaction(db, pending.child, result))
			return fail(db, row, state, "execution_result_invalidated");
		if (result.modelCalls > pending.allocation || result.modelCalls < 0)
			throw new Error("execution_budget_invalid");
		pending.result = result;
		db.query(
			"UPDATE agent_execution_steps SET result_json=?,state=? WHERE id=?",
		).run(JSON.stringify(result), result.state, pending.child.id);
		if (result.state === "running") return saveExecution(db, row, state, now());
		if (result.state === "waiting_input")
			return question(
				db,
				row,
				state,
				result.question ?? result.summary,
				result.questionSchema,
				result.questionDeadline,
			);
		// A stopped in-flight domain call may not have settled its last inference counter yet.
		state.consumed += [
			"failed",
			"cancelled",
			"expired",
			"indeterminate",
		].includes(result.state)
			? pending.allocation
			: result.modelCalls;
		addReferences(db, row, state, result);
		const reference = {
			ref: `result:${pending.child.id}`,
			owner: "agent-runtime",
			id: pending.child.id,
			revision: String(pending.child.revision),
			digest: hash(result),
			label: "子呼出しの確定結果",
			kind: "result" as const,
			preview: result.summary.slice(0, 2000),
		};
		addReferences(db, row, state, { ...result, references: [reference] });
		state.notes.push({
			id: pending.child.id,
			state: result.state,
			summary: result.summary.slice(0, 2000),
			refs: [reference.ref, ...result.references.map((r) => r.ref)],
		});
		const item = state.plan?.items.find(
			(entry) => entry.childId === pending.child.id,
		);
		if (item) {
			item.resultRef = reference.ref;
			item.resultState = result.state;
		}
		state.selecting = false;
		const selected = pending.child.chainRevisionId;
		state.retained = [
			selected,
			...state.retained.filter((id) => id !== selected),
		].slice(0, 4);
		state.offered = state.retained;
		state.pending = null;
		state.amending = false;
		if (["indeterminate", "handoff"].includes(result.state))
			return fail(
				db,
				row,
				state,
				result.code ??
					(result.state === "handoff"
						? "interactive_handoff"
						: "operation_indeterminate"),
			);
		if (state.pipeline && advance) advance(db, row, state, result);
		else enqueue(db, row, state);
	}
	function startChild(
		db: Database,
		row: ExecutionRow,
		state: ParentState,
		chainRevisionId: string,
		args: Record<string, unknown>,
	) {
		const planned = plannedInvocation(db, state, chainRevisionId, args);
		if (planned.replay) return planned.replay;
		launch(db, row, state, planned.input, planned.item.childId, () => {
			planned.item.inputDigest = planned.digest;
		});
	}
	const launch = childLauncher(ctx, enqueue, fail);
	function active(db: Database, id: string, epoch: number, ordinal: number) {
		const row = executionRow(db, id);
		if (!row || row.epoch !== epoch || !isExecutionActive(row)) return null;
		const state = executionState(row);
		if (state.ordinal !== ordinal) return null;
		if (now() >= row.deadline) {
			fail(db, row, state, "deadline_exceeded");
			return null;
		}
		const source = executionSource(row);
		if (
			!controlValid(db, state) ||
			!ctx.port().validSourceInTransaction(db, source) ||
			state.refs.some(
				(ref) => !ctx.port().validReferenceInTransaction(db, source, ref),
			)
		) {
			fail(db, row, state, "execution_source_invalid");
			return null;
		}
		return { row, state, source };
	}
	const controlValid = (db: Database, state: ParentState) =>
		followsControl(ctx, db, state);
	return {
		enqueue,
		finish,
		fail,
		question,
		startChild,
		launch,
		adoptChild,
		active,
		controlValid,
		setAdvance: (fn: NonNullable<typeof advance>) => {
			advance = fn;
		},
	};
}
export type ExecutionOps = ReturnType<typeof createExecutionStore>;

/** The run still follows what it started from: the task binding, or the pipeline's published binding. */
function followsControl(
	ctx: ExecutionContext,
	db: Database,
	state: ParentState,
) {
	return state.pipeline
		? ctx.port().pipelineInTransaction?.(db, state.pipeline.toolchainRevisionId)
				?.bindingRevisionId === state.bindingRevisionId
		: ctx.port().controlInTransaction(db)?.revisionId ===
				state.bindingRevisionId;
}

/** Hands one invocation to a child job, within the run's budget and time. */
function childLauncher(
	ctx: ExecutionContext,
	enqueue: (
		db: Database,
		row: ExecutionRow,
		state: ParentState,
		child: boolean,
	) => void,
	fail: (
		db: Database,
		row: ExecutionRow,
		state: ParentState,
		code: string,
	) => void,
) {
	const { now } = ctx;
	return function launch(
		db: Database,
		row: ExecutionRow,
		state: ParentState,
		input: Pick<
			import("../../tool-runtime").ChildExecution,
			"chainRevisionId" | "request" | "arguments" | "refs" | "materials"
		>,
		id: string,
		started?: () => void,
	) {
		if (
			state.children >= state.limits.childCalls ||
			now() >= row.deadline - 45_000
		)
			return fail(db, row, state, "execution_budget_exceeded");
		const allocation = Math.min(
			12,
			state.limits.modelCalls - state.consumed - 1,
		);
		if (allocation < 1)
			return fail(db, row, state, "execution_budget_exceeded");
		const child = {
			...input,
			id,
			executionId: row.id,
			revision: row.request_revision,
			step: state.ordinal,
			source: executionSource(row),
			deadline: Math.min(
				row.deadline - 45_000,
				ctx
					.port()
					.childDeadlineInTransaction?.(
						db,
						input.chainRevisionId,
						row.deadline - 45_000,
					) ?? row.deadline - 45_000,
			),
			modelCalls: allocation,
		};
		const body = JSON.stringify(child);
		if (new TextEncoder().encode(body).length > 24_576)
			throw new Error("execution_input_capacity");
		state.children++;
		started?.();
		state.pending = { child, result: null, allocation };
		row.state = "waiting_child";
		db.query(
			"INSERT INTO agent_execution_steps(id,execution_id,request_revision,ordinal,input_digest,input_json,state) VALUES(?,?,?,?,?,?,'queued')",
		).run(id, row.id, row.request_revision, state.ordinal, hash(child), body);
		enqueue(db, row, state, true);
	};
}
