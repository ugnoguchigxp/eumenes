import type { Database } from "bun:sqlite";
import { z } from "zod";
import { createTasks, type TaskFence, type WorkTask } from "../domains/tasks";
import type { QueueService, HandlerDefinition } from "../domains/queue";
import type { SchedulerService } from "../domains/scheduler";
import type { SqliteStore } from "../infrastructure/sqlite";

/** Future coding/runner wiring must provide confirmed receipts, never arbitrary shell text. */
export interface TaskExecutionPort {
	available(): boolean;
	/** Optional lower-domain intent, committed atomically with the task and dispatch job. */
	prepareInTransaction?(
		tx: Database,
		task: WorkTask,
		context: { commandId: string; answerQuestionId?: string },
	): void;
	dispatch(
		task: WorkTask,
		context: {
			signal: AbortSignal;
			commandId: string;
			answer?: { questionId: string; text: string };
		},
	): Promise<{ accepted: boolean }>;
	observe(
		task: WorkTask,
		signal: AbortSignal,
	): Promise<void | { hasMore: boolean }>;
	/** Stop deliveries may repeat after failure; commandId is stable for the revoked authority. */
	stop(
		task: WorkTask,
		context: { signal: AbortSignal; commandId: string },
	): Promise<{ stopped: boolean }>;
}
const payloadSchema = z.strictObject({
	taskId: z.string().min(1).max(160),
	authorityEpoch: z.number().int().min(1),
	executionGeneration: z.number().int().min(0),
	commandId: z.string().min(1).max(200),
	answerQuestionId: z.string().min(1).max(160).optional(),
});
type Payload = z.infer<typeof payloadSchema>;
const payload = (task: WorkTask, commandId: string): Payload => ({
	taskId: task.id,
	authorityEpoch: task.authorityEpoch,
	executionGeneration: task.executionGeneration,
	commandId,
});
const fence = (t: WorkTask): TaskFence => ({
	taskId: t.id,
	expectedRevision: t.revision,
	authorityEpoch: t.authorityEpoch,
	executionGeneration: t.executionGeneration,
});

