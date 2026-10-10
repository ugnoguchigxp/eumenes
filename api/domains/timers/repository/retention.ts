import type { Database } from "bun:sqlite";

function changed(result: { changes: number }): boolean {
	return result.changes === 1;
}

export function markDispatchExhausted(
	db: Database,
	id: string,
	cancelEpoch: number,
	dispatchGeneration: number,
	at: number,
): boolean {
	return changed(
		db
			.query(
				`UPDATE timers SET state='elapsed', terminal_at_ms=?, revision=revision+1,
         error_code='timer_dispatch_exhausted', updated_at_ms=?
         WHERE id=? AND state='active' AND cancel_epoch=? AND dispatch_generation=?`,
			)
			.run(at, at, id, cancelEpoch, dispatchGeneration),
	);
}

export function pruneBatch(
	db: Database,
	now: number,
	retentionMs: number,
	tombstoneMs: number,
	limit: number,
	protectedIds: readonly string[],
	listRetentionMs: number,
): { operations: number; timers: number; deleted: number } {
	const cutoff = now - retentionMs;
	const listDeleted = deleteExpiredListOperations(
		db,
		now - listRetentionMs,
		limit,
	);
	const tombCutoff = now - tombstoneMs;
	const protectedJson = JSON.stringify(protectedIds);
	const operations = db
		.query(
			`UPDATE timer_operations
       SET receipt_json=NULL, expired_at_ms=?
       WHERE id IN (
         SELECT id FROM timer_operations
         WHERE receipt_json IS NOT NULL AND created_at_ms<=?
           AND id NOT IN (SELECT value FROM json_each(?))
         ORDER BY created_at_ms ASC, id ASC LIMIT ?
       )`,
		)
		.run(now, cutoff, protectedJson, limit).changes;
	const timers = db
		.query(
			`UPDATE timers
       SET label='', conversation_id=NULL, origin_run_id=NULL, origin_message_id=NULL,
           origin_key=NULL, body_expired=1, updated_at_ms=?
       WHERE id IN (
         SELECT t.id FROM timers t
         WHERE t.state!='active' AND t.body_expired=0 AND t.updated_at_ms<=?
           AND NOT EXISTS (
             SELECT 1 FROM timer_notifications n
             WHERE n.timer_id=t.id AND n.status!='dismissed'
           )
           AND NOT EXISTS (
             SELECT 1 FROM timer_operations o
             WHERE o.timer_id=t.id AND o.id IN (SELECT value FROM json_each(?))
           )
         ORDER BY t.updated_at_ms ASC, t.id ASC LIMIT ?
       )`,
		)
		.run(now, cutoff, protectedJson, limit).changes;
	db.query(
		`DELETE FROM timer_notifications
     WHERE status IN ('played','dismissed') AND timer_id IN (
       SELECT t.id FROM timers t
       WHERE t.body_expired=1 AND t.state!='active' AND t.updated_at_ms<=?
         AND NOT EXISTS (
           SELECT 1 FROM timer_notifications n
           WHERE n.timer_id=t.id AND n.status IN ('pending','claimed','silent')
         )
     )`,
	).run(tombCutoff);
	const deletedOps = db
		.query(
			`DELETE FROM timer_operations
       WHERE id IN (
         SELECT id FROM timer_operations
         WHERE expired_at_ms IS NOT NULL AND expired_at_ms<=?
           AND id NOT IN (SELECT value FROM json_each(?))
         ORDER BY expired_at_ms ASC, id ASC LIMIT ?
       )`,
		)
		.run(tombCutoff, protectedJson, limit).changes;
	const deletedTimers = db
		.query(
			`DELETE FROM timers
       WHERE id IN (
         SELECT t.id FROM timers t
         WHERE t.body_expired=1 AND t.state!='active' AND t.updated_at_ms<=?
           AND NOT EXISTS (
             SELECT 1 FROM timer_notifications n
             WHERE n.timer_id=t.id AND n.status IN ('pending','claimed','silent')
           )
           AND NOT EXISTS (
             SELECT 1 FROM timer_operations o WHERE o.timer_id=t.id
           )
         ORDER BY t.updated_at_ms ASC, t.id ASC LIMIT ?
       )`,
		)
		.run(tombCutoff, limit).changes;
	return {
		operations,
		timers,
		deleted: deletedOps + deletedTimers + listDeleted,
	};
}

/** List receipts only serve replay; replays older than the request window are rejected anyway. */
export function deleteExpiredListOperations(
	db: Database,
	cutoffMs: number,
	limit: number,
): number {
	return db
		.query(
			`DELETE FROM timer_operations
       WHERE id IN (
         SELECT id FROM timer_operations
         WHERE receipt_json IS NOT NULL AND created_at_ms<=? AND operation='list'
         ORDER BY created_at_ms ASC, id ASC LIMIT ?
       )`,
		)
		.run(cutoffMs, limit).changes;
}
