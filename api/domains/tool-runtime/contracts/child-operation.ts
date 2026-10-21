import type { Database } from "bun:sqlite";
import type { Owner } from "../../capabilities";
import type { AdapterOperation } from "./index";

/** Real caller identities. Research does not impersonate a task-execution row. */
export type ChildCaller =
	| {
			kind: "research";
			owner: Owner;
			invocationId: string;
			source: import("./task-execution").ExecutionSource;
	  }
	| { kind: "execution"; child: import("./task-execution").ChildExecution };
export interface ChildOperationPort {
	startInTransaction(
		db: Database,
		input: {
			caller: ChildCaller;
			requestId: string;
			request: string;
			url?: string;
			deadline: number;
			parentJobId: string;
		},
	): { operationId: string; jobId: string };
	get(id: string): AdapterOperation | null;
	cancelInTransaction(db: Database, id: string): string[];
}
