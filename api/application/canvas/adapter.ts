import { z } from "zod";
import { sha256Hex } from "../../infrastructure/digest";
import type { ConversationService } from "../../domains/conversation";
import type { AdapterResult, DomainAdapter } from "../../domains/tool-runtime";
import type { CanvasJobs } from "./jobs";
import { canvasOwner, type CanvasRuntime } from "./runtime";
import { canvasProduce } from "../../domains/capabilities/contracts";

export const canvasAdapterRef = "adapter:canvas@1";
export const canvasWorkspaceQuery = "query:canvas.workspace@1";
const operation = "canvas.produce";
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
	operations: new Map([
		[
			operation,
			{ inputSchemaRef: "builtin:canvasProduce", effect: "write" as const },
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
	return {
		ref: canvasAdapterRef,
		describe: describeCanvasAdapter,
		availableInTransaction: runtime.ready,
		snapshotInTransaction: () => ({
			artworks: runtime.ready()
				? runtime.service
						.listArtworks(canvasOwner)
						.slice(0, 25)
						.map(({ id, title, currentRevision }) => ({
							artworkId: id,
							title,
							currentRevision,
						}))
				: [],
		}),
		invokeInTransaction(db, req) {
			const { origin } = req;
			if (
				req.operationName !== operation ||
				(origin.kind !== "conversation" && origin.kind !== "task")
			)
				throw new Error("unsupported_operation");
			const source = origin.messageId
				? conversation.messageInTransaction(db, origin.messageId)?.message
				: null;
			if (
				!source ||
				source.role !== "user" ||
				source.conversationId !== origin.conversationId
			)
				throw new Error("execution_source_invalid");
			const { artworkId } = canvasProduce.parse(req.input);
			if (artworkId) runtime.service.getArtwork(canvasOwner, artworkId);
			const accepted = jobs.submit(
				db,
				{
					conversationId: origin.conversationId,
					message: source.text,
					artworkId,
				},
				req.requestId,
				origin.kind === "task" ? origin.execution.deadline : undefined,
			);
			return receipt(accepted.job, req.requestId, !accepted.fresh);
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
				const run =
					job?.state === "completed" && job.resultRef && runtime.ready()
						? runtime.service.getRun(canvasOwner, job.resultRef)
						: null;
				const state =
					run?.state === "presented"
						? "completed"
						: run?.state === "cancelled"
							? "cancelled"
							: job?.state === "completed"
								? "failed"
								: job?.state;
				return {
					state:
						state === "completed"
							? "completed"
							: state === "cancelled"
								? "cancelled"
								: state === "expired"
									? "expired"
									: state === "queued" || state === "running"
										? "running"
										: "failed",
					ref: { operationId: id },
					summary:
						state === "completed"
							? "Canvasの観測を通過した候補を提示しました。"
							: "Canvasアプリの制作状況",
					output: job && { jobId: job.id, state, runId: job.resultRef },
					code: job?.errorCode ?? undefined,
					modelCalls: run?.attempts ?? 0,
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
