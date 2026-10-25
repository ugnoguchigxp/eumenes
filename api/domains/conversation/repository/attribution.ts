import type { Database } from "bun:sqlite";
import { attributionSchema, type Message } from "../contracts";
export const attributionMigration = {
	id: "conversation/0010-attribution",
	after: ["conversation/0009-message-delivery"],
	sql: "CREATE TABLE message_attributions(message_id TEXT PRIMARY KEY REFERENCES messages(id), data_json TEXT NOT NULL);",
};
const ready = new WeakMap<Database, boolean>();
function available(db: Database) {
	let value = ready.get(db);
	if (value === undefined) {
		value = !!db
			.query(
				"SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_attributions'",
			)
			.get();
		ready.set(db, value);
	}
	return value;
}
export function readAttribution(db: Database, id: string) {
	if (!available(db)) return {};
	const row = db
		.query("SELECT data_json FROM message_attributions WHERE message_id=?")
		.get(id) as { data_json: string } | null;
	return row
		? { attribution: attributionSchema.parse(JSON.parse(row.data_json)) }
		: {};
}
export function writeAttribution(db: Database, message: Message) {
	if (!message.attribution) return;
	if (!available(db)) throw new Error("message_attribution_unavailable");
	db.query("INSERT INTO message_attributions VALUES(?,?)").run(
		message.id,
		JSON.stringify(attributionSchema.parse(message.attribution)),
	);
}
