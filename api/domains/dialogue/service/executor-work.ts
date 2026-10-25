import type { Database } from "bun:sqlite";
import type { Run } from "../contracts";
import { byId } from "../repository";
import type { DialogueDeps } from "./context";
import type { ToolOutcome } from "./generation-loop";
import { type ParsedCall, type WorkArgs } from "./generation-tools";
import { endRun } from "./run-end";
import { activeFields, todoOf } from "./work-ledger";
import { dispatchInTransaction } from "./work-dispatch";

import {
	HandoverRefused,
	acceptHere,
	adoptHere,
	type ExecutorContext,
} from "./executor-context";

/* The operations on the conversation's TODOs (section 6.1). */
export async function work(
	x: ExecutorContext,
	call: ParsedCall,
	args: WorkArgs,
): Promise<ToolOutcome> {
	const { deps, current, acted, handle } = x;
	const { store } = deps;
	const ledger = deps.work;
	if (!ledger) return { result: { ok: false, code: "work_unavailable" } };
	const cancelled: string[] = [];
	const operate = () =>
		store.write((tx): ToolOutcome => {
			const run = current(tx);
			const row = ledger.workInTransaction(tx, args.todo);
			if (!row || row.conversationId !== run.conversationId || row.archivedAt)
				return { result: { ok: false, code: "todo_not_found" } };
			const state = (next = row) => ({
				todo: todoOf(next),
				...activeFields(next),
			});
			const record = (fields: Record<string, unknown>) => {
				acted(tx, `work:${row.id}:${args.operation}:${args.revision}`, {
					action: `work.${args.operation}`,
					todo: row.id,
					...fields,
				});
				// An operation on the work is a side effect (section 8.2); a check only reads.
				if (args.operation !== "check") handle(tx);
			};
			if (args.operation === "check") {
				const checked = ledger.checkInTransaction(tx, row.id)!;
				record({});
				return { result: { ok: true, ...state(checked) } };
			}
			if (row.revision !== args.revision)
				return { result: { ok: false, code: "revision_stale", ...state() } };
			// Finished work is not answered, amended or cancelled: its result stays as it was reported.
			if (row.status === "done")
				return { result: { ok: false, code: "todo_done", ...state() } };
			if (row.execution === "task")
				return controlExecution(x, tx, run, row, args, record, state);
			if (args.operation === "answer")
				return answerCommand(x, tx, run, row, args, record, state);
			if (args.operation === "cancel") {
				const waiting = byId(tx, row.runId);
				if (
					waiting &&
					(waiting.status === "queued" || waiting.status === "running") &&
					waiting.id !== run.id
				) {
					deps.agents?.cancelTreeInTransaction(tx, waiting.id);
					if (waiting.jobId) {
						deps.queue.cancelInTransaction(
							tx,
							waiting.jobId,
							"cancel_requested",
						);
						cancelled.push(waiting.jobId);
					}
					endRun(deps, tx, waiting, "cancelled", "cancel_requested");
				}
				const next = ledger.reportInTransaction(tx, row.id, {
					status: "done",
					outcome: "cancelled",
					result: null,
				});
				record({});
				return { result: { ok: true, ...state(next ?? row) } };
			}
			return { result: { ok: false, code: "amend_unsupported", ...state() } };
		});
	let outcome: ToolOutcome;
	try {
		outcome = await operate();
	} catch (error) {
		if (error instanceof HandoverRefused)
			return { result: { ok: false, code: error.code } };
		throw error;
	}
	if (cancelled.length) deps.queue.flushCancellations(cancelled);
	return outcome;
}

