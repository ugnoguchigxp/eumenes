import type { Database } from "bun:sqlite";

export const agencyMigration = `
CREATE TABLE dialogue_agency_state (
 conversation_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0,
 scope TEXT NOT NULL, snapshot_json TEXT, idle_json TEXT, source_refs_json TEXT NOT NULL DEFAULT '[]',
 settings_digest TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE dialogue_agency_feed (id INTEGER PRIMARY KEY CHECK(id=1), cursor INTEGER NOT NULL, active_id TEXT);
CREATE TABLE dialogue_agency_work (
 root_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, epoch INTEGER NOT NULL,
 ticket_id TEXT NOT NULL, intent_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
 question TEXT NOT NULL, toolchain_revision_id TEXT NOT NULL, deadline INTEGER NOT NULL,
 source_refs_json TEXT NOT NULL, task_id TEXT, returned INTEGER NOT NULL DEFAULT 0,
 revoked INTEGER NOT NULL DEFAULT 0, UNIQUE(conversation_id,epoch,ticket_id)
);`;
// A separate column keeps delayed snapshot saves from replacing a committed dispatch time.
export const dispatchClockMigration = `
ALTER TABLE dialogue_agency_state ADD COLUMN last_dispatch_at INTEGER;
UPDATE dialogue_agency_state SET last_dispatch_at=CAST(unixepoch('subsec')*1000 AS INTEGER)
 WHERE json_extract(snapshot_json,'$.state.lastOutboundAt') IS NOT NULL;`;

