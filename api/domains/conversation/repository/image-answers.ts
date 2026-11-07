import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { ImageAnswerTrace, ImageReference } from "../contracts/history";

// Deployed SQL: keep its checksum; schema changes belong in a later migration.
export const imageAnswersMigration: Migration = {
	id: "conversation/0017-image-answers",
	after: ["conversation/0016-utterance-notice"],
	sql: `CREATE TABLE conversation_image_answers (
 message_id TEXT NOT NULL REFERENCES messages(id), ordinal INTEGER NOT NULL,
 source_message_id TEXT NOT NULL REFERENCES messages(id), attachment_id TEXT NOT NULL REFERENCES conversation_attachments(id),
 answer_revision TEXT NOT NULL, source_revision TEXT NOT NULL,
 request_id TEXT NOT NULL, attempt_id TEXT NOT NULL, adopted_at TEXT NOT NULL,
 PRIMARY KEY(message_id, ordinal)
);`,
};

/** Map recorded revisions to their outbox events at adoption; an unresolvable revision stays invalid. */
export const imageAnswerSequencesMigration: Migration = {
	id: "conversation/0018-image-answer-sequences",
	after: ["conversation/0017-image-answers"],
	sql: `CREATE TABLE conversation_image_answers_sequences (
 message_id TEXT NOT NULL REFERENCES messages(id), ordinal INTEGER NOT NULL,
 source_message_id TEXT NOT NULL REFERENCES messages(id), attachment_id TEXT NOT NULL REFERENCES conversation_attachments(id),
 answer_seq INTEGER NOT NULL, source_seq INTEGER NOT NULL,
 request_id TEXT NOT NULL, attempt_id TEXT NOT NULL, adopted_at TEXT NOT NULL,
 PRIMARY KEY(message_id, ordinal)
);
INSERT INTO conversation_image_answers_sequences
SELECT e.message_id, e.ordinal, e.source_message_id, e.attachment_id,
 COALESCE((SELECT MAX(o.seq) FROM conversation_outbox o
  WHERE o.source_id=e.message_id AND o.revision=e.answer_revision AND o.occurred_at<=e.adopted_at), -1),
 COALESCE((SELECT MAX(o.seq) FROM conversation_outbox o
  WHERE o.source_id=e.source_message_id AND o.revision=e.source_revision AND o.occurred_at<=e.adopted_at), -1),
 e.request_id, e.attempt_id, e.adopted_at
FROM conversation_image_answers e;
DROP TABLE conversation_image_answers;
ALTER TABLE conversation_image_answers_sequences RENAME TO conversation_image_answers;`,
};

function liveRevision(db: Database, id: string) {
	return db
		.query(
			`SELECT m.conversation_id, m.role, o.seq
FROM messages m JOIN conversation_outbox o ON o.seq=(SELECT MAX(seq) FROM conversation_outbox WHERE source_id=m.id)
WHERE m.id=? AND m.retracted_at IS NULL`,
		)
		.get(id) as {
		conversation_id: string;
		role: string;
		seq: number;
	} | null;
}

/** Called by the host only after accepting the actual model receipt, in the answer's writer transaction. */
export function recordImageAnswer(
	db: Database,
	messageId: string,
	trace: ImageAnswerTrace,
	adoptedAt: string,
) {
	const answer = liveRevision(db, messageId);
	if (
		!answer ||
		answer.role !== "assistant" ||
		!trace.inputs.length ||
		!trace.requestId ||
		!trace.attemptId
	)
		throw new Error("image_answer_evidence_invalid");
	let ordinal = 0;
	for (const input of trace.inputs) {
		const source = liveRevision(db, input.messageId);
		const attachments = db
			.query(
				"SELECT attachment_id FROM message_attachments WHERE message_id=? ORDER BY ordinal",
			)
			.all(input.messageId) as Array<{ attachment_id: string }>;
		if (
			!source ||
			source.role !== "user" ||
			source.conversation_id !== answer.conversation_id ||
			!input.attachmentIds.length ||
			JSON.stringify(attachments.map((a) => a.attachment_id)) !==
				JSON.stringify(input.attachmentIds)
		)
			throw new Error("image_answer_source_invalid");
		for (const id of input.attachmentIds)
			db.query(
				"INSERT INTO conversation_image_answers VALUES(?,?,?,?,?,?,?,?,?)",
			).run(
				messageId,
				ordinal++,
				input.messageId,
				id,
				answer.seq,
				source.seq,
				trace.requestId,
				trace.attemptId,
				adoptedAt,
			);
	}
}

/** null means no recorded evidence; [] means evidence exists but its source or answer changed. */
export function imageAnswerReferences(
	db: Database,
	messageId: string,
): ImageReference[] | null {
	if (
		!db
			.query(
				"SELECT 1 FROM sqlite_master WHERE name='conversation_image_answers'",
			)
			.get()
	)
		return null;
	const rows = db
		.query(
			"SELECT * FROM conversation_image_answers WHERE message_id=? ORDER BY ordinal",
		)
		.all(messageId) as Array<{
		source_message_id: string;
		attachment_id: string;
		answer_seq: number;
		source_seq: number;
		request_id: string;
		attempt_id: string;
		adopted_at: string;
	}>;
	if (!rows.length) return null;
	const answer = liveRevision(db, messageId);
	const refs = new Map<string, ImageReference>();
	for (const row of rows) {
		const source = liveRevision(db, row.source_message_id);
		if (
			!answer ||
			answer.seq !== row.answer_seq ||
			!source ||
			source.seq !== row.source_seq ||
			source.conversation_id !== answer.conversation_id
		)
			return [];
		let ref = refs.get(row.source_message_id);
		if (!ref) {
			ref = {
				messageId: row.source_message_id,
				attachmentIds: [],
				answerEvidence: {
					requestId: row.request_id,
					attemptId: row.attempt_id,
					adoptedAt: row.adopted_at,
				},
			};
			refs.set(row.source_message_id, ref);
		}
		ref.attachmentIds.push(row.attachment_id);
	}
	return [...refs.values()];
}
