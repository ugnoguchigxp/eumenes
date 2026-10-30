import type { Database } from "bun:sqlite";
import type { NotificationReason } from "../contracts";
import {
	changed,
	mapNotification,
	type NotificationRow,
	type SqlTimer,
} from "./rows";

export function insertNotificationIfAbsent(
	db: Database,
	row: {
		id: string;
		timerId: string;
		scope: string;
		generation: number;
		dueAtMs: number;
		status: "pending" | "silent";
		reason: NotificationReason | null;
		at: number;
	},
): boolean {
	const result = db
		.query(
			`INSERT INTO timer_notifications (
        id, timer_id, scope, generation, due_at_ms, status, reason, revision,
        created_at_ms, updated_at_ms
      ) VALUES (?,?,?,?,?,?,?,0,?,?)
      ON CONFLICT(timer_id, generation) DO NOTHING`,
		)
		.run(
			row.id,
			row.timerId,
			row.scope,
			row.generation,
			row.dueAtMs,
			row.status,
			row.reason,
			row.at,
			row.at,
		);
	return result.changes === 1;
}

export function getNotification(
	db: Database,
	id: string,
): NotificationRow | null {
	const row = db
		.query("SELECT * FROM timer_notifications WHERE id=?")
		.get(id) as SqlTimer | null;
	return row ? mapNotification(row) : null;
}

export function latestOpenNotification(
	db: Database,
	timerId: string,
): NotificationRow | null {
	const row = db
		.query(
			`SELECT * FROM timer_notifications
       WHERE timer_id=? AND status!='dismissed'
       ORDER BY generation DESC, id DESC LIMIT 1`,
		)
		.get(timerId) as SqlTimer | null;
	return row ? mapNotification(row) : null;
}

export function undismissedCount(db: Database, timerId: string): number {
	return (
		db
			.query(
				"SELECT COUNT(*) AS n FROM timer_notifications WHERE timer_id=? AND status!='dismissed'",
			)
			.get(timerId) as { n: number }
	).n;
}

export function dismissNotifications(
	db: Database,
	timerId: string,
	at: number,
): number {
	return db
		.query(
			`UPDATE timer_notifications
       SET status='dismissed', dismissed_at_ms=?, claim_id=NULL, lease_until_ms=NULL,
           revision=revision+1, updated_at_ms=?
       WHERE timer_id=? AND status!='dismissed'`,
		)
		.run(at, at, timerId).changes;
}

export function listNotifications(
	db: Database,
	scope: string,
	cursorDue: number | null,
	cursorId: string | null,
	limit: number,
): NotificationRow[] {
	const rows = db
		.query(
			`SELECT * FROM timer_notifications
       WHERE scope=? AND status!='dismissed'
         AND (? IS NULL OR due_at_ms > ? OR (due_at_ms = ? AND id > ?))
       ORDER BY due_at_ms ASC, id ASC
       LIMIT ?`,
		)
		.all(scope, cursorDue, cursorDue, cursorDue, cursorId, limit) as SqlTimer[];
	return rows.map(mapNotification);
}

/** Archives the scope's existing notices without changing timers or deleting records. */
export function archiveNotifications(db: Database, scope: string, at: number) {
	return db
		.query(`UPDATE timer_notifications
		SET status='dismissed', dismissed_at_ms=?, claim_id=NULL, lease_until_ms=NULL,
			revision=revision+1, updated_at_ms=?
		WHERE scope=? AND status!='dismissed'`)
		.run(at, at, scope).changes;
}

export function claimNotification(
	db: Database,
	id: string,
	scope: string,
	expectedRevision: number,
	claimId: string,
	claimRequestId: string,
	clientId: string,
	leaseUntilMs: number,
	at: number,
): boolean {
	return changed(
		db
			.query(
				`UPDATE timer_notifications
         SET status='claimed', reason=NULL, revision=revision+1,
             claim_id=?, claim_request_id=?, client_id=?, lease_until_ms=?, updated_at_ms=?
         WHERE id=? AND scope=? AND status='pending' AND revision=?`,
			)
			.run(
				claimId,
				claimRequestId,
				clientId,
				leaseUntilMs,
				at,
				id,
				scope,
				expectedRevision,
			),
	);
}

export function releaseClaim(db: Database, id: string, at: number): boolean {
	return changed(
		db
			.query(
				`UPDATE timer_notifications
         SET status='pending', claim_id=NULL, claim_request_id=NULL, client_id=NULL,
             lease_until_ms=NULL, revision=revision+1, updated_at_ms=?
         WHERE id=? AND status='claimed'`,
			)
			.run(at, id),
	);
}

export function settleNotification(
	db: Database,
	id: string,
	scope: string,
	claimId: string,
	clientId: string,
	status: "played" | "silent",
	reason: NotificationReason | null,
	at: number,
): boolean {
	return changed(
		db
			.query(
				`UPDATE timer_notifications
         SET status=?, reason=?, played_at_ms=CASE WHEN ?='played' THEN ? ELSE played_at_ms END,
             revision=revision+1, updated_at_ms=?
         WHERE id=? AND scope=? AND status='claimed' AND claim_id=? AND client_id=?
           AND lease_until_ms IS NOT NULL AND lease_until_ms>?`,
			)
			.run(status, reason, status, at, at, id, scope, claimId, clientId, at),
	);
}

export function silencePending(
	db: Database,
	id: string,
	scope: string,
	expectedRevision: number,
	reason: "muted" | "blocked" | "stale",
	at: number,
): boolean {
	return changed(
		db
			.query(
				`UPDATE timer_notifications
         SET status='silent', reason=?, revision=revision+1, updated_at_ms=?
         WHERE id=? AND scope=? AND status='pending' AND revision=?`,
			)
			.run(reason, at, id, scope, expectedRevision),
	);
}

export function silenceClaimedStale(
	db: Database,
	id: string,
	at: number,
): boolean {
	return changed(
		db
			.query(
				`UPDATE timer_notifications
         SET status='silent', reason='stale', claim_id=NULL, claim_request_id=NULL,
             client_id=NULL, lease_until_ms=NULL, revision=revision+1, updated_at_ms=?
         WHERE id=? AND status='claimed'`,
			)
			.run(at, id),
	);
}

export function expiredClaims(db: Database, now: number, limit: number) {
	const rows = db
		.query(
			`SELECT * FROM timer_notifications
       WHERE status='claimed' AND lease_until_ms IS NOT NULL AND lease_until_ms<=?
       ORDER BY lease_until_ms ASC, id ASC LIMIT ?`,
		)
		.all(now, limit) as SqlTimer[];
	return rows.map(mapNotification);
}

export function stalePending(
	db: Database,
	now: number,
	freshMs: number,
	limit: number,
) {
	const rows = db
		.query(
			`SELECT * FROM timer_notifications
       WHERE status='pending' AND ? - due_at_ms > ?
       ORDER BY due_at_ms ASC, id ASC LIMIT ?`,
		)
		.all(now, freshMs, limit) as SqlTimer[];
	return rows.map(mapNotification);
}
