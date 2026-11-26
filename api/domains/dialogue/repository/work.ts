/**
 * The first forms of the conversation's TODOs and confirmations (the ContextWindow specification, sections 6.7 and
 * 10.1), kept as they were applied. The ledger is retired and its tables are dropped by
 * `dialogue/0049-drop-retired-todos` (retired-todos.ts).
 */
export const workMigration = `
CREATE TABLE dialogue_work (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, run_id TEXT NOT NULL,
 toolchain_id TEXT NOT NULL, toolchain_revision_id TEXT NOT NULL, execution TEXT NOT NULL,
 request TEXT NOT NULL, title TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('todo','waiting','done')),
 outcome TEXT, revision INTEGER NOT NULL, question_id TEXT, question TEXT, result_json TEXT,
 source_ref TEXT, dedupe_key TEXT NOT NULL,
 archive_requested TEXT, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX dialogue_work_dedupe ON dialogue_work(conversation_id, dedupe_key);
CREATE INDEX dialogue_work_open ON dialogue_work(conversation_id, archived_at, created_at);
CREATE INDEX dialogue_work_run ON dialogue_work(run_id);
CREATE INDEX dialogue_work_source ON dialogue_work(source_ref);
CREATE TABLE dialogue_confirmations (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, toolchain_id TEXT NOT NULL,
 toolchain_revision_id TEXT NOT NULL, request TEXT NOT NULL, inputs_json TEXT,
 impact TEXT NOT NULL, statement_delivery_key TEXT NOT NULL, issued_at TEXT NOT NULL,
 expires_at TEXT NOT NULL, used_at TEXT, superseded_at TEXT
);
CREATE INDEX dialogue_confirmations_open ON dialogue_confirmations(conversation_id, used_at, superseded_at);
`;

/** The user's messages each TODO and confirmation comes from, so forgetting one reaches them (section 13). */
export const workOriginsMigration = `
ALTER TABLE dialogue_work ADD COLUMN message_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE dialogue_confirmations ADD COLUMN message_ids_json TEXT NOT NULL DEFAULT '[]';`;

/**
 * The short number the model reads a TODO (`t<ref>`) and a confirmation (`c<ref>`) by: per conversation, in
 * creation order, never changed (the ContextWindow layout specification, section 6).
 */
export const workRefsMigration = `
ALTER TABLE dialogue_work ADD COLUMN ref INTEGER;
UPDATE dialogue_work SET ref = (SELECT COUNT(*) FROM dialogue_work w WHERE w.conversation_id = dialogue_work.conversation_id
 AND (w.created_at < dialogue_work.created_at OR (w.created_at = dialogue_work.created_at AND w.rowid <= dialogue_work.rowid)));
CREATE UNIQUE INDEX dialogue_work_ref ON dialogue_work(conversation_id, ref);
ALTER TABLE dialogue_confirmations ADD COLUMN ref INTEGER;
UPDATE dialogue_confirmations SET ref = (SELECT COUNT(*) FROM dialogue_confirmations c
 WHERE c.conversation_id = dialogue_confirmations.conversation_id
 AND (c.issued_at < dialogue_confirmations.issued_at OR (c.issued_at = dialogue_confirmations.issued_at AND c.rowid <= dialogue_confirmations.rowid)));
CREATE UNIQUE INDEX dialogue_confirmations_ref ON dialogue_confirmations(conversation_id, ref);`;

/** The saved item a confirmed request changes, and how its unsaved edits are resolved: the approval hands them over. */
export const confirmationTargetMigration = `
ALTER TABLE dialogue_confirmations ADD COLUMN target TEXT;
ALTER TABLE dialogue_confirmations ADD COLUMN resolve_unsaved TEXT;`;

/** The name the confirmed item was shown by: the open confirmations name it, so two on one request stay apart. */
export const confirmationTargetLabelMigration = `
ALTER TABLE dialogue_confirmations ADD COLUMN target_label TEXT;`;

/** The user's own words a confirmed request was made from (the quote of its statement and the TODO's title). */
export const confirmationWordsMigration = `
ALTER TABLE dialogue_confirmations ADD COLUMN words TEXT;`;

/**
 * A TODO is archived as it finishes and the user is told by a notice on screen, unread until `notice_read_at` (the
 * TODO completion notice design, 2026-10-29). TODOs archived before are read; finished ones that still waited for
 * their spoken report are archived now and told once.
 */
export const workNoticesMigration = `
ALTER TABLE dialogue_work ADD COLUMN notice_read_at TEXT;
UPDATE dialogue_work SET notice_read_at = archived_at WHERE archived_at IS NOT NULL;
UPDATE dialogue_work SET archived_at = updated_at WHERE status = 'done' AND archived_at IS NULL;
ALTER TABLE dialogue_work DROP COLUMN archive_requested;
CREATE INDEX dialogue_work_archived ON dialogue_work(archived_at);`;
