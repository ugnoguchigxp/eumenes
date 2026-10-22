import type { Database } from "bun:sqlite";
import type { Capabilities, ToolchainCard } from "../../domains/capabilities";
import {
	inputParameters,
	parseInputs,
	stepOutline,
} from "../../domains/pipelines";
import type { AdapterRegistry } from "../../domains/tool-runtime";

/**
 * The host side of task pipelines in the candidates (spec task-pipeline-design 2026-10-22 §13.3): a pipeline's
 * card carries its inputs, as an instant toolchain's carries its arguments. A pipeline whose adapter cannot run it
 * now is not offered. Other cards pass unchanged.
 */
export function createPipelineRouting(deps: {
	capabilities: Capabilities;
	registry: Pick<AdapterRegistry, "get">;
}) {
	return {
		card(db: Database, card: ToolchainCard): ToolchainCard[] {
			if (card.execution !== "pipeline") return [card];
			const binding = deps.capabilities.toolchainBindingInTransaction(
				db,
				card.revisionId,
			)?.binding.document;
			if (binding?.execution !== "pipeline") return [];
			const adapter = deps.registry.get(binding.adapterRef);
			if (!adapter?.availableInTransaction(db)) return [];
			const definition = binding.pipeline;
			return [
				{
					...card,
					pipeline: {
						parameters: inputParameters(definition),
						outline: stepOutline(definition),
						parse: (args, request) => parseInputs(definition, args, request),
					},
				},
			];
		},
	};
}
