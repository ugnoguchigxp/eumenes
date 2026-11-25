import { measureStage } from "../../../infrastructure/performance";
import type { DialogueDeps } from "./context";

import { createExecutorContext, type ToolExecutor } from "./executor-context";
import { delegate } from "./executor-delegation";
import { memory } from "./executor-memory";
import { read } from "./executor-read";
import { answered, find } from "./executor-search";

/**
 * The host side of the fixed tools (the ContextWindow specification, sections 6.1, 6.5, 9 and 14): each call runs
 * here and its result goes back to the model. A delegation that hands the conversation to a session ends the
 * generation.
 */
export function createGenerationExecutor(
	deps: DialogueDeps,
	ctx: Parameters<typeof createExecutorContext>[1],
) {
	const x = createExecutorContext(deps, ctx);
	const execute: ToolExecutor = (
		call,
		{ signal, receipt, exchange, routedSteps },
	) =>
		measureStage(
			"dialogue",
			"tool_execution",
			async () => {
				x.state.receipt = receipt;
				x.state.exchange = exchange;
				switch (call.name) {
					case "memory":
						return memory(x, call, call.args);
					case "find_toolchain":
						return find(x, call, call.args.query, signal);
					case "delegate":
						return delegate(x, call, call.args, signal, routedSteps);
					default:
						return read(x, call);
				}
			},
			{ kind: call.name },
		);
	return {
		execute,
		handover: () => x.state.handover,
		answered: (refused?: boolean) => answered(x, refused),
	};
}
