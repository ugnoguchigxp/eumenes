import type { Database } from "bun:sqlite";

/**
 * One user-intent judgement of an utterance and the routing chosen with it (the intent gate design, section 6): the
 * judge's raw answer, the routing the host would have chosen without it, the one it chose, and what the model then
 * did. No utterance text and no credential.
 */
export const intentJudgmentsMigration = `
CREATE TABLE dialogue_intent_judgments (
	id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL,
	run_id TEXT NOT NULL,
	message_id TEXT NOT NULL,
	mode TEXT NOT NULL CHECK(mode IN ('shadow','ruri')),
	model TEXT,
	head_revision TEXT,
	choice TEXT,
	probabilities_json TEXT,
	truncated INTEGER,
	history_tokens_dropped INTEGER,
	state_tokens_dropped INTEGER,
	legacy_route TEXT NOT NULL,
	final_route TEXT NOT NULL CHECK(final_route IN ('free','search')),
	duration_ms INTEGER NOT NULL,
	fallback_reason TEXT,
	observed_search INTEGER,
	observed_delegate INTEGER,
	created_at TEXT NOT NULL
);
CREATE INDEX dialogue_intent_judgments_message ON dialogue_intent_judgments(message_id);
`;

/** The record takes the routing that lets no tool be called (`answer`): the table is built again, its rows kept. */
export const intentAnswerRouteMigration = `
CREATE TABLE dialogue_intent_judgments_next (
	id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL,
	run_id TEXT NOT NULL,
	message_id TEXT NOT NULL,
	mode TEXT NOT NULL CHECK(mode IN ('shadow','ruri')),
	model TEXT,
	head_revision TEXT,
	choice TEXT,
	probabilities_json TEXT,
	truncated INTEGER,
	history_tokens_dropped INTEGER,
	state_tokens_dropped INTEGER,
	legacy_route TEXT NOT NULL,
	final_route TEXT NOT NULL CHECK(final_route IN ('free','search','answer')),
	duration_ms INTEGER NOT NULL,
	fallback_reason TEXT,
	observed_search INTEGER,
	observed_delegate INTEGER,
	created_at TEXT NOT NULL
);
INSERT INTO dialogue_intent_judgments_next SELECT * FROM dialogue_intent_judgments;
DROP TABLE dialogue_intent_judgments;
ALTER TABLE dialogue_intent_judgments_next RENAME TO dialogue_intent_judgments;
CREATE INDEX dialogue_intent_judgments_message ON dialogue_intent_judgments(message_id);
`;

export type IntentJudgmentRow = {
	id: string;
	conversationId: string;
	runId: string;
	messageId: string;
	mode: "shadow" | "ruri";
	judgment: {
		model: string;
		headRevision: string | null;
		choice: string;
		probabilities: Record<string, number>;
		truncated: boolean;
		historyTokensDropped: number;
		stateTokensDropped: number;
	} | null;
	legacyRoute: "free";
	finalRoute: "free" | "search" | "answer";
	durationMs: number;
	fallbackReason: string | null;
	observed?: { searched: boolean; delegated: boolean };
	createdAt: string;
};

const flag = (value: boolean | undefined) =>
	value === undefined ? null : value ? 1 : 0;

export function insertIntentJudgment(db: Database, row: IntentJudgmentRow) {
	const j = row.judgment;
	db.query(
		`INSERT INTO dialogue_intent_judgments(id,conversation_id,run_id,message_id,mode,model,head_revision,choice,
		probabilities_json,truncated,history_tokens_dropped,state_tokens_dropped,legacy_route,final_route,duration_ms,
		fallback_reason,observed_search,observed_delegate,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		row.id,
		row.conversationId,
		row.runId,
		row.messageId,
		row.mode,
		j?.model ?? null,
		j?.headRevision ?? null,
		j?.choice ?? null,
		j ? JSON.stringify(j.probabilities) : null,
		j ? (j.truncated ? 1 : 0) : null,
		j?.historyTokensDropped ?? null,
		j?.stateTokensDropped ?? null,
		row.legacyRoute,
		row.finalRoute,
		Math.max(0, Math.round(row.durationMs)),
		row.fallbackReason,
		flag(row.observed?.searched),
		flag(row.observed?.delegated),
		row.createdAt,
	);
}

/** What the model did in the generation the judgement belongs to, once it ended. */
export function observeIntentJudgment(
	db: Database,
	id: string,
	observed: { searched: boolean; delegated: boolean },
) {
	db.query(
		"UPDATE dialogue_intent_judgments SET observed_search=?,observed_delegate=? WHERE id=?",
	).run(flag(observed.searched), flag(observed.delegated), id);
}

/** The judgements of a message, oldest first (one per generation that judged it). */
export function intentJudgmentsOfMessage(db: Database, messageId: string) {
	return db
		.query(
			`SELECT id,run_id AS runId,mode,model,head_revision AS headRevision,choice,probabilities_json AS probabilities,
			legacy_route AS legacyRoute,final_route AS finalRoute,duration_ms AS durationMs,fallback_reason AS fallbackReason,
			observed_search AS observedSearch,observed_delegate AS observedDelegate
			FROM dialogue_intent_judgments WHERE message_id=? ORDER BY created_at, rowid`,
		)
		.all(messageId) as Array<{
		id: string;
		runId: string;
		mode: string;
		model: string | null;
		headRevision: string | null;
		choice: string | null;
		probabilities: string | null;
		legacyRoute: string;
		finalRoute: string;
		durationMs: number;
		fallbackReason: string | null;
		observedSearch: number | null;
		observedDelegate: number | null;
	}>;
}
