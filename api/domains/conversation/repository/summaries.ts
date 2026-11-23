import type { Database } from "bun:sqlite";
import type {
	ConversationSummary,
	ConversationSummaryKind,
	ConversationSummaryState,
} from "../contracts/input";

/**
 * Persisted compacted summaries (`## Summary`) for cache-first conversation compaction
 * (`spec/conversation-cache-compaction-and-history-design-2026-11-22.md`, §6.1).
 */
export const conversationSummaryMigration = {
	id: "conversation/0020-conversation-summaries",
	after: ["conversation/0019-message-displays"],
	sql: `
CREATE TABLE conversation_summaries (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('staged','active','superseded','retracted')),
 base_cut_revision INTEGER NOT NULL,
 covered_from_seq INTEGER NOT NULL,
 covered_through_seq INTEGER NOT NULL,
 summary_text TEXT NOT NULL,
 source_refs_json TEXT NOT NULL,
 token_estimate INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('llm','mechanical')),
 created_at TEXT NOT NULL,
 activated_at TEXT,
 retracted_at TEXT
);
CREATE INDEX conversation_summaries_lookup
 ON conversation_summaries(conversation_id, state, base_cut_revision);
`,
};

/** Earlier summaries can contain replayed tool output whose source manifest had already been purged. */
export const resetUnverifiedSummariesMigration = {
	id: "conversation/0021-reset-unverified-summaries",
	after: [conversationSummaryMigration.id],
	sql: `
UPDATE conversation_cuts SET revision = revision + 1
 WHERE conversation_id IN (SELECT conversation_id FROM conversation_summaries WHERE state IN ('active','staged'));
DELETE FROM conversation_summaries;
`,
};

const readyCache = new WeakMap<Database, boolean>();
export function summariesReady(db: Database): boolean {
	let value = readyCache.get(db);
	if (value === undefined) {
		value = !!db
			.query(
				"SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_summaries'",
			)
			.get();
		readyCache.set(db, value);
	}
	return value;
}

type SummaryRow = {
	id: string;
	conversation_id: string;
	state: ConversationSummaryState;
	base_cut_revision: number;
	covered_from_seq: number;
	covered_through_seq: number;
	summary_text: string;
	source_refs_json: string;
	token_estimate: number;
	kind: ConversationSummaryKind;
	created_at: string;
	activated_at: string | null;
	retracted_at: string | null;
};

const COLUMNS =
	"id, conversation_id, state, base_cut_revision, covered_from_seq, covered_through_seq, summary_text, source_refs_json, token_estimate, kind, created_at, activated_at, retracted_at";

function parseRefs(raw: string): string[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((v): v is string => typeof v === "string")
			: [];
	} catch {
		return [];
	}
}

const summaryOf = (row: SummaryRow): ConversationSummary => ({
	id: row.id,
	conversationId: row.conversation_id,
	state: row.state,
	baseCutRevision: row.base_cut_revision,
	coveredFromSeq: row.covered_from_seq,
	coveredThroughSeq: row.covered_through_seq,
	text: row.summary_text,
	sourceRefs: parseRefs(row.source_refs_json),
	tokenEstimate: row.token_estimate,
	kind: row.kind,
	createdAt: row.created_at,
	activatedAt: row.activated_at,
	retractedAt: row.retracted_at,
});

export function activeSummary(
	db: Database,
	conversationId: string,
): ConversationSummary | null {
	if (!summariesReady(db)) return null;
	const row = db
		.query(
			`SELECT ${COLUMNS} FROM conversation_summaries WHERE conversation_id = ? AND state = 'active' AND retracted_at IS NULL ORDER BY activated_at DESC, rowid DESC LIMIT 1`,
		)
		.get(conversationId) as SummaryRow | null;
	return row ? summaryOf(row) : null;
}

export function stagedSummary(
	db: Database,
	conversationId: string,
	baseCutRevision: number,
): ConversationSummary | null {
	if (!summariesReady(db)) return null;
	const row = db
		.query(
			`SELECT ${COLUMNS} FROM conversation_summaries WHERE conversation_id = ? AND state = 'staged' AND base_cut_revision = ? AND retracted_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`,
		)
		.get(conversationId, baseCutRevision) as SummaryRow | null;
	return row ? summaryOf(row) : null;
}

export type SaveSummaryInput = {
	id: string;
	conversationId: string;
	baseCutRevision: number;
	coveredFromSeq: number;
	coveredThroughSeq: number;
	text: string;
	sourceRefs: readonly string[];
	tokenEstimate: number;
	kind: ConversationSummaryKind;
	at: string;
};

