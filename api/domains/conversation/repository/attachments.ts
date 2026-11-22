import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { Attachment } from "../contracts/attachments";
import type { ImageReference } from "../contracts/history";
import { inputReady } from "./input";

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
/**
 * Whether a user's utterance that stands in the conversation has an attachment on its message: one `EXISTS`, which
 * stops at the first one (each utterance is looked up by the attachment links' key, nothing is read into memory). A
 * retracted utterance or message does not count, as with `imageInputReferences`.
 */
export function hasImageInputs(db: Database, conversationId: string): boolean {
	if (!attachmentsReady(db) || !inputReady(db)) return false;
	const row = db
		.query<{ present: number }, [string]>(
			`SELECT EXISTS(
SELECT 1 FROM conversation_utterances u
WHERE u.conversation_id=? AND u.speaker='user' AND u.retracted_at IS NULL AND u.message_id IS NOT NULL
 AND EXISTS(SELECT 1 FROM message_attachments a WHERE a.message_id=u.message_id)
 AND EXISTS(SELECT 1 FROM messages m WHERE m.id=u.message_id AND m.retracted_at IS NULL)
) AS present`,
		)
		.get(conversationId);
	return row?.present === 1;
}
/** Metadata only, scoped to the target's conversation and the newest image input of its exchange. */
export function imageInputReferences(
	db: Database,
	messageId: string,
): ImageReference[] {
	if (!attachmentsReady(db)) return [];
	const rows = db
		.query(
			`
SELECT input.id AS message_id, a.attachment_id
FROM messages target JOIN messages input ON input.conversation_id=target.conversation_id
 AND ((target.role='user' AND input.id=target.id)
 OR (target.role='assistant' AND input.rowid=(
 SELECT MAX(candidate.rowid) FROM messages candidate
 WHERE candidate.conversation_id=target.conversation_id AND candidate.role='user' AND candidate.run_id=target.run_id
 AND EXISTS(SELECT 1 FROM message_attachments linked WHERE linked.message_id=candidate.id))))
JOIN message_attachments a ON a.message_id=input.id
WHERE target.id=? AND target.retracted_at IS NULL AND input.retracted_at IS NULL
ORDER BY input.rowid DESC, a.ordinal
`,
		)
		.all(messageId) as Array<{ message_id: string; attachment_id: string }>;
	const first = rows[0];
	return first
		? [
				{
					messageId: first.message_id,
					attachmentIds: rows
						.filter((r) => r.message_id === first.message_id)
						.map((r) => r.attachment_id),
				},
			]
		: [];
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
