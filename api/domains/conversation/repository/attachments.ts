import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { Attachment } from "../contracts/attachments";

export const attachmentsMigration: Migration = {
	id: "conversation/0006-attachments",
	after: ["conversation/0005-retraction"],
	sql: `
CREATE TABLE conversation_attachments (
 id TEXT PRIMARY KEY, principal TEXT NOT NULL, conversation_id TEXT NOT NULL,
 metadata TEXT NOT NULL, original BLOB NOT NULL, bytes BLOB NOT NULL, preview BLOB NOT NULL,
 original_digest TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE message_attachments (
 message_id TEXT NOT NULL REFERENCES messages(id), attachment_id TEXT NOT NULL REFERENCES conversation_attachments(id),
 ordinal INTEGER NOT NULL, PRIMARY KEY(message_id,ordinal), UNIQUE(message_id,attachment_id)
);
CREATE INDEX attachment_pending_expiry ON conversation_attachments(expires_at);
CREATE INDEX message_attachment_id ON message_attachments(attachment_id);
`,
};
function attachmentsReady(db: Database) {
	return !!db
		.query("SELECT 1 FROM sqlite_master WHERE name='conversation_attachments'")
		.get();
}
export function messageAttachments(db: Database, id: string): Attachment[] {
	if (!attachmentsReady(db)) return [];
	return (
		db
			.query(
				"SELECT a.metadata FROM message_attachments m JOIN conversation_attachments a ON a.id=m.attachment_id WHERE m.message_id=? ORDER BY m.ordinal",
			)
			.all(id) as { metadata: string }[]
	).map((r) => JSON.parse(r.metadata));
}
export type AttachmentRow = {
	id: string;
	principal: string;
	conversation_id: string;
	metadata: string;
	bytes: Uint8Array;
	preview: Uint8Array;
	original_digest: string;
	expires_at: number;
};
export function ownedAttachment(
	db: Database,
	id: string,
	principal: string,
	conversationId: string,
): AttachmentRow {
	const row = db
		.query(
			"SELECT * FROM conversation_attachments WHERE id=? AND principal=? AND conversation_id=?",
		)
		.get(id, principal, conversationId) as AttachmentRow | null;
	if (!row) throw new Error("attachment_not_found");
	const linked = db
		.query(
			"SELECT m.retracted_at FROM message_attachments a JOIN messages m ON m.id=a.message_id WHERE a.attachment_id=?",
		)
		.all(id) as { retracted_at: string | null }[];
	if (
		linked.length
			? linked.every((m) => m.retracted_at !== null)
			: row.expires_at < Date.now()
	)
		throw new Error("attachment_source_unavailable");
	return row;
}
export function linkAttachments(
	db: Database,
	messageId: string,
	ids: string[],
	principal: string,
	conversationId: string,
) {
	for (const [ordinal, id] of ids.entries()) {
		ownedAttachment(db, id, principal, conversationId);
		db.query(
			"INSERT INTO message_attachments(message_id,attachment_id,ordinal) VALUES(?,?,?)",
		).run(messageId, id, ordinal);
	}
}
