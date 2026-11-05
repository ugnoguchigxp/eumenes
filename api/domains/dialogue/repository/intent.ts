/**
 * The user-intent judgements of the routing the router package replaced (the intent gate design, section 6; spec
 * router-package-integration 2026-11-04): nothing writes them any more. The applied migrations stay, unchanged; the
 * rows are the user's to remove.
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
