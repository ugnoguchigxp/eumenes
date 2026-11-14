import type { Capabilities } from "../../domains/capabilities";
import type { ReviewPort } from "../../domains/collaboration";
import type { InferencePort } from "../../domains/inference";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { createReviewSubagent } from "./subagent";

export function workflowReviewer(
	store: SqliteStore,
	inference: InferencePort,
	capabilities: Capabilities,
): ReviewPort["evaluate"] | undefined {
	const evaluate = createReviewSubagent(store, inference, capabilities);
	if (!evaluate) return undefined;
	return (input, deadline, signal, current) =>
		evaluate(
			{
				skill: "skill:review.workflow@1",
				target: { id: input.workRef, version: String(input.revision) },
				originalRequest: input.source.request,
				request: input.request,
				conditions: input.conditions,
				evidence: [{ id: "workflow", document: input.document }],
				sourceMessageIds: [
					...new Set([
						input.source.messageId,
						input.requestMessageId,
						...(input.conditions.state === "available"
							? input.conditions.entries.flatMap(({ sources }) =>
									sources.map(({ id }) => id),
								)
							: []),
					]),
				],
			},
			deadline,
			signal,
			current,
		);
}
