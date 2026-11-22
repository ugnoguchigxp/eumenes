import type { Database } from "bun:sqlite";
import type {
	PlanEvidence,
	PlanItem,
	PlanKind,
	PlanState,
	QuestionEntry,
	QuestionState,
} from "../contracts/plans";

/**
 * L3 and the question ledger. Both rest on evidence rows (one table, `owner_kind` tells whose): a
 * message of a conversation (with its quote), or a memory item. Deleting what an owner rests on deletes
 * the owner.
 */
export const plansMigration = `
CREATE TABLE continuity_plans (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('plan','intent','open_question','decision')),
 text TEXT NOT NULL, due_at TEXT,
 state TEXT NOT NULL CHECK(state IN ('open','awaiting_confirmation','closed')),
 revision INTEGER NOT NULL, created_at TEXT NOT NULL, last_touched_at TEXT NOT NULL
);
CREATE INDEX continuity_plans_due ON continuity_plans(state, due_at);
CREATE INDEX continuity_plans_conversation ON continuity_plans(conversation_id, state);
CREATE VIRTUAL TABLE continuity_plan_search USING fts5(id UNINDEXED, content, tokenize='trigram');
CREATE TABLE continuity_questions (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, attribute TEXT NOT NULL, attribute_key TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('asked','answered','declined','deferred')),
 revision INTEGER NOT NULL, asked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE continuity_evidence (
 owner_kind TEXT NOT NULL CHECK(owner_kind IN ('plan','question')), owner_id TEXT NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('message','memory')), source_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL, quote TEXT,
 PRIMARY KEY (owner_kind, owner_id, source_kind, source_id)
);
CREATE INDEX continuity_evidence_source ON continuity_evidence(source_kind, source_id);
`;

/**
 * The goals, decisions and open questions that are still open move to L3 (goal -> intent); memos are dropped
 * (the user's decision, 2026-11-22). Closed notes and notes already past their expiry are not moved.
 */
export const shortTermToPlansMigration = `
INSERT INTO continuity_plans (id, conversation_id, kind, text, due_at, state, revision, created_at, last_touched_at)
 SELECT id, conversation_id,
  CASE kind WHEN 'goal' THEN 'intent' ELSE kind END,
  text, NULL, 'open', 1, created_at, updated_at
 FROM continuity_items
 WHERE status = 'active' AND kind IN ('goal','decision','open_question')
  AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 ORDER BY rowid;
INSERT INTO continuity_plan_search (id, content) SELECT id, text FROM continuity_plans;
INSERT INTO continuity_evidence (owner_kind, owner_id, source_kind, source_id, conversation_id, quote)
 SELECT 'plan', s.item_id, 'message', s.message_id, p.conversation_id, NULL
 FROM continuity_item_source s JOIN continuity_plans p ON p.id = s.item_id;
`;

/**
 * The old short-term notes (`continuity_items`, their sources and revisions) have no reader left: the plans took
 * what mattered (0009), the forget works on plans, and nothing else reads the tables.
 */
export const dropShortTermMigration = `
DROP TABLE continuity_item_source;
DROP TABLE continuity_items;
DROP TABLE continuity_revisions;
`;

type Row = Record<string, unknown>;
const SOURCE_CHUNK = 500;
type OwnerKind = "plan" | "question";
export type SourceFilter = {
	messageIds: readonly string[];
	memoryItemIds: readonly string[];
};

function chunks<T>(list: readonly T[]): T[][] {
	const out: T[][] = [];
	for (let start = 0; start < list.length; start += SOURCE_CHUNK)
		out.push(list.slice(start, start + SOURCE_CHUNK));
	return out;
}

// ---- evidence ----

