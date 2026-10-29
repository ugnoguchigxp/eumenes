import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AgentRuntime } from "../../domains/agent-runtime";
import { hash } from "../../domains/capabilities";
import {
	todoSourceQuery,
	type TodoPage,
	type TodoQuery,
} from "../../domains/agent-runtime/contracts";
import type { DomainAdapter } from "../../domains/tool-runtime";
export const TASK_ADAPTER_REF = "adapter:task-execution@1";
export const TASK_TODOS_QUERY = "query:agent-runtime.todos@1";
/** The TODO screen's archive of one TODO (the TODO completion notice design, section 3.4). */
export const TODOS_ARCHIVE = "todos.archive";
const archiveInput = z.object({ todoId: z.string().min(1).max(120) });
export const describeTaskAdapter = () => ({
	owner: "agent-runtime",
	operations: new Map([
		[
			TODOS_ARCHIVE,
			{
				inputSchemaRef: "schema:todo-screen-archive@1",
				effect: "write" as const,
			},
		],
	]),
	queries: new Set([TASK_TODOS_QUERY]),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:task-execution@1",
	task: true,
});

/** A ledger TODO as the page read returns it (the dialogue ledger owns the record). */
export type LedgerWorkRow = {
	id: string;
	request: string;
	status: "todo" | "waiting" | "done";
	outcome: TodoPage["rows"][number]["outcome"];
	question: string | null;
	result: unknown;
	execution: string;
	archivedAt: string | null;
	updatedAt: string;
};
/** Reads one page of a conversation's TODOs from the dialogue ledger, inside the caller's transaction. */
type TodoPageReader = (
	db: Database,
	conversationId: string,
	query: TodoQuery,
) => {
	rows: LedgerWorkRow[];
	total: number;
	pageIndex: number;
	counts: TodoPage["counts"];
};
/** The conversation's TODO ledger as the TODO screen uses it (the dialogue ledger owns every record). */
export type TodoLedgerPort = {
	todoPageInTransaction: TodoPageReader;
	/** The user archived a TODO: work still going is stopped; the jobs it stopped are flushed after commit. */
	archiveTodoInTransaction(
		db: Database,
		todoId: string,
	): {
		row: { id: string; revision: number; archivedAt: string | null };
		jobs: string[];
	};
	flushTodoCancellations(jobs: readonly string[]): void;
};

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
/** What the screen says of a TODO's result: the open question, or the result's own summary, in full; never its body. */
function summaryOf(row: LedgerWorkRow): string | null {
	if (row.status === "waiting")
		return row.question ? oneLine(row.question) : null;
	const summary = (row.result as { summary?: unknown } | null)?.summary;
	return typeof summary === "string" && summary.trim()
		? oneLine(summary)
		: null;
}

/**
 * Registry entry of task executions (the agent-runtime owns every transition and persisted record) and of the TODO
 * screen: its page reads and its archive go to the dialogue ledger.
 */
export function createTaskAdapter(
	runtime: () => AgentRuntime | undefined,
	todos: () => TodoLedgerPort | undefined = () => undefined,
): DomainAdapter {
	// The jobs the last archive stopped: aborted once its transaction commits.
	let stopped: string[] = [];
	return {
		ref: TASK_ADAPTER_REF,
		describe: describeTaskAdapter,
		task: {
			startInTransaction: (db, input) => {
				const agent = runtime();
				if (!agent) throw new Error("execution_unavailable");
				return agent.executions.startInTransaction(db, input);
			},
			controlInTransaction: (db, conversationId, input, messageId) => {
				const agent = runtime();
				if (!agent) throw new Error("execution_unavailable");
				return agent.executions.controlInTransaction(
					db,
					conversationId,
					input,
					messageId,
				);
			},
			viewInTransaction: (db, id) =>
				runtime()?.executions.viewInTransaction(db, id) ?? null,
		},
		availableInTransaction: (db) =>
			runtime()?.executions.availableInTransaction(db) ?? false,
		artifactAvailableInTransaction: () => runtime() !== undefined,
		snapshotInTransaction: () => null,
		invokeInTransaction(tx, request) {
			// What a rolled-back archive stopped is not carried to the next commit (the flush re-reads each job anyway).
			stopped = [];
			// The archive is the user's act on the screen; nothing else may archive a TODO through here.
			if (
				request.operationName !== TODOS_ARCHIVE ||
				request.origin.kind !== "ui"
			)
				throw new Error("task_lifecycle_required");
			const input = archiveInput.safeParse(request.input);
			const ledger = todos();
			if (!input.success) throw new Error("invalid_input");
			if (!ledger) throw new Error("work_unavailable");
			const { row, jobs } = ledger.archiveTodoInTransaction(
				tx,
				input.data.todoId,
			);
			stopped = jobs;
			const receipt = {
				todoId: row.id,
				revision: row.revision,
				archivedAt: row.archivedAt,
			};
			return {
				receipt,
				receiptRef: {
					owner: "dialogue",
					operationId: request.requestId,
					digest: hash(receipt),
				},
				resultRefs: [
					{
						owner: "dialogue",
						kind: "todo",
						id: row.id,
						schemaRef: "domain:dialogue.todo@1",
						revision: row.revision,
					},
				],
				replay: false,
			};
		},
		afterCommit() {
			const jobs = stopped;
			stopped = [];
			todos()?.flushTodoCancellations(jobs);
		},
		readInTransaction: () => null,
		sourceInTransaction(tx, query, targetRef, params) {
			if (query !== TASK_TODOS_QUERY || targetRef !== undefined) return null;
			const input = todoSourceQuery.safeParse(params);
			const read = todos()?.todoPageInTransaction;
			if (!input.success || !read) return null;
			const { conversationId, ...page } = input.data;
			const data = read(tx, conversationId, page);
			const rows = data.rows.map((row) => ({
				id: row.id,
				request: oneLine(row.request),
				status: row.status,
				outcome: row.outcome,
				summary: summaryOf(row),
				pipeline: row.execution === "pipeline",
				archived: row.archivedAt !== null,
				updatedAt: row.updatedAt,
			}));
			return {
				revision: Math.max(
					0,
					...data.rows.flatMap((row) => [
						Date.parse(row.updatedAt) || 0,
						row.archivedAt ? Date.parse(row.archivedAt) || 0 : 0,
					]),
				),
				data: {
					rows,
					counts: data.counts,
					total: data.total,
					state: page.state,
					pageIndex: data.pageIndex,
					pageSize: page.pageSize,
				} satisfies TodoPage,
			};
		},
		targetInput: () => ({}),
	};
}
