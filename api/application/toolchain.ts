import { projectTimerResult } from "./timer-result-context";
import type { SqliteStore } from "../infrastructure/sqlite";
import type { QueueService } from "../domains/queue";
import type { InferencePort } from "../domains/inference";
import {
	webToolArguments,
	type WebResearchService,
} from "../domains/web-research";
import { createCapabilities, toolRuntimeOf } from "../domains/capabilities";
import {
	createToolRuntime,
	type ActionAdapter,
	type ToolAdapter,
} from "../domains/tool-runtime";
import { createAgentRuntime } from "../domains/agent-runtime";
import { timerReceiptDigest as digest } from "../domains/timers";
import { readActionOriginInTransaction } from "../domains/dialogue";
import type { Clock } from "../domains/research-routes";
import { createResearchRoutes } from "../domains/research-routes";
import { createReadPorts } from "./research-history-ports";
export async function createToolchain(
	store: SqliteStore,
	queue: QueueService,
	inference: InferencePort,
	web: WebResearchService,
	options: {
		researchRoutes?: boolean;
		routeClock?: Clock;
		history?: boolean;
		webResearch?: boolean;
		conversation?: import("../domains/conversation").ConversationService;
		timers?: import("../domains/timers").TimersService;
		/** Tests that observe a pass immediately after a commit set 0. */
		reconcileThrottleMs?: number;
	} = {},
) {
	const capabilities = createCapabilities(
		store,
		new Set([
			...(options.webResearch !== false ? ["web"] : []),
			...(options.timers ? ["timer"] : []),
			...(options.conversation && options.history !== false ? ["history"] : []),
		]),
	);
	await capabilities.seed();
	// Stored route records remain manageable. New research has no topic parser.
	const routes =
		options.researchRoutes === false
			? undefined
			: createResearchRoutes({
					clock: options.routeClock,
					queue,
					externalBytes: (db) =>
						capabilities.learnedUsageInTransaction(db).bytes,
					prune: (db, input) =>
						capabilities.pruneLearnedInTransaction(db, input),
				});
	const adapter: ToolAdapter = {
		...createReadPorts(
			web,
			options.history === false ? undefined : options.conversation,
			() => agents,
		),
		startInTransaction(db, r) {
			const raw = webToolArguments(
				r.tool.id,
				r.arguments as Record<string, unknown>,
				r.requestId,
			);
			const op = web.submitInTransaction(db, raw, {
				deadlineAtMs: r.deadline,
				parentJobId: r.parentJobId,
				lane: "background",
				attemptTimeoutMs: r.attemptTimeoutMs,
			});
			return { operationId: op.runId, jobId: op.jobId };
		},
		get(id) {
			const run = web.get(id);
			if (!run) return null;
			return {
				state:
					run.status === "queued" || run.status === "running"
						? "pending"
						: run.status === "completed"
							? "succeeded"
							: run.status,
				result: run.result ?? undefined,
				errorCode: run.resultExpired
					? "result_expired"
					: (run.errorCode ?? undefined),
			};
		},
		cancelInTransaction: (db, id) =>
			web.cancelInTransaction(db, id, "cancel_requested"),
	};
	const timerActions: ActionAdapter | undefined = options.timers
		? {
				contextInTransaction(db) {
					return options.timers!.routeSnapshotInTransaction(db);
				},
				executeInTransaction(db, request) {
					const timers = options.timers!;
					agents.validateActionOwnerInTransaction(db, request.owner);
					const [runId, epoch] = request.originToken.split(":");
					if (
						runId !== request.owner.rootRunId ||
						Number(epoch) !== request.owner.cancelEpoch
					)
						throw new Error("origin_invalid");
					const source = readActionOriginInTransaction(db, runId!);
					if (!source || source.taskId !== request.owner.taskId)
						throw new Error("origin_invalid");
					const args = request.arguments as {
						durationSeconds?: number;
						label?: string;
						timerId?: string;
						state?: "active" | "elapsed" | "cancelled";
						expectedRevision?: number;
					};
					const origin = {
						scope: "default" as const,
						conversationId: source.conversationId,
						runId: request.owner.rootRunId,
						messageId: source.messageId,
						originKey: `${request.owner.rootRunId}:timer:0`,
					};
					const verb = toolRuntimeOf(request.tool.revisionId)?.localAction
						?.verb;
					const saved =
						verb === "start"
							? timers.startInTransaction(
									db,
									{
										requestId: request.requestId,
										issuedAt: request.issuedAt,
										durationSeconds: args.durationSeconds ?? 0,
										...(args.label ? { label: args.label } : {}),
									},
									origin,
								)
							: verb === "cancel"
								? timers.cancelInTransaction(
										db,
										{
											requestId: request.requestId,
											issuedAt: request.issuedAt,
											expectedRevision: args.expectedRevision ?? 0,
										},
										"default",
										args.timerId ?? "",
									)
								: verb === "list"
									? timers.recordListOperationInTransaction(
											db,
											{
												requestId: request.requestId,
												issuedAt: request.issuedAt,
												...(args.timerId ? { timerId: args.timerId } : {}),
												...(args.state ? { state: args.state } : {}),
											},
											"default",
										)
									: (() => {
											throw new Error("capability_unavailable");
										})();
					return {
						kind: "local_action",
						backend: "timer",
						version: 1,
						operationId: saved.receipt.operationId,
						receiptDigest: digest(saved.receipt),
						payload: saved.receipt,
						answerContext: projectTimerResult(saved.receipt),
					};
				},
				readInTransaction(db, operationId) {
					const row = options.timers!.readReceiptInTransaction(db, operationId);
					if (!row) return null;
					const payload = options.timers!.projectReceiptInTransaction(
						db,
						operationId,
					);
					if (!payload) throw new Error("invalid_action_result");
					return {
						kind: "local_action",
						backend: "timer",
						version: 1,
						operationId: row.operationId,
						receiptDigest: row.receiptDigest,
						payload,
						answerContext: projectTimerResult(payload),
					};
				},
			}
		: undefined;
	const tools = createToolRuntime(
		store,
		capabilities,
		queue,
		adapter,
		Date.now,
		timerActions,
	);
	const agents = createAgentRuntime({
		store,
		capabilities,
		tools,
		queue,
		inference,
		...(options.reconcileThrottleMs === undefined
			? {}
			: { reconcileThrottleMs: options.reconcileThrottleMs }),
	});
	for (const handler of routes?.maintenanceHandlers() ?? [])
		queue.registerHandler(handler);
	return {
		capabilities,
		tools,
		agents,
		routeService: routes,
		postAnswer: undefined,
	};
}
