import type { Database } from "bun:sqlite";
import type { LiveConversationPort } from "../contracts";
import { session } from "../repository";

type Segment = {
	id: string;
	speaker: "user" | "assistant";
	text: string;
	start_ms: number;
	end_ms: number;
	message_id: string | null;
};
/** Closes a received range; this is storage framing, never a semantic turn/approval decision. */
export function publishSegments(
	db: Database,
	id: string,
	conversation: LiveConversationPort,
	_at: string,
) {
	const row = session(db, id);
	if (!row) return;
	for (const segment of db
		.query(
			"SELECT * FROM live_voice_segments WHERE session_id=? AND message_id IS NULL ORDER BY seq",
		)
		.all(id) as Segment[]) {
		if (!segment.text.trim() || row.test) continue;
		conversation.publish(db, {
			id: segment.id,
			conversationId: row.conversation_id,
			role: segment.speaker,
			text: segment.text,
			at: new Date(Date.parse(row.started_at) + segment.start_ms).toISOString(),
		});
		db.query("UPDATE live_voice_segments SET message_id=id WHERE id=?").run(
			segment.id,
		);
	}
}
export function appendTranscript(
	db: Database,
	id: string,
	event: {
		speaker: "user" | "assistant";
		delta: string;
		start: number;
		end: number;
	},
	conversation: LiveConversationPort,
	at: string,
) {
	const row = session(db, id);
	if (!row || !["active", "closing"].includes(row.status)) return;
	const total = db
		.query(
			"SELECT coalesce(sum(length(delta)),0) AS n FROM live_voice_fragments WHERE session_id=?",
		)
		.get(id) as { n: number };
	if (total.n + event.delta.length > 2_000_000)
		throw new Error("live_transcript_capacity");
	const last = db
		.query(
			"SELECT * FROM live_voice_segments WHERE session_id=? AND speaker=? ORDER BY seq DESC LIMIT 1",
		)
		.get(id, event.speaker) as Segment | null;
	const seq = (
		db
			.query(
				"SELECT coalesce(max(seq),0)+1 AS n FROM live_voice_fragments WHERE session_id=?",
			)
			.get(id) as { n: number }
	).n;
	// Timing and size only frame received ranges; they never trigger tool execution.
	const continues =
		last &&
		last.message_id === null &&
		event.start - last.end_ms < 1200 &&
		last.text.length + event.delta.length < 6000;
	if (!continues && last?.message_id === null)
		publishSegments(db, id, conversation, at);
	const segmentId = continues ? last.id : crypto.randomUUID();
	if (continues)
		db.query(
			"UPDATE live_voice_segments SET text=text||?,end_ms=max(end_ms,?) WHERE id=?",
		).run(event.delta, event.end, segmentId);
	else
		db.query("INSERT INTO live_voice_segments VALUES(?,?,?,?,?,?,NULL,?)").run(
			segmentId,
			id,
			event.speaker,
			event.delta,
			event.start,
			event.end,
			seq,
		);
	db.query("INSERT INTO live_voice_fragments VALUES(?,?,?,?,?,?)").run(
		id,
		seq,
		segmentId,
		event.delta,
		event.start,
		event.end,
	);
	if (event.speaker === "user")
		db.query(
			"UPDATE live_voice_sessions SET input_version=input_version+1 WHERE id=?",
		).run(id);
}

/** A user correction/forget erases all raw copies too; already closed ids never reappear. */
export function purgeMessage(db: Database, messageId: string) {
	const found = db
		.query(
			"SELECT session_id FROM live_voice_segments WHERE message_id=? OR id=?",
		)
		.get(messageId, messageId) as { session_id: string } | null;
	if (!found) return null;
	db.query(
		"UPDATE live_voice_fragments SET delta='' WHERE segment_id IN (SELECT id FROM live_voice_segments WHERE message_id=? OR id=?)",
	).run(messageId, messageId);
	db.query(
		"UPDATE live_voice_segments SET text='' WHERE message_id=? OR id=?",
	).run(messageId, messageId);
	db.query("UPDATE live_voice_outputs SET text='' WHERE session_id=?").run(
		found.session_id,
	);
	db.query("UPDATE live_voice_notices SET text='' WHERE session_id=?").run(
		found.session_id,
	);
	db.query(
		"UPDATE live_voice_sessions SET status='interrupted',error='live_history_changed',input_version=input_version+1 WHERE id=? AND status IN ('connecting','active','closing')",
	).run(found.session_id);
	return found.session_id;
}
