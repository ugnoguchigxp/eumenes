import type { SqliteStore } from "../infrastructure/sqlite";
import type { CodingService } from "../domains/coding";
import type { TasksService } from "../domains/tasks";
import type {
	CodingSupervision,
	WorkflowPort,
} from "../domains/coding-supervision";
import type { TaskExecutionPort } from "./delegated-tasks";
import {
	codingObservationReader,
	observationFailure,
} from "./coding-observation";
/** Read-only fallback. Registered checks/review/Git need the isolated operation worker from plan02 C6. */
export function unavailableCodingWorkflow(
	store: SqliteStore,
	coding: CodingService,
): WorkflowPort {
	const reader = codingObservationReader(store, coding);
	return {
		available: () => false,
		policy: () => ({ checkIds: [], checksDigest: "", reviewPolicyDigest: "" }),
		// Adopted facts plus a bounded read of stored text; `available` stays false for mutation.
		observe: (taskId, signal) => reader.inspect(taskId, signal),
		async execute() {
			throw new Error("coding_workflow_unavailable");
		},
	};
}
export function superviseCodingExecution(input: {
	store: SqliteStore;
	tasks: () => TasksService;
	base: TaskExecutionPort;
	supervision: () => CodingSupervision;
	workflow: WorkflowPort;
	/** Used only to name a failed observation with a fixed code and the last adopted cursor. */
	coding?: CodingService;
}): TaskExecutionPort {
	const { store, base, workflow } = input;
	// Commands whose preparation ended in a fixed-code hold: nothing exists to dispatch.
	const heldCommands = new Set<string>();
	return {
		available: base.available,
		prepareInTransaction(db, t, c) {
			input.supervision().initializeInTransaction(db, t);
			// The answer to an approval question is a decision, not a CLI turn: prepare no
			// coding execution (it would never start and would hold the workspace).
			if (
				c.answerQuestionId &&
				input
					.supervision()
					.isApprovalAnswerInTransaction(db, t.id, c.answerQuestionId)
			)
				return;
			try {
				return base.prepareInTransaction?.(db, t, c);
			} catch (error) {
				// A v1 session is never continued: hold with a fixed code and report, do not just fail.
				if (
					error instanceof Error &&
					error.message === "coding_legacy_continue_unsupported"
				) {
					input.supervision().holdFixedInTransaction(db, t.id, error.message);
					heldCommands.add(c.commandId);
					return;
				}
				throw error;
			}
		},
		dispatch(t, context) {
			// The answer to an approval question is a decision, not text for the CLI.
			// Approved instructions are launched by supervision as a verified step.
			if (
				context.answer &&
				input.supervision().isApprovalAnswer(t.id, context.answer.questionId)
			)
				return Promise.resolve({ accepted: true });
			if (heldCommands.has(context.commandId))
				return Promise.resolve({ accepted: false });
			return base.dispatch(t, context);
		},
		stop: base.stop,
		async observe(t, signal) {
			try {
				const result = await base.observe(t, signal);
				if (result?.hasMore) return result;
				const observation = await workflow.observe(t.id, signal);
				signal.throwIfAborted();
				await store.write((db) => {
					const latest = input.tasks().getInTransaction(db, t.id);
					if (
						!latest ||
						latest.revision !== t.revision ||
						latest.executionGeneration !== t.executionGeneration ||
						latest.authorityEpoch !== t.authorityEpoch
					)
						return;
					input.supervision().observeInTransaction(db, t.id, observation);
				});
				return result;
			} catch (error) {
				const failure = input.coding
					? observationFailure(
							store,
							input.coding,
							t.id,
							error,
							t.executionGeneration,
							t.authorityEpoch,
						)
					: undefined;
				await store.write((db) =>
					input.supervision().observationFailedInTransaction(db, t.id, failure),
				);
				throw error;
			}
		},
	};
}