/** Answer, amend or cancel a task execution through its own control (section 6.1). */
export function controlExecution(
	x: ExecutorContext,
	tx: Database,
	run: Run,
	row: NonNullable<
		ReturnType<NonNullable<DialogueDeps["work"]>["workInTransaction"]>
	>,
	args: WorkArgs,
	record: (fields: Record<string, unknown>) => unknown,
	state: (next?: typeof row) => Record<string, unknown>,
): ToolOutcome {
	const { deps, input } = x;
	const executions = deps.agents?.executions;
	const view = row.sourceRef
		? executions?.viewInTransaction(tx, row.sourceRef)
		: null;
	if (!executions || !view)
		return {
			result: { ok: false, code: "execution_unavailable", ...state() },
		};
	const messageId =
		input.final.kind === "utterances"
			? input.final.messageIds.at(-1)
			: undefined;
	if (!messageId)
		return { result: { ok: false, code: "utterance_required", ...state() } };
	const action =
		args.operation === "answer"
			? "answer"
			: args.operation === "amend"
				? "amend"
				: "cancel";
	// A question that asks for a structured answer (its input schema is not a plain string) takes the text as JSON.
	const schema = view.question?.inputSchema;
	const structured = !!schema && schema.type !== "string";
	let answer: unknown = args.text;
	if (action === "answer" && structured && args.text) {
		try {
			answer = JSON.parse(args.text);
		} catch {
			answer = undefined;
		}
		if (answer === undefined)
			return {
				result: {
					ok: false,
					code: "invalid_answer",
					inputSchema: schema,
					...state(),
				},
			};
	}
	try {
		executions.controlInTransaction(
			tx,
			run.conversationId,
			{
				workRef: view.id,
				expectedRevision: view.revision,
				action,
				...(args.questionId ? { questionRef: args.questionId } : {}),
				...(action === "answer" && args.text ? { input: answer } : {}),
				...(action === "amend" && args.text ? { request: args.text } : {}),
			},
			messageId,
		);
	} catch (error) {
		const code =
			error instanceof Error && /^[a-z_]+$/.test(error.message)
				? error.message
				: "control_failed";
		// An answer of the wrong shape is told the shape it needs, so it can be answered again.
		return {
			result: {
				ok: false,
				code,
				...(code === "invalid_answer" && schema ? { inputSchema: schema } : {}),
				...state(),
			},
		};
	}
	const next =
		action === "amend" && args.text
			? deps.work!.amendInTransaction(tx, row.id, row.revision, args.text)
			: deps.work!.reportInTransaction(
					tx,
					row.id,
					action === "cancel"
						? { status: "done", outcome: "cancelled", result: null }
						: { status: "todo" },
				);
	record({});
	return { result: { ok: true, ...state(next ?? row) } };
}

/**
 * A command toolchain's question: the answer is accepted once and this run resumes the interaction, waiting
 * for the work like a new delegation (the TODO moves to this run).
 */
export function answerCommand(
	x: ExecutorContext,
	tx: Database,
	run: Run,
	row: NonNullable<
		ReturnType<NonNullable<DialogueDeps["work"]>["workInTransaction"]>
	>,
	args: WorkArgs,
	record: (fields: Record<string, unknown>) => unknown,
	state: (next?: typeof row) => Record<string, unknown>,
): ToolOutcome {
	const { deps, input, events } = x;
	const { toolchains } = deps;
	if (
		row.status !== "waiting" ||
		!row.questionId ||
		args.questionId !== row.questionId ||
		!args.text
	)
		return { result: { ok: false, code: "question_not_open", ...state() } };
	const card = toolchains?.cardInTransaction(tx, row.toolchainRevisionId);
	if (!card || !deps.interactions)
		return {
			result: { ok: false, code: "toolchain_unavailable", ...state() },
		};
	const accepted = deps.interactions.acceptNaturalLanguageInTransaction(
		tx,
		run,
		{
			questionRef: row.questionId,
			functionName: card.functionName,
			revisionId: card.revisionId,
			request: args.text,
		},
	);
	if (!accepted.ok)
		return { result: { ok: false, code: accepted.code, ...state() } };
	const dispatched = dispatchInTransaction(deps, tx, {
		jobId: x.jobId,
		run,
		card,
		request: args.text,
		references: [],
		interactionId: accepted.interactionId,
	});
	// A refused dispatch rolls the accepted answer back too; the model reads the code.
	if (!dispatched.ok) throw new HandoverRefused(dispatched.code);
	// The generation ends here: this is its adoption.
	adoptHere(x, tx, run);
	acceptHere(x, tx, dispatched);
	if (input.final.kind === "utterances")
		events.handleInTransaction(tx, run.conversationId, input.final.seqs);
	const ledger = deps.work!;
	const moved = ledger.relinkInTransaction(tx, row.id, run.id);
	record({});
	x.state.handover = { announcement: "", handed: true, workId: row.id };
	return {
		result: { ok: true, ...state(moved ?? row) },
		end: true,
	};
}
