import type { Migration } from "../../infrastructure/sqlite";

export const migrations: readonly Migration[] = [
	{
		id: "kanban/0001-cards",
		after: ["queue/0001-init"],
		sql: `
CREATE TABLE kanban_board (
 id INTEGER PRIMARY KEY CHECK(id = 1),
 revision INTEGER NOT NULL
);
INSERT INTO kanban_board(id, revision) VALUES(1, 0);
CREATE TABLE kanban_cards (
 id TEXT PRIMARY KEY,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 title TEXT NOT NULL,
 prompt TEXT NOT NULL,
 column_name TEXT NOT NULL CHECK(column_name IN ('todo','running','finished')),
 label TEXT CHECK(label IN ('done','blocker')),
 reviewed INTEGER NOT NULL DEFAULT 0,
 commit_push_reported INTEGER NOT NULL DEFAULT 0,
 project_id TEXT NOT NULL,
 position INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 CHECK((column_name = 'finished') = (label IS NOT NULL))
);
CREATE INDEX kanban_cards_column ON kanban_cards(column_name, position, id);
CREATE TABLE kanban_receipts (
 request_id TEXT PRIMARY KEY,
 operation TEXT NOT NULL,
 input_digest TEXT NOT NULL,
 receipt_json TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
`,
	},
	{
		id: "kanban/0002-runs",
		after: ["kanban/0001-cards"],
		sql: `
ALTER TABLE kanban_cards ADD COLUMN reason TEXT;
ALTER TABLE kanban_cards ADD COLUMN claude_session_id TEXT;
ALTER TABLE kanban_cards ADD COLUMN current_run_id TEXT;
ALTER TABLE kanban_cards ADD COLUMN last_report TEXT;
ALTER TABLE kanban_cards ADD COLUMN files_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE kanban_board ADD COLUMN queue_state TEXT NOT NULL DEFAULT 'running'
 CHECK(queue_state IN ('running','paused'));
ALTER TABLE kanban_board ADD COLUMN queue_reason TEXT;
CREATE TABLE kanban_runs (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 card_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('task','followup','commit_push')),
 state TEXT NOT NULL CHECK(state IN ('waiting_turn','handed','completed','blocked','cancelled')),
 reason TEXT,
 card_revision INTEGER NOT NULL,
 title TEXT NOT NULL,
 prompt TEXT NOT NULL,
 body TEXT NOT NULL,
 claude_session_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 origin TEXT NOT NULL CHECK(origin IN ('board','conversation')),
 conversation_id TEXT,
 stop_requested INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 handed_at INTEGER,
 finished_at INTEGER
);
CREATE INDEX kanban_runs_state ON kanban_runs(state, seq);
CREATE INDEX kanban_runs_card ON kanban_runs(card_id, seq);
CREATE TABLE kanban_notices (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL CHECK(kind IN ('done','blocker','waiting','commit_push','queue_paused')),
 card_id TEXT,
 run_id TEXT,
 text TEXT NOT NULL,
 is_read INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX kanban_notices_run_kind ON kanban_notices(run_id, kind) WHERE run_id IS NOT NULL;
`,
	},
];