export function claimAgencyDispatch(
	db: Database,
	conversationId: string,
	epoch: number,
	now: number,
	interval: number,
) {
	return (
		db
			.query(
				`UPDATE dialogue_agency_state SET last_dispatch_at=?
		WHERE conversation_id=? AND epoch=? AND snapshot_json IS NOT NULL
		AND (last_dispatch_at IS NULL OR last_dispatch_at<=?)`,
			)
			.run(now, conversationId, epoch, now - interval).changes === 1
	);
}
export type AgencyRecord = {
	conversationId: string;
	epoch: number;
	scope: string;
	snapshot: unknown;
	idle: unknown;
	settingsDigest: string;
	sourceRefs: readonly string[];
};
type StateRow = {
	conversation_id: string;
	epoch: number;
	scope: string;
	snapshot_json: string | null;
	idle_json: string | null;
	settings_digest: string;
	source_refs_json: string;
};
export function agencyRecords(db: Database): AgencyRecord[] {
	return (
		db
			.query(
				"SELECT * FROM dialogue_agency_state WHERE snapshot_json IS NOT NULL",
			)
			.all() as StateRow[]
	).map((r) => ({
		conversationId: r.conversation_id,
		epoch: r.epoch,
		scope: r.scope,
		snapshot: JSON.parse(r.snapshot_json!),
		idle: JSON.parse(r.idle_json ?? "null"),
		settingsDigest: r.settings_digest,
		sourceRefs: JSON.parse(r.source_refs_json),
	}));
}
export function agencyEpoch(db: Database, id: string) {
	return (
		(
			db
				.query(
					"SELECT epoch FROM dialogue_agency_state WHERE conversation_id=?",
				)
				.get(id) as { epoch: number } | null
		)?.epoch ?? 0
	);
}
export function saveAgency(db: Database, r: AgencyRecord, at: number): boolean {
	db.query(
		`INSERT INTO dialogue_agency_state(conversation_id,epoch,scope,snapshot_json,idle_json,settings_digest,source_refs_json,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET scope=excluded.scope,snapshot_json=excluded.snapshot_json,idle_json=excluded.idle_json,settings_digest=excluded.settings_digest,source_refs_json=excluded.source_refs_json,updated_at=excluded.updated_at WHERE dialogue_agency_state.epoch=excluded.epoch`,
	).run(
		r.conversationId,
		r.epoch,
		r.scope,
		JSON.stringify(r.snapshot),
		JSON.stringify(r.idle),
		r.settingsDigest,
		JSON.stringify(r.sourceRefs),
		at,
	);
	return (
		db
			.query(
				"SELECT scope FROM dialogue_agency_state WHERE conversation_id=? AND epoch=?",
			)
			.get(r.conversationId, r.epoch) !== null
	);
}
export function agencyFeed(db: Database) {
	return db
		.query(
			"SELECT cursor,active_id AS activeId FROM dialogue_agency_feed WHERE id=1",
		)
		.get() as { cursor: number; activeId: string | null } | null;
}
export function saveAgencyFeed(
	db: Database,
	cursor: number,
	activeId: string | null,
) {
	db.query(
		"INSERT INTO dialogue_agency_feed(id,cursor,active_id) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET cursor=MAX(dialogue_agency_feed.cursor,excluded.cursor),active_id=excluded.active_id",
	).run(cursor, activeId);
}
export type AgencyWorkRow = {
	root_id: string;
	conversation_id: string;
	epoch: number;
	ticket_id: string;
	intent_id: string;
	candidate_id: string;
	question: string;
	toolchain_revision_id: string;
	deadline: number;
	source_refs_json: string;
	task_id: string | null;
	returned: number;
	revoked: number;
};
export function agencyWorks(
	db: Database,
	id?: string,
	includeReturned = false,
): AgencyWorkRow[] {
	return (
		id === undefined
			? db
					.query(
						"SELECT * FROM dialogue_agency_work WHERE revoked=0 AND returned=0",
					)
					.all()
			: db
					.query(
						"SELECT * FROM dialogue_agency_work WHERE conversation_id=? AND revoked=0 AND (returned=0 OR ?)",
					)
					.all(id, includeReturned ? 1 : 0)
	) as AgencyWorkRow[];
}
export function agencyWork(db: Database, root: string): AgencyWorkRow | null {
	return db
		.query("SELECT * FROM dialogue_agency_work WHERE root_id=?")
		.get(root) as AgencyWorkRow | null;
}
export function insertAgencyWork(
	db: Database,
	r: Omit<AgencyWorkRow, "task_id" | "returned" | "revoked">,
) {
	db.query(
		"INSERT INTO dialogue_agency_work(root_id,conversation_id,epoch,ticket_id,intent_id,candidate_id,question,toolchain_revision_id,deadline,source_refs_json) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(root_id) DO NOTHING",
	).run(
		r.root_id,
		r.conversation_id,
		r.epoch,
		r.ticket_id,
		r.intent_id,
		r.candidate_id,
		r.question,
		r.toolchain_revision_id,
		r.deadline,
		r.source_refs_json,
	);
}
export function linkAgencyWork(db: Database, id: string, taskId: string) {
	db.query("UPDATE dialogue_agency_work SET task_id=? WHERE root_id=?").run(
		taskId,
		id,
	);
}
export function returnAgencyWork(db: Database, id: string) {
	db.query("UPDATE dialogue_agency_work SET returned=1 WHERE root_id=?").run(
		id,
	);
}
export function revokeAgency(db: Database, id: string) {
	db.query(
		"UPDATE dialogue_agency_state SET epoch=epoch+1,snapshot_json=NULL,idle_json=NULL,source_refs_json='[]' WHERE conversation_id=?",
	).run(id);
	db.query(
		"UPDATE dialogue_agency_work SET revoked=1,question='',source_refs_json='[]' WHERE conversation_id=?",
	).run(id);
}
/** A saved intent, not a user's message, owns this research. Terminal or withdrawn work authorizes no new reads. */
export function currentAgencyWork(db: Database, r: AgencyWorkRow): boolean {
	const row = db
		.query(
			"SELECT snapshot_json FROM dialogue_agency_state WHERE conversation_id=? AND epoch=?",
		)
		.get(r.conversation_id, r.epoch) as { snapshot_json: string | null } | null;
	if (!row?.snapshot_json) return false;
	const snapshot = JSON.parse(row.snapshot_json) as {
		state: {
			intents: Array<{ id: string; state: string; workRef?: string | null }>;
		};
	};
	return snapshot.state.intents.some(
		(i) =>
			i.id === r.intent_id &&
			["proposed", "adopted", "held"].includes(i.state) &&
			i.workRef === r.ticket_id,
	);
}
/** Only the real persisted autonomous work can authorize research; never an action grant. */
export function autonomousResearchSource(
	db: Database,
	root: string,
	now: number,
) {
	const r = agencyWork(db, root);
	if (
		!r ||
		r.revoked ||
		r.returned ||
		r.deadline <= now ||
		agencyEpoch(db, r.conversation_id) !== r.epoch ||
		!currentAgencyWork(db, r)
	)
		return null;
	return {
		origin: "autonomous" as const,
		conversationId: r.conversation_id,
		runId: r.root_id,
		request: r.question,
		intentId: r.intent_id,
		candidateId: r.candidate_id,
		ticketId: r.ticket_id,
	};
}
export function revokeAgencyWork(db: Database, id: string) {
	db.query("UPDATE dialogue_agency_work SET revoked=1 WHERE root_id=?").run(id);
}