/** Stores a background pre-computed summary as `staged`, superseding any older staged row of the conversation. */
export function saveStagedSummary(
	db: Database,
	input: SaveSummaryInput,
): ConversationSummary | null {
	if (!summariesReady(db)) return null;
	db.query(
		"UPDATE conversation_summaries SET state = 'superseded' WHERE conversation_id = ? AND state = 'staged'",
	).run(input.conversationId);
	db.query(
		`INSERT INTO conversation_summaries (
		 id, conversation_id, state, base_cut_revision, covered_from_seq, covered_through_seq,
		 summary_text, source_refs_json, token_estimate, kind, created_at, activated_at, retracted_at
		) VALUES (?,?, 'staged', ?,?,?,?,?,?,?,?, NULL, NULL)`,
	).run(
		input.id,
		input.conversationId,
		input.baseCutRevision,
		input.coveredFromSeq,
		input.coveredThroughSeq,
		input.text,
		JSON.stringify([...new Set(input.sourceRefs)]),
		input.tokenEstimate,
		input.kind,
		input.at,
	);
	return stagedSummary(db, input.conversationId, input.baseCutRevision);
}

/** Promotes a matching `staged` summary to `active`, superseding any previous `active` summary. */
export function activateStagedSummary(
	db: Database,
	conversationId: string,
	summaryId: string,
	at: string,
): ConversationSummary | null {
	if (!summariesReady(db)) return null;
	const target = db
		.query(
			`SELECT ${COLUMNS} FROM conversation_summaries WHERE id = ? AND conversation_id = ? AND state = 'staged' AND retracted_at IS NULL`,
		)
		.get(summaryId, conversationId) as SummaryRow | null;
	if (!target) return null;
	db.query(
		"UPDATE conversation_summaries SET state = 'superseded' WHERE conversation_id = ? AND state = 'active'",
	).run(conversationId);
	db.query(
		"UPDATE conversation_summaries SET state = 'active', activated_at = ? WHERE id = ?",
	).run(at, summaryId);
	return activeSummary(db, conversationId);
}

/** Atomically replaces the active summary (used for mechanical fallback compaction) and clears stale staged rows. */
export function replaceActiveSummary(
	db: Database,
	input: SaveSummaryInput,
): ConversationSummary | null {
	if (!summariesReady(db)) return null;
	db.query(
		"UPDATE conversation_summaries SET state = 'superseded' WHERE conversation_id = ? AND state IN ('active','staged')",
	).run(input.conversationId);
	db.query(
		`INSERT INTO conversation_summaries (
		 id, conversation_id, state, base_cut_revision, covered_from_seq, covered_through_seq,
		 summary_text, source_refs_json, token_estimate, kind, created_at, activated_at, retracted_at
		) VALUES (?,?, 'active', ?,?,?,?,?,?,?,?,?, NULL)`,
	).run(
		input.id,
		input.conversationId,
		input.baseCutRevision,
		input.coveredFromSeq,
		input.coveredThroughSeq,
		input.text,
		JSON.stringify([...new Set(input.sourceRefs)]),
		input.tokenEstimate,
		input.kind,
		input.at,
		input.at,
	);
	return activeSummary(db, input.conversationId);
}

/** Clears active and staged summaries on session reset (30-minute gap or explicit clear). */
export function clearSummaries(db: Database, conversationId: string): void {
	if (!summariesReady(db)) return;
	db.query(
		"UPDATE conversation_summaries SET state = 'superseded' WHERE conversation_id = ? AND state IN ('active','staged')",
	).run(conversationId);
}

/** Supersedes pending staged summaries when a cut advances without promoting them, keeping any active summary intact. */
export function clearStagedSummaries(
	db: Database,
	conversationId: string,
): void {
	if (!summariesReady(db)) return;
	db.query(
		"UPDATE conversation_summaries SET state = 'superseded' WHERE conversation_id = ? AND state = 'staged'",
	).run(conversationId);
}

/**
 * Scrubs every version derived from a withdrawn source. Only visible or pending summaries affect the current cut.
 * Returns the distinct conversation IDs affected so callers can mark cuts due for forgetting.
 */
export function retractSummariesBySourceRefs(
	db: Database,
	sourceRefs: readonly string[],
	at: string,
): string[] {
	if (!sourceRefs.length || !summariesReady(db)) return [];
	const rows = db
		.query(
			`SELECT id, conversation_id, state FROM conversation_summaries
			 WHERE retracted_at IS NULL
			 AND EXISTS (SELECT 1 FROM json_each(source_refs_json) r WHERE r.value IN (SELECT value FROM json_each(?)))`,
		)
		.all(JSON.stringify([...new Set(sourceRefs)])) as Array<{
		id: string;
		conversation_id: string;
		state: ConversationSummaryState;
	}>;
	if (!rows.length) return [];
	const conversations = new Set<string>();
	for (const row of rows) {
		db.query(
			"UPDATE conversation_summaries SET state = 'retracted', summary_text = '', retracted_at = ? WHERE id = ?",
		).run(at, row.id);
		if (row.state !== "superseded") conversations.add(row.conversation_id);
	}
	return [...conversations];
}
