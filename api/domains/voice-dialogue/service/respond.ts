import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { Database } from "bun:sqlite";
import type { DialogueService } from "../../dialogue";
import type { InferencePort } from "../../inference";
import type { SpeechPreparation } from "../../delivery";
import type { VoiceTurn } from "../contracts";
import type { Speech } from "./speech-state";
import { spokenText } from "./spoken-text";
import { getLogger } from "../../../infrastructure/logger";
const log = getLogger("voice-dialogue");
export type VoiceAdvance = (
	id: string,
	status: VoiceTurn["status"],
) => Promise<boolean>;
export function createVoiceResponder({
	store,
	dialogue,
	larm,
	advance,
	createSpeech,
	audio,
	linkRunInTransaction,
}: {
	store: SqliteStore;
	dialogue: DialogueService;
	larm: InferencePort;
	advance: VoiceAdvance;
	createSpeech: (
		id: string,
		runId: string,
		controller: AbortController,
		preparation: SpeechPreparation,
	) => Speech;
	audio: Map<string, Speech>;
	linkRunInTransaction: (db: Database, id: string, runId: string) => void;
}) {
	return async (
		turn: VoiceTurn,
		text: string,
		transcriptionRequestIds: string[],
		controller: AbortController,
	) => {
		controller.signal.throwIfAborted();
		if (!transcriptionRequestIds.every((id) => larm.validRequest?.(id)))
			throw new Error("permission_revoked");
		let run: Awaited<ReturnType<DialogueService["submitVoice"]>>;
		try {
			run = await dialogue.submitVoice(
				{
					requestId: turn.utteranceId,
					utteranceId: turn.utteranceId,
					conversationId: "main",
					text,
				},
				turn.utteranceId,
				transcriptionRequestIds,
				(db, accepted) =>
					linkRunInTransaction(db, turn.utteranceId, accepted.id),
			);
		} catch (error) {
			// Cancelled meanwhile: the run was rolled back with the link.
			if (error instanceof Error && error.message === "voice_turn_inactive")
				return;
			throw error;
		}

		const snapshot = store.read((db) =>
			larm.snapshotFor?.(db, turn.utteranceId),
		);
		const autoSpeak = !snapshot || snapshot.voice.autoSpeak;
		let speech: Speech | undefined;
		// Text may stream to the UI, but speech waits for the adopted complete answer.
		// A partial "なるほど" must not decide the expression of the whole response.
		if (autoSpeak)
			await store.write((db) =>
				larm.skipInTransaction?.(db, turn.utteranceId, "tts"),
			);
		const waitMs = run.deadlineAt
			? Math.max(0, Date.parse(run.deadlineAt) - Date.now()) + 10_000
			: undefined;
		const final = await dialogue.waitForTerminal(run.id, {
			signal: controller.signal,
			timeoutMs: waitMs,
		});
		if (controller.signal.aborted) return;
		if (final && ["queued", "running"].includes(final.status)) {
			// Stop waiting and make sure a late answer can never be adopted.
			await dialogue.cancel(run.id);
			throw new Error("dialogue_wait_timeout");
		}
		if (final?.status !== "completed" || !final.answerMessageId)
			throw new Error(final?.error ?? "dialogue_incomplete");
		const answer = dialogue.answerText(run.id);
		if (!answer) throw new Error("answer_missing");
		if (!autoSpeak) {
			log.info("voice.synthesis_skipped", {
				runId: run.id,
				reason: "auto_speak_disabled",
			});
			await store.write((db) =>
				larm.skipInTransaction?.(db, turn.utteranceId, "tts"),
			);
			await advance(turn.utteranceId, "completed");
			return;
		}
		if (!(await advance(turn.utteranceId, "synthesizing"))) return;
		log.info("voice.synthesis_started", { runId: run.id });
		speech = createSpeech(turn.utteranceId, run.id, controller, {
			collection: {
				conversationId: run.conversationId,
				turnId: run.id,
				granularity: "answer",
				chunkOrder: null,
			},
			context: dialogue.answerContext?.(run.id) ?? { answer, turns: [] },
			delivery: dialogue.answerDelivery?.(run.id),
		});
		speech.append(spokenText(answer), true);
		await speech!.work;
		if (controller.signal.aborted) return;
		if (speech!.error) throw speech!.error;
		log.info("voice.synthesis_completed", {
			runId: run.id,
			count: speech!.chunks.size,
		});
		if (speech!.skipped > 0)
			log.warn("voice.speech_truncated", {
				runId: run.id,
				count: speech!.skipped,
			});
		await advance(turn.utteranceId, speech!.chunks.size ? "ready" : "played");
		if (!speech!.chunks.size) audio.delete(turn.utteranceId);
	};
}
