import type { Database } from "bun:sqlite";
import { toErrorCode } from "../../../infrastructure/error-code";
import { getLogger } from "../../../infrastructure/logger";
import type { QueueService } from "../../queue";
import type { DialogueDeps } from "./context";

const log = getLogger("dialogue");

type OpenTask = {
	id: string;
	conversation_id: string;
	toolchain_revision_id: string;
	source_ref: string;
};

/**
 * Closes the TODO rows and confirmations left open when the ledger was retired: the work is cancelled at its
 * owner, then every open row is closed. Nothing writes these tables any more, so only the first call finds rows.
 * `closed` counts the TODO rows closed and `cancelled` the tasks the owner cancelled. An execution the agency still
 * holds (`dialogue_agency_work` not revoked and not returned: old research and work wrote their TODO row with the same
 * execution id) is not cancelled: only its TODO row is closed. After the commit, `flushRetiredCancellations` aborts
 * what the owners cancelled.
 */
export function closeRetiredTodosInTransaction(
	deps: Pick<DialogueDeps, "toolchains" | "agents" | "clock">,
	db: Database,
): { closed: number; cancelled: number } {
	const now = deps.clock();
	let cancelled = 0;
	const tasks = db
		.query(
			`SELECT id, conversation_id, toolchain_revision_id, source_ref FROM dialogue_work
			 WHERE archived_at IS NULL AND execution IN ('task','pipeline') AND source_ref IS NOT NULL
			 AND source_ref NOT IN (SELECT execution_id FROM dialogue_agency_work
			  WHERE execution_id IS NOT NULL AND revoked=0 AND returned=0)`,
		)
		.all() as OpenTask[];
	for (const task of tasks) {
		// One row's owner failing rolls back only its own writes and leaves the other rows to close.
		db.exec("SAVEPOINT retired_todo_cancel");
		try {
			const owner = deps.toolchains?.taskInTransaction?.(
				db,
				task.toolchain_revision_id,
			);
			if (owner)
				owner.cancelInTransaction?.(db, task.conversation_id, task.source_ref);
			else
				deps.agents?.executions.cancelByUserInTransaction(
					db,
					task.conversation_id,
					task.source_ref,
				);
			db.exec("RELEASE retired_todo_cancel");
			cancelled++;
		} catch (error) {
			db.exec("ROLLBACK TO retired_todo_cancel; RELEASE retired_todo_cancel");
			log.warn(
				"dialogue.retired_todo_cancel_failed",
				{
					taskId: task.source_ref,
					reason: toErrorCode(error, "cancel_failed"),
				},
				error,
			);
		}
	}
	const closed = db
		.query(
			`UPDATE dialogue_work SET status='done', outcome='interrupted', question_id=NULL, question=NULL,
			 archived_at=?, notice_read_at=COALESCE(notice_read_at, ?), revision=revision+1, updated_at=?
			 WHERE archived_at IS NULL`,
		)
		.run(now, now, now).changes;
	db.query(
		`UPDATE dialogue_confirmations SET superseded_at=? WHERE used_at IS NULL AND superseded_at IS NULL`,
	).run(now);
	db.query(
		`INSERT INTO command_interaction_events(id, interaction_id, kind, event_id, payload_json, created_at)
		 SELECT 'ev:' || id || ':ledger_retired', id, 'end', 'end:' || id || ':' || (revision + 1),
		  json_object('status', 'cancelled', 'code', 'ledger_retired'), ?
		 FROM command_interactions WHERE status IN ('waiting_input','ready','invoking')`,
	).run(now);
	db.query(
		`UPDATE command_interactions SET status='cancelled', revision=revision+1, authority_epoch=authority_epoch+1,
		 execution_generation=execution_generation+1, question_id=NULL, end_code='ledger_retired',
		 ended_at=?, updated_at=?
		 WHERE status IN ('waiting_input','ready','invoking')`,
	).run(now, now);
	return { closed, cancelled };
}

/** After the closure committed: the owners marked their jobs cancelled, and this tells the queue's runner to abort them. */
export function flushRetiredCancellations(
	queue: Pick<QueueService, "list" | "flushCancellations">,
) {
	try {
		const jobs = queue
			.list({ state: "cancel_requested" }, null, 100)
			.items.map((job) => job.id);
		if (jobs.length) queue.flushCancellations(jobs);
	} catch (error) {
		// Best effort: the job is cancelled in the queue, the runner stops it at its next check.
		log.warn(
			"dialogue.retired_todo_flush_failed",
			{ reason: toErrorCode(error, "flush_failed") },
			error,
		);
	}
}
