import { dirname, join } from "node:path";
import type { Capabilities } from "../domains/capabilities";
import {
	createEvents,
	createSecretBox,
	createWorkSettings,
} from "../domains/dots";
import { createTaskReports } from "../domains/task-reports";
import type { Config } from "../infrastructure/config";
import { createTasks } from "../domains/tasks";
import type { SchedulerService } from "../domains/scheduler";
import { createDotsTasks } from "./work/dots-tasks";
import type { Core } from "./server-core";
import { createTaskReportDelivery } from "./work/task-report-delivery";

/**
 * Delegated tasks with their kinds (dots) and reports. The task and capability
 * references are lazy because the parts are wired to each other.
 */
export async function buildTasks(
	config: Config,
	deps: {
		core: Pick<Core, "store" | "queue" | "conversation">;
		scheduler: SchedulerService;
		capabilities: () => Capabilities;
	},
) {
	const { store, queue, conversation } = deps.core;
	const taskReports = createTaskReports({
		store,
		tasks: () => tasks,
	});
	const dotsSecretBox = createSecretBox(
		config.env.EUMENES_KEY_DIR ?? join(dirname(config.dbPath), "keys"),
	);
	const dotsEvents = createEvents({ store, queue, ...dotsSecretBox });
	const dots = createDotsTasks({
		store,
		conversation,
		tasks: () => tasks,
		reports: taskReports,
		capabilities: deps.capabilities,
		commandPrepared: dotsEvents.enqueueInTransaction,
	});
	const tasks = createTasks(store, {
		kinds: [dots.kind],
		changedInTransaction: dots.redactInTransaction,
		purgeInTransaction: (db, t) => {
			taskReports.purgeInTransaction(db, t.id);
			dots.purgeInTransaction(db, t.id);
		},
	});
	// Jobs and schedules written by any commit start without waiting for the next poll.
	const unsubscribe = store.onCommit(() => {
		queue.wake();
		deps.scheduler.wake();
	});
	const delegated = { tasks, close: unsubscribe };
	const deliverTaskReports = createTaskReportDelivery(
		taskReports,
		tasks,
		conversation,
		(db) => createWorkSettings().inTransaction(db).settings.showInConversation,
	);
	return {
		taskReports,
		dotsEvents,
		dots,
		delegated,
		deliverTaskReports,
	};
}
