import type { Database } from "bun:sqlite";
import type { BrowserService } from "../../domains/browser";
import type {
	ChildCaller,
	ChildOperationPort,
	Source,
	ToolResult,
} from "../../domains/tool-runtime";
import { hash } from "../../domains/capabilities";

/** Composes existing domain tasks with the shared invocation ledger, without another lifecycle. */
export function createChildOperations(
	browser: BrowserService,
	valid: (db: Database, caller: ChildCaller) => boolean,
	budget?: (
		db: Database,
		caller: ChildCaller,
		reservationId: string,
	) => number | undefined,
): ChildOperationPort {
	const prefix = "browser-child:";
	browser.setChildAuthority((db, caller) => valid(db, caller as ChildCaller));
	return {
		startInTransaction(db, input) {
			const allocation = budget?.(db, input.caller, input.requestId);
			const task = browser.startTaskInTransaction(db, {
				owner:
					input.caller.kind === "research"
						? input.caller.owner.taskId
						: input.caller.child.executionId,
				conversationId:
					input.caller.kind === "research"
						? input.caller.source.conversationId
						: input.caller.child.source.conversationId,
				origin: "child",
				requestId: input.requestId,
				request:
					input.caller.kind === "research"
						? input.caller.source.request
						: input.caller.child.source.request,
				url: input.url,
				deadline: Math.min(input.deadline - 150000, Date.now() + 90000),
				frozen: {
					packageRevisionId: "package:browser.service-search@6",
					brief: input.request,
					caller: input.caller,
					modelStepMs: 30000,
					maxModelCalls: allocation ?? 12,
				},
			});
			return { operationId: prefix + task.taskId, jobId: task.jobId };
		},
		get(id) {
			if (!id.startsWith(prefix)) return null;
			const task = browser.taskRow(id.slice(prefix.length));
			if (!task || task.origin !== "child") return null;
			if (["queued", "running"].includes(task.state))
				return { state: "pending", continuing: true };
			const pages = browser.researchPages(task.id);
			if (
				["cancelled", "indeterminate"].includes(task.state) ||
				(task.state === "expired" && !pages.length)
			)
				return {
					state: task.state === "cancelled" ? "cancelled" : "failed",
					errorCode:
						task.error_code ??
						(task.state === "needs_input"
							? "browser_input_required"
							: "browser_task_failed"),
				};
			const readings: Source[] = pages.flatMap<Source>((page) =>
				page.purpose === "facts"
					? [
							{
								sourceId: page.collectionRef,
								viewId: page.collectionRef,
								viewDigest: hash(page.text),
								kind: "web_source" as const,
								url: page.url,
								title: page.title,
								body: page.text,
								basis: "page" as const,
								fetchedAt: page.fetchedAt,
								truncated: true,
								security: { decision: "source_content", reasonCodes: [] },
							},
						]
					: page.links.map((link, i) => ({
							sourceId: link.reference,
							viewId: link.reference,
							viewDigest: hash(link.text),
							kind: "web_source" as const,
							url: link.url,
							title: link.title,
							body: link.text,
							basis: "snippet" as const,
							fetchedAt: page.fetchedAt,
							truncated: true,
							source: { provider: "browser", query: "", rank: i + 1 },
							security: { decision: "source_content", reasonCodes: [] },
						})),
			);
			const result: ToolResult = {
				observedAt: new Date(task.updated_at).toISOString(),
				readings,
				notes: {
					route: "browser",
					phase: task.phase,
					summary: task.result_text?.slice(0, 1000),
					collected: pages.length,
				},
				hits: [],
				documents: [],
				failures:
					task.state === "completed"
						? []
						: [
								{
									url: task.start_url ?? "",
									code: task.error_code ?? "browser_input_required",
								},
							],
			};
			if (new TextEncoder().encode(JSON.stringify(result)).length > 24576)
				return { state: "failed", errorCode: "collection_capacity" };
			return {
				state: task.state === "completed" ? "succeeded" : "partial",
				result,
			};
		},
		cancelInTransaction(db, id) {
			const row = browser.taskRow(id.slice(prefix.length));
			if (row) {
				browser.cancelTaskInTransaction(db, row.owner, row.id);
				void Promise.resolve().then(() => browser.abortTask(row.id));
			}
			return [];
		},
	};
}
