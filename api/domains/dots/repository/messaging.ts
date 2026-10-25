import type { Database } from "bun:sqlite";
import type {
	MessageConversation,
	MessagingSetting,
	OutgoingMessage,
	SavedMessageReply,
} from "../contracts/messaging";
function read<T>(db: Database, table: string, id: string): T | null {
	const r = db.query(`SELECT data_json FROM ${table} WHERE id=?`).get(id) as {
		data_json: string;
	} | null;
	return r ? (JSON.parse(r.data_json) as T) : null;
}
export const setting = (db: Database, id: string) =>
	read<MessagingSetting>(db, "dots_messaging_settings", id) ?? {
		connectionRef: id,
		enabled: false,
		revision: 0,
		epoch: 0,
		verifiedAt: null,
	};
export const thread = (db: Database, id: string) =>
	read<MessageConversation>(db, "dots_message_conversations", id);
export const message = (db: Database, id: string) =>
	read<OutgoingMessage>(db, "dots_messages", id);
export const reply = (db: Database, id: string) =>
	read<SavedMessageReply>(db, "dots_message_replies", id);
export function byRequest(
	db: Database,
	table: "dots_messages" | "dots_message_conversations",
	id: string,
) {
	const r = db.query(`SELECT id FROM ${table} WHERE request_id=?`).get(id) as {
		id: string;
	} | null;
	return r?.id ?? null;
}
export function saveSetting(db: Database, s: MessagingSetting) {
	db.query(
		"INSERT INTO dots_messaging_settings VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json",
	).run(s.connectionRef, JSON.stringify(s));
}
export function saveThread(db: Database, t: MessageConversation) {
	db.query(
		"INSERT INTO dots_message_conversations VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json",
	).run(
		t.id,
		t.connectionRef,
		t.requestId,
		t.conversationId,
		JSON.stringify(t),
	);
}
export function saveMessage(db: Database, m: OutgoingMessage) {
	db.query(
		"INSERT INTO dots_messages VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json",
	).run(m.id, m.threadId, m.requestId, m.sequence, JSON.stringify(m));
}
export function saveReply(db: Database, r: SavedMessageReply) {
	db.query("INSERT INTO dots_message_replies VALUES(?,?,?,?)").run(
		r.id,
		r.messageId,
		r.threadId,
		JSON.stringify(r),
	);
}
export function messages(
	db: Database,
	threadId: string,
	after = 0,
	limit = 50,
): OutgoingMessage[] {
	return (
		db
			.query(
				"SELECT data_json FROM dots_messages WHERE thread_id=? AND sequence>? ORDER BY sequence LIMIT ?",
			)
			.all(threadId, after, limit) as { data_json: string }[]
	).map((x) => JSON.parse(x.data_json));
}
export function allMessages(db: Database): OutgoingMessage[] {
	return (
		db.query("SELECT data_json FROM dots_messages ORDER BY rowid").all() as {
			data_json: string;
		}[]
	).map((x) => JSON.parse(x.data_json));
}

export function threads(db: Database): MessageConversation[] {
	return (
		db
			.query("SELECT data_json FROM dots_message_conversations ORDER BY rowid")
			.all() as { data_json: string }[]
	).map((x) => JSON.parse(x.data_json));
}
export function delivery(db: Database, commandId: string) {
	const r = db
		.query("SELECT data_json FROM dots_deliveries WHERE command_id=?")
		.get(commandId) as { data_json: string } | null;
	return r
		? (JSON.parse(r.data_json) as { state: string; httpStatus: number | null })
		: null;
}

export function latestAnswered(
	db: Database,
	threadId: string,
	epoch: number,
): OutgoingMessage | null {
	const r = db
		.query(
			"SELECT data_json FROM dots_messages WHERE thread_id=? AND json_extract(data_json,'$.state')='answered' AND json_extract(data_json,'$.redacted')=0 AND json_extract(data_json,'$.settingsEpoch')=? ORDER BY sequence DESC LIMIT 1",
		)
		.get(threadId, epoch) as { data_json: string } | null;
	return r ? JSON.parse(r.data_json) : null;
}
