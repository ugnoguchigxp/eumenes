import type { Database } from "bun:sqlite";
import {
	answerTaskSchema,
	codingPhases,
	taskOriginSchema,
	taskQuestionInputSchema,
	taskResultSchema,
	type TaskQuestion,
	type TaskQuestionInput,
	type WorkTask,
} from "../contracts";
import * as repo from "../repository";
import type { TaskFence, TrustedTaskContext } from "../types";
import type { TaskCore } from "./core";
import {
	iso,
	manual,
	receipt,
	syncHook,
	terminal,
	transitions,
} from "./helpers";

/** Runner-driven progress: state transitions, questions and answers. */
export function createTaskProgress(core: TaskCore) {
	const {
		now,
		kindFor,
		requireTask,
		revision,
		currentGrant,
		fence,
		record,
		once,
		requireStorage,
	} = core;
	function applyTransitionInTransaction(
		tx: Database,
		f: TaskFence,
		input: {
			state: WorkTask["state"];
			phase?: WorkTask["phase"];
			reason: string;
			result?: unknown;
		},
	) {
		const t = fence(tx, f);
		if (
			!transitions[t.state]?.includes(input.state) ||
			input.state === "waiting_user"
		)
			throw new Error("task_state_conflict");
		if (
			input.phase !== undefined &&
			input.phase !== null &&
			!codingPhases.includes(input.phase)
		)
			throw new Error("invalid_task_phase");
		if (input.state === "completed" || input.state === "failed") {
			const result = taskResultSchema.safeParse(input.result);
			if (
				!result.success ||
				(input.state === "completed" &&
					(result.data.conditionsMet.length !== t.completionConditions.length ||
						!result.data.conditionsMet.every(Boolean)))
			)
				throw new Error("invalid_task_result");
			t.result = result.data;
		} else if (input.result !== undefined)
			throw new Error("invalid_task_result");
		t.state = input.state;
		if (input.phase !== undefined) t.phase = input.phase;
		const accepted = receipt(record(tx, t, input.reason));
		if (!terminal(t.state) && t.state !== "reconciling") requireStorage(tx);
		return accepted;
	}
	function askInTransaction(
		tx: Database,
		f: TaskFence,
		input: TaskQuestionInput,
	) {
		const parsed = taskQuestionInputSchema.safeParse(input);
		if (!parsed.success) throw new Error("invalid_task_question");
		const data = parsed.data;
		const t = fence(tx, f);
		if (!["active", "reconciling"].includes(t.state))
			throw new Error("task_state_conflict");
		if (repo.question(tx, data.questionId) || repo.openQuestion(tx, t.id))
			throw new Error("task_question_conflict");
		t.state = "waiting_user";
		record(tx, t, "question_opened");
		const q: TaskQuestion = {
			id: data.questionId,
			taskId: t.id,
			prompt: data.prompt,
			answerType: data.answerType,
			choices: data.choices,
			authorityEpoch: t.authorityEpoch,
			executionGeneration: t.executionGeneration,
			state: "open",
			answer: null,
			answeredFrom: null,
			createdAt: iso(now()),
		};
		repo.putQuestion(tx, q);
		requireStorage(tx);
		return receipt(t);
	}
	function answerInTransaction(
		tx: Database,
		taskId: string,
		input: unknown,
		context: TrustedTaskContext = manual,
	) {
		const parsed = answerTaskSchema.safeParse(input);
		if (!parsed.success || !taskOriginSchema.safeParse(context.origin).success)
			throw new Error("invalid_task_input");
		return once(
			tx,
			parsed.data.requestId,
			{ op: "answer", taskId, ...parsed.data, origin: context.origin },
			() => {
				const t = requireTask(tx, taskId);
				revision(t, parsed.data.expectedRevision);
				currentGrant(t);
				const q = repo.question(tx, parsed.data.questionId);
				if (
					t.state !== "waiting_user" ||
					!q ||
					q.taskId !== t.id ||
					q.state !== "open" ||
					q.authorityEpoch !== t.authorityEpoch ||
					q.executionGeneration !== t.executionGeneration
				)
					throw new Error("task_question_conflict");
				if (
					q.answerType === "choice" &&
					!q.choices.includes(parsed.data.answer)
				)
					throw new Error("invalid_task_answer");
				const kind = kindFor(t);
				if (!kind?.available() || !kind.answerInTransaction)
					throw new Error("task_execution_unavailable");
				repo.putQuestion(tx, {
					...q,
					state: "answered",
					answer: parsed.data.answer,
					answeredFrom: context.origin,
				});
				t.state = "queued";
				record(tx, t, "question_answered");
				syncHook(kind.answerInTransaction(tx, t, q.id));
				return t;
			},
		);
	}
	return {
		applyTransitionInTransaction,
		askInTransaction,
		answerInTransaction,
	};
}