export function createDelegatedTasks(input: {
	store: SqliteStore;
	queue: QueueService;
	scheduler: SchedulerService;
	enabled: boolean;
	execution?: TaskExecutionPort;
	now?: () => number;
	changedInTransaction?: (tx: Database, task: WorkTask) => void;
}) {
	const { store, queue, scheduler, execution } = input;
	const now = input.now ?? Date.now;
	const aborted = new Set<string>();
	const registeringMonitor = new Set<string>();
	const available = () => input.enabled && execution?.available() === true;
	function cancelRuntime(
		tx: Database,
		t: WorkTask,
		exceptJobId?: string,
	) {
		const refs = tasks.runtimeInTransaction(tx, t.id);
		if (refs.scheduleId) {
			const s = scheduler.getInTransaction(tx, refs.scheduleId);
			if (s && ["active", "paused"].includes(s.state))
				scheduler.cancelInTransaction(tx, s.id, s.revision);
		}
		for (const jobId of [refs.dispatchJobId, refs.observeJobId])
			if (jobId && jobId !== exceptJobId) {
				queue.cancelInTransaction(tx, jobId, "work_task_stopped");
				aborted.add(jobId);
			}
	}
	function dispatchInTransaction(
		tx: Database,
		t: WorkTask,
		answerQuestionId?: string,
	) {
		const commandId = `${t.id}:${t.executionGeneration}:${t.revision}`;
		const { job } = queue.enqueueInTransaction(tx, {
			scope: `work-task:${t.id}`,
			kind: "tasks.dispatch.v1",
			dedupeKey: commandId,
			payload: {
				...payload(t, commandId),
				...(answerQuestionId ? { answerQuestionId } : {}),
			},
			subjectRef: t.id,
			lane: "background",
			concurrencyKey: `work-task:${t.id}:dispatch`,
			maxAttempts: 1,
		});
		tasks.setRuntimeInTransaction(tx, t.id, { dispatchJobId: job.id });
		const prepared: unknown = execution?.prepareInTransaction?.(tx, t, {
			commandId: job.id,
			...(answerQuestionId ? { answerQuestionId } : {}),
		});
		if (
			prepared &&
			(typeof prepared === "object" || typeof prepared === "function") &&
			"then" in prepared &&
			typeof prepared.then === "function"
		) {
			void Promise.resolve(prepared).catch(() => {});
			throw new Error("task_async_preparation_forbidden");
		}
	}
	const tasks = createTasks(store, {
		now,
		changedInTransaction: input.changedInTransaction,
		kinds: [
			{
				kind: "coding",
				version: 1,
				available,
				startInTransaction(tx, t) {
					cancelRuntime(tx, t);
					dispatchInTransaction(tx, t);
					registeringMonitor.add(t.id);
					try {
						const s = scheduler.createInTransaction(tx, {
							requestId: crypto.randomUUID(),
							target: {
								kind: "tasks.observe.v1",
								payload: {
									taskId: t.id,
									authorityEpoch: t.authorityEpoch,
									executionGeneration: t.executionGeneration,
								},
							},
							schedule: {
								type: "interval",
								anchor: new Date(now() + 60_000).toISOString(),
								intervalMs: 60_000,
							},
							misfirePolicy: "coalesce",
							graceMs: 300_000,
						});
						tasks.setRuntimeInTransaction(tx, t.id, { scheduleId: s.id });
					} finally {
						registeringMonitor.delete(t.id);
					}
				},
				stopInTransaction(tx, t, context) {
					cancelRuntime(tx, t);
					if (
						execution &&
						t.executionGeneration > 0 &&
						!context?.executionStopped
					) {
						const commandId = `${t.id}:stop:${t.authorityEpoch}`;
						const refs = tasks.runtimeInTransaction(tx, t.id);
						const previous = refs.stopJobId
							? queue.getInTransaction(tx, refs.stopJobId)
							: null;
						const previousPayload = previous
							? payloadSchema.safeParse(JSON.parse(previous.payloadJson))
							: null;
						let dedupeKey = commandId;
						if (
							previous &&
							previousPayload?.success &&
							previousPayload.data.commandId === commandId
						) {
							if (
								[
									"queued",
									"running",
									"retry_wait",
									"cancel_requested",
								].includes(previous.state)
							)
								return;
							// Retry only stop delivery, with the same external operation identity and a bounded cadence.
							if (
								previous.finishedAtMs !== null &&
								now() < previous.finishedAtMs + 60_000
							)
								return;
							dedupeKey = `${commandId}:after:${previous.id}`;
						} else if (previous) {
							queue.cancelInTransaction(tx, previous.id, "work_task_stale");
							aborted.add(previous.id);
						}
						try {
							const { job } = queue.enqueueInTransaction(tx, {
								scope: `work-task:${t.id}`,
								kind: "tasks.stop.v1",
								dedupeKey,
								payload: payload(t, commandId),
								subjectRef: t.id,
								lane: "interactive",
								concurrencyKey: `work-task:${t.id}:stop`,
								maxAttempts: 1,
							});
							tasks.setRuntimeInTransaction(tx, t.id, { stopJobId: job.id });
						} catch (error) {
							if (!(error instanceof Error) || error.message !== "queue_full")
								throw error;
							// The saved stopping state is a durable retry intent when the Queue is full.
						}
					}
				},
				answerInTransaction: dispatchInTransaction,
				terminalInTransaction: cancelRuntime,
			},
		],
	});
	function current(tx: Database, p: Payload, stopping: boolean) {
		const t = tasks.getInTransaction(tx, p.taskId);
		if (
			!t ||
			t.authorityEpoch !== p.authorityEpoch ||
			t.executionGeneration !== p.executionGeneration ||
			(stopping
				? t.state !== "stopping"
				: !["queued", "active", "waiting_user"].includes(t.state))
		)
			return null;
		if (
			!stopping &&
			(Date.parse(t.grant.expiresAt) <= now() ||
				(t.executionDeadlineAt !== null &&
					Date.parse(t.executionDeadlineAt) <= now()))
		)
			return null;
		return t;
	}
	if (execution) {
		function register(op: "dispatch" | "observe" | "stop") {
			const handler: HandlerDefinition<
				Payload,
				{
					task: WorkTask;
					commandId: string;
					answer?: { questionId: string; text: string };
				},
				{ confirmed: boolean; hasMore?: boolean }
			> = {
				kind: `tasks.${op}.v1`,
				payloadVersions: [1],
				schema: payloadSchema,
				recovery: op === "observe" ? "replay_safe" : "interrupt",
				prepareInTransaction(tx, claim) {
					let t = current(tx, claim.payload, op === "stop");
					if (!t) return { status: "stale", reason: "work_task_stale" };
					if (op !== "stop" && !available()) {
						if (op === "dispatch" && t.state === "queued") {
							tasks.applyTransitionInTransaction(tx, fence(t), {
								state: "reconciling",
								reason: "execution_unavailable",
							});
							cancelRuntime(tx, t);
						}
						return { status: "stale", reason: "work_task_unavailable" };
					}
					if (op === "dispatch") {
						if (t.state !== "queued")
							return { status: "stale", reason: "work_task_not_queued" };
					}
					const q = claim.payload.answerQuestionId
						? tasks.questionInTransaction(tx, claim.payload.answerQuestionId)
						: null;
					if (
						claim.payload.answerQuestionId &&
						(!q ||
							q.taskId !== t.id ||
							q.state !== "answered" ||
							q.answer === null ||
							q.authorityEpoch !== t.authorityEpoch ||
							q.executionGeneration !== t.executionGeneration)
					) {
						if (op === "dispatch") {
							tasks.applyTransitionInTransaction(tx, fence(t), {
								state: "reconciling",
								reason: "answer_unavailable",
							});
							cancelRuntime(tx, t);
						}
						return { status: "stale", reason: "work_task_answer_stale" };
					}
					if (op === "dispatch") {
						tasks.applyTransitionInTransaction(tx, fence(t), {
							state: "active",
							reason: "dispatch_started",
						});
						t = tasks.getInTransaction(tx, t.id)!;
					}
					return {
						status: "ready",
						input: {
							task: t,
							commandId: claim.payload.commandId,
							...(q?.answer
								? { answer: { questionId: q.id, text: q.answer } }
								: {}),
						},
					};
				},
				async execute(prepared, context) {
					const t = prepared.task;
					if (op === "stop")
						return {
							confirmed:
								(
									await execution!.stop(t, {
										signal: context.signal,
										commandId: prepared.commandId,
									})
								).stopped === true,
						};
					if (op === "observe") {
						const result = await execution!.observe(t, context.signal);
						return { confirmed: true, hasMore: result?.hasMore === true };
					}
					// The stable job ID survives retries/recovery; dispatch never invents a new operation ID.
					return {
						confirmed:
							(
								await execution!.dispatch(t, {
									signal: context.signal,
									commandId: context.jobId,
									...(prepared.answer ? { answer: prepared.answer } : {}),
								})
							).accepted === true,
					};
				},
				settleInTransaction(tx, claim, _prepared, outcome) {
					const t = current(tx, claim.payload, op === "stop");
					if (!t) return "stale";
					if (outcome.type === "success" && outcome.result.confirmed) {
						if (op === "stop") tasks.settleStopInTransaction(tx, fence(t));
						if (op === "observe" && outcome.result.hasMore) {
							const commandId = `backlog:${claim.jobId}`;
							const { job } = queue.enqueueInTransaction(tx, {
								scope: `work-task:${t.id}`,
								kind: "tasks.observe.v1",
								dedupeKey: commandId,
								payload: payload(t, commandId),
								subjectRef: t.id,
								lane: "background",
								concurrencyKey: `work-task:${t.id}:observe`,
							});
							tasks.setRuntimeInTransaction(tx, t.id, { observeJobId: job.id });
						}
						return "applied";
					}
					if (op === "dispatch" && ["queued", "active"].includes(t.state)) {
						tasks.applyTransitionInTransaction(tx, fence(t), {
							state: "reconciling",
							reason: "dispatch_unconfirmed",
						});
						cancelRuntime(tx, t);
					}
					return {
						status: "failed",
						errorCode: "work_task_operation_unconfirmed",
					};
				},
				cancelInTransaction(tx, job) {
					if (op !== "dispatch") return;
					const t = current(tx, job.payload, false);
					if (!t || !["queued", "active"].includes(t.state)) return;
					tasks.applyTransitionInTransaction(tx, fence(t), {
						state: "reconciling",
						reason: "dispatch_cancelled",
					});
					// The Queue owns the job currently being cancelled; avoid cancelling it recursively.
					cancelRuntime(tx, t, job.jobId);
				},
			};
			queue.registerHandler(handler);
		}
		register("dispatch");
		register("observe");
		register("stop");
	}
	scheduler.registerTarget({
		kind: "tasks.observe.v1",
		version: 1,
		schema: payloadSchema.omit({ commandId: true, answerQuestionId: true }),
		validateInTransaction(tx, value) {
			if (
				!registeringMonitor.has(value.taskId) ||
				!execution ||
				!available() ||
				!current(tx, { ...value, commandId: "validate" }, false)
			)
				throw new Error("invalid_task_observation");
			const refs = tasks.runtimeInTransaction(tx, value.taskId);
			const existing = refs.scheduleId
				? scheduler.getInTransaction(tx, refs.scheduleId)
				: null;
			if (existing && ["active", "paused"].includes(existing.state))
				throw new Error("invalid_task_observation");
		},
		materializeInTransaction(tx, occurrence) {
			const p = { ...occurrence.payload, commandId: occurrence.occurrenceId };
			if (!current(tx, p, false) || !execution || !available())
				throw new Error("invalid_task_observation");
			const refs = tasks.runtimeInTransaction(tx, p.taskId);
			const existing = refs.observeJobId
				? queue.getInTransaction(tx, refs.observeJobId)
				: null;
			if (
				existing &&
				["queued", "running", "retry_wait"].includes(existing.state)
			)
				return { jobId: existing.id, subjectRef: p.taskId };
			const { job } = queue.enqueueInTransaction(tx, {
				scope: `work-task:${p.taskId}`,
				kind: "tasks.observe.v1",
				dedupeKey: p.commandId,
				payload: p,
				subjectRef: p.taskId,
				lane: "background",
				concurrencyKey: `work-task:${p.taskId}:observe`,
			});
			tasks.setRuntimeInTransaction(tx, p.taskId, { observeJobId: job.id });
			return { jobId: job.id, subjectRef: p.taskId };
		},
	});
	const unsubscribe = store.onCommit(() => {
		queue.flushCancellations([...aborted]);
		aborted.clear();
		queue.wake();
		scheduler.wake();
	});
	return {
		tasks,
		close: unsubscribe,
		async recover() {
			await tasks.recover();
			await store.write((tx) => {
				for (const t of tasks.liveInTransaction(tx))
					if (["reconciling", "stopping"].includes(t.state))
						cancelRuntime(tx, t);
			});
		},
	};
}
