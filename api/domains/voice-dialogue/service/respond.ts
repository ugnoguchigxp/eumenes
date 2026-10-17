import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { Database } from "bun:sqlite";
import type { DialogueService } from "../../dialogue";
import type { InferencePort } from "../../inference";
import type { SpeechPreparation } from "../../delivery";
import type { VoiceTurn } from "../contracts";
import type { Speech } from "./speech-state";
import { spokenPrefix, spokenText } from "./spoken-text";
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
		const speechController = new AbortController();
		const stopSpeech = () => speechController.abort(controller.signal.reason);
		controller.signal.addEventListener("abort", stopSpeech, { once: true });
		let speech: Speech | undefined;
		let preparation: SpeechPreparation | undefined;
		let unsubscribe = () => {};
		let streamError: unknown;
		let sourcePrefix = "";
		let announcement = "";
		const append = (body: string, final = false) => {
			const text = announcement ? `${announcement}\n${body}` : body;
			if (!text.startsWith(sourcePrefix))
				throw new Error("speech_stream_diverged");
			sourcePrefix = text;
			speech!.append(spokenPrefix(text, final), final);
		};
		try {
			if (autoSpeak) {
				await store.write((db) =>
					larm.skipInTransaction?.(db, turn.utteranceId, "tts"),
				);
				controller.signal.throwIfAborted();
				preparation = {
					deliveryScope: "chunk",
					collection: {
						conversationId: run.conversationId,
						turnId: run.id,
						granularity: "chunk",
						chunkOrder: null,
					},
					context: dialogue.answerContext?.(run.id) ?? {
						answer: "",
						turns: [],
					},
				};
				speech = createSpeech(
					turn.utteranceId,
					run.id,
					speechController,
					preparation,
				);
				log.info("voice.synthesis_started", { runId: run.id });
				unsubscribe =
					dialogue.subscribeProgress?.(run.id, (progress) => {
						if (controller.signal.aborted || speechController.signal.aborted)
							return;
						if (
							["failed", "cancelled", "interrupted"].includes(progress.status)
						) {
							speechController.abort();
							audio.delete(turn.utteranceId);
							return;
						}
						if (progress.announcement) announcement = progress.announcement;
						if (progress.status !== "running" && progress.status !== "queued")
							return;
						if (!progress.text && !announcement) return;
						try {
							preparation!.context = {
								...(dialogue.answerContext?.(run.id) ?? preparation!.context!),
								answer: spokenText(progress.text),
							};
							append(progress.text);
						} catch (error) {
							streamError = error;
							speechController.abort();
						}
					}) ?? (() => {});
			}
			const waitMs = run.deadlineAt
				? Math.max(0, Date.parse(run.deadlineAt) - Date.now()) + 10_000
				: undefined;
			const final = await dialogue.waitForTerminal(run.id, {
				signal: controller.signal,
				timeoutMs: waitMs,
			});
			if (controller.signal.aborted) return;
			if (streamError) throw streamError;
			if (final && ["queued", "running"].includes(final.status)) {
				await dialogue.cancel(run.id);
				throw new Error("dialogue_wait_timeout");
			}
			if (final?.status !== "completed" || !final.answerMessageId)
				throw new Error(final?.error ?? "dialogue_incomplete");
			const answer = dialogue.answerText(run.id);
			if (!answer) throw new Error("answer_missing");
			if (!speech) {
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
			preparation!.context = dialogue.answerContext?.(run.id) ?? {
				answer,
				turns: preparation!.context?.turns ?? [],
			};
			announcement = final.announcement ?? announcement;
			append(answer, true);
			await speech.work;
			if (controller.signal.aborted) return;
			if (speech.error) throw speech.error;
			log.info("voice.synthesis_completed", {
				runId: run.id,
				count: speech.chunks.size,
			});
			if (speech.skipped > 0)
				log.warn("voice.speech_truncated", {
					runId: run.id,
					count: speech.skipped,
				});
			await advance(turn.utteranceId, speech.chunks.size ? "ready" : "played");
			if (!speech.chunks.size) audio.delete(turn.utteranceId);
		} catch (error) {
			speechController.abort();
			audio.delete(turn.utteranceId);
			throw error;
		} finally {
			unsubscribe();
			controller.signal.removeEventListener("abort", stopSpeech);
			if (controller.signal.aborted) {
				speechController.abort();
				audio.delete(turn.utteranceId);
			}
		}
	};
}
