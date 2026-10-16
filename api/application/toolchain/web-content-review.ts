import type { SqliteStore } from "../../infrastructure/sqlite";
import type { InferenceService } from "../../domains/inference";
import {
	createWebContentReview,
	contentReviewSchema,
} from "../../domains/web-research";

/** One isolated control call: the fetched document is data, with no dialogue history or execution tools. */
export function createWebReview(
	store: SqliteStore,
	inference: InferenceService,
) {
	return createWebContentReview(async (messages, signal) => {
		const taskId = `web-guard-${crypto.randomUUID()}`;
		const deadline = Date.now() + 30_000;
		signal.throwIfAborted();
		const requestId = await store.write((db) => {
			signal.throwIfAborted();
			const resourceId =
				inference.snapshotInTransaction(db).subagent.resourceId;
			return inference.captureBackgroundControlInTransaction(db, {
				taskId,
				decisionId: "review",
				authorityEpoch: 1,
				executionGeneration: 1,
				deadline,
				taskDeadline: deadline,
				maxOutputTokens: 1024,
				route: resourceId ? { resourceId } : "conversation",
				structuredOutput: true,
			});
		});
		try {
			const receipt = await inference.executeControl(
				requestId,
				messages,
				signal,
				{
					instructions: messages[0]!.content,
					outputSchema: contentReviewSchema,
					reasoningEffort: "low",
				},
				{ sessionRole: "auxiliary" },
			);
			signal.throwIfAborted();
			if (typeof receipt.value !== "string")
				throw new Error("web_review_invalid_output");
			const accepted = await store.write(
				(db) => !signal.aborted && inference.acceptInTransaction(db, receipt),
			);
			if (!accepted) throw new Error("web_review_stale");
			return receipt.value;
		} finally {
			await inference.cancelSubject(`background:${taskId}:review`);
		}
	});
}
