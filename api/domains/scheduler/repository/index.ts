import type { Database } from "bun:sqlite";

export const migration = `
CREATE TABLE scheduler_schedules (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, input_digest TEXT NOT NULL, scope TEXT NOT NULL,
 target_kind TEXT NOT NULL, target_version INTEGER NOT NULL, target_payload_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','paused','cancelled','completed')),
 revision INTEGER NOT NULL DEFAULT 0,
 mode TEXT NOT NULL CHECK(mode IN ('once','interval')),
 anchor_at_ms INTEGER NOT NULL, interval_ms INTEGER, next_due_at_ms INTEGER NOT NULL,
 misfire_policy TEXT NOT NULL CHECK(misfire_policy IN ('coalesce','skip')),
 grace_ms INTEGER NOT NULL, overlap_policy TEXT NOT NULL CHECK(overlap_policy IN ('skip')),
 defer_reason TEXT, created_seq INTEGER NOT NULL UNIQUE,
 created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
);
CREATE INDEX scheduler_due ON scheduler_schedules(state, next_due_at_ms);
CREATE TABLE scheduler_occurrences (
 id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES scheduler_schedules(id),
 schedule_revision INTEGER NOT NULL, scheduled_at_ms INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('dispatched','skipped')),
 job_id TEXT, subject_ref TEXT, reason TEXT, created_at_ms INTEGER NOT NULL, seq INTEGER NOT NULL UNIQUE,
 UNIQUE(schedule_id, schedule_revision, scheduled_at_ms)
);
CREATE INDEX scheduler_occurrences_schedule ON scheduler_occurrences(schedule_id, seq);
`;

export interface ScheduleRecord {
	id: string;
	requestId: string;
	inputDigest: string;
	scope: string;
	targetKind: string;
	targetVersion: number;
	targetPayloadJson: string;
	state: "active" | "paused" | "cancelled" | "completed";
	revision: number;
	mode: "once" | "interval";
	anchorAtMs: number;
	intervalMs: number | null;
	nextDueAtMs: number;
	misfirePolicy: "coalesce" | "skip";
	graceMs: number;
	overlapPolicy: "skip";
	deferReason: string | null;
	createdSeq: number;
	createdAtMs: number;
	updatedAtMs: number;
}
export interface OccurrenceRecord {
	id: string;
	scheduleId: string;
	scheduleRevision: number;
	scheduledAtMs: number;
	state: "dispatched" | "skipped";
	jobId: string | null;
	subjectRef: string | null;
	reason: string | null;
	createdAtMs: number;
	seq: number;
}

const scheduleColumns =
	"id, request_id, input_digest, scope, target_kind, target_version, target_payload_json, state, revision, mode, anchor_at_ms, interval_ms, next_due_at_ms, misfire_policy, grace_ms, overlap_policy, defer_reason, created_seq, created_at_ms, updated_at_ms";
