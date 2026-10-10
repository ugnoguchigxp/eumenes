import { getLogger } from "../../../infrastructure/logger";
import {
	isTransientStoreError,
	toErrorCode,
} from "../../../infrastructure/error-code";
import type { Run } from "../contracts";
import {
	byId,
	linkAnswer,
	transition,
	unfinishedAgentRuns,
} from "../repository";
import { GENERATE_KIND, TERMINAL, type DialogueDeps } from "./context";
const log = getLogger("dialogue");

/** Agent-runtime reconciliation: turns agent events into answer jobs and syncs terminal states. */
export function createAgentSync(deps: DialogueDeps) {
	const { store, queue, clock, agents } = deps;
	let stopped = false,
		pending = false,
		reconciling: Promise<void> | null = null,
		retryTimer: ReturnType<typeof setTimeout> | null = null;
	let retryCount = 0;
	const eventFailures = new Map<string, number>();
	const failureCode = (error: unknown) =>
		toErrorCode(error, "agent_reconcile_failed");
	function retryLater() {
		if (retryTimer || stopped) return;
		const delay = Math.min(30_000, 250 * 2 ** retryCount);
		retryCount++;
		retryTimer = setTimeout(() => {
			retryTimer = null;
			scheduleAgents();
		}, delay);
		retryTimer.unref();
	}
	async function failRunAfterRepeatedFailure(runId: string, eventId: string) {
		try {
			await store.write((db) => {
				const run = byId(db, runId);
				if (!run || TERMINAL.includes(run.status)) return;
				transition(
					db,
					run.id,
					run.revision,
					"failed",
					clock(),
					"agent_event_failed",
				);
				agents!.failAnswerInTransaction(db, run.id, "agent_event_failed");
			});
			eventFailures.delete(eventId);
		} catch (error) {
			log.error(
				"dialogue.agent_event_give_up_failed",
				{ runId, reason: failureCode(error) },
				error,
			);
		}
	}
	function scheduleAgents() {
		if (!agents || stopped) return;
		pending = true;
		if (!reconciling)
			queueMicrotask(() => {
				if (!reconciling && !stopped)
					void reconcileAgents().catch((error) =>
						log.error(
							"dialogue.agent_reconcile_failed",
							{ reason: failureCode(error) },
							error,
						),
					);
			});
	}
	async function reconcileAgents() {
		if (reconciling) return reconciling;
		reconciling = (async () => {
			while (pending && !stopped) {
				pending = false;
				let failed = false;
				for (const event of agents?.pendingEvents() ?? []) {
					try {
						await store.write((db) => {
							const run = byId(db, event.root_run_id);
							if (!run || TERMINAL.includes(run.status)) return;
							const root = agents!.byRootInTransaction(db, run.id);
							if (root?.state !== "ready_for_answer") return;
							if (root.deadline <= Date.now()) {
								transition(
									db,
									run.id,
									run.revision,
									"failed",
									clock(),
									"deadline_exceeded",
								);
								agents!.failAnswerInTransaction(
									db,
									run.id,
									"deadline_exceeded",
								);
								return;
							}
							const { job } = queue.enqueueInTransaction(db, {
								scope: "dialogue",
								kind: GENERATE_KIND,
								dedupeKey: `answer:${run.id}:${event.id}`,
								payload: { runId: run.id },
								subjectRef: run.id,
								lane: "interactive",
								resourceKey: "inference.llm",
								maxAttempts: 1,
								concurrencyKey: `conversation:${run.conversationId}`,
								deadlineAtMs: root.deadline,
							});
							linkAnswer(db, run.id, job.id);
							agents!.reserveAnswerInTransaction(db, event.id, job.id);
						});
						eventFailures.delete(event.id);
					} catch (error) {
						failed = true;
						log.warn(
							"dialogue.agent_event_failed",
							{ runId: event.root_run_id, reason: failureCode(error) },
							error,
						);
						// Busy/closing writer: retry with backoff, but it is not evidence of a poison event.
						if (!isTransientStoreError(error)) {
							const n = (eventFailures.get(event.id) ?? 0) + 1;
							eventFailures.set(event.id, n);
							if (n >= 5)
								await failRunAfterRepeatedFailure(event.root_run_id, event.id);
						}
						retryLater();
					}
				}
				for (const run of store.read((db) => unfinishedAgentRuns(db))) {
					if (!run.agentTaskId || TERMINAL.includes(run.status)) continue;
					const root = store.read((db) =>
						agents!.byRootInTransaction(db, run.id),
					);
					if (
						root &&
						["failed", "cancelled", "interrupted"].includes(root.state)
					)
						try {
							await store.write((db) => {
								const current = byId(db, run.id);
								if (current && !TERMINAL.includes(current.status))
									transition(
										db,
										run.id,
										current.revision,
										root.state as Run["status"],
										clock(),
										root.error_code,
									);
							});
						} catch (error) {
							failed = true;
							log.warn(
								"dialogue.agent_run_sync_failed",
								{ runId: run.id, reason: failureCode(error) },
								error,
							);
							retryLater();
						}
				}
				if (!failed) retryCount = 0;
			}
		})().finally(() => {
			reconciling = null;
			if (pending && !stopped) scheduleAgents();
		});
		return reconciling;
	}
	const stopAgentCommits = store.onCommit(scheduleAgents);
	return {
		async close() {
			stopped = true;
			stopAgentCommits();
			if (retryTimer) clearTimeout(retryTimer);
			await reconciling?.catch(() => {});
			eventFailures.clear();
		},
	};
}
