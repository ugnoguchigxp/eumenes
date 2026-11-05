import type { ToolchainExecutionPort } from "../../domains/tool-runtime";
import type { TaskExecutionHost } from "../toolchain/task-execution-port";
import { collaborationBackends } from "./collaboration-backends";

/** Attach public lifecycle ports only after the shared execution port is ready. */
export function configureCollaboration(
	host: TaskExecutionHost,
	execution: ToolchainExecutionPort,
) {
	if (!host.collaboration) return;
	host.collaboration.configure(
		collaborationBackends({
			dialogue: host.dialogue,
			agents: host.agents,
			capabilities: host.capabilities,
			execution,
			interact: host.interact,
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
	);
	host.memory?.registerForgetPurge((db, purge) =>
		host.collaboration!.works.forget(db, purge.messageIds),
	);
}
