import type { Database } from "bun:sqlite";
import type { Owner, FixedDefinition } from "../../capabilities";
export type ToolResult = {
	observedAt: string;
	hits: Array<{ url: string; title: string; snippet: string }>;
	documents: Array<{
		url: string;
		title: string;
		text: string;
		fetchedAt: string;
		truncated: boolean;
	}>;
	failures: Array<{ url: string; code: string }>;
};
export type Source = {
	sourceId: string;
	url: string;
	title: string;
	basis: "page" | "snippet";
	fetchedAt: string;
	truncated: boolean;
	body: string;
};
export type SourceMetadata = Omit<Source, "body">;
export type AdapterOperation = {
	state:
		| "pending"
		| "succeeded"
		| "partial"
		| "failed"
		| "cancelled"
		| "interrupted";
	result?: ToolResult;
	errorCode?: string;
};
export interface ToolAdapter {
	startInTransaction(
		tx: Database,
		request: {
			requestId: string;
			tool: FixedDefinition;
			arguments: unknown;
			owner: Owner;
			deadline: number;
			parentJobId: string;
			question?: string;
		},
	): { operationId: string; jobId: string };
	get(operationId: string): AdapterOperation | null;
	cancelInTransaction(tx: Database, operationId: string): string[];
}
export type Invocation = {
	id: string;
	owner_task_id: string;
	root_run_id: string;
	tool_revision_id: string;
	step_id: string;
	args_digest: string;
	operation_id: string;
	job_id: string;
	state: string;
	result_ref: string | null;
	result_digest: string | null;
	error_code: string | null;
	deadline: number;
};
