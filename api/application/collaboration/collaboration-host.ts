import type { QueueService } from "../../domains/queue";
import {
	createCollaborationWorks,
	type Ports,
} from "../../domains/collaboration";
import { createCollaborationAdapter } from "./collaboration-adapter";
import { registerCollaborationFollowup } from "./collaboration-followup";

export function createCollaborationHost(queue: QueueService) {
	const works = createCollaborationWorks();
	let afterCommit = () => {};
	const watch = registerCollaborationFollowup(queue, works, () =>
		afterCommit(),
	);
	const adapters = (["pipeline", "interact"] as const).map((kind) => ({
		...createCollaborationAdapter(kind, works, watch),
		afterCommit: () => afterCommit(),
	}));
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
