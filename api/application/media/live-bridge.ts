import { createConversationPrewarm } from "../conversation-prewarm";
import type { Database } from "bun:sqlite";
import type { Core } from "../server-core";
import type { DialogueService } from "../../domains/dialogue";
import type { ContinuityService } from "../../domains/continuity";
import type { MemoryService } from "../../domains/memory";
import type { ExternalOutputPort } from "../../domains/dialogue/contracts/external-output";
import { createVoiceDialogue } from "../../domains/voice-dialogue";
import { buildLiveVoice } from "./live-voice";
/** Resolves the composition cycle without exposing Live's repository to dialogue or agency. */
export function createLiveBridge() {
	let liveVoice: ReturnType<typeof buildLiveVoice> | undefined;
	const externalOutput: ExternalOutputPort = {
		active: (tx, id) => liveVoice?.externalOutput.active(tx, id) ?? false,
		reattach: (tx, id, conv, input) =>
			liveVoice?.externalOutput.reattach(tx, id, conv, input),
		owns: (tx, id) => liveVoice?.externalOutput.owns(tx, id) ?? false,
		assertCurrent: (tx, id) => liveVoice?.externalOutput.assertCurrent(tx, id),
		offer: (tx, run, text, confirmation) =>
			liveVoice?.externalOutput.offer(tx, run, text, confirmation) ?? false,
		report: (tx, input) => liveVoice?.externalOutput.report(tx, input) ?? false,
		announce: async (run, text, signal) => {
			if (!liveVoice) throw new Error("live_session_inactive");
			return liveVoice.externalOutput.announce(run, text, signal);
		},
	};
	return {
		externalOutput,
		agency: {
			routeSpeechInTransaction: (tx: Database, id: string, text: string) =>
				liveVoice?.live.proposeInTransaction(tx, id, text) ?? false,
		},
		attach({
			store,
			settings,
			conversation,
			inference,
			queue,
			dialogue,
			continuity,
			memory,
			serviceTests,
		}: Pick<
			Core,
			| "store"
			| "settings"
			| "conversation"
			| "inference"
			| "queue"
			| "serviceTests"
		> & {
			dialogue: DialogueService;
			continuity: ContinuityService;
			memory: MemoryService;
		}) {
			// The latest conversation's prompt is read ahead when it would be cold (started, shown, idle while shown).
			const prewarm = createConversationPrewarm({
				store,
				inference,
				latestConversationIdInTransaction:
					dialogue.latestConversationIdInTransaction,
				task: dialogue.conversationTaskInTransaction,
			});

			const voice = createVoiceDialogue(
				store,
				dialogue,
				inference,
				undefined,
				() => liveVoice?.live.isActive("main") ?? false,
			);
			liveVoice = buildLiveVoice({
				store,
				settings,
				conversation,
				continuity,
				dialogue,
				stopLegacy: async () => {
					await voice.pauseAll();
					await serviceTests.pauseVoice();
				},
				wake: () => queue.wake(),
			});
			const live = liveVoice.live;
			serviceTests.setVoiceAvailability(
				(tx) => !live.activeInTransaction(tx, "main"),
			);
			memory.registerForgetPurge((tx, purge) => {
				for (const id of purge.messageIds)
					live.purgeInTransaction(
						tx,
						id,
						conversation.messageInTransaction(tx, id)?.message.conversationId,
					);
			});
			return { voice, liveVoice, prewarm };
		},
	};
}
