import type { SqliteStore } from "../infrastructure/sqlite";
import type { QueueService } from "../domains/queue";
import type { InferencePort } from "../domains/inference";
import {
	publicDataUrl,
	sourceMatchesQuestion,
	publicInvocationHint,
} from "../domains/web-research";
import type { WebResearchService } from "../domains/web-research";
import { createCapabilities } from "../domains/capabilities";
import { createToolRuntime, type ToolAdapter } from "../domains/tool-runtime";
import { createAgentRuntime } from "../domains/agent-runtime";
export async function createToolchain(
	store: SqliteStore,
	queue: QueueService,
	inference: InferencePort,
	web: WebResearchService,
) {
	const capabilities = createCapabilities(store);
	await capabilities.seed();
	const adapter: ToolAdapter = {
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
				if (!sourceMatchesQuestion(known, value, r.question ?? ""))
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
	const tools = createToolRuntime(store, capabilities, queue, adapter);
	const agents = createAgentRuntime({
		store,
		capabilities,
		tools,
		queue,
		inference,
		invocationHint: publicInvocationHint,
	});
	return { capabilities, tools, agents };
}
export function toolchainEnabled(
	value = process.env.EUMENES_TOOLCHAIN_ENABLED,
) {
	if (value === undefined || value === "1") return true;
	if (value === "0") return false;
	throw new Error("invalid_toolchain_enabled");
}