export function addEvidence(
	db: Database,
	ownerKind: OwnerKind,
	ownerId: string,
	defaultConversationId: string,
	evidence: {
		messages: readonly {
			messageId: string;
			conversationId?: string;
			quote?: string | null;
		}[];
		memoryItemIds?: readonly string[];
	},
) {
	const insert = db.query(
		`INSERT OR IGNORE INTO continuity_evidence (owner_kind, owner_id, source_kind, source_id, conversation_id, quote)
		 VALUES (?,?,?,?,?,?)`,
	);
	for (const message of evidence.messages)
		insert.run(
			ownerKind,
			ownerId,
			"message",
			message.messageId,
			message.conversationId ?? defaultConversationId,
			message.quote ?? null,
		);
	for (const itemId of evidence.memoryItemIds ?? [])
		insert.run(ownerKind, ownerId, "memory", itemId, "", null);
}

type Evidence = { evidence: PlanEvidence[]; memoryItemIds: string[] };
function evidenceOf(
	db: Database,
	ownerKind: OwnerKind,
	ids: readonly string[],
): Map<string, Evidence> {
	const found = new Map<string, Evidence>();
	for (const chunk of chunks(ids)) {
		const rows = db
			.query(
				`SELECT owner_id, source_kind, source_id, conversation_id, quote FROM continuity_evidence
				 WHERE owner_kind = ? AND owner_id IN (${chunk.map(() => "?").join(",")}) ORDER BY rowid`,
			)
			.all(ownerKind, ...chunk) as Row[];
		for (const row of rows) {
			const entry = found.get(row.owner_id as string) ?? {
				evidence: [],
				memoryItemIds: [],
			};
			if (row.source_kind === "message")
				entry.evidence.push({
					conversationId: row.conversation_id as string,
					messageId: row.source_id as string,
					quote: (row.quote as string | null) ?? null,
				});
			else entry.memoryItemIds.push(row.source_id as string);
			found.set(row.owner_id as string, entry);
		}
	}
	return found;
}

// ---- plans ----

const planColumns =
	"id, conversation_id, kind, text, due_at, state, revision, created_at, last_touched_at";
function mapPlan(row: Row, evidence: Map<string, Evidence>): PlanItem {
	const found = evidence.get(row.id as string);
	return {
		id: row.id as string,
		conversationId: row.conversation_id as string,
		kind: row.kind as PlanKind,
		text: row.text as string,
		dueAt: (row.due_at as string | null) ?? null,
		state: row.state as PlanState,
		revision: row.revision as number,
		createdAt: row.created_at as string,
		lastTouchedAt: row.last_touched_at as string,
		evidence: found?.evidence ?? [],
		memoryItemIds: found?.memoryItemIds ?? [],
	};
}
function mapPlans(db: Database, rows: Row[]): PlanItem[] {
	const evidence = evidenceOf(
		db,
		"plan",
		rows.map((row) => row.id as string),
	);
	return rows.map((row) => mapPlan(row, evidence));
}

