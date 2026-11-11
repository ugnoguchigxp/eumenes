import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { Capabilities } from "../../capabilities";
import type { InferencePort } from "../../inference";
import type { QueueService } from "../../queue";
import type {
	ResearchDocumentPort,
	ResearchWebPort,
	SourcePort,
} from "../contracts";
import { active, rowOf, stateOf, type RunRow } from "../repository";

export type PursuitDeps = {
	store: SqliteStore;
	queue: QueueService;
	capabilities: Capabilities;
	inference: InferencePort;
	web: ResearchWebPort;
	documents?: ResearchDocumentPort;
	now?: () => number;
	id?: () => string;
};
export type Context = PursuitDeps & {
	now: () => number;
	id: () => string;
	source: () => SourcePort;
	abortJobs: Set<string>;
	abortRequests: Set<string>;
	enqueue(db: Database, row: RunRow, receiptOnly?: boolean): void;
	forget(db: Database, id: string): void;
	notice(db: Database, row: RunRow): void;
};
/** Every model/operation boundary checks host authority; the model cannot renew it. */
export function current(
	ctx: Context,
	db: Database,
	id: string,
	epoch?: number,
	terminal = false,
): RunRow {
	const row = rowOf(db, id);
	if (
		!row?.data_json ||
		(epoch !== undefined && row.epoch !== epoch) ||
		(!terminal && !active(row))
	)
		throw new Error("pursuit_run_stale");
	const state = stateOf(row);
	if (
		!ctx.source().validSourceInTransaction(db, state.source) ||
		state.references.some(
			(ref) => !ctx.source().validReferenceInTransaction(db, state.source, ref),
		)
	)
		throw new Error("pursuit_source_invalid");
	ctx.capabilities.validateInTransaction(db, state.prepared);
	if (
		ctx.capabilities.toolchainBindingInTransaction(
			db,
			state.toolchainRevisionId,
		)?.binding.revisionId !== state.bindingRevisionId
	)
		throw new Error("pursuit_capability_revoked");
	if (!terminal && row.deadline <= ctx.now())
		throw new Error("pursuit_deadline_exceeded");
	return row;
}
