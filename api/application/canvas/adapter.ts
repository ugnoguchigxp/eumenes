import { z } from "zod";
import type { Database } from "bun:sqlite";
import { ServiceError } from "eumenes-canvas/src/core/service";
import { sha256Hex } from "../../infrastructure/digest";
import type { ConversationService } from "../../domains/conversation";
import type { AdapterResult, DomainAdapter } from "../../domains/tool-runtime";
import type { CanvasJobs } from "./jobs";
import { canvasOwner, type CanvasRuntime } from "./runtime";
import {
	canvasFind,
	canvasProduce,
	canvasProduceV2,
} from "../../domains/capabilities/contracts";
import { canvasRequest } from "./input";

export const canvasAdapterRef = "adapter:canvas@1";
export const canvasWorkspaceQuery = "query:canvas.workspace@1";
const operation = "canvas.produce";
const currentOperation = "canvas.produce.v2";
const projection = "projection:canvas.receipt@1";
export const canvasDomainSchemas = {
	"domain:canvas.receipt@1": z.strictObject({
		jobId: z.string(),
		state: z.string(),
	}),
};
export const describeCanvasAdapter = () => ({
	owner: "canvas",
	availability: "availability:canvas@1",
	instant: true,
	operations: new Map([
		[
			operation,
			{ inputSchemaRef: "builtin:canvasProduce", effect: "write" as const },
		],
		[
			currentOperation,
			{ inputSchemaRef: "builtin:canvasProduceV2", effect: "write" as const },
		],
		[
			"canvas.find",
			{ inputSchemaRef: "builtin:canvasFind", effect: "read" as const },
		],
	]),
	inputAdapters: new Map(),
	queries: new Set([canvasWorkspaceQuery]),
	projections: new Set([projection]),
});

export function createCanvasAdapter(
	runtime: CanvasRuntime,
	jobs: CanvasJobs,
	conversation: ConversationService,
	sourceMessages: (db: Database, runId: string) => string[] = () => [],
): DomainAdapter {
	const receipt = (
		job: { id: string },
		id: string,
		replay: boolean,
	): AdapterResult => {
		// This is the acceptance receipt. The queue owns the evolving execution status.
		const value = { jobId: job.id, state: "accepted" };
		const text = JSON.stringify(value);
		return {
			receipt: value,
			receiptRef: { owner: "canvas", operationId: id, digest: sha256Hex(text) },
			resultRefs: [],
			replay,
			answerContext: { kind: "canvas", result: text, truncated: false },
		};
	};
	const resolveTarget = (scope: string, ref: string) => {
		try {
			return runtime.service.catalog.resolve(canvasOwner, scope, ref);
		} catch (error) {
			throw new Error(
				error instanceof ServiceError && error.extra.code === "conflict"
					? "canvas_revision_conflict"
					: "canvas_target_expired",
			);
		}
	};
	return {
		ref: canvasAdapterRef,
		describe: describeCanvasAdapter,
		availableInTransaction: runtime.ready,
		snapshotInTransaction: (_db, context) =>
			runtime.ready()
				? runtime.service.catalog.snapshot(
						canvasOwner,
						context?.conversationId ?? "",
					)
				: { artworks: [], hasMore: false, nextCursor: null },
		invokeInTransaction(db, req) {
			const { origin } = req;
			if (
				![operation, currentOperation].includes(req.operationName) ||
				(origin.kind !== "conversation" && origin.kind !== "task")
			)
				throw new Error("unsupported_operation");
			const legacy =
				req.operationName === operation ? canvasProduce.parse(req.input) : null;
			if (legacy?.artworkId) throw new Error("canvas_request_version_expired");
			if (origin.kind === "task" && origin.execution.modelCalls < 1)
				throw new Error("canvas_model_budget");
			const input = legacy
				? { request: undefined, targetRef: undefined }
				: canvasProduceV2.parse(req.input);
			const request = canvasRequest(
				db,
				conversation,
				origin,
				input.request,
				origin.kind === "conversation" ? sourceMessages(db, origin.runId) : [],
			);
			const previous = jobs.byRequest(db, req.requestId);
			const saved = previous
				? (JSON.parse(previous.payloadJson) as import("./input").CanvasJobInput)
				: null;
			if (saved && saved.targetRef !== input.targetRef)
				throw new Error("request_conflict");
			const target = saved
				? { artworkId: saved.artworkId, expectedBase: saved.expectedBase }
				: input.targetRef
					? resolveTarget(origin.conversationId, input.targetRef)
					: {};
			const accepted = jobs.submit(
				db,
				{
					...request,
					...target,
					targetRef: input.targetRef,
					modelCallLimit:
						origin.kind === "task"
							? Math.min(6, origin.execution.modelCalls)
							: 6,
				},
				req.requestId,
				origin.kind === "task" ? origin.execution.deadline : undefined,
			);
			return receipt(accepted.job, req.requestId, !accepted.fresh);
		},
		instant: {
			async run(name, input, signal, context) {
				if (
					name !== "canvas.find" ||
					!context?.conversationId ||
					!runtime.ready()
				)
					return { ok: false, code: "canvas_unavailable" };
				signal.throwIfAborted();
				try {
					const page = runtime.service.catalog.page(
						canvasOwner,
						context.conversationId,
						canvasFind.parse(input),
					);
					return {
						ok: true,
						answer: page.artworks.length
							? page.artworks
									.map((a) => `${a.title}（r${a.currentRevision}）`)
									.join("\n") +
								(page.hasMore
									? "\nほかにも作品があります。作品名で絞り込むか、Canvas画面で続きを開けます。"
									: "")
							: "条件に合うCanvas作品はありません。",
					};
				} catch {
					return { ok: false, code: "canvas_search_failed" };
				}
			},
		},
		readInTransaction(db, id) {
			const row = jobs.byRequest(db, id);
			return row ? receipt(row, id, true) : null;
		},
		sourceInTransaction(_db, query, target) {
			return query === canvasWorkspaceQuery &&
				target === undefined &&
				runtime.ready()
				? { revision: 1, data: { kind: "canvas-workspace" } }
				: null;
		},
		targetInput: () => ({}),
		afterCommit: jobs.wake,
		execution: {
			currentInTransaction(db, id) {
				const job = jobs.byRequest(db, id);
				const raw = job ? jobs.runOf(job.id) : null;
				const run = raw ? jobs.visibleRun(raw.id) : null;
				const state =
					job?.state === "completed"
						? run?.state === "presented"
							? "completed"
							: run?.state === "cancelled"
								? "cancelled"
								: "failed"
						: job?.state;
				return {
					state:
						state === "completed"
							? "completed"
							: state === "cancelled"
								? "cancelled"
								: state === "expired"
									? "expired"
									: state &&
										  [
												"queued",
												"running",
												"retry_wait",
												"cancel_requested",
										  ].includes(state)
										? "running"
										: "failed",
					ref: { operationId: id },
					summary:
						state === "completed"
							? "Canvasの観測を通過した候補を提示しました。"
							: "Canvasアプリの制作状況",
					output: job && { jobId: job.id, state, runId: run?.id ?? null },
					code:
						job?.errorCode ??
						(job?.state === "completed" &&
						raw?.state === "presented" &&
						run?.state === "failed"
							? "canvas_source_changed"
							: undefined),
					modelCalls: run?.modelCalls ?? run?.attempts ?? 0,
					references: [],
				};
			},
			cancelInTransaction(db, id) {
				jobs.cancelInTransaction(db, id);
			},
			stop: async (id) => jobs.flushCancellation(id),
			validateAnswerInTransaction: () => false,
		},
	};
}
