import type { QueueService } from "../../domains/queue";
import {
	createCollaborationWorks,
	type Ports,
} from "../../domains/collaboration";
import { createCollaborationAdapter } from "./collaboration-adapter";
import { registerCollaborationFollowup } from "./collaboration-followup";
import {
	createSchedulerAdapter,
	type SchedulerAdapterPorts,
} from "../scheduler/scheduler-adapter";
import type { DomainAdapter } from "../../domains/tool-runtime";

export function createCollaborationHost(
	queue: QueueService,
	schedules?: SchedulerAdapterPorts,
) {
	const works = createCollaborationWorks(Date.now, queue);
	let taskDiscovery:
		| {
				store: import("../../infrastructure/sqlite").SqliteStore;
				find: ReturnType<
					typeof import("./collaboration-task").collaborationTask
				>["find"];
				handoff: ReturnType<
					typeof import("./collaboration-task").collaborationTask
				>["handoff"];
		  }
		| undefined;
	let afterCommit = () => {};
	const watch = registerCollaborationFollowup(queue, works, () =>
		afterCommit(),
	);
	const adapters: DomainAdapter[] = (
		["pipeline", "interact", "brave", "task"] as const
	).map((kind) => ({
		...createCollaborationAdapter(
			kind,
			works,
			watch,
			kind === "task"
				? {
						source(origin) {
							if (!taskDiscovery) throw new Error("collaboration_unavailable");
							return taskDiscovery.store.read((db) =>
								works.sourceOfTurn(
									db,
									"task",
									origin.workRef,
									origin.sessionId,
									origin.runId,
								),
							);
						},
						find: (query, source, signal) =>
							taskDiscovery!.find(query, source, signal),
						handoff: (db, revisionId) =>
							taskDiscovery?.handoff(db, revisionId) ?? false,
					}
				: undefined,
		),
		afterCommit: () => {
			afterCommit();
			queue.wake();
		},
	}));
	if (schedules) adapters.push(createSchedulerAdapter(schedules, works));
	return {
		works,
		adapters,
		configure(
			ports: Ports,
			flush: () => void,
			discovery?: NonNullable<typeof taskDiscovery>,
		) {
			works.configure(ports);
			afterCommit = flush;
			taskDiscovery = discovery;
		},
	};
}
export type CollaborationHost = ReturnType<typeof createCollaborationHost>;
