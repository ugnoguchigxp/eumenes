import type { Database } from "bun:sqlite";
import { type ToolchainExecutionPort } from "../../tool-runtime";
import {
	eraseExecutionBodies,
	executionRow,
	executionSource,
	executionState,
	executionView,
	isExecutionActive,
	type ExecutionRow,
} from "../repository/executions";
import { executionAccess } from "./execution-access";
import { executionChild } from "./execution-child";
import { executionCommands } from "./execution-commands";
import type { ExecutionContext } from "./execution-context";
import { executionStep } from "./execution-step";
import { executionExtract } from "./execution-extract";
import { executionPipeline } from "./execution-pipeline";
import { createExecutionStore } from "./execution-store";
export function createTaskExecutions(deps: Omit<ExecutionContext, "port">) {
	let port: ToolchainExecutionPort | null = null;
	let stopped = false,
		started = false,
		scheduled = false,
		dirty = false,
		running: Promise<void> | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const ctx: ExecutionContext = {
		...deps,
		port: () => {
			if (!port) throw new Error("execution_unavailable");
			return port;
		},
	};
	const { store, queue, now } = ctx;
	const ops = createExecutionStore(ctx);
	queue.registerHandler(executionStep(ctx, ops));
	queue.registerHandler(executionChild(ctx, ops));
	const pipeline = executionPipeline(ctx, ops);
	queue.registerHandler(executionExtract(ctx, ops, pipeline));
	const table = (db: Database) =>
		!!db
			.query(
				"SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_executions'",
			)
			.get();
	const available = (db: Database) =>
		!!port && table(db) && !!port.controlInTransaction(db);
	function schedule() {
		if (stopped || !started || !port || scheduled) return;
		if (running) {
			dirty = true;
			return;
		}
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			void reconcile().catch(() => {
				timer = setTimeout(schedule, 1000);
				timer.unref();
			});
		});
	}
	const stop = store.onCommit(schedule);
	function reconcile() {
		if (running) return running;
		running = (async () => {
			if (!port || stopped || !store.read(table)) return;
			const rows = store.read(
				(db) =>
					db
						.query(
							"SELECT * FROM agent_executions WHERE state IN ('queued','deciding','waiting_child','waiting_user')",
						)
						.all() as ExecutionRow[],
			);
			for (const row of rows) {
				const state = executionState(row);
				const valid = store.read(
					(db) =>
						port!.validSourceInTransaction(db, executionSource(row)) &&
						state.refs.every((ref) =>
							port!.validReferenceInTransaction(db, executionSource(row), ref),
						) &&
						ops.controlValid(db, state),
				);
				if (
					!valid ||
					row.deadline <= now() ||
					(state.question && state.question.expiresAt <= now())
				) {
					await store.write((db) => {
						const r = executionRow(db, row.id)!;
						if (isExecutionActive(r))
							ops.fail(
								db,
								r,
								executionState(r),
								!valid
									? "execution_source_invalid"
									: state.question && state.question.expiresAt <= now()
										? "execution_question_expired"
										: "deadline_exceeded",
							);
						if (!valid)
							eraseExecutionBodies(db, executionRow(db, row.id)!, now());
					});
					continue;
				}
				if (
					row.state !== "waiting_child" ||
					state.pending?.result?.state !== "running"
				)
					continue;
				let result: import("../../tool-runtime").ChildResult;
				try {
					result = store.read((db) =>
						port!.currentInTransaction(
							db,
							state.pending!.child,
							state.pending!.result!.ref,
						),
					);
				} catch {
					await store.write((db) => {
						const r = executionRow(db, row.id)!;
						if (r.epoch === row.epoch && isExecutionActive(r))
							ops.fail(
								db,
								r,
								executionState(r),
								"execution_child_result_invalidated",
							);
					});
					continue;
				}
				if (result.state === "running") continue;
				await store.write((db) => {
					const r = executionRow(db, row.id)!;
					if (r.epoch === row.epoch && r.state === "waiting_child") {
						db.exec("SAVEPOINT execution_observation");
						try {
							ops.adoptChild(db, r, executionState(r), result);
							db.exec("RELEASE execution_observation");
						} catch {
							db.exec("ROLLBACK TO execution_observation");
							db.exec("RELEASE execution_observation");
							const current = executionRow(db, row.id)!;
							ops.fail(
								db,
								current,
								executionState(current),
								"execution_child_result_rejected",
							);
						}
					}
				});
			}
			const events = store.read(
				(db) =>
					db
						.query(
							"SELECT id,execution_id,kind,state FROM agent_execution_events WHERE state IN ('pending','accepted')",
						)
						.all() as Array<{
						id: string;
						execution_id: string;
						kind: string;
						state: string;
					}>,
			);
			for (const event of events) {
				if (event.state === "accepted") {
					const status = store.read(
						(db) =>
							port!.deliveryStateInTransaction?.(db, event.id) ?? "pending",
					);
					if (status !== "pending")
						await store.write((db) => {
							db.query(
								"UPDATE agent_execution_events SET state=? WHERE id=? AND state='accepted'",
							).run(status, event.id);
						});
					continue;
				}
				await store.write((db) => {
					const row = executionRow(db, event.execution_id);
					if (!row) return;
					if (
						event.kind.startsWith("question:") &&
						executionState(row).question?.id !== event.kind.slice(9)
					) {
						db.query(
							"UPDATE agent_execution_events SET state='cancelled' WHERE id=?",
						).run(event.id);
						return;
					}
					const delivered = port!.deliverInTransaction(
						db,
						executionView(row),
						event.id,
					);
					db.query("UPDATE agent_execution_events SET state=? WHERE id=?").run(
						delivered ? "delivered" : "accepted",
						event.id,
					);
				});
			}
			port.flush();
			if (timer) clearTimeout(timer);
			const deadline = store.read(
				(db) =>
					(
						db
							.query(
								"SELECT MIN(MIN(deadline,COALESCE(json_extract(state_json,'$.question.expiresAt'),deadline))) AS n FROM agent_executions WHERE state IN ('queued','deciding','waiting_child','waiting_user')",
							)
							.get() as { n: number | null }
					).n,
			);
			if (deadline) {
				timer = setTimeout(schedule, Math.max(1, deadline - now()));
				timer.unref();
			}
		})().finally(() => {
			running = null;
			if (dirty) {
				dirty = false;
				schedule();
			}
		});
		return running;
	}

	return {
		start() {
			started = true;
			schedule();
		},
		configure(value: ToolchainExecutionPort) {
			port = value;
			schedule();
		},
		availableInTransaction: available,
		/** Whether this host runs task pipelines now (the task binding is not needed for them). */
		pipelinesAvailableInTransaction: (db: Database) => !!port && table(db),
		startPipelineInTransaction(
			db: Database,
			input: Parameters<typeof pipeline.startPipelineInTransaction>[1],
		) {
			if (!port || !table(db)) throw new Error("execution_unavailable");
			return pipeline.startPipelineInTransaction(db, input);
		},
		...executionCommands(ctx, ops, available),
		...executionAccess(ctx, ops, table, () => !!port),
		reconcile,
		async recover() {
			if (!port || !store.read(table)) return;
			await store.write((db) => {
				for (const r of db
					.query(
						"SELECT * FROM agent_executions WHERE state IN ('queued','deciding','waiting_child','waiting_user')",
					)
					.all() as ExecutionRow[])
					ops.fail(
						db,
						r,
						executionState(r),
						"backend_restarted",
						"interrupted",
					);
			});
		},
		async close() {
			stopped = true;
			stop();
			if (timer) clearTimeout(timer);
			await running;
			if (port && store.read(table))
				await store.write((db) => {
					for (const row of db
						.query(
							"SELECT * FROM agent_executions WHERE state IN ('queued','deciding','waiting_child','waiting_user')",
						)
						.all() as ExecutionRow[])
						ops.fail(
							db,
							row,
							executionState(row),
							"backend_stopped",
							"interrupted",
						);
				});
		},
	};
}
export type TaskExecutions = ReturnType<typeof createTaskExecutions>;
