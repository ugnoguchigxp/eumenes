import type { ToolchainExecutionPort } from "../../domains/tool-runtime";
import type { TaskExecutionHost } from "../toolchain/task-execution-port";
import { collaborationBackends } from "./collaboration-backends";
import { collaborationBrave } from "./collaboration-brave";
import { collaborationTask } from "./collaboration-task";
import { workflowReviewer } from "../review/workflow-review";

/** Attach public lifecycle ports only after the shared execution port is ready. */
export function configureCollaboration(
	host: TaskExecutionHost,
	execution: ToolchainExecutionPort,
) {
	if (!host.collaboration) return;
	const evaluate = workflowReviewer(
		host.store,
		host.inference,
		host.capabilities,
	);
	const task = collaborationTask(host, execution);
	host.collaboration.configure(
		collaborationBackends({
			dialogue: host.dialogue,
			agents: host.agents,
			capabilities: host.capabilities,
			execution,
			task,
			interact: host.interact,
			brave: host.browser && collaborationBrave(host.browser, execution),
			review: evaluate
				? {
						evaluate,
						conditions: host.dialogue.specialistReviewConditionsInTransaction,
					}
				: undefined,
			interactAvailable: (db) =>
				host.registry
					.all()
					.some(
						(adapter) =>
							adapter.describe().availability ===
								"availability:browser.interact@1" &&
							adapter.availableInTransaction(db),
					),
		}),
		() => host.interact?.afterCommit(),
		{ store: host.store, find: task.find, handoff: task.handoff },
	);
	host.memory?.registerForgetPurge((db, purge) =>
		host.collaboration!.works.forget(db, purge.messageIds),
	);
}
