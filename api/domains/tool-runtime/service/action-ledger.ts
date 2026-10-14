import type { Database } from "bun:sqlite";
import type {
	ActionRequestView,
	ExecutionResultV1,
	ReceiptRef,
} from "../contracts";
import {
	ACTION_POLICY,
	iso,
	type LedgerContext,
	type Row,
} from "./action-types";

/** Rows of the acceptance ledger: reading, projection, capacity and retention. */
export const rowOf = (db: Database, eventId: string) =>
	db
		.query("SELECT * FROM tool_action_requests WHERE event_id=?")
		.get(eventId) as Row | null;

/** The result of a row whose JSON body was deleted (or never stored), from its columns. */
function rebuilt(row: Row): ExecutionResultV1 | undefined {
	if (row.status === "pending") return undefined;
	const receiptRef: ReceiptRef | undefined =
		row.receipt_owner && row.receipt_operation_id && row.receipt_digest
			? {
					owner: row.receipt_owner,
					operationId: row.receipt_operation_id,
					digest: row.receipt_digest,
				}
			: undefined;
	return {
		version: 1,
		executionId: row.event_id,
		artifactRevisionId: row.artifact_revision_id,
		outcome:
			row.status === "accepted"
				? "completed"
				: row.status === "indeterminate"
					? "indeterminate"
					: "failed",
		...(receiptRef ? { receiptRef } : {}),
		resultRefs: [],
		artifactRefs: [],
		...(row.error_code
			? {
					error: {
						code: row.error_code,
						retry:
							row.status === "indeterminate"
								? ("reconcile" as const)
								: ("user_resubmit" as const),
					},
				}
			: {}),
	};
}

export function viewOf(
	ctx: LedgerContext,
	db: Database,
	row: Row,
): ActionRequestView {
	let result = row.result_json
		? (JSON.parse(row.result_json) as ExecutionResultV1)
		: rebuilt(row);
	if (
		result &&
		row.status === "accepted" &&
		row.receipt_operation_id &&
		row.receipt_digest
	) {
		// The domain owns the receipt body; read it back instead of copying it here.
		try {
			const read = ctx.registry
				.get(row.adapter_ref)
				?.readInTransaction(db, row.receipt_operation_id);
			if (read && read.receiptRef.digest === row.receipt_digest)
				result = { ...result, receipt: read.receipt };
		} catch {
			// An expired domain receipt leaves the confirmed reference without a body.
		}
	}
	return {
		eventId: row.event_id,
		status: row.status,
		...(row.error_code ? { errorCode: row.error_code } : {}),
		...(result ? { result } : {}),
		createdAt: iso(row.created_at),
		...(row.settled_at !== null ? { settledAt: iso(row.settled_at) } : {}),
	};
}

/** Delete bodies 30 days after settlement and whole rows 30 days after that. */
export function purge(ctx: LedgerContext, db: Database) {
	const t = ctx.now();
	const bodies = db
		.query(
			`UPDATE tool_action_requests SET canonical_input_json=NULL,result_json=NULL,body_deleted_at=?
         WHERE body_deleted_at IS NULL AND settled_at IS NOT NULL AND settled_at<=?`,
		)
		.run(t, t - ACTION_POLICY.bodyMs).changes;
	const tombstones = db
		.query(
			"DELETE FROM tool_action_requests WHERE settled_at IS NOT NULL AND settled_at<=?",
		)
		.run(t - ACTION_POLICY.bodyMs - ACTION_POLICY.tombstoneMs).changes;
	const conflicts = db
		.query("DELETE FROM tool_action_request_conflicts WHERE created_at<=?")
		.run(t - ACTION_POLICY.bodyMs - ACTION_POLICY.tombstoneMs).changes;
	return { bodies, tombstones, conflicts };
}

export function hasRoom(ctx: LedgerContext, db: Database, cancel: boolean) {
	const count = () =>
		(
			db.query("SELECT COUNT(*) AS n FROM tool_action_requests").get() as {
				n: number;
			}
		).n;
	const limit =
		ACTION_POLICY.capacity + (cancel ? ACTION_POLICY.cancelReserve : 0);
	if (count() < limit) return true;
	purge(ctx, db);
	return count() < limit;
}

export function recordConflict(
	ctx: LedgerContext,
	db: Database,
	eventId: string,
	digest: string | undefined,
) {
	// No digest means the event may carry a secret and no key could protect it: audit nothing.
	if (!digest) return;
	const n = (
		db
			.query("SELECT COUNT(*) AS n FROM tool_action_request_conflicts")
			.get() as {
			n: number;
		}
	).n;
	// A flood of bad resends cannot grow the audit table without bound.
	if (n < ACTION_POLICY.conflictCapacity)
		db.query(
			"INSERT OR IGNORE INTO tool_action_request_conflicts(event_id,input_digest,created_at) VALUES(?,?,?)",
		).run(eventId, digest, ctx.now());
}

export function unsettledRows(ctx: LedgerContext, db: Database) {
	return (
		db
			.query(
				"SELECT * FROM tool_action_requests WHERE scope=? AND status IN ('pending','indeterminate') ORDER BY created_at,event_id LIMIT ?",
			)
			.all(ctx.scope, ACTION_POLICY.unsettledLimit) as Row[]
	).map((row) => viewOf(ctx, db, row));
}
