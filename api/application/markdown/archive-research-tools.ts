import { z } from "zod";
import type { QueueService } from "../../domains/queue";
import type { MarkdownService } from "../../domains/markdown";
import type {
	SourceMetadata,
	ToolAdapter,
	ToolResult,
} from "../../domains/tool-runtime";
import { validators } from "../../domains/capabilities";

const kind = "markdown.archive-research";
const prefix = "archive-research:";
const common = {
	taskId: z.string(),
	owner: z.string(),
	binding: z.string(),
	deadline: z.number(),
};
const payload = z.discriminatedUnion("operation", [
	z.strictObject({
		...common,
		operation: z.literal("search"),
		terms: validators.archiveSearch.shape.terms,
		cursor: z.string().optional(),
	}),
	z.strictObject({
		...common,
		operation: z.literal("read"),
		sourceId: z.string(),
		revision: z.string(),
		offset: validators.archiveRead.shape.offset,
	}),
]);
type Job = z.infer<typeof payload>;
type Grant = Pick<Job, "taskId" | "owner" | "binding" | "deadline"> &
	(
		| { kind: "document"; sourceId: string; revision: string }
		| { kind: "page"; cursor: string }
	);

/** Jobs run outside the writer. References and unadopted readings live only for the owning worker. */
export function createArchiveResearchTools(
	queue: QueueService,
	archive: MarkdownService["research"],
) {
	const grants = new Map<string, Grant>();
	const results = new Map<
		string,
		{ taskId: string; deadline: number; result: ToolResult }
	>();
	const prune = () => {
		const at = Date.now();
		for (const [ref, value] of grants)
			if (value.deadline <= at) grants.delete(ref);
		for (const [ref, value] of results)
			if (value.deadline <= at) results.delete(ref);
	};
	const issue = (grant: Grant) => {
		const id = crypto.randomUUID();
		grants.set(id, grant);
		return id;
	};
	queue.registerHandler<Job, Job, ToolResult>({
		kind,
		payloadVersions: [1],
		schema: payload,
		recovery: "interrupt",
		prepareInTransaction: (_db, claim) => ({
			status: "ready",
			input: claim.payload,
		}),
		async execute(input, { signal }) {
			const observed = { hits: [], documents: [], failures: [] };
			if (input.operation === "search") {
				const page = await archive.search(
					input.binding,
					input.terms,
					input.cursor,
					signal,
				);
				prune();
				if (grants.size + page.items.length + 1 > 1024)
					throw new Error("result_capacity");
				const grant = {
					taskId: input.taskId,
					owner: input.owner,
					deadline: input.deadline,
					binding: input.binding,
				};
				return {
					...observed,
					observedAt: new Date().toISOString(),
					notes: {
						matches: page.items.map(
							({ title, sourceId, revision, namespace, path }) => ({
								title: title.slice(0, 65),
								namespace: namespace.slice(0, 30),
								path: path.slice(0, 65),
								documentRef: issue({
									...grant,
									kind: "document",
									sourceId,
									revision,
								}),
							}),
						),
						scanned: page.scanned,
						omitted: page.omitted,
						nextPageRef: page.nextCursor
							? issue({ ...grant, kind: "page", cursor: page.nextCursor })
							: null,
					},
				};
			}
			const section = await archive.read(input, signal);
			const fetchedAt = new Date().toISOString();
			return {
				...observed,
				observedAt: fetchedAt,
				notes: { nextOffset: section.nextOffset },
				readings: section.body.trim()
					? [
							{
								kind: "archive_document",
								basis: "archive",
								sourceId: crypto.randomUUID(),
								viewId: crypto.randomUUID(),
								title: section.title,
								fetchedAt,
								truncated: section.start !== 0 || section.nextOffset !== null,
								body: section.body,
								start: section.start,
								end: section.end,
								archive: {
									binding: input.binding,
									documentId: input.sourceId,
									revision: input.revision,
								},
							},
						]
					: [],
			};
		},
		settleInTransaction(_db, claim, input, outcome) {
			if (outcome.type !== "success" || !input) return "applied";
			if (archive.binding() !== input.binding)
				return {
					status: "failed",
					errorCode: "markdown_archive_binding_changed",
				};
			prune();
			if (results.size >= 64)
				return { status: "failed", errorCode: "result_capacity" };
			results.set(claim.jobId, {
				taskId: input.taskId,
				deadline: input.deadline,
				result: outcome.result,
			});
			return "applied";
		},
		cancelInTransaction(_db, job) {
			results.delete(job.jobId);
		},
	});
	return {
		startInTransaction(db, request) {
			prune();
			const binding = archive.binding();
			if (!binding) throw new Error("markdown_archive_unavailable");
			const owner = JSON.stringify([
				request.owner.rootRunId,
				request.owner.taskId,
				request.owner.cancelEpoch,
			]);
			const shared = {
				taskId: request.owner.taskId,
				owner,
				binding,
				deadline: request.deadline,
			};
			const issued = (ref: string) => {
				const grant = grants.get(ref);
				if (!grant || grant.owner !== owner || grant.binding !== binding)
					throw new Error("archive_reference_invalid");
				return grant;
			};
			let input: Job;
			if (request.tool.id === "archive.search") {
				const args = validators.archiveSearch.parse(request.arguments);
				const page = args.pageRef ? issued(args.pageRef) : undefined;
				if (page && page.kind !== "page")
					throw new Error("archive_reference_invalid");
				input = {
					...shared,
					operation: "search",
					terms: args.terms,
					cursor: page?.cursor,
				};
			} else {
				const args = validators.archiveRead.parse(request.arguments);
				const document = issued(args.documentRef);
				if (document.kind !== "document")
					throw new Error("archive_reference_invalid");
				input = {
					...shared,
					operation: "read",
					sourceId: document.sourceId,
					revision: document.revision,
					offset: args.offset,
				};
			}
			const { job } = queue.enqueueInTransaction(db, {
				scope: "markdown",
				kind,
				dedupeKey: request.invocationId,
				payload: input,
				parentJobId: request.parentJobId,
				lane: "background",
				deadlineAtMs: request.deadline,
			});
			return { operationId: prefix + job.id, jobId: job.id };
		},
		get(id) {
			prune();
			const entry = results.get(id.slice(prefix.length));
			return entry
				? { state: "succeeded", result: entry.result }
				: { state: "pending" };
		},
		cancelInTransaction(db, id) {
			const jobId = id.slice(prefix.length);
			return queue.cancelInTransaction(db, jobId, "cancel_requested")
				?.wasRunning
				? [jobId]
				: [];
		},
		releaseTask(id) {
			for (const [ref, grant] of grants)
				if (grant.taskId === id) grants.delete(ref);
			for (const [ref, entry] of results)
				if (entry.taskId === id) results.delete(ref);
		},
		validate(sources: readonly SourceMetadata[]) {
			return sources.every(
				(source) =>
					!!source.archive && archive.binding() === source.archive.binding,
			);
		},
	} satisfies Pick<
		ToolAdapter,
		"startInTransaction" | "get" | "cancelInTransaction" | "releaseTask"
	> & { validate(sources: readonly SourceMetadata[]): boolean };
}

export const isArchiveResearchOperation = (id: string) => id.startsWith(prefix);
