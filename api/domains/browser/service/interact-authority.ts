import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
	getRun,
	isTerminalRunStatus,
	listOperations,
	settleOperation,
	transitionRun,
} from "eumenes-interact/sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { QueueService } from "../../queue";
import type { InteractMemory } from "../contracts/interact";
import { interactMeta } from "../repository/interact";
import { endTaskApprovals } from "../repository/approvals";

export const interactHash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const interactIso = (at: number) => new Date(at).toISOString();

/** The saved run is authoritative; a queue claim and its generation are capabilities, not model input. */
export function interactAuthority(deps: {
	store: SqliteStore;
	queue: QueueService;
	now: () => number;
	memory: Map<string, InteractMemory>;
	validSource?: (db: Database, source: unknown) => boolean;
}) {
	function owned(
		db: Database,
		owner: string,
		conversationId: string,
		runId: string,
	) {
		const meta = interactMeta(db, runId);
		const run = getRun(db, owner, runId);
		if (
			!meta ||
			!run ||
			meta.owner !== owner ||
			meta.conversation_id !== conversationId
		)
			throw new Error("browser_interact_not_found");
		return { meta, run };
	}
	function current(
		db: Database,
		runId: string,
		generation: number,
		jobId: string,
		jobGeneration: number,
	) {
		const meta = interactMeta(db, runId);
		if (!meta || meta.generation !== generation || meta.job_id !== jobId)
			return false;
		const run = getRun(db, meta.owner, runId);
		const job = deps.queue.getInTransaction(db, jobId);
		const mem = deps.memory.get(runId);
		return !!(
			run?.status === "running" &&
			run.deadlineAt &&
			Date.parse(run.deadlineAt) > deps.now() &&
			job?.state === "running" &&
			job.generation === jobGeneration &&
			job.cancelRequestedAtMs === null &&
			job.leaseUntilMs !== null &&
			job.leaseUntilMs > deps.now() &&
			mem &&
			!mem.controller.signal.aborted &&
			(mem.source === undefined || deps.validSource?.(db, mem.source))
		);
	}
	function end(
		db: Database,
		runId: string,
		status:
			| "completed"
			| "partial"
			| "failed"
			| "cancelled"
			| "expired"
			| "indeterminate",
		code: string,
	) {
		const meta = interactMeta(db, runId);
		if (!meta) return;
		const run = getRun(db, meta.owner, runId)!;
		if (isTerminalRunStatus(run.status)) return;
		const operations = listOperations(db, meta.owner, runId);
		const sent = operations.filter((o) => o.status === "dispatched");
		for (const op of sent)
			settleOperation(db, meta.owner, op.operationId, {
				status: "indeterminate",
				retryable: false,
				code: "operation_outcome_unknown",
				nowIso: interactIso(deps.now()),
			});
		if (
			(sent.length || operations.some((o) => o.status === "indeterminate")) &&
			status !== "cancelled" &&
			status !== "expired"
		)
			status = "indeterminate";
		transitionRun(db, meta.owner, runId, status, {
			reason: code,
			nowIso: interactIso(deps.now()),
		});
		db.query(
			"UPDATE browser_interact_runs SET generation=generation+1, revision=revision+1, question_id=NULL, question_kind=NULL, question_deadline=NULL, approval_id=NULL, approval_observation=NULL WHERE run_id=?",
		).run(runId);
		endTaskApprovals(db, runId, deps.now());
	}
	return { owned, current, end };
}
export type InteractAuthority = ReturnType<typeof interactAuthority>;
