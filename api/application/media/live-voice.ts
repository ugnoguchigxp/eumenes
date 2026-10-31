import type { SqliteStore } from "../../infrastructure/sqlite";
import type { SettingsService } from "../../domains/settings";
import type { ConversationService } from "../../domains/conversation";
import type { ContinuityService } from "../../domains/continuity";
import type { DialogueService } from "../../domains/dialogue";
import { createLiveVoice } from "../../domains/live-voice";
import type { ConnectLive } from "../../domains/live-voice/contracts";

export function buildLiveVoice({
	store,
	settings,
	conversation,
	continuity,
	dialogue,
	stopLegacy,
	wake,
	connect,
}: {
	store: SqliteStore;
	settings: SettingsService;
	conversation: ConversationService;
	continuity: ContinuityService;
	dialogue: DialogueService;
	stopLegacy: () => Promise<void>;
	wake: () => void;
	connect?: ConnectLive;
}) {
	const live = createLiveVoice({
		store,
		settings,
		stopLegacy,
		connect,
		conversation: {
			ensure: () => {},
			history: (tx, id) =>
				conversation
					.messagesInTransaction(tx, id)
					.filter((m) => m.presentation !== "artifact")
					.map((m) => ({ role: m.role, text: m.text })),
			publish(tx, input) {
				conversation.appendInTransaction(tx, {
					id: input.id,
					conversationId: input.conversationId,
					role: input.role,
					text: input.text,
					createdAt: input.at,
					runId: null,
					attribution: {
						namespace: "live-voice",
						sourceId: input.id,
						displayName:
							input.role === "user"
								? "音声の文字起こし"
								: "AI音声の文字起こし（再生範囲未確認）",
					},
				});
				conversation.input.appendUtteranceInTransaction(tx, {
					conversationId: input.conversationId,
					speaker: input.role === "user" ? "user" : "agent",
					text:
						input.role === "assistant"
							? `音声の字幕（再生範囲は未確認）:\n${input.text}`
							: input.text,
					messageId: input.id,
					at: input.at,
				});
			},
			delegate: (tx, input) => dialogue.acceptExistingInTransaction(tx, input),
			wake,
			cancelReply: (id) => dialogue.stopReply(id),
		},
	});
	conversation.addRetractHook((tx, id) => {
		live.purgeInTransaction(
			tx,
			id,
			conversation.messageInTransaction(tx, id)?.message.conversationId,
		);
	});
	conversation.addCorrectHook((tx, id) => {
		live.purgeInTransaction(
			tx,
			id,
			conversation.messageInTransaction(tx, id)?.message.conversationId,
		);
	});
	return {
		live,
		externalOutput: {
			active: live.activeInTransaction,
			reattach: live.delivery.capture,
			owns: live.delivery.owns,
			assertCurrent: live.delivery.assertCurrent,
			offer: live.delivery.offer,
			announce: live.delivery.announce,
		},
		async displayed(sessionId: string, noticeId: string) {
			await live.delivery.displayed(
				sessionId,
				noticeId,
				(tx, conversationId) => {
					if (!noticeId.startsWith("confirmation:")) return;
					const runId = noticeId.slice("confirmation:".length);
					live.delivery.assertCurrent(tx, runId);
					const said = continuity.events.deliveredUtteranceInTransaction(
						tx,
						conversationId,
						`run:${runId}`,
					);
					if (!said) return;
					continuity.events.appendInTransaction(tx, {
						conversationId: conversationId,
						at: new Date().toISOString(),
						type: "delivered",
						by: "host",
						fields: { ref: said.id, heard: "full", channel: "screen" },
						dedupeKey: `delivered:${said.id}`,
					});
				},
			);
		},
	};
}
