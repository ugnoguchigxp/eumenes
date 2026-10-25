import type { Database } from "bun:sqlite";
import {
	messageReplyInput,
	type MessageReceipt,
	type SavedMessageReply,
} from "../contracts/messaging";
import { currentMessage, messageDigest } from "./messaging-state";
import * as records from "../repository/messaging";
import * as repo from "../repository";
export function acceptMessageReply(
	db: Database,
	owner: string,
	raw: unknown,
	now: number,
) {
	const r = messageReplyInput.parse(raw),
		c = repo.command(db, r.commandId),
		m = records.message(db, r.messageId);
	if (
		!c ||
		c.kind !== "message" ||
		c.connectionRef !== owner ||
		!m ||
		m.connectionRef !== owner ||
		c.messageId !== m.id
	)
		throw new Error("dots_permission_denied");
	const digest = messageDigest(r),
		old = records.reply(db, r.replyId);
	if (old) {
		if (old.messageId !== r.messageId || old.digest !== digest)
			throw new Error("dots_conflict");
		return { receipt: old.receipt, replay: true, reply: r, message: m };
	}
	const { thread: t, setting: s } = currentMessage(db, owner, c, now);
	if (
		c.state !== "claimed" ||
		c.leaseId !== r.leaseId ||
		r.epoch !== m.epoch ||
		m.replyId
	)
		throw new Error("dots_stale");
	const context = c.snapshot.context as {
		coveredMessageIds?: string[];
		basedOnReplyId?: string | null;
	};
	const permitted = new Set([
		m.userMessageId,
		...(context.coveredMessageIds ?? []),
	]);
	if (
		new Set(r.coveredMessageIds).size !== r.coveredMessageIds.length ||
		r.coveredMessageIds.some((id) => !permitted.has(id))
	)
		throw new Error("dots_permission_denied");
	const receipt: MessageReceipt = {
		replyId: r.replyId,
		messageId: m.id,
		state: r.outcome,
		replyMessageId: `dots-reply:${r.replyId}`,
		summaryMessageId: r.summary === null ? null : `dots-summary:${r.replyId}`,
	};
	const saved: SavedMessageReply = {
		id: r.replyId,
		messageId: m.id,
		threadId: t.id,
		connectionRef: owner,
		digest,
		receipt,
		coveredMessageIds: r.coveredMessageIds,
		limitations: r.limitations,
		basedOnReplyId: context.basedOnReplyId ?? null,
		createdAt: now,
		redacted: false,
	};
	records.saveReply(db, saved);
	m.state = r.outcome;
	m.replyId = r.replyId;
	m.terminalAt = now;
	m.revision++;
	m.bodyBytes +=
		Buffer.byteLength(r.replyText) + Buffer.byteLength(r.summary ?? "");
	records.saveMessage(db, m);
	c.state = "reported";
	repo.putCommand(db, c);
	t.revision++;
	records.saveThread(db, t);
	records.saveSetting(db, { ...s, verifiedAt: now });
	return { receipt, replay: false, reply: r, message: m };
}
