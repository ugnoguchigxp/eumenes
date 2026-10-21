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
import { createRuntimeState, type SearchReportHook } from "./runtime-context";
import { createStartTask } from "./start-task";
import { createStepHandler } from "./step-handler";
import { createTaskOps } from "./task-ops";
import { createTaskExecutions } from "./executions";
import { executionChildren } from "./execution-children";

export function createAgentRuntime({
	store,
	capabilities,
	tools,
	inference,
	queue,
	now = Date.now,
	reconcileThrottleMs = 25,
	timers = { setTimeout, clearTimeout },
	onSearchReport,
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
	onSearchReport?: SearchReportHook;
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
			onSearchReport,
		},
	};
	const ops = createTaskOps(ctx);
	const answer = createAnswer(ctx, ops);
	const { handler } = createStepHandler(ctx, ops);
	const flush = createFlush(ctx);
	const reconcile = createReconcile(ctx, ops, flush);
	const executions = createTaskExecutions({ store, queue, inference, now });
	const maintenance = createMaintenance(ctx, ops, executions.maintenance);
	const lifecycle = createLifecycle(ctx, ops, reconcile, maintenance, flush);
	return {
		executions,
		...executionChildren(ctx, answer, ops),
		handler,
		cancelTreeInTransaction: ops.cancelTreeInTransaction,
		...createQueries(ctx, answer),
		...createStartTask(ctx, ops),
		...answer.api,
		...lifecycle,
		start() {
			lifecycle.start();
			executions.start();
		},
		async recover() {
			await executions.recover();
			await lifecycle.recover();
		},
		async close() {
			await executions.close();
			await lifecycle.close();
		},
	};
}
export type AgentRuntime = ReturnType<typeof createAgentRuntime>;
