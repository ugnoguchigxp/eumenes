import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	messagingSettingInput,
	messageConversationInput,
	sendMessageInput,
	cancelMessageInput,
	type MessageConversation,
	type MessageCommand,
	type OutgoingMessage,
} from "../contracts/messaging";
import { createCommands } from "./commands";
import { readSubscription } from "./event-delivery";
import {
	activeMessage,
	currentMessage,
	messageThread,
	messageDigest,
	supersedeMessage,
} from "./messaging-state";
import * as repo from "../repository";
import * as records from "../repository/messaging";
export function createMessaging(input: {
	store: SqliteStore;
	commands: ReturnType<typeof createCommands>;
	now?: () => number;
	notify: (db: Database, c: MessageCommand) => void;
}) {
	const { store, commands, notify } = input,
		now = input.now ?? Date.now;
	function settingInTransaction(db: Database, owner: string) {
		if (!repo.connection(db, owner)) throw new Error("dots_not_found");
		return records.setting(db, owner);
	}
	function configureInTransaction(db: Database, owner: string, raw: unknown) {
		const v = messagingSettingInput.parse(raw),
			s = settingInTransaction(db, owner);
		if (v.expectedRevision !== s.revision) throw new Error("dots_conflict");
		if (v.enabled && !repo.connection(db, owner)?.enabled)
			throw new Error("dots_unavailable");
		const next = {
			...s,
			enabled: v.enabled,
			revision: s.revision + 1,
			epoch: s.epoch + 1,
			verifiedAt: null,
		};
		records.saveSetting(db, next);
		for (const m of records.allMessages(db))
			if (m.connectionRef === owner)
				supersedeMessage(db, m, "cancelled", now());
		return next;
	}
	function openInTransaction(db: Database, raw: unknown) {
		const v = messageConversationInput.parse(raw),
			oldId = records.byRequest(db, "dots_message_conversations", v.requestId);
		if (oldId) {
			const t = messageThread(db, oldId);
			if (
				t.connectionRef !== v.connectionRef ||
				t.conversationId !== v.conversationId
			)
				throw new Error("dots_conflict");
			return { thread: t, replay: true };
		}
		const s = settingInTransaction(db, v.connectionRef);
		if (!s.enabled || !repo.connection(db, v.connectionRef)?.enabled)
			throw new Error("dots_unavailable");
		const t: MessageConversation = {
			...v,
			id: crypto.randomUUID(),
			epoch: 1,
			revision: 1,
			sequence: 0,
			createdAt: now(),
		};
		records.saveThread(db, t);
		return { thread: t, replay: false };
	}
	function sendInTransaction(
		db: Database,
		threadId: string,
		raw: unknown,
		context: Record<string, unknown>,
	) {
		const v = sendMessageInput.parse(raw),
			t = messageThread(db, threadId),
			s = settingInTransaction(db, t.connectionRef),
			connection = repo.connection(db, t.connectionRef);
		const oldId = records.byRequest(db, "dots_messages", v.requestId);
		if (oldId) {
			const m = records.message(db, oldId)!,
				c = repo.command(db, m.commandId);
			if (
				m.threadId !== threadId ||
				c?.snapshot.requestDigest !== messageDigest(v)
			)
				throw new Error("dots_conflict");
			return { message: m, command: c as MessageCommand, replay: true };
		}
		if (!s.enabled || !connection?.enabled) throw new Error("dots_unavailable");
		const sub = readSubscription(db, t.connectionRef);
		if (!sub || sub.expiresAt <= now()) throw new Error("dots_not_subscribed");
		for (const m of records
			.allMessages(db)
			.filter((m) => m.threadId === threadId))
			if (activeMessage(m)) {
				if (m.expiresAt <= now()) supersedeMessage(db, m, "expired", now());
				else throw new Error("dots_message_pending");
			}
		t.sequence++;
		t.epoch++;
		t.revision++;
		records.saveThread(db, t);
		const id = crypto.randomUUID(),
			commandId = crypto.randomUUID(),
			at = now();
		const m: OutgoingMessage = {
			id,
			requestId: v.requestId,
			threadId,
			connectionRef: t.connectionRef,
			sequence: t.sequence,
			userMessageId: `dots-user:${id}`,
			commandId,
			epoch: t.epoch,
			settingsEpoch: s.epoch,
			connectionRevision: connection.revision,
			expiresAt: at + 600000,
			createdAt: at,
			terminalAt: null,
			state: "pending",
			revision: 1,
			replyId: null,
			bodyBytes: Buffer.byteLength(v.text),
			redacted: false,
		};
		records.saveMessage(db, m);
		const c: MessageCommand = {
			commandId,
			kind: "message",
			messageId: id,
			messageConversationId: threadId,
			connectionRef: t.connectionRef,
			authorityEpoch: t.epoch,
			executionGeneration: 1,
			createdAt: at,
			expiresAt: m.expiresAt,
			state: "pending",
			leaseId: null,
			snapshot: {
				protocolVersion: 1,
				messageProtocolVersion: 1,
				requestDigest: messageDigest(v),
				text: v.text,
				sourceMessageId: m.userMessageId,
				context,
			},
		};
		commands.prepareInTransaction(db, c);
		notify(db, c);
		return { message: m, command: c, replay: false };
	}
	function getCommand(
		owner: string,
		id: string,
	): MessageCommand & {
		receipt?: import("../contracts/messaging").MessageReceipt;
	} {
		return store.readSnapshot((db) => {
			const c = repo.command(db, id);
			if (!c || c.connectionRef !== owner)
				throw new Error("dots_permission_denied");
			if (c.kind !== "message") throw new Error("invalid_dots_command_kind");
			const m = records.message(db, c.messageId);
			const saved = m?.replyId ? records.reply(db, m.replyId) : null;
			if (saved)
				return {
					...c,
					snapshot: { protocolVersion: 1, messageProtocolVersion: 1 },
					receipt: saved.receipt,
				};
			currentMessage(db, owner, c, now());
			return c;
		});
	}
	function cancelInTransaction(db: Database, id: string, raw: unknown) {
		const v = cancelMessageInput.parse(raw),
			m = records.message(db, id);
		if (!m) throw new Error("dots_not_found");
		const old = db
			.query(
				"SELECT message_id,data_json FROM dots_message_cancellations WHERE id=?",
			)
			.get(v.requestId) as { message_id: string; data_json: string } | null;
		if (old) {
			if (
				old.message_id !== id ||
				JSON.parse(old.data_json).digest !== messageDigest(v)
			)
				throw new Error("dots_conflict");
			return records.message(db, id)!;
		}
		if (m.revision !== v.expectedRevision || !activeMessage(m))
			throw new Error("dots_conflict");
		supersedeMessage(db, m, "cancelled", now());
		const t = messageThread(db, m.threadId);
		t.epoch++;
		t.revision++;
		records.saveThread(db, t);
		db.query("INSERT INTO dots_message_cancellations VALUES(?,?,?)").run(
			v.requestId,
			id,
			JSON.stringify({ digest: messageDigest(v) }),
		);
		return m;
	}
	return {
		latestAnsweredInTransaction: records.latestAnswered,
		threadInTransaction: messageThread,
		messagesInTransaction: records.messages,
		replyInTransaction: records.reply,
		deliveryInTransaction: records.delivery,
		listConversations: () => store.readSnapshot(records.threads),
		settingInTransaction,
		configureInTransaction,
		openInTransaction,
		sendInTransaction,
		cancelInTransaction,
		getCommand,
		setting: (owner: string) =>
			store.readSnapshot((db) => settingInTransaction(db, owner)),
		handles: (owner: string, id: string) =>
			store.readSnapshot((db) => {
				const c = repo.command(db, id);
				if (!c || c.connectionRef !== owner)
					throw new Error("dots_permission_denied");
				return c.kind === "message";
			}),
		claim: (owner: string, raw: unknown) =>
			commands.claim(owner, raw, (db, c) => {
				if (c.kind !== "message") throw new Error("invalid_dots_command_kind");
				const { message: m } = currentMessage(db, owner, c, now());
				if (m.state !== "claimed") {
					m.state = "claimed";
					m.revision++;
					records.saveMessage(db, m);
				}
			}),
	};
}
