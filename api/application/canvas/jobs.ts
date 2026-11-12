import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { QueueService } from "../../domains/queue";
import type { ConversationService } from "../../domains/conversation";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { CanvasRuntime } from "./runtime";
import { canvasOwner } from "./runtime";

export const canvasJobKind = "canvas.produce";
const payload = z.strictObject({
	conversationId: z.string().min(1).max(128),
	message: z.string().trim().min(1).max(4000),
	artworkId: z
		.string()
		.regex(/^a_[A-Za-z0-9_-]{12}$/)
		.optional(),
});

export function createCanvasJobs(
	queue: QueueService,
	runtime: CanvasRuntime,
	store: SqliteStore,
	conversation: Pick<
		ConversationService,
		"messageInTransaction" | "appendInTransaction"
	>,
) {
	queue.registerHandler({
		kind: canvasJobKind,
		payloadVersions: [1],
		schema: payload,
		recovery: "interrupt",
		prepareInTransaction: (_db, claim) => ({
			status: "ready",
			input: claim.payload,
		}),
		async execute(input, { signal }) {
			signal.throwIfAborted();
			const service = runtime.service;
			const session = createHash("sha256")
				.update(input.conversationId)
				.digest("base64url");
			const run = await service.startRun(canvasOwner, session, input);
			const cancel = () => service.cancelRun(canvasOwner, run.id);
			let cancelled: ReturnType<typeof cancel> | undefined;
			const abort = () => {
				cancelled = cancel();
				void cancelled.catch(() => {});
			};
			signal.addEventListener("abort", abort, { once: true });
			try {
				if (signal.aborted) abort();
				await service.inflight.get(run.id);
				await cancelled;
				signal.throwIfAborted();
				const result = service.getRun(canvasOwner, run.id);
				if (result.state !== "presented" || !result.presentedCandidateId)
					throw new Error("canvas_generation_failed");
				return run.id;
			} finally {
				signal.removeEventListener("abort", abort);
			}
		},
		settleInTransaction(db, claim, _input, outcome) {
			if (outcome.type !== "success" && outcome.type !== "failed")
				return "applied";
			if (outcome.type === "success") outcome.resultRef = outcome.result;
			const id = `canvas-notice:${claim.jobId}`;
			if (!conversation.messageInTransaction(db, id)) {
				conversation.appendInTransaction(db, {
					id,
					conversationId: claim.payload.conversationId,
					role: "assistant",
					text:
						outcome.type === "success"
							? "Canvasアプリの候補を用意しました。アーティファクトで操作できます。"
							: "Canvasアプリの制作を完了できませんでした。アーティファクトで状態を確認できます。",
					createdAt: new Date().toISOString(),
					runId: null,
				});
			}
			return "applied";
		},
		cancelInTransaction() {},
	});
	function job(id: string) {
		const row = queue.get(id);
		return row?.kind === canvasJobKind ? row : null;
	}
	return {
		submit(
			db: Database,
			input: z.infer<typeof payload>,
			requestId: string,
			deadline?: number,
		) {
			return queue.enqueueInTransaction(db, {
				kind: canvasJobKind,
				scope: "canvas",
				lane: "interactive",
				dedupeKey: requestId,
				payload: input,
				subjectRef: input.conversationId,
				deadlineAtMs: deadline ?? Date.now() + 180_000,
				maxAttempts: 1,
			});
		},
		byRequest: (db: Database, id: string) =>
			queue.findByDedupeInTransaction(db, "canvas", canvasJobKind, id),
		latest(conversationId: string) {
			const item = queue.list(
				{ scope: "canvas", kind: canvasJobKind, subjectRef: conversationId },
				null,
				1,
			).items[0];
			return item ? job(item.id) : null;
		},
		job,
		cancelInTransaction(db: Database, requestId: string) {
			const row = queue.findByDedupeInTransaction(
				db,
				"canvas",
				canvasJobKind,
				requestId,
			);
			if (row) queue.cancelInTransaction(db, row.id, "cancel_requested");
		},
		flushCancellation(requestId: string) {
			const row = store.read((db) =>
				queue.findByDedupeInTransaction(db, "canvas", canvasJobKind, requestId),
			);
			if (!row) return false;
			queue.flushCancellations([row.id]);
			return row.state === "cancelled";
		},
		cancel: (id: string) => (job(id) ? queue.cancel(id) : null),
		wake: () => queue.wake(),
	};
}
export type CanvasJobs = ReturnType<typeof createCanvasJobs>;
