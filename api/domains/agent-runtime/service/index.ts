import { getLogger } from "../../../infrastructure/logger";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { Capabilities } from "../../capabilities";
import type { InferencePort } from "../../inference";
import type { QueueService } from "../../queue";
import type { ToolRuntime } from "../../tool-runtime";
import { createAnswer } from "./answer";
import { createFlush } from "./flush";
import { createLifecycle } from "./lifecycle";
import { createMaintenance } from "./maintenance";
import { createQueries } from "./queries";
import { createReconcile } from "./reconcile";
import { createRuntimeState, STEP_KIND } from "./runtime-context";
import { createStartTask } from "./start-task";
import { createStepHandler } from "./step-handler";
import { createTaskOps } from "./task-ops";

export { STEP_KIND };

export function createAgentRuntime({
	store,
	capabilities,
	tools,
	inference,
	queue,
	now = Date.now,
	reconcileThrottleMs = 25,
	timers = { setTimeout, clearTimeout },
}: {
	store: SqliteStore;
	capabilities: Capabilities;
	tools: ToolRuntime;
	inference: InferencePort;
	queue: QueueService;
	now?: () => number;
	/** Minimum gap between the end of one reconcile pass and the start of a commit-triggered one. */
	reconcileThrottleMs?: number;
	/** Injected only by tests so the throttle never waits in real time. */
	timers?: {
		setTimeout: typeof setTimeout;
		clearTimeout: typeof clearTimeout;
	};
}) {
	const ctx = {
		state: createRuntimeState(),
		deps: {
			store,
			capabilities,
			tools,
			inference,
			queue,
			now,
			reconcileThrottleMs,
			timers,
			log: getLogger("agent-runtime"),
		},
	};
	const ops = createTaskOps(ctx);
	const answer = createAnswer(ctx, ops);
	const { handler } = createStepHandler(ctx, ops);
	const flush = createFlush(ctx);
	const reconcile = createReconcile(ctx, ops, flush);
	const maintenance = createMaintenance(ctx, ops);
	return {
		handler,
		cancelTreeInTransaction: ops.cancelTreeInTransaction,
		...createQueries(ctx, answer),
		...createStartTask(ctx, ops),
		...answer.api,
		...createLifecycle(ctx, ops, reconcile, maintenance, flush),
	};
}
export type AgentRuntime = ReturnType<typeof createAgentRuntime>;
