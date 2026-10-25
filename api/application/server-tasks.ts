import { dirname, join } from "node:path";
import type { Capabilities } from "../domains/capabilities";
import { createCodingSupervision } from "../domains/coding-supervision";
import {
	createEvents,
	createSecretBox,
	createWorkSettings,
} from "../domains/dots";
import { createTaskReports } from "../domains/task-reports";
import type { SchedulerService } from "../domains/scheduler";
import type { Config } from "../infrastructure/config";
import { createProductionCoding } from "./work/coding";
import { codingObservationReader } from "./work/coding-observation";
import {
	purgeTaskDependents,
	superviseCodingExecution,
	unavailableCodingWorkflow,
} from "./work/coding-supervision";
import { createCodingTaskExecution } from "./work/coding-tasks";
import { createDelegatedTasks } from "./work/delegated-tasks";
import { createDotsTasks } from "./work/dots-tasks";
import type { Core } from "./server-core";
import { createTaskReportDelivery } from "./work/task-report-delivery";

/**
 * Delegated tasks with their kinds: coding (with supervision and reports) and
 * dots. The task, supervision and capability references are lazy because the
 * parts are wired to each other.
 */
export async function buildTasks(
	config: Config,
	deps: {
		core: Pick<
			Core,
			"store" | "queue" | "inference" | "conversation" | "settings"
		>;
		scheduler: SchedulerService;
		capabilities: () => Capabilities;
	},
) {
	const { store, queue, inference, conversation, settings } = deps.core;
	const { scheduler } = deps;
	const codingComposition = config.codingRunnerConfig
		? await createProductionCoding(store, config.codingRunnerConfig)
		: undefined;
	const codingExecution = codingComposition
		? createCodingTaskExecution({
				store,
				coding: codingComposition.coding,
				tasks: () => delegated.tasks,
				available: codingComposition.available,
			})
		: undefined;
	const taskReports = createTaskReports({
		store,
		tasks: () => delegated.tasks,
	});
	const dotsSecretBox = createSecretBox(
		config.env.EUMENES_KEY_DIR ?? join(dirname(config.dbPath), "keys"),
	);
	const dotsEvents = createEvents({ store, queue, ...dotsSecretBox });
	const dots = createDotsTasks({
		store,
		conversation,
		tasks: () => delegated.tasks,
		reports: taskReports,
		capabilities: deps.capabilities,
		commandPrepared: dotsEvents.enqueueInTransaction,
	});
	const workflow = codingComposition
		? unavailableCodingWorkflow(store, codingComposition.coding)
		: undefined;
	const supervisedExecution =
		codingExecution && workflow
			? superviseCodingExecution({
					store,
					base: codingExecution.execution,
					tasks: () => delegated.tasks,
					supervision: () => supervision!,
					workflow,
					coding: codingComposition?.coding,
				})
			: undefined;
	const delegated = createDelegatedTasks({
		store,
		queue,
		scheduler,
		enabled: config.delegatedTasksEnabled,
		execution: supervisedExecution,
		additionalKinds: [dots.kind],
		changedInTransaction: (db, t) => {
			if (t.kind === "coding") supervision?.taskChangedInTransaction(db, t);
			else dots.redactInTransaction(db, t);
		},
		purgeInTransaction: (db, t) => {
			purgeTaskDependents(taskReports)(db, t);
			dots.purgeInTransaction(db, t.id);
		},
	});
	const deliverTaskReports = createTaskReportDelivery(
		taskReports,
		delegated.tasks,
		conversation,
		(db, t) =>
			t.kind !== "orchestration" ||
			createWorkSettings().inTransaction(db).settings.showInConversation,
	);
	const supervision = workflow
		? createCodingSupervision({
				store,
				tasks: () => delegated.tasks,
				queue,
				inference,
				reports: taskReports,
				workflow,
				observationReader: codingComposition
					? codingObservationReader(store, codingComposition.coding)
					: undefined,
				approveInstructions: () =>
					settings.get().codingSupervision.approveInstructions,
			})
		: undefined;
	return {
		codingComposition,
		codingExecution,
		taskReports,
		dotsEvents,
		dots,
		delegated,
		deliverTaskReports,
		supervision,
	};
}
