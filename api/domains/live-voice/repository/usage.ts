import type { Database } from "bun:sqlite";
export const liveUsageModelsInTransaction = (db: Database) =>
	(
		db
			.query(
				"SELECT DISTINCT model FROM live_voice_sessions WHERE model IS NOT NULL",
			)
			.all() as { model: string }[]
	).map((r) => r.model);

export function activeLiveUsageInTransaction(db: Database) {
	return db
		.query(
			"SELECT id,model,connection_id AS connectionId,started_at AS startedAt,observed_seconds AS seconds FROM live_voice_sessions WHERE status IN ('connecting','active','closing')",
		)
		.all() as Array<{
		id: string;
		model: string | null;
		connectionId: string;
		startedAt: string;
		seconds: number | null;
	}>;
}

/** A provider's cumulative seconds, never a local wall-clock estimate. */
export function usageSeconds(raw: unknown): number | null {
	const n = (raw as { seconds?: unknown } | null)?.seconds;
	return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

export function observeUsage(
	db: Database,
	id: string,
	raw: unknown,
	at: string,
	final = false,
) {
	const seconds = usageSeconds(raw);
	if (seconds === null) return false;
	const row = db
		.query("SELECT observed_seconds FROM live_voice_sessions WHERE id=?")
		.get(id) as { observed_seconds: number | null } | null;
	if (!row || (row.observed_seconds !== null && seconds < row.observed_seconds))
		return false;
	db.query(
		"UPDATE live_voice_sessions SET observed_seconds=?,usage_observed_at=?,usage_confirmed=?,usage=? WHERE id=?",
	).run(seconds, at, final ? 1 : 0, JSON.stringify({ seconds }), id);
	return true;
}

/** Only numerical accounting metadata leaves this owner; no transcript or credential. */
export function liveUsageInTransaction(
	db: Database,
	start: number,
	end: number,
) {
	return db
		.query(`SELECT id,model,connection_id AS connectionId,connection_name AS connectionName,
started_at AS startedAt,ended_at AS endedAt,status,test,
observed_seconds AS seconds,usage_confirmed AS confirmed,error
FROM live_voice_sessions WHERE julianday(started_at)>=julianday(?) AND julianday(started_at)<julianday(?) ORDER BY started_at DESC,id`)
		.all(new Date(start).toISOString(), new Date(end).toISOString()) as Array<{
		id: string;
		model: string | null;
		connectionId: string;
		connectionName: string | null;
		startedAt: string;
		endedAt: string | null;
		status: string;
		test: number;
		seconds: number | null;
		confirmed: number;
		error: string | null;
	}>;
}
