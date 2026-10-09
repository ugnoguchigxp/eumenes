import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../infrastructure/sqlite";
import type { CodingService, CodingAuthority } from "../domains/coding";
import type { TasksService, WorkTask } from "../domains/tasks";
import type { TaskExecutionPort } from "./delegated-tasks";

export function createCodingTaskExecution(input: {
	store: SqliteStore;
	coding: CodingService;
	tasks: () => TasksService;
	available: boolean;
}) {
	const { store, coding } = input;
	const authority = (t: WorkTask): CodingAuthority => ({
		taskId: t.id,
		generation: t.executionGeneration,
		authorityEpoch: t.authorityEpoch,
		workspaceId: t.grant.workspaceId,
		branch: t.grant.branch,
		operations: t.grant.operations,
		network: t.grant.network,
		deadlineAt: Math.min(
			Date.parse(t.grant.expiresAt),
			Date.parse(t.executionDeadlineAt ?? t.grant.expiresAt),
		),
	});
	const fence = (t: WorkTask) => ({
		taskId: t.id,
		expectedRevision: t.revision,
		authorityEpoch: t.authorityEpoch,
		executionGeneration: t.executionGeneration,
	});
	function current(db: Database, original: WorkTask) {
		const t = input.tasks().getInTransaction(db, original.id);
		if (
			!t ||
			t.revision !== original.revision ||
			t.authorityEpoch !== original.authorityEpoch ||
			t.executionGeneration !== original.executionGeneration ||
			!["queued", "active", "waiting_user"].includes(t.state) ||
			authority(t).deadlineAt <= Date.now()
		)
			throw new Error("coding_authority_stale");
		return t;
	}
	const execution: TaskExecutionPort = {
		available: () => input.available,
		prepareInTransaction(db, t, context) {
			const previous = coding.latestInTransaction(db, t.id);
			const q = context.answerQuestionId
				? input.tasks().questionInTransaction(db, context.answerQuestionId)
				: null;
			if (!t.request || (context.answerQuestionId && (!q || q.answer === null)))
				throw new Error("coding_instruction_missing");
			coding.prepareInTransaction(db, authority(t), {
				operationId: context.commandId,
				instruction: q?.answer ?? t.request,
				kind: q ? "continue" : "implement",
				...(q && previous ? { previousExecutionId: previous.id } : {}),
			});
		},
		async dispatch(t, context) {
			const prepared = store.readSnapshot((db) => {
				current(db, t);
				return coding.preparedInTransaction(db, context.commandId);
			});
			const receipt = await coding.dispatch(prepared, context.signal);
			if (
				receipt.executionId !== prepared.spec.executionId ||
				receipt.operationId !== prepared.spec.operationId
			)
				throw new Error("coding_receipt_conflict");
			await store.write((db) => {
				const latest = current(db, t);
				coding.acceptInTransaction(db, authority(latest), receipt);
			});
			return {
				accepted: ["reserved", "running", "exited", "stopped"].includes(
					receipt.state,
				),
			};
		},
		async observe(t, signal) {
			const latest = store.readSnapshot((db) => {
				current(db, t);
				return coding.latestInTransaction(db, t.id);
			});
			if (!latest) throw new Error("coding_intent_missing");
			let cursor = latest.cursor;
			// Read bounded batches immediately. A continuously growing backlog yields after 20 batches.
			for (let count = 0; count < 20; count++) {
				let batch: Awaited<ReturnType<typeof coding.inspect>>;
				try {
					batch = await coding.inspect(latest.id, cursor, 100, false, signal);
					if (batch.receipt.executionId !== latest.id)
						throw new Error("coding_receipt_conflict");
					await store.write((db) => {
						const task = current(db, t);
						coding.adoptInTransaction(db, authority(task), batch);
					});
				} catch (error) {
					if (
						!(error instanceof Error) ||
						error.message !== "coding_authority_stale"
					)
						await store.write((db) => {
							const task = current(db, t);
							coding.unknownInTransaction(db, latest.id);
							input.tasks().applyTransitionInTransaction(db, fence(task), {
								state: "reconciling",
								reason: "coding_observation_conflict",
							});
						});
					throw error;
				}
				cursor = batch.nextCursor;
				if (!batch.hasMore) return { hasMore: false };
			}
			return { hasMore: true };
		},
		async stop(t, context) {
			const latest = store.readSnapshot((db) =>
				coding.latestInTransaction(db, t.id),
			);
			if (!latest) return { stopped: true }; // Never dispatched; the atomic intent is absent.
			const prepared = store.readSnapshot((db) => {
				const spec = coding.specInTransaction(db, latest.id);
				return coding.preparedInTransaction(db, spec.operationId);
			});
			coding.publish(prepared);
			await coding.stop(
				latest.id,
				latest.generation,
				context.commandId.replace(/[^a-zA-Z0-9_-]/g, "_"),
				t.stopIntent === "pause" ? "pause" : "cancel",
				context.signal,
			);
			const observed = await coding.inspect(
				latest.id,
				latest.cursor,
				1,
				false,
				context.signal,
			);
			if (
				observed.receipt.executionId !== latest.id ||
				observed.receipt.generation !== latest.generation ||
				!observed.receipt.childrenStopped ||
				!["exited", "stopped"].includes(observed.receipt.state)
			)
				return { stopped: false };
			await store.write((db) => {
				const task = input.tasks().getInTransaction(db, t.id);
				if (
					!task ||
					task.state !== "stopping" ||
					task.authorityEpoch !== t.authorityEpoch ||
					task.executionGeneration !== t.executionGeneration
				)
					throw new Error("coding_authority_stale");
				coding.confirmStoppedInTransaction(
					db,
					t.id,
					latest.generation,
					observed.receipt,
				);
			});
			return { stopped: true };
		},
	};
	let closing = false;
	let heartbeatPromise: Promise<void> | null = null;
	function heartbeat(): Promise<void> {
		if (closing) return Promise.resolve();
		if (heartbeatPromise) return heartbeatPromise;
		heartbeatPromise = runHeartbeat().finally(() => {
			heartbeatPromise = null;
		});
		return heartbeatPromise;
	}
	async function runHeartbeat() {
		try {
			const lives = store.readSnapshot((db) =>
				coding.liveInTransaction(db).map((e) => ({
					execution: e,
					task: input.tasks().getInTransaction(db, e.taskId),
				})),
			);
			function authorized(
				task: WorkTask | null,
				e: (typeof lives)[number]["execution"],
			) {
				return (
					task &&
					task.authorityEpoch === e.authorityEpoch &&
					task.executionGeneration === e.generation &&
					["queued", "active", "waiting_user"].includes(task.state) &&
					authority(task).deadlineAt > Date.now() &&
					e.state !== "outcome_unknown"
				);
			}
			async function revoke(e: (typeof lives)[number]["execution"]) {
				const prepared = store.readSnapshot((db) => {
					const spec = coding.specInTransaction(db, e.id);
					return coding.preparedInTransaction(db, spec.operationId);
				});
				coding.publish(prepared);
				await coding.stop(
					e.id,
					e.generation,
					`revoke_${e.id}`,
					"authority_revoked",
					AbortSignal.timeout(3000),
				);
			}
			// Valid leases take priority, with bounded concurrent RPCs so one stalled peer cannot starve all workers.
			lives.sort(
				(a, b) =>
					Number(Boolean(authorized(b.task, b.execution))) -
					Number(Boolean(authorized(a.task, a.execution))),
			);
			for (let offset = 0; offset < lives.length && !closing; offset += 16) {
				await Promise.allSettled(
					lives.slice(offset, offset + 16).map(async ({ execution: e }) => {
						try {
							const task = store.readSnapshot((db) =>
								input.tasks().getInTransaction(db, e.taskId),
							);
							if (authorized(task, e)) {
								await coding.inspect(
									e.id,
									e.cursor,
									1,
									true,
									AbortSignal.timeout(3000),
								);
								const latest = store.readSnapshot((db) =>
									input.tasks().getInTransaction(db, e.taskId),
								);
								if (!authorized(latest, e)) await revoke(e);
							} else await revoke(e);
						} catch {
							/* Independent worker lease bounds failure; never replay start. */
						}
					}),
				);
			}
		} catch {
			/* Closing the host cannot create an unhandled heartbeat rejection. */
		}
	}

	async function shutdown() {
		closing = true;
		await heartbeatPromise;
		const lives = store.readSnapshot((db) => coding.liveInTransaction(db));
		for (let offset = 0; offset < lives.length; offset += 16) {
			await Promise.allSettled(
				lives.slice(offset, offset + 16).map(async (e) => {
					try {
						const prepared = store.readSnapshot((db) => {
							const spec = coding.specInTransaction(db, e.id);
							return coding.preparedInTransaction(db, spec.operationId);
						});
						coding.publish(prepared);
						await coding.stop(
							e.id,
							e.generation,
							`shutdown_${e.id}`,
							"shutdown",
							AbortSignal.timeout(3000),
						);
					} catch {
						/* Independent worker deadline/lease remains authoritative. */
					}
				}),
			);
		}
	}
	return { execution, heartbeat, shutdown };
}
