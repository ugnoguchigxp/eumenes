import type { SqliteStore } from "../../infrastructure/sqlite";
import type { Capabilities } from "../../domains/capabilities";
import type { ConversationService } from "../../domains/conversation";
import { createTasks } from "../../domains/tasks";
import { createTaskReports } from "../../domains/task-reports";
import { createDotsTasks } from "./dots-tasks";
import { createDotsWork } from "./dots-work";
/** Isolated fixture only: commands are persisted but no external webhook or native Session is called. */
export function createDotsHarness(
	store: SqliteStore,
	conversation: ConversationService,
	capabilities: () => Capabilities,
) {
	const reports = createTaskReports({
		store,
		tasks: () => tasks,
		now: Date.now,
	});
	const dots = createDotsTasks({
		store,
		conversation,
		tasks: () => tasks,
		reports,
		capabilities,
	});
	const tasks = createTasks(store, { kinds: [dots.kind] });
	const work = createDotsWork({ tasks, reports, conversation, capabilities });
	return {
		dots,
		tasks,
		reports,
		work,
		async setup() {
			await dots.config.configure({
				id: "fixture-dots",
				expectedRevision: 0,
				title: "模擬の外部担当",
				enabled: true,
				oauth: null,
			});
			await dots.config.configureProject({
				ref: "fixture-project",
				connectionRef: "fixture-dots",
				expectedRevision: 0,
				title: "模擬の作業先",
				capabilityRevisionId: "package:dots.orchestrate@4",
				nativeProjectId: "fixture-native-project",
				hostId: "local",
				environment: "local",
				enabled: true,
			});
			await store.write((db) =>
				work.settings.applyInTransaction(db, {
					requestId: crypto.randomUUID(),
					expectedRevision: 0,
					settings: {
						...work.settings.inTransaction(db).settings,
						enabled: true,
						connectionRef: "fixture-dots",
						projectRef: "fixture-project",
					},
					digest: "fixture-initial-settings",
				}),
			);
		},
	};
}
