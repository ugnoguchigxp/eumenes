import type { Database } from "bun:sqlite";
import type { TaskExecutionHost } from "../toolchain/task-execution-port";
/** A published pipeline follows its exact binding and existing adapter availability. */
export function pipelineContract(
	host: TaskExecutionHost,
	db: Database,
	toolchainRevisionId: string,
) {
	const { capabilities, registry } = host;
	const id = /^toolchain:(.+)@[1-9][0-9]*$/.exec(toolchainRevisionId)?.[1];
	if (!id || !capabilities.toolchainsInTransaction(db).some((d) => d.id === id))
		return null;
	const bound = capabilities.toolchainBindingInTransaction(
		db,
		toolchainRevisionId,
	);
	const binding = bound?.binding.document;
	if (
		binding?.execution !== "pipeline" ||
		!registry.get(binding.adapterRef)?.availableInTransaction(db)
	)
		return null;
	return {
		bindingRevisionId: bound!.binding.revisionId,
		instructions: (() => {
			const set = capabilities.toolchainSetInTransaction(
				db,
				toolchainRevisionId,
			);
			return [set.profile, ...set.skills].join("\n\n");
		})(),
		runMs: binding.timeLimits.runMs,
	};
}
