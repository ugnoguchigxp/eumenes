import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { getLogger } from "../../../infrastructure/logger";
import type {
	CreateTask,
	TaskGrant,
	TaskOrigin,
	TaskReceipt,
} from "../contracts";
import * as repo from "../repository";
import type { TasksOptions, TrustedTaskContext } from "../types";
import { createTaskCore } from "./core";
import { createTaskGrants } from "./grants";
import { createTaskLifecycle } from "./lifecycle";
import { createTaskMaintenance } from "./maintenance";
import { createTaskProgress } from "./progress";
import { createTaskQueries } from "./queries";

export function createTasks(store: SqliteStore, options: TasksOptions = {}) {
	const log = getLogger("tasks");
	async function writeCommand(
		operation: (tx: Database) => TaskReceipt,
		event: string,
	) {
		const result = await store.write(operation);
		log.info(event, {
			workTaskId: result.taskId,
			status: result.state,
			generation: result.executionGeneration,
		});
		return result;
	}
	const core = createTaskCore(options);
	const lifecycle = createTaskLifecycle(core);
	const { amendGrantInTransaction } = createTaskGrants(core, lifecycle);
	const progress = createTaskProgress(core);
	const maintenance = createTaskMaintenance(core, lifecycle);
	const {
		createInTransaction,
		requestStartInTransaction,
		requestStopInTransaction,
		forgetInTransaction,
		settleStopInTransaction,
	} = lifecycle;
	const {
		applyTransitionInTransaction,
		askInTransaction,
		answerInTransaction,
	} = progress;
	const { maintenanceInTransaction, recoverInTransaction } = maintenance;
	return {
		createInTransaction,
		requestStartInTransaction,
		requestStopInTransaction,
		forgetInTransaction,
		settleStopInTransaction,
		amendGrantInTransaction,
		applyTransitionInTransaction,
		askInTransaction,
		answerInTransaction,
		getInTransaction: (tx: Database, taskId: string) => repo.get(tx, taskId),
		questionInTransaction: (tx: Database, questionId: string) =>
			repo.question(tx, questionId),
		openQuestionInTransaction: repo.openQuestion,
		assertFenceInTransaction: core.fence,
		create: (input: CreateTask, context?: TrustedTaskContext) =>
			writeCommand(
				(tx) => createInTransaction(tx, input, context),
				"tasks.registered",
			),
		start: (taskId: string, input: unknown) =>
			writeCommand(
				(tx) => requestStartInTransaction(tx, taskId, input),
				"tasks.start_requested",
			),
		stop: (taskId: string, input: unknown) =>
			writeCommand(
				(tx) => requestStopInTransaction(tx, taskId, input),
				"tasks.stop_requested",
			),
		amend: (taskId: string, input: unknown) =>
			writeCommand(
				(tx) => amendGrantInTransaction(tx, taskId, input),
				"tasks.grant_amended",
			),
		answer: (taskId: string, input: unknown) =>
			writeCommand(
				(tx) => answerInTransaction(tx, taskId, input),
				"tasks.answered",
			),
		forget: (taskId: string, input: unknown) =>
			store.write((tx) => forgetInTransaction(tx, taskId, input)),
		...createTaskQueries(store, core),
		liveInTransaction: repo.live,
		hasConnectionHistoryInTransaction: repo.hasConnectionHistory,
		conversationInTransaction(
			db: Database,
			conversationId: string,
			limit = 50,
		) {
			return repo.conversation(db, conversationId, limit);
		},
		runtimeInTransaction: repo.runtime,
		setRuntimeInTransaction(
			tx: Database,
			taskId: string,
			refs: repo.TaskRuntimeRefs,
		) {
			core.requireTask(tx, taskId);
			repo.setRuntime(tx, taskId, refs);
		},
		maintenance: () => store.write(maintenanceInTransaction),
		async recover() {
			return store.write(recoverInTransaction);
		},
	};
}
export type TasksService = ReturnType<typeof createTasks>;
export type { TaskGrant, TaskOrigin };
