import { createConversationPrewarm } from "../conversation-prewarm";
import type { Core } from "../server-core";
import {
	routeConversation,
	type DialogueService,
} from "../../domains/dialogue";
import type { MemoryService } from "../../domains/memory";
import type { ExternalOutputPort } from "../../domains/dialogue/contracts/external-output";
import { createVoiceDialogue } from "../../domains/voice-dialogue";
import { buildLiveVoice } from "./live-voice";
import type { SpeechRouter } from "../agency/speech";
import type { AgencyLayerPort } from "../../domains/dialogue/contracts";
/** Resolves the composition cycle without exposing Live's repository to dialogue or agency. */
export function createLiveBridge() {
	let liveVoice: ReturnType<typeof buildLiveVoice> | undefined;
	const externalOutput: ExternalOutputPort = {
		active: (tx, id) => liveVoice?.externalOutput.active(tx, id) ?? false,
		reattach: (tx, id, conv, input) =>
			liveVoice?.externalOutput.reattach(tx, id, conv, input),
		owns: (tx, id) => liveVoice?.externalOutput.owns(tx, id) ?? false,
		assertCurrent: (tx, id) => liveVoice?.externalOutput.assertCurrent(tx, id),
		offer: (tx, run, text) =>
			liveVoice?.externalOutput.offer(tx, run, text) ?? false,
		announce: async (run, text, signal) => {
			if (!liveVoice) throw new Error("live_session_inactive");
			return liveVoice.externalOutput.announce(run, text, signal);
		},
	};
	return {
		externalOutput,
		agency: {
			routeSpeechInTransaction: ((tx, id, text, origin) =>
				liveVoice?.live.proposeInTransaction(tx, id, text, origin) ??
				false) satisfies SpeechRouter,
		},
		attach({
			store,
			settings,
			conversation,
			inference,
			queue,
			dialogue,
			memory,
			agency,
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
			memory: MemoryService;
			agency?: AgencyLayerPort;
		}) {
			// The latest conversation's prompt is read ahead when it would be cold (started, shown, idle while shown).
			const prewarm = createConversationPrewarm({
				store,
				inference,
				latestConversationIdInTransaction:
					dialogue.latestConversationIdInTransaction,
				// The conversation's own route judgement, on a copy: it is a prompt LARM keeps only when LARM serves it.
				usesLarm: (db) => {
					const snapshot = structuredClone(inference.snapshotInTransaction(db));
					routeConversation(snapshot);
					return snapshot.routes.llm.mode !== "cloud-only";
				},
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
				dialogue,
				memory,
				agency,
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
				live.purgeSourcesInTransaction(tx, [
					...purge.messageIds,
					...purge.itemIds.map((id) => `memory:${id}`),
				]);
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