export function insertPlan(db: Database, plan: PlanItem) {
	db.query(
		`INSERT INTO continuity_plans (${planColumns}) VALUES (?,?,?,?,?,?,?,?,?)`,
	).run(
		plan.id,
		plan.conversationId,
		plan.kind,
		plan.text,
		plan.dueAt,
		plan.state,
		plan.revision,
		plan.createdAt,
		plan.lastTouchedAt,
	);
	db.query("INSERT INTO continuity_plan_search (id, content) VALUES (?,?)").run(
		plan.id,
		plan.text,
	);
	addEvidence(db, "plan", plan.id, plan.conversationId, {
		messages: plan.evidence,
		memoryItemIds: plan.memoryItemIds,
	});
}
export function getPlan(db: Database, id: string): PlanItem | null {
	const row = db
		.query(`SELECT ${planColumns} FROM continuity_plans WHERE id = ?`)
		.get(id) as Row | null;
	return row ? (mapPlans(db, [row])[0] ?? null) : null;
}
/** Rewrites a plan that is not closed at its expected revision; false when it moved on. */
export function changePlan(
	db: Database,
	id: string,
	expectedRevision: number | undefined,
	change: {
		text?: string;
		dueAt?: string | null;
		state?: PlanState;
		touchedAt?: string;
	},
): boolean {
	const sets = ["revision = revision + 1"];
	const values: Array<string | number | null> = [];
	if (change.text !== undefined) {
		sets.push("text = ?");
		values.push(change.text);
	}
	if (change.dueAt !== undefined) {
		sets.push("due_at = ?");
		values.push(change.dueAt);
	}
	if (change.state !== undefined) {
		sets.push("state = ?");
		values.push(change.state);
	}
	if (change.touchedAt !== undefined) {
		sets.push("last_touched_at = ?");
		values.push(change.touchedAt);
	}
	const guard = expectedRevision === undefined ? "" : " AND revision = ?";
	const result = db
		.query(
			`UPDATE continuity_plans SET ${sets.join(", ")} WHERE id = ? AND state <> 'closed'${guard}`,
		)
		.run(
			...values,
			id,
			...(expectedRevision === undefined ? [] : [expectedRevision]),
		);
	if (result.changes !== 1) return false;
	if (change.text !== undefined)
		db.query("UPDATE continuity_plan_search SET content = ? WHERE id = ?").run(
			change.text,
			id,
		);
	return true;
}
export function countOpenPlans(db: Database, conversationId?: string): number {
	const row = db
		.query(
			`SELECT COUNT(*) AS n FROM continuity_plans WHERE state <> 'closed'${conversationId === undefined ? "" : " AND conversation_id = ?"}`,
		)
		.get(...(conversationId === undefined ? [] : [conversationId])) as {
		n: number;
	};
	return row.n;
}
/** Soonest due first, then the plans without a date by the latest touch. */
export function listPlans(
	db: Database,
	filter: {
		conversationId?: string;
		kinds?: readonly PlanKind[];
		states: readonly PlanState[];
	},
): PlanItem[] {
	const where = [`state IN (${filter.states.map(() => "?").join(",")})`];
	const values: string[] = [...filter.states];
	if (filter.conversationId !== undefined) {
		where.push("conversation_id = ?");
		values.push(filter.conversationId);
	}
	if (filter.kinds) {
		where.push(`kind IN (${filter.kinds.map(() => "?").join(",")})`);
		values.push(...filter.kinds);
	}
	const rows = db
		.query(
			`SELECT ${planColumns} FROM continuity_plans WHERE ${where.join(" AND ")}
			 ORDER BY (due_at IS NULL), due_at, last_touched_at DESC, created_at, id`,
		)
		.all(...values) as Row[];
	return mapPlans(db, rows);
}
/** Three-character pieces of the text (the trigram index cannot match shorter words). */
function trigramQuery(text: string): string {
	const chars = [...text.normalize("NFKC").replace(/\s+/g, " ").trim()];
	const grams = new Set<string>();
	for (let i = 0; i + 3 <= chars.length && grams.size < 48; i++) {
		const gram = chars.slice(i, i + 3).join("");
		if (gram.trim().length === 3) grams.add(gram);
	}
	return [...grams]
		.map((gram) => `"${gram.replaceAll('"', '""')}"`)
		.join(" OR ");
}
/** Full-text search over plan texts: best match first. Texts under three characters are matched as a substring. */
export function searchPlans(
	db: Database,
	text: string,
	filter: { conversationId?: string; states: readonly PlanState[] },
): PlanItem[] {
	const needle = text.normalize("NFKC").trim();
	if (needle === "") return [];
	const where = [`p.state IN (${filter.states.map(() => "?").join(",")})`];
	const values: string[] = [...filter.states];
	if (filter.conversationId !== undefined) {
		where.push("p.conversation_id = ?");
		values.push(filter.conversationId);
	}
	const query = trigramQuery(needle);
	const rows =
		[...needle].length >= 3
			? query === ""
				? []
				: (db
						.query(
							`SELECT p.id, p.conversation_id, p.kind, p.text, p.due_at, p.state, p.revision, p.created_at, p.last_touched_at
							 FROM continuity_plan_search s JOIN continuity_plans p ON p.id = s.id
							 WHERE continuity_plan_search MATCH ? AND ${where.join(" AND ")} ORDER BY bm25(continuity_plan_search), p.id`,
						)
						.all(query, ...values) as Row[])
			: (db
					.query(
						`SELECT ${planColumns.replaceAll(/(\w+)/g, "p.$1")} FROM continuity_plans p
						 WHERE instr(p.text, ?) > 0 AND ${where.join(" AND ")} ORDER BY p.last_touched_at DESC, p.id`,
					)
					.all(needle, ...values) as Row[]);
	return mapPlans(db, rows);
}
/**
 * Open plans whose date has passed become "awaiting confirmation". `localNow` is the local time as
 * `YYYY-MM-DDTHH:MM`; a date alone is over when its day is, a date with a time when that minute is. A zone
 * written in `dueAt` was converted to local time when the plan was saved.
 */
