import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { ConversationService } from "../../domains/conversation";
import type { ContinuityService } from "../../domains/continuity";
import {
	createMessaging,
	acceptMessageReply,
	createCommands,
	type createEvents,
} from "../../domains/dots";
import { createMessageLifecycle } from "./dots-message-lifecycle";
// Compose only public transaction operations of dots, conversation and continuity.
export function createDotsMessages(input: {
	store: SqliteStore;
	conversation: ConversationService;
	continuity: ContinuityService;
	commands: ReturnType<typeof createCommands>;
	events: ReturnType<typeof createEvents>;
	now?: () => number;
}) {
	const { store, conversation, continuity, events } = input,
		now = input.now ?? Date.now;
	const service = createMessaging({
		...input,
		now,
		notify: events.enqueueInTransaction,
	});
	const lifecycle = createMessageLifecycle({
		store,
		conversation,
		continuity,
		now,
	});
	conversation.addRetractHook(lifecycle.invalidateMessageInTransaction);
	conversation.addCorrectHook((db, id) =>
		lifecycle.invalidateMessageInTransaction(db, id),
	);
	const readText = (db: Database, id: string | null) =>
		id
			? (conversation.messageInTransaction(db, id)?.message.text ?? null)
			: null;
	function contextInTransaction(db: Database, threadId: string) {
		const t = service.threadInTransaction(db, threadId);
		const previous = service.latestAnsweredInTransaction(
			db,
			threadId,
			service.settingInTransaction(db, t.connectionRef).epoch,
		);
		const r = previous?.replyId
			? service.replyInTransaction(db, previous.replyId)
			: null;
		const summary =
			r && !r.redacted ? readText(db, r.receipt.summaryMessageId) : null;
		const exchanges = service
			.messagesInTransaction(db, threadId, previous?.sequence ?? 0, 4096)
			.filter(
				(m) =>
					!m.redacted &&
					m.settingsEpoch ===
						service.settingInTransaction(db, t.connectionRef).epoch,
			)
			.map((m) => {
				const reply = m.replyId
					? service.replyInTransaction(db, m.replyId)
					: null;
				return {
					messageId: m.userMessageId,
					text: readText(db, m.userMessageId),
					replyMessageId: reply?.receipt.replyMessageId ?? null,
					replyText:
						reply && !reply.redacted
							? readText(db, reply.receipt.replyMessageId)
							: null,
					state: m.state,
				};
			});
		return {
			basedOnReplyId: summary ? r!.id : null,
			previousSummary: summary,
			summaryBaseMissing: t.sequence > 0 && !summary,
			exchanges,
			coveredMessageIds: exchanges.flatMap((e) => [
				e.messageId,
				...(e.replyMessageId ? [e.replyMessageId] : []),
			]),
		};
	}
	function viewInTransaction(db: Database, id: string, after = 0, limit = 50) {
		if (
			!Number.isSafeInteger(after) ||
			after < 0 ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 100
		)
			throw new Error("invalid_dots_cursor");
		const thread = service.threadInTransaction(db, id),
			all = service.messagesInTransaction(db, id, after, limit + 1);
		const items = all.slice(0, limit).map((m) => {
			const r = m.replyId ? service.replyInTransaction(db, m.replyId) : null;
			const status =
				m.state === "pending" || m.state === "claimed"
					? m.expiresAt <= now()
						? "expired"
						: m.state
					: m.state;
			return {
				...m,
				delivery: service.deliveryInTransaction(db, m.commandId),
				state: status,
				text: m.redacted ? null : readText(db, m.userMessageId),
				reply: r
					? {
							...r,
							replyText: r.redacted
								? null
								: readText(db, r.receipt.replyMessageId),
							summary: r.redacted
								? null
								: readText(db, r.receipt.summaryMessageId),
						}
					: null,
			};
		});
		return {
			thread,
			setting: service.settingInTransaction(db, thread.connectionRef),
			subscription: events.statusInTransaction(db, thread.connectionRef),
			items,
			nextCursor: all.length > limit ? all[limit - 1]!.sequence : null,
		};
	}
	return {
		...service,
		...lifecycle,
		configure: (owner: string, raw: unknown) =>
			store.write((db) => service.configureInTransaction(db, owner, raw)),
		open: (raw: unknown) =>
			store.write((db) => {
				const result = service.openInTransaction(db, raw);
				return result.thread;
			}),
		send: async (id: string, raw: unknown) => {
			const result = await store.write((db) => {
				const r = service.sendInTransaction(
					db,
					id,
					raw,
					contextInTransaction(db, id),
				);
				if (!r.replay) {
					const t = service.threadInTransaction(db, id);
					conversation.appendInTransaction(db, {
						id: r.message.userMessageId,
						conversationId: t.conversationId,
						role: "user",
						text: String(r.command.snapshot.text),
						createdAt: new Date(r.message.createdAt).toISOString(),
						runId: null,
					});
					continuity.events.appendInTransaction(db, {
						conversationId: t.conversationId,
						at: new Date(r.message.createdAt).toISOString(),
						type: "said",
						by: "user",
						fields: {
							to: "specialist",
							toolchain: "dots",
							text: String(r.command.snapshot.text),
						},
						messageIds: [r.message.userMessageId],
						dedupeKey: `dots:${r.message.userMessageId}`,
					});
				}
				return r.message;
			});
			eventsWake();
			return result;
		},
		cancel: (id: string, raw: unknown) =>
			store.write((db) => service.cancelInTransaction(db, id, raw)),
		reply: (owner: string, raw: unknown) =>
			store.write((db) => {
				const r = acceptMessageReply(db, owner, raw, now());
				if (r.replay) return r.receipt;
				const t = service.threadInTransaction(db, r.message.threadId),
					at = new Date(now()).toISOString();
				function save(id: string, text: string, label: string) {
					const m = {
						id,
						conversationId: t.conversationId,
						role: "assistant" as const,
						text,
						createdAt: at,
						runId: null,
						attribution: {
							namespace: "dots",
							sourceId: r.receipt.replyId,
							displayName: label,
						},
					};
					conversation.appendInTransaction(db, m);
					continuity.events.appendInTransaction(db, {
						conversationId: t.conversationId,
						at,
						type: "said",
						by: "specialist",
						fields: { toolchain: label, text, attribution: m.attribution },
						messageIds: [id],
						dedupeKey: `dots:${id}`,
					});
				}
				save(r.receipt.replyMessageId, r.reply.replyText, "dots の返答");
				if (r.receipt.summaryMessageId && r.reply.summary !== null)
					save(r.receipt.summaryMessageId, r.reply.summary, "dots の要約");
				return r.receipt;
			}),
		view: (id: string, after = 0, limit = 50) =>
			store.readSnapshot((db) => viewInTransaction(db, id, after, limit)),
		viewInTransaction,
	};
	function eventsWake() {
		events.wake();
	}
}
export type DotsMessages = ReturnType<typeof createDotsMessages>;
