import type { Migration } from "../../../infrastructure/sqlite";
import {
	dropActiveMigration,
	dropWindowMigration,
	eventsMigration,
	retractActivityMigration,
} from "./events";
import {
	dropShortTermMigration,
	plansMigration,
	shortTermToPlansMigration,
} from "./plans";
export const migration = `
CREATE TABLE continuity_items (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('goal','decision','open_question')),
 text TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','resolved','retracted')),
 revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX continuity_items_conversation ON continuity_items(conversation_id, created_at, id);
CREATE TABLE continuity_revisions (conversation_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
`;
/**
 * Short-term layer: activity and memo kinds, where an item came from, and when it stops mattering.
 * SQLite cannot change a CHECK, so the table is rebuilt (rows keep their ids and positions).
 */
export const shortTermMigration = `
CREATE TABLE continuity_items_v2 (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('goal','decision','open_question','activity','memo')),
 text TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','resolved','retracted')),
 revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 origin TEXT NOT NULL DEFAULT 'user' CHECK(origin IN ('user','agent')),
 source_message_id TEXT, expires_at TEXT
);
INSERT INTO continuity_items_v2 (id, conversation_id, kind, text, status, revision, created_at, updated_at)
 SELECT id, conversation_id, kind, text, status, revision, created_at, updated_at FROM continuity_items ORDER BY rowid;
DROP TABLE continuity_items;
ALTER TABLE continuity_items_v2 RENAME TO continuity_items;
CREATE INDEX continuity_items_conversation ON continuity_items(conversation_id, created_at, id);
`;
/**
 * A note comes from one or more messages. The sources live in their own table (many to many) and the old
 * single `source_message_id` column goes: existing values are copied over first.
 */
export const itemSourceMigration = `
CREATE TABLE continuity_item_source (
 item_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY (item_id, message_id)
);
CREATE INDEX continuity_item_source_message ON continuity_item_source(message_id);
INSERT INTO continuity_item_source (item_id, message_id)
 SELECT id, source_message_id FROM continuity_items WHERE source_message_id IS NOT NULL;
ALTER TABLE continuity_items DROP COLUMN source_message_id;
`;
/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{ id: "continuity/0001-init", sql: migration },
	{
		id: "continuity/0002-short-term",
		sql: shortTermMigration,
		after: ["continuity/0001-init"],
	},
	{
		id: "continuity/0003-item-source",
		sql: itemSourceMigration,
		after: ["continuity/0002-short-term"],
	},
	{
		id: "continuity/0004-events",
		sql: eventsMigration,
		after: ["continuity/0003-item-source"],
	},
	{
		id: "continuity/0005-drop-active",
		sql: dropActiveMigration,
		after: ["continuity/0004-events"],
	},
	{
		id: "continuity/0006-retract-activity",
		sql: retractActivityMigration,
		after: ["continuity/0005-drop-active"],
	},
	{
		id: "continuity/0007-drop-window",
		sql: dropWindowMigration,
		after: ["continuity/0006-retract-activity"],
	},
	{
		id: "continuity/0008-plans",
		sql: plansMigration,
		after: ["continuity/0007-drop-window"],
	},
	{
		id: "continuity/0009-short-term-to-plans",
		sql: shortTermToPlansMigration,
		after: ["continuity/0008-plans"],
	},
	{
		id: "continuity/0010-drop-short-term",
		sql: dropShortTermMigration,
		after: ["continuity/0009-short-term-to-plans"],
	},
];
