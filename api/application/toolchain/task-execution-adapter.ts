import type { Database } from "bun:sqlite";
import type { AgentRuntime } from "../../domains/agent-runtime";
import {
	todoSourceQuery,
	type TodoPage,
	type TodoQuery,
} from "../../domains/agent-runtime/contracts";
import type { DomainAdapter } from "../../domains/tool-runtime";
export const TASK_ADAPTER_REF = "adapter:task-execution@1";
export const TASK_TODOS_QUERY = "query:agent-runtime.todos@1";
export const describeTaskAdapter = () => ({
	owner: "agent-runtime",
	operations: new Map(),
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
export type TodoPageReader = (
	db: Database,
	conversationId: string,
	query: TodoQuery,
) => {
	rows: LedgerWorkRow[];
	total: number;
	pageIndex: number;
	counts: TodoPage["counts"];
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

/** Registry entry only; the agent-runtime owns every transition and persisted record. */
export function createTaskAdapter(
	runtime: () => AgentRuntime | undefined,
	todoPage: () => TodoPageReader | undefined = () => undefined,
): DomainAdapter {
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
		invokeInTransaction() {
			throw new Error("task_lifecycle_required");
		},
		readInTransaction: () => null,
		sourceInTransaction(tx, query, targetRef, params) {
			if (query !== TASK_TODOS_QUERY || targetRef !== undefined) return null;
			const input = todoSourceQuery.safeParse(params);
			const read = todoPage();
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
