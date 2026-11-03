import type { Database } from "bun:sqlite";

/** The retained utterances, without tool arguments/results, attachments or delivery metadata. */
export function routingExportUtterance(
	db: Database,
	conversationId: string,
	messageId: string | null,
	runId?: string,
) {
	if (!messageId && runId) {
		const linked = db
			.query(
				"SELECT id FROM messages WHERE conversation_id=? AND run_id=? AND role='user' AND retracted_at IS NULL LIMIT 2",
			)
			.all(conversationId, runId) as Array<{ id: string }>;
		if (linked.length === 1) messageId = linked[0]!.id;
	}
	const current = messageId
		? (db
				.query(
					"SELECT seq,text,created_at FROM conversation_utterances WHERE conversation_id=? AND message_id=? AND speaker='user' AND retracted_at IS NULL",
				)
				.get(conversationId, messageId) as {
				seq: number;
				text: string;
				created_at: string;
			} | null)
		: null;
	if (current) {
		const previous = (speaker: string) =>
			(
				db
					.query(
						"SELECT text FROM conversation_utterances WHERE conversation_id=? AND seq<? AND speaker=? AND retracted_at IS NULL ORDER BY seq DESC LIMIT 1",
					)
					.get(conversationId, current.seq, speaker) as { text: string } | null
			)?.text ?? null;
		return {
			messageId,
			text: current.text,
			timestamp: current.created_at,
			previousUser: previous("user"),
			previousAgent: previous("agent"),
		};
	}
	const message = messageId
		? (db
				.query(
					"SELECT rowid,text,created_at FROM messages WHERE conversation_id=? AND id=? AND role='user' AND retracted_at IS NULL",
				)
				.get(conversationId, messageId) as {
				rowid: number;
				text: string;
				created_at: string;
			} | null)
		: null;
	const previous = (role: string) =>
		message
			? ((
					db
						.query(
							"SELECT text FROM messages WHERE conversation_id=? AND role=? AND retracted_at IS NULL AND (created_at<? OR (created_at=? AND rowid<?)) ORDER BY created_at DESC,rowid DESC LIMIT 1",
						)
						.get(
							conversationId,
							role,
							message.created_at,
							message.created_at,
							message.rowid,
						) as { text: string } | null
				)?.text ?? null)
			: null;
	return {
		messageId,
		text: message?.text ?? null,
		timestamp: message?.created_at ?? null,
		previousUser: previous("user"),
		previousAgent: previous("assistant"),
	};
}
