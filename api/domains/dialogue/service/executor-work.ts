import type { Database } from "bun:sqlite";
import type { Run } from "../contracts";
import { byId } from "../repository";
import type { WorkRow } from "../repository/work";
import type { DialogueDeps } from "./context";
import type { ToolOutcome } from "./generation-loop";
import { type ParsedCall, type WorkArgs } from "./generation-tools";
import { endRun } from "./run-end";
import { hideUris, type DocumentRefs } from "./work-items";
import { CHECK_MAX_TOKENS } from "./input-text";
import { resultText } from "./result-text";
import { madeOf } from "./state-text";
import { resultFields } from "./work-ledger";
import { dispatchInTransaction } from "./work-dispatch";

import {
	HandoverRefused,
	acceptHere,
	adoptHere,
	type ExecutorContext,
} from "./executor-context";

/** A work call with its TODO found: the row's id, the revision the model saw, and the open question. */
export type ResolvedWork = Omit<WorkArgs, "todo"> & {
	todo: string;
	revision: number;
	questionId?: string;
};

/** A TODO as a work tool result shows it: its number, never its id; a resource in its result is its number too. */
function todoView(row: WorkRow, refs: DocumentRefs): Record<string, unknown> {
	return {
		todo: `t${row.ref}`,
		title: row.title,
		status: row.status,
		...(hideUris(resultFields(row), refs) as Record<string, unknown>),
	};
}

/* The operations on the conversation's TODOs (section 6.1). */
export async function work(
	x: ExecutorContext,
	call: ParsedCall,
	given: WorkArgs,
): Promise<ToolOutcome> {
	const { deps, current, acted, handle } = x;
	const { store } = deps;
	const ledger = deps.work;
	if (!ledger) return { result: { ok: false, code: "work_unavailable" } };
	const cancelled: string[] = [];
	const operate = () =>
		store.write((tx): ToolOutcome => {
			const run = current(tx);
			// The model names a TODO by its number (`t<ref>`, the layout specification's section 6).
			const ref = /^t(\d+)$/.exec(given.todo);
			const row = ref
				? ledger.workByRefInTransaction(tx, run.conversationId, Number(ref[1]))
				: null;
			// A reported (archived) TODO can still be read; nothing else is done to it.
			if (!row || (row.archivedAt && given.operation !== "check"))
				return { result: { ok: false, code: "todo_not_found" } };
			const seen = x.state.todoRevisions.get(row.id) ?? row.revision;
			const args: ResolvedWork = {
				...given,
				todo: row.id,
				revision: seen,
				...(row.questionId ? { questionId: row.questionId } : {}),
			};
			// What a result shows is what the model has now seen.
			const state = (next = row) => {
				x.state.todoRevisions.set(next.id, next.revision);
				return todoView(next, ledger.refsInTransaction(tx, run.conversationId));
			};
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
				x.state.todoRevisions.set(checked.id, checked.revision);
				// What the check read is what a reply may report now (its sources may be linked).
				if (!x.input.shown.todos.includes(checked.id))
					x.input.shown.todos.push(checked.id);
				const refs = ledger.refsInTransaction(tx, run.conversationId);
				// The result as the host notice shows one: the same text, so the model reads it the same way.
				return {
					result: `- ok: true\n${
						resultText(
							{
								ref: `t${checked.ref}`,
								title: checked.title,
								status: checked.status,
								...(checked.outcome ? { outcome: checked.outcome } : {}),
								...(checked.question ? { question: checked.question } : {}),
								result: checked.result,
								made: ledger
									.todosInTransaction(tx, run.conversationId)
									.filter((todo) => todo.id === checked.id)
									.flatMap((todo) => madeOf(todo, refs)),
								resource: refs.resource,
							},
							CHECK_MAX_TOKENS,
						).text
					}`,
				};
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
				// Ending the run it waited on already finished (and archived) the TODO: its row as it is now.
				return {
					result: {
						ok: true,
						...state(next ?? ledger.workInTransaction(tx, row.id) ?? row),
					},
				};
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
	args: ResolvedWork,
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
	args: ResolvedWork,
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
