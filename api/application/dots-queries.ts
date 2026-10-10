import { getLogger } from "../infrastructure/logger";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../infrastructure/sqlite";
import type { createCommands, Command } from "../domains/dots";
import type { WorkTask } from "../domains/tasks";
import { adoptDotsReport, type DotsReportPorts } from "./dots-report-adoption";
export function createDotsQueries(
	ports: DotsReportPorts & {
		store: SqliteStore;
		now: () => number;
		commands: ReturnType<typeof createCommands>;
		prepare: (
			db: Database,
			t: WorkTask,
			kind: Command["kind"],
			questionId?: string,
		) => void;
	},
) {
	const { store, commands, tasks, inbox, current, prepare, reports, now } =
		ports;

	return {
		getCommand(owner: string, id: string) {
			return store.readSnapshot((db) => {
				const c = commands.getInTransaction(db, owner, id);
				current(db, owner, c);
				return c;
			});
		},
		claim(owner: string, raw: unknown) {
			return commands.claim(owner, raw, (db, c) => {
				current(db, owner, c);
			});
		},
		report(owner: string, raw: unknown) {
			return store
				.write((db) =>
					inbox.appendInTransaction(db, owner, raw, (r, c) =>
						adoptDotsReport(db, owner, r, c, ports),
					),
				)
				.then((receipt) => {
					getLogger("dots").info("dots.report_adopted", {
						workTaskId: receipt.taskId,
						status: receipt.state,
						generation: receipt.executionGeneration,
					});
					return receipt;
				});
		},
		taskSnapshot(owner: string, id: string) {
			return store.readSnapshot((db) => {
				const t = tasks().getInTransaction(db, id);
				if (!t || t.kind !== "orchestration" || t.grant.connectionRef !== owner)
					throw new Error("dots_permission_denied");
				if (t.bodyExpired || t.forgottenAt) {
					if (t.state !== "stopping") throw new Error("dots_stale");
					return {
						task: {
							id: t.id,
							state: t.state,
							authorityEpoch: t.authorityEpoch,
							executionGeneration: t.executionGeneration,
							stopIntent: t.stopIntent,
						},
						sessions: inbox.sessionsInTransaction(db, id),
						sourceSequence: inbox.lastSequenceInTransaction(db, id),
					};
				}
				if (
					!inbox.connectionInTransaction(db, owner)?.enabled &&
					t.state !== "stopping"
				)
					throw new Error("dots_permission_denied");
				return {
					task:
						t.state === "stopping"
							? {
									id: t.id,
									state: t.state,
									authorityEpoch: t.authorityEpoch,
									executionGeneration: t.executionGeneration,
									stopIntent: t.stopIntent,
								}
							: t,
					question: tasks().openQuestionInTransaction(db, id),
					sessions: inbox.sessionsInTransaction(db, id),
					sourceSequence: inbox.lastSequenceInTransaction(db, id),
				};
			});
		},
		bindSchedule(taskId: string, scheduleRef: string) {
			return store.write((db) => {
				const t = tasks().getInTransaction(db, taskId);
				if (!t || t.kind !== "orchestration") throw new Error("dots_not_found");
				if (
					t.bodyExpired ||
					t.forgottenAt ||
					["stopping", "cancelled", "paused"].includes(t.state)
				)
					throw new Error("dots_stale");
				const connection = inbox.connectionInTransaction(
						db,
						t.grant.connectionRef,
					),
					project = inbox.projectInTransaction(db, t.grant.projectRef);
				if (!connection?.enabled || !project?.enabled)
					throw new Error("dots_unavailable");
				const old = inbox.scheduleInTransaction(db, scheduleRef);
				if (old && old.expires_at > now()) {
					if (
						old.task_id !== taskId ||
						old.connection_ref !== t.grant.connectionRef
					)
						throw new Error("dots_conflict");
					try {
						const c = commands.getInTransaction(
							db,
							t.grant.connectionRef,
							old.command_id,
						);
						current(db, t.grant.connectionRef, c);
						return {
							taskId,
							scheduleRef,
							commandId: old.command_id,
							expiresAt: old.expires_at,
						};
					} catch (e) {
						if (!(e instanceof Error) || e.message !== "dots_stale") throw e;
					}
				}
				const expiresAt = now() + 7 * 86400000,
					commandId = createHash("sha256")
						.update(
							JSON.stringify([
								taskId,
								scheduleRef,
								expiresAt,
								t.authorityEpoch,
								t.executionGeneration,
								connection.revision,
								project.revision,
							]),
						)
						.digest("hex");
				inbox.bindScheduleInTransaction(
					db,
					t.grant.connectionRef,
					taskId,
					scheduleRef,
					commandId,
					expiresAt,
				);
				commands.prepareInTransaction(db, {
					commandId,
					taskId,
					connectionRef: t.grant.connectionRef,
					kind: "reminder",
					authorityEpoch: t.authorityEpoch,
					executionGeneration: t.executionGeneration,
					createdAt: now(),
					expiresAt,
					state: "pending",
					leaseId: null,
					snapshot: {
						protocolVersion: 1,
						workflowVersion: 1,
						task: { id: t.id, title: t.title, state: t.state },
						scheduleRef,
						project,
						connectionRevision: connection.revision,
						projectRevision: project.revision,
						sessions: inbox.sessionsInTransaction(db, t.id),
					},
				});
				return { taskId, scheduleRef, commandId, expiresAt };
			});
		},
		async maintenance() {
			return store.write((db) => {
				for (const t of tasks().liveInTransaction(db)) {
					if (
						t.kind !== "orchestration" ||
						["registered", "paused", "stopping"].includes(t.state)
					)
						continue;
					const last = inbox
						.commandsInTransaction(db, t.id)
						.reverse()
						.find((c) => c.state !== "superseded" && c.kind !== "reminder");
					if (!last) continue;
					try {
						current(db, t.grant.connectionRef, last);
					} catch (e) {
						if (
							!(e instanceof Error) ||
							!["dots_stale", "capability_revoked"].includes(e.message)
						)
							throw e;
						tasks().requestStopInTransaction(db, t.id, {
							requestId: crypto.randomUUID(),
							expectedRevision: t.revision,
							intent: "pause",
						});
					}
				}
			});
		},
		async recover() {
			await store.write((db) => {
				for (const t of tasks().liveInTransaction(db))
					if (t.kind === "orchestration" && t.state === "reconciling") {
						commands.supersedeInTransaction(db, t.id, true);
						try {
							prepare(db, t, "reconcile");
						} catch (e) {
							if (
								!(e instanceof Error) ||
								![
									"dots_unavailable",
									"capability_revoked",
									"capability_unavailable",
								].includes(e.message)
							)
								throw e;
							tasks().requestStopInTransaction(db, t.id, {
								requestId: crypto.randomUUID(),
								expectedRevision: t.revision,
								intent: "pause",
							});
						}
					}
			});
		},
		redactInTransaction(db: Database, t: WorkTask) {
			if (t.kind !== "orchestration" || (!t.bodyExpired && !t.forgottenAt))
				return;
			commands.redactInTransaction(db, t.id);
			reports.purgeInTransaction(db, t.id);
		},
		purgeInTransaction: commands.purgeInTransaction,
	};
}
