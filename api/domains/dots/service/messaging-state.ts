import type { Database } from "bun:sqlite";
import { canonicalJson, sha256Hex } from "../../../infrastructure/digest";
import type { MessageCommand, OutgoingMessage } from "../contracts/messaging";
import * as repo from "../repository";
import * as messages from "../repository/messaging";
export const messageDigest = (value: unknown) =>
	sha256Hex(
		canonicalJson(value, { omitUndefined: true, keyOrder: "codeUnit" }),
	);
export const activeMessage = (m: OutgoingMessage) =>
	m.state === "pending" || m.state === "claimed";
export function messageThread(db: Database, id: string) {
	const t = messages.thread(db, id);
	if (!t) throw new Error("dots_not_found");
	return t;
}
export function currentMessage(
	db: Database,
	owner: string,
	c: MessageCommand,
	now: number,
) {
	const m = messages.message(db, c.messageId),
		t = messages.thread(db, c.messageConversationId),
		s = messages.setting(db, owner),
		connection = repo.connection(db, owner);
	if (
		!m ||
		!t ||
		m.connectionRef !== owner ||
		t.connectionRef !== owner ||
		c.connectionRef !== owner
	)
		throw new Error("dots_permission_denied");
	if (
		!connection?.enabled ||
		!s.enabled ||
		s.epoch !== m.settingsEpoch ||
		connection.revision !== m.connectionRevision ||
		t.epoch !== m.epoch ||
		c.authorityEpoch !== m.epoch ||
		!activeMessage(m) ||
		m.expiresAt <= now ||
		m.redacted ||
		c.state === "superseded"
	)
		throw new Error("dots_stale");
	return { message: m, thread: t, setting: s };
}
export function supersedeMessage(
	db: Database,
	m: OutgoingMessage,
	state: "cancelled" | "expired",
	at: number,
) {
	if (!activeMessage(m)) return;
	const t = messageThread(db, m.threadId);
	t.revision++;
	messages.saveThread(db, t);
	m.state = state;
	m.revision++;
	m.terminalAt = at;
	messages.saveMessage(db, m);
	const c = repo.command(db, m.commandId);
	if (c) {
		c.state = "superseded";
		repo.putCommand(db, c);
	}
}
