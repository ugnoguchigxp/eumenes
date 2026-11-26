import type { Database } from "bun:sqlite";

/** The last adopted conversational search owns the single slot. A late settlement of an older run cannot replace it. */
export function saveLatestSearch(
	db: Database,
	runId: string,
	messageId: string,
	search: unknown,
) {
	if (search === undefined) return;
	db.query(
		`INSERT INTO dialogue_search_offers(conversation_id,run_seq,message_id,search_json)
		SELECT conversation_id,seq,?,? FROM dialogue_runs WHERE id=?
		ON CONFLICT(conversation_id) DO UPDATE SET run_seq=excluded.run_seq,message_id=excluded.message_id,search_json=excluded.search_json
		WHERE excluded.run_seq>=dialogue_search_offers.run_seq`,
	).run(messageId, JSON.stringify(search), runId);
}

export function latestSearch(db: Database, conversationId: string) {
	return db
		.query<{ message_id: string; search_json: string | null }, [string]>(
			"SELECT message_id,search_json FROM dialogue_search_offers WHERE conversation_id=?",
		)
		.get(conversationId);
}

export function clearOffersFromMessage(db: Database, messageId: string) {
	db.query(
		`UPDATE dialogue_search_offers SET search_json=NULL WHERE message_id=? OR EXISTS
		(SELECT 1 FROM json_each(search_json,'$.sources') WHERE json_extract(value,'$.id')=?)`,
	).run(messageId, messageId);
}
