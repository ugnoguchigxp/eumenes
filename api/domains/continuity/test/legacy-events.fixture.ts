// Retired bookmark schema from efc8aba7; no product data.
export const legacyEventsSchema = `
CREATE TABLE continuity_events (
	sequence INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	bookmark_id TEXT NOT NULL,
	conversation_id TEXT NOT NULL,
	operation TEXT NOT NULL CHECK(operation IN ('create','revise','deactivate')),
	kind TEXT NOT NULL CHECK(kind IN ('goal','decision','open_question')),
	text TEXT NOT NULL,
	status TEXT NOT NULL CHECK(status IN ('active','inactive')),
	revision INTEGER NOT NULL CHECK(revision >= 1),
	source_message_id TEXT NOT NULL,
	source_digest TEXT NOT NULL,
	origin TEXT NOT NULL CHECK(origin IN ('user_confirmed','user_edited')),
	request_id TEXT NOT NULL,
	request_digest TEXT NOT NULL,
	created_at TEXT NOT NULL,
	UNIQUE(bookmark_id, revision),
	UNIQUE(conversation_id, request_id)
);
CREATE INDEX continuity_events_conversation ON continuity_events(conversation_id, sequence);
CREATE INDEX continuity_events_bookmark ON continuity_events(bookmark_id, sequence);
`;
