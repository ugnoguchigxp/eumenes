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
	const works = createCollaborationWorks();
	let afterCommit = () => {};
	const watch = registerCollaborationFollowup(queue, works, () =>
		afterCommit(),
	);
	const adapters: DomainAdapter[] = (["pipeline", "interact"] as const).map(
		(kind) => ({
			...createCollaborationAdapter(kind, works, watch),
			afterCommit: () => afterCommit(),
		}),
	);
	if (schedules) adapters.push(createSchedulerAdapter(schedules, works));
	return {
		works,
		adapters,
		configure(ports: Ports, flush: () => void) {
			works.configure(ports);
			afterCommit = flush;
		},
	};
}
export type CollaborationHost = ReturnType<typeof createCollaborationHost>;
