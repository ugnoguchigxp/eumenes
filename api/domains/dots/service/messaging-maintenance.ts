import type { Database } from "bun:sqlite";
import * as records from "../repository/messaging";
import * as repo from "../repository";
import { activeMessage, supersedeMessage } from "./messaging-state";
const DAY = 86400000;
export function invalidateMessageSource(
	db: Database,
	sourceId: string,
	now: number,
) {
	const all = records.allMessages(db),
		source = all.find(
			(m) =>
				m.userMessageId === sourceId ||
				(m.replyId &&
					[`dots-reply:${m.replyId}`, `dots-summary:${m.replyId}`].includes(
						sourceId,
					)),
		);
	if (!source) return [] as string[];
	const ids: string[] = [];
	for (const m of all)
		if (
			m.threadId === source.threadId &&
			m.sequence >= source.sequence &&
			!m.redacted
		) {
			supersedeMessage(db, m, "cancelled", now);
			m.redacted = true;
			m.bodyBytes = 0;
			m.terminalAt ??= now;
			m.revision++;
			records.saveMessage(db, m);
			ids.push(m.userMessageId);
			const c = repo.command(db, m.commandId);
			if (c) {
				c.state = "superseded";
				c.snapshot = {
					protocolVersion: 1,
					messageProtocolVersion: 1,
					requestDigest: c.snapshot.requestDigest,
				};
				repo.putCommand(db, c);
			}
			if (m.replyId) {
				const r = records.reply(db, m.replyId);
				if (r) {
					r.redacted = true;
					r.coveredMessageIds = [];
					r.limitations = [];
					r.basedOnReplyId = null;
					db.query(
						"UPDATE dots_message_replies SET data_json=? WHERE id=?",
					).run(JSON.stringify(r), r.id);
					ids.push(r.receipt.replyMessageId);
					if (r.receipt.summaryMessageId) ids.push(r.receipt.summaryMessageId);
				}
			}
		}
	return ids;
}
export function maintainMessages(db: Database, now: number) {
	const redactions = new Set<string>();
	for (const m of records.allMessages(db)) {
		const c = repo.connection(db, m.connectionRef),
			s = records.setting(db, m.connectionRef);
		if (
			activeMessage(m) &&
			(!c?.enabled ||
				c.revision !== m.connectionRevision ||
				!s.enabled ||
				s.epoch !== m.settingsEpoch)
		)
			supersedeMessage(db, m, "cancelled", now);
		if (activeMessage(m) && m.expiresAt <= now)
			supersedeMessage(db, m, "expired", now);
		if (m.terminalAt !== null && m.terminalAt + 7 * DAY <= now && !m.redacted)
			for (const id of invalidateMessageSource(db, m.userMessageId, now))
				redactions.add(id);
		if (m.terminalAt !== null && m.terminalAt + 30 * DAY <= now) {
			db.query("DELETE FROM dots_deliveries WHERE command_id=?").run(
				m.commandId,
			);
			db.query("DELETE FROM dots_commands WHERE id=?").run(m.commandId);
			db.query("DELETE FROM dots_message_replies WHERE message_id=?").run(m.id);
			db.query("DELETE FROM dots_message_cancellations WHERE message_id=?").run(
				m.id,
			);
			db.query("DELETE FROM dots_messages WHERE id=?").run(m.id);
		}
	}
	return [...redactions];
}
