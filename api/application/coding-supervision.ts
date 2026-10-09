import type { SqliteStore } from "../infrastructure/sqlite";
import type { CodingService } from "../domains/coding";
import type { TasksService } from "../domains/tasks";
import type {
	CodingSupervision,
	WorkflowPort,
} from "../domains/coding-supervision";
import type { TaskExecutionPort } from "./delegated-tasks";
/** Read-only fallback. Registered checks/review/Git need the isolated operation worker from plan02 C6. */
export function unavailableCodingWorkflow(
	store: SqliteStore,
	coding: CodingService,
): WorkflowPort {
	return {
		available: () => false,
		policy: () => ({ checkIds: [], checksDigest: "", reviewPolicyDigest: "" }),
		async observe(taskId, signal) {
			signal.throwIfAborted();
			return store.readSnapshot((db) => {
				const e = coding.latestInTransaction(db, taskId);
				if (!e) throw new Error("coding_intent_missing");
				return {
					executionId: e.id,
					eventSeq: e.cursor,
					sessionId: null,
					snapshotHash: null,
					turnFinished: e.turnFinished,
					childrenStopped: e.childrenStopped,
					evidenceComplete: e.evidenceComplete,
					exitCode: e.exitCode,
					question: null,
					evidenceRefs: [],
					facts: [`実行状態: ${e.state}`, `確認済みイベント数: ${e.cursor}`],
					excerpt: "",
				};
			});
		},
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
}): TaskExecutionPort {
	const { store, base, workflow } = input;
	return {
		available: base.available,
		prepareInTransaction(db, t, c) {
			input.supervision().initializeInTransaction(db, t);
			return base.prepareInTransaction?.(db, t, c);
		},
		dispatch: base.dispatch,
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
				await store.write((db) =>
					input.supervision().observationFailedInTransaction(db, t.id),
				);
				throw error;
			}
		},
	};
}
