import type { SqliteStore } from "../infrastructure/sqlite";
import type { QueueService } from "../domains/queue";
import type { InferencePort } from "../domains/inference";
import {
	publicDataUrl,
	sourceMatchesQuestion,
	publicInvocationHint,
	shortForecastReportGap,
} from "../domains/web-research";
import type { WebResearchService } from "../domains/web-research";
import { createCapabilities } from "../domains/capabilities";
import {
	createToolRuntime,
	type ActionAdapter,
	type ToolAdapter,
} from "../domains/tool-runtime";
import { createAgentRuntime } from "../domains/agent-runtime";
import { timerReceiptDigest as digest } from "../domains/timers";
import { readActionOriginInTransaction } from "../domains/dialogue";
import type { Clock } from "../domains/research-routes";
import { createRouteWiring } from "./research-routes";
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
	// Peers are attached after construction: no constructor runs another service's operations.
	const wiring =
		options.researchRoutes === false
			? null
			: createRouteWiring({
					queue,
					capabilities,
					inference,
					clock: options.routeClock,
				});
	const adapter: ToolAdapter = {
		...createReadPorts(
			web,
			options.history === false ? undefined : options.conversation,
			() => agents,
		),
		startInTransaction(db, r) {
			const known =
				r.tool.id === "web.forecast"
					? "forecast"
					: r.tool.id === "web.quote"
						? "quote"
						: null;
			if (known) {
				const args = r.arguments as { areaCode?: string; symbol?: string };
				const value = known === "forecast" ? args.areaCode! : args.symbol!;
				// A cached-route grant was already authorized for this exact URL by the route port.
				if (
					r.grantedUrl
						? publicDataUrl(known, value) !== r.grantedUrl
						: !sourceMatchesQuestion(known, value, r.question ?? "")
				)
					throw new Error("tool_url_out_of_scope");
				const op = web.submitInTransaction(
					db,
					{
						operation: "read",
						url: publicDataUrl(known, value),
						requestId: r.requestId,
						freshness: "live",
						retention: "none",
					},
					{
						deadlineAtMs: r.deadline,
						parentJobId: r.parentJobId,
						lane: "background",
						attemptTimeoutMs: r.attemptTimeoutMs,
					},
				);
				return { operationId: op.runId, jobId: op.jobId };
			}
			const raw = {
				...(r.arguments as Record<string, unknown>),
				...(r.tool.id === "web.lookup"
					? {
							region:
								(r.arguments as { region?: string; language?: string })
									.region ??
								((r.arguments as { language?: string }).language === "en"
									? "US"
									: "JP"),
						}
					: {}),
				requestId: r.requestId,
				freshness: "live",
				...(r.tool.id === "web.lookup"
					? { operation: "lookup", readPages: 0 }
					: { operation: "read", retention: "none" }),
			};
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
					const saved =
						request.tool.id === "timer.start"
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
							: request.tool.id === "timer.cancel"
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
								: request.tool.id === "timer.list"
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
					};
				},
				readInTransaction(db, operationId) {
					const row = options.timers!.readReceiptInTransaction(db, operationId);
					if (!row) return null;
					return {
						kind: "local_action",
						backend: "timer",
						version: 1,
						operationId: row.operationId,
						receiptDigest: row.receiptDigest,
						payload: options.timers!.projectReceiptInTransaction(
							db,
							operationId,
						),
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
		wiring?.cachedSource,
		timerActions,
	);
	const agents = createAgentRuntime({
		store,
		capabilities,
		tools,
		queue,
		inference,
		invocationHint: publicInvocationHint,
		reportFeedback: shortForecastReportGap,
		acquisition: wiring?.acquisition,
	});
	wiring?.attach({ agents, tools });
	// Handlers are registered here, before the caller recovers and starts any runner.
	for (const handler of wiring?.handlers() ?? [])
		queue.registerHandler(handler);
	return {
		capabilities,
		tools,
		agents,
		routeService: wiring?.routes,
		postAnswer: wiring?.observer,
	};
}
export function toolchainEnabled(
	value = process.env.EUMENES_TOOLCHAIN_ENABLED,
) {
	if (value === undefined || value === "1") return true;
	if (value === "0") return false;
	throw new Error("invalid_toolchain_enabled");
}
