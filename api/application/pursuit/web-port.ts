import type { ResearchWebPort } from "../../domains/pursuit";
import type { WebResearchService } from "../../domains/web-research";
import type { QueueService } from "../../domains/queue";

/** Reuse the guarded Web acquisition owner, queue and saved bodies; no second network client. */
export function createPursuitWebPort(
	web: WebResearchService,
	queue: QueueService,
): ResearchWebPort {
	const stopped = new Set<string>();
	return {
		startInTransaction(db, input) {
			const submitted = web.submitInTransaction(
				db,
				{
					...input.arguments,
					requestId: input.requestId,
					operation: input.kind,
					...(input.kind === "lookup"
						? { freshness: "live", readPages: 0 }
						: { retention: "none" }),
				},
				{
					deadlineAtMs: input.deadline,
					acquisitionTimeoutMs: input.timeoutMs,
					parentJobId: input.parentJobId,
					lane: "background",
				},
			);
			return { id: submitted.runId, jobId: submitted.jobId };
		},
		current(id) {
			const run = web.get(id);
			if (run && ["queued", "running"].includes(run.status))
				return { state: "waiting", hits: [], documents: [], failures: [] };
			if (!run?.result)
				return {
					state: "failed",
					code:
						run?.errorCode ??
						(run?.resultExpired ? "web_result_expired" : "web_result_missing"),
					hits: [],
					documents: [],
					failures: [],
				};
			return {
				state: "finished",
				hits: run.result.hits,
				documents: run.result.documents
					.filter(
						(d) =>
							d.verification === "source_read" &&
							["allow", "allow_with_warning"].includes(d.guardDecision),
					)
					.map((d) => ({
						...d,
						text: web.savedBodies.deliveryText(id, d.url) ?? d.text,
					})),
				failures: run.result.failures,
			};
		},
		cancelInTransaction(db, id) {
			for (const job of web.cancelInTransaction(db, id, "pursuit_stopped"))
				stopped.add(job);
		},
		forgetInTransaction(db, id) {
			for (const job of web.forgetInTransaction(db, id)) stopped.add(job);
		},
		flush() {
			queue.flushCancellations([...stopped]);
			stopped.clear();
			web.flushForgotten();
			queue.wake();
		},
	};
}
