/**
 * One operation's question and answer (spec 2026-10-13 §7). The tables are no longer written: a command toolchain's
 * question is the agent's assignment question now. They stay with their rows.
 */
export const commandInteractionsMigration = `
CREATE TABLE command_interactions (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 origin_message_id TEXT NOT NULL REFERENCES messages(id),
 origin_run_id TEXT NOT NULL REFERENCES dialogue_runs(id),
 current_run_id TEXT NOT NULL REFERENCES dialogue_runs(id),
 chain_revision_id TEXT NOT NULL,
 function_name TEXT NOT NULL,
 package_revision_id TEXT NOT NULL,
 binding_revision_id TEXT NOT NULL,
 artifact_revision_id TEXT,
 revision INTEGER NOT NULL,
 authority_epoch INTEGER NOT NULL,
 execution_generation INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('waiting_input','ready','invoking','completed','cancelled','expired','indeterminate')),
 question_id TEXT,
 question_prompt TEXT,
 question_schema_ref TEXT,
 question_count INTEGER NOT NULL,
 request_text TEXT,
 input_json TEXT,
 request_id TEXT NOT NULL,
 issued_at TEXT,
 receipt_owner TEXT,
 receipt_operation_id TEXT,
 receipt_digest TEXT,
 end_code TEXT,
 expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 ended_at TEXT,
 body_deleted_at TEXT
);
CREATE INDEX command_interactions_conversation ON command_interactions(conversation_id, created_at);
CREATE INDEX command_interactions_status ON command_interactions(status, expires_at);
CREATE INDEX command_interactions_run ON command_interactions(current_run_id);
CREATE UNIQUE INDEX command_interactions_question ON command_interactions(question_id) WHERE question_id IS NOT NULL;
CREATE TABLE command_interaction_events (
 id TEXT PRIMARY KEY,
 interaction_id TEXT NOT NULL REFERENCES command_interactions(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('question','answer','invoke','cancel','end')),
 event_id TEXT NOT NULL UNIQUE,
 payload_json TEXT,
 created_at TEXT NOT NULL
);
CREATE INDEX command_interaction_events_interaction ON command_interaction_events(interaction_id, created_at);
`;

/** The host-issued choices of an open question (a later migration, so 0005 stays as shipped). */
export const questionChoicesMigration = `ALTER TABLE command_interactions ADD COLUMN question_choices_json TEXT;`;