type Row = Record<string, unknown>;
function mapSchedule(r: Row): ScheduleRecord {
	return {
		id: r.id as string,
		requestId: r.request_id as string,
		inputDigest: r.input_digest as string,
		scope: r.scope as string,
		targetKind: r.target_kind as string,
		targetVersion: r.target_version as number,
		targetPayloadJson: r.target_payload_json as string,
		state: r.state as ScheduleRecord["state"],
		revision: r.revision as number,
		mode: r.mode as ScheduleRecord["mode"],
		anchorAtMs: r.anchor_at_ms as number,
		intervalMs: r.interval_ms as number | null,
		nextDueAtMs: r.next_due_at_ms as number,
		misfirePolicy: r.misfire_policy as ScheduleRecord["misfirePolicy"],
		graceMs: r.grace_ms as number,
		overlapPolicy: "skip",
		deferReason: r.defer_reason as string | null,
		createdSeq: r.created_seq as number,
		createdAtMs: r.created_at_ms as number,
		updatedAtMs: r.updated_at_ms as number,
	};
}
export function getSchedule(db: Database, id: string): ScheduleRecord | null {
	const row = db
		.query(`SELECT ${scheduleColumns} FROM scheduler_schedules WHERE id=?`)
		.get(id) as Row | null;
	return row ? mapSchedule(row) : null;
}
export function getByRequest(
	db: Database,
	requestId: string,
): ScheduleRecord | null {
	const row = db
		.query(
			`SELECT ${scheduleColumns} FROM scheduler_schedules WHERE request_id=?`,
		)
		.get(requestId) as Row | null;
	return row ? mapSchedule(row) : null;
}
export function countLive(db: Database): number {
	return (
		db
			.query(
				"SELECT COUNT(*) AS n FROM scheduler_schedules WHERE state IN ('active','paused')",
			)
			.get() as { n: number }
	).n;
}
export function insertSchedule(
	db: Database,
	s: Omit<ScheduleRecord, "createdSeq" | "deferReason" | "overlapPolicy">,
) {
	const seq = (
		db
			.query(
				"SELECT COALESCE(MAX(created_seq),0)+1 AS n FROM scheduler_schedules",
			)
			.get() as { n: number }
	).n;
	db.query(
		`INSERT INTO scheduler_schedules (${scheduleColumns}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'skip',NULL,?,?,?)`,
	).run(
		s.id,
		s.requestId,
		s.inputDigest,
		s.scope,
		s.targetKind,
		s.targetVersion,
		s.targetPayloadJson,
		s.state,
		s.revision,
		s.mode,
		s.anchorAtMs,
		s.intervalMs,
		s.nextDueAtMs,
		s.misfirePolicy,
		s.graceMs,
		seq,
		s.createdAtMs,
		s.updatedAtMs,
	);
	return getSchedule(db, s.id) as ScheduleRecord;
}
export function listSchedules(
	db: Database,
	state: string | undefined,
	cursor: number | null,
	limit: number,
): ScheduleRecord[] {
	const where: string[] = [];
	const params: Array<string | number> = [];
	if (state) {
		where.push("state=?");
		params.push(state);
	}
	if (cursor !== null) {
		where.push("created_seq<?");
		params.push(cursor);
	}
	return (
		db
			.query(
				`SELECT ${scheduleColumns} FROM scheduler_schedules ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_seq DESC LIMIT ?`,
			)
			.all(...params, limit) as Row[]
	).map(mapSchedule);
}
export function dueSchedules(
	db: Database,
	now: number,
	limit: number,
): Array<{ id: string; revision: number; targetKind: string }> {
	return (
		db
			.query(
				"SELECT id, revision, target_kind FROM scheduler_schedules WHERE state='active' AND next_due_at_ms <= ? ORDER BY next_due_at_ms, created_seq LIMIT ?",
			)
			.all(now, limit) as Array<{
			id: string;
			revision: number;
			target_kind: string;
		}>
	).map((r) => ({ id: r.id, revision: r.revision, targetKind: r.target_kind }));
}
export function nextDueAt(db: Database): number | null {
	return (
		db
			.query(
				"SELECT MIN(next_due_at_ms) AS t FROM scheduler_schedules WHERE state='active'",
			)
			.get() as { t: number | null }
	).t;
}
export function countActive(db: Database): number {
	return (
		db
			.query(
				"SELECT COUNT(*) AS n FROM scheduler_schedules WHERE state='active'",
			)
			.get() as { n: number }
	).n;
}
/** Revision-conditional state change (pause / resume / cancel). */
export function transitionSchedule(
	db: Database,
	id: string,
	expectedRevision: number,
	from: string[],
	to: string,
	nextDueAtMs: number | null,
	now: number,
): boolean {
	return (
		db
			.query(
				`UPDATE scheduler_schedules SET state=?, next_due_at_ms=COALESCE(?, next_due_at_ms), revision=revision+1, defer_reason=NULL, updated_at_ms=? WHERE id=? AND revision=? AND state IN (${from.map(() => "?").join(",")})`,
			)
			.run(to, nextDueAtMs, now, id, expectedRevision, ...from).changes === 1
	);
}
/** Advance after an occurrence; deliberately does not bump revision (config unchanged). */
export function advanceSchedule(
	db: Database,
	id: string,
	revision: number,
	nextDueAtMs: number | null,
	now: number,
) {
	db.query(
		"UPDATE scheduler_schedules SET state=CASE WHEN ? IS NULL THEN 'completed' ELSE state END, next_due_at_ms=COALESCE(?, next_due_at_ms), defer_reason=NULL, updated_at_ms=? WHERE id=? AND revision=? AND state='active'",
	).run(nextDueAtMs, nextDueAtMs, now, id, revision);
}
export function setDeferReason(
	db: Database,
	id: string,
	reason: string,
	now: number,
) {
	db.query(
		"UPDATE scheduler_schedules SET defer_reason=?, updated_at_ms=? WHERE id=? AND state='active'",
	).run(reason, now, id);
}
export function insertOccurrence(
	db: Database,
	o: Omit<OccurrenceRecord, "seq">,
): boolean {
	return (
		db
			.query(
				"INSERT INTO scheduler_occurrences (id, schedule_id, schedule_revision, scheduled_at_ms, state, job_id, subject_ref, reason, created_at_ms, seq) VALUES (?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM scheduler_occurrences)) ON CONFLICT(schedule_id, schedule_revision, scheduled_at_ms) DO NOTHING",
			)
			.run(
				o.id,
				o.scheduleId,
				o.scheduleRevision,
				o.scheduledAtMs,
				o.state,
				o.jobId,
				o.subjectRef,
				o.reason,
				o.createdAtMs,
			).changes === 1
	);
}
export function lastDispatchedJob(
	db: Database,
	scheduleId: string,
): string | null {
	const row = db
		.query(
			"SELECT job_id FROM scheduler_occurrences WHERE schedule_id=? AND state='dispatched' ORDER BY seq DESC LIMIT 1",
		)
		.get(scheduleId) as { job_id: string | null } | null;
	return row?.job_id ?? null;
}
export function listOccurrences(
	db: Database,
	scheduleId: string,
	cursor: number | null,
	limit: number,
): OccurrenceRecord[] {
	return (
		db
			.query(
				`SELECT id, schedule_id, schedule_revision, scheduled_at_ms, state, job_id, subject_ref, reason, created_at_ms, seq FROM scheduler_occurrences WHERE schedule_id=? ${cursor === null ? "" : "AND seq<?"} ORDER BY seq DESC LIMIT ?`,
			)
			.all(
				...(cursor === null
					? [scheduleId, limit]
					: [scheduleId, cursor, limit]),
			) as Row[]
	).map((r) => ({
		id: r.id as string,
		scheduleId: r.schedule_id as string,
		scheduleRevision: r.schedule_revision as number,
		scheduledAtMs: r.scheduled_at_ms as number,
		state: r.state as OccurrenceRecord["state"],
		jobId: r.job_id as string | null,
		subjectRef: r.subject_ref as string | null,
		reason: r.reason as string | null,
		createdAtMs: r.created_at_ms as number,
		seq: r.seq as number,
	}));
}