export function markPlansOverdue(db: Database, localNow: string): string[] {
	const ids = (
		db
			.query(
				`SELECT id FROM continuity_plans WHERE state = 'open' AND due_at IS NOT NULL
				 AND ((length(due_at) = 10 AND due_at < substr(?1, 1, 10)) OR (length(due_at) > 10 AND substr(due_at, 1, 16) < ?1))
				 ORDER BY due_at, id`,
			)
			.all(localNow) as Array<{ id: string }>
	).map((row) => row.id);
	const mark = db.query(
		"UPDATE continuity_plans SET state = 'awaiting_confirmation', revision = revision + 1 WHERE id = ? AND state = 'open'",
	);
	for (const id of ids) mark.run(id);
	return ids;
}
export function pruneClosedPlans(db: Database, closedBefore: string): number {
	const ids = (
		db
			.query(
				"SELECT id FROM continuity_plans WHERE state = 'closed' AND last_touched_at < ?",
			)
			.all(closedBefore) as Array<{ id: string }>
	).map((row) => row.id);
	deleteOwners(db, "plan", ids);
	return ids.length;
}

// ---- question ledger ----

const questionColumns =
	"id, conversation_id, attribute, state, revision, asked_at, created_at, updated_at";
function mapQuestions(db: Database, rows: Row[]): QuestionEntry[] {
	const evidence = evidenceOf(
		db,
		"question",
		rows.map((row) => row.id as string),
	);
	return rows.map((row) => ({
		id: row.id as string,
		conversationId: row.conversation_id as string,
		attribute: row.attribute as string,
		state: row.state as QuestionState,
		revision: row.revision as number,
		askedAt: (row.asked_at as string | null) ?? null,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
		evidence: evidence.get(row.id as string)?.evidence ?? [],
		memoryItemIds: evidence.get(row.id as string)?.memoryItemIds ?? [],
	}));
}
export function insertQuestion(
	db: Database,
	entry: QuestionEntry,
	key: string,
) {
	db.query(
		`INSERT INTO continuity_questions (${questionColumns}, attribute_key) VALUES (?,?,?,?,?,?,?,?,?)`,
	).run(
		entry.id,
		entry.conversationId,
		entry.attribute,
		entry.state,
		entry.revision,
		entry.askedAt,
		entry.createdAt,
		entry.updatedAt,
		key,
	);
	addEvidence(db, "question", entry.id, entry.conversationId, {
		messages: entry.evidence,
		memoryItemIds: entry.memoryItemIds,
	});
}
export function getQuestion(db: Database, id: string): QuestionEntry | null {
	const row = db
		.query(`SELECT ${questionColumns} FROM continuity_questions WHERE id = ?`)
		.get(id) as Row | null;
	return row ? (mapQuestions(db, [row])[0] ?? null) : null;
}
export function getQuestionByKey(
	db: Database,
	key: string,
): QuestionEntry | null {
	const row = db
		.query(
			`SELECT ${questionColumns} FROM continuity_questions WHERE attribute_key = ?`,
		)
		.get(key) as Row | null;
	return row ? (mapQuestions(db, [row])[0] ?? null) : null;
}
export function changeQuestion(
	db: Database,
	id: string,
	expectedRevision: number | undefined,
	change: { state: QuestionState; askedAt?: string; updatedAt: string },
): boolean {
	const result = db
		.query(
			`UPDATE continuity_questions SET state = ?, revision = revision + 1, updated_at = ?, asked_at = COALESCE(?, asked_at)
			 WHERE id = ?${expectedRevision === undefined ? "" : " AND revision = ?"}`,
		)
		.run(
			change.state,
			change.updatedAt,
			change.askedAt ?? null,
			id,
			...(expectedRevision === undefined ? [] : [expectedRevision]),
		);
	return result.changes === 1;
}
export function countQuestions(db: Database): number {
	return (
		db.query("SELECT COUNT(*) AS n FROM continuity_questions").get() as {
			n: number;
		}
	).n;
}
/** Latest change first. */
export function listQuestions(
	db: Database,
	filter: { conversationId?: string; states?: readonly QuestionState[] },
): QuestionEntry[] {
	const where: string[] = [];
	const values: string[] = [];
	if (filter.conversationId !== undefined) {
		where.push("conversation_id = ?");
		values.push(filter.conversationId);
	}
	if (filter.states) {
		where.push(`state IN (${filter.states.map(() => "?").join(",")})`);
		values.push(...filter.states);
	}
	const rows = db
		.query(
			`SELECT ${questionColumns} FROM continuity_questions${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
			 ORDER BY updated_at DESC, id`,
		)
		.all(...values) as Row[];
	return mapQuestions(db, rows);
}

