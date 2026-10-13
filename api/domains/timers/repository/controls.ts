import type { Database } from "bun:sqlite";

export function countLive(db: Database, scope: string): number {
	return (
		db
			.query(
				"SELECT COUNT(*) AS n FROM timers WHERE scope=? AND state IN ('active','paused') AND body_expired=0",
			)
			.get(scope) as { n: number }
	).n;
}
export function markPaused(
	db: Database,
	id: string,
	revision: number,
	at: number,
): boolean {
	return (
		db
			.query(`UPDATE timers SET state='paused', paused_at_ms=?, paused_remaining_ms=due_at_ms-?,
    revision=revision+1, cancel_epoch=cancel_epoch+1, schedule_id=NULL, expiry_job_id=NULL, updated_at_ms=?
    WHERE id=? AND state='active' AND revision=? AND due_at_ms>? AND body_expired=0`)
			.run(at, at, at, id, revision, at).changes === 1
	);
}
export function markResumed(
	db: Database,
	id: string,
	revision: number,
	dueAt: number,
	at: number,
): boolean {
	return (
		db
			.query(`UPDATE timers SET state='active', due_at_ms=?, paused_total_ms=?-started_at_ms-duration_seconds*1000,
    paused_at_ms=NULL, paused_remaining_ms=NULL, cancelled_at_ms=NULL, terminal_at_ms=NULL,
    revision=revision+1, cancel_epoch=cancel_epoch+1, schedule_id=NULL, expiry_job_id=NULL, error_code=NULL, updated_at_ms=?
    WHERE id=? AND state IN ('paused','cancelled') AND revision=? AND body_expired=0`)
			.run(dueAt, dueAt, at, id, revision).changes === 1
	);
}