// ---- forgetting ----

function deleteOwners(
	db: Database,
	ownerKind: OwnerKind,
	ids: readonly string[],
) {
	const table =
		ownerKind === "plan" ? "continuity_plans" : "continuity_questions";
	for (const chunk of chunks(ids)) {
		const marks = chunk.map(() => "?").join(",");
		db.query(`DELETE FROM ${table} WHERE id IN (${marks})`).run(...chunk);
		db.query(
			`DELETE FROM continuity_evidence WHERE owner_kind = ? AND owner_id IN (${marks})`,
		).run(ownerKind, ...chunk);
		if (ownerKind === "plan")
			db.query(`DELETE FROM continuity_plan_search WHERE id IN (${marks})`).run(
				...chunk,
			);
	}
}
function ownersOf(
	db: Database,
	ownerKind: OwnerKind,
	sources: SourceFilter,
): string[] {
	const found = new Set<string>();
	const lookup = (kind: "message" | "memory", ids: readonly string[]) => {
		for (const chunk of chunks([...new Set(ids)]))
			for (const row of db
				.query(
					`SELECT DISTINCT owner_id FROM continuity_evidence WHERE owner_kind = ? AND source_kind = ? AND source_id IN (${chunk.map(() => "?").join(",")})`,
				)
				.all(ownerKind, kind, ...chunk) as Array<{ owner_id: string }>)
				found.add(row.owner_id);
	};
	lookup("message", sources.messageIds);
	lookup("memory", sources.memoryItemIds);
	return [...found];
}
/** Physically deletes the plans and ledger entries that rest on any of the sources. */
export function deleteBySources(
	db: Database,
	sources: SourceFilter,
): { planIds: string[]; questionIds: string[] } {
	const planIds = ownersOf(db, "plan", sources);
	const questionIds = ownersOf(db, "question", sources);
	deleteOwners(db, "plan", planIds);
	deleteOwners(db, "question", questionIds);
	return { planIds, questionIds };
}
/** The sources of the given entries, for the exclusion check of a read. */
export function sourcesOfOwners(
	owners: ReadonlyArray<{ evidence: PlanEvidence[]; memoryItemIds: string[] }>,
): SourceFilter {
	return {
		messageIds: [
			...new Set(owners.flatMap((o) => o.evidence.map((e) => e.messageId))),
		],
		memoryItemIds: [...new Set(owners.flatMap((o) => o.memoryItemIds))],
	};
}
