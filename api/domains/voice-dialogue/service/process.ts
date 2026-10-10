import type { Database } from "bun:sqlite";
import type { SpeechPreparation } from "../../delivery";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { DialogueService } from "../../dialogue";
import type { InferencePort, Receipt } from "../../inference";
import type { VoiceTurn } from "../contracts";
import { get } from "../repository";
import { withLogContext, getLogger } from "../../../infrastructure/logger";
import { toErrorCode } from "../../../infrastructure/error-code";
import { spokenText } from "./spoken-text";
import {
	transcriptLanguageMessages,
	parseTranscriptLanguage,
	transcriptLanguageStatus,
} from "./transcript-language";
import type { Speech } from "./speech-state";
const log = getLogger("voice-dialogue");
export type VoiceAdvance = (
	id: string,
	status: VoiceTurn["status"],
	patch?: { text?: string; runId?: string; error?: string },
	receipt?: Receipt,
	language?: { receipt: Receipt; turn: VoiceTurn; signal: AbortSignal },
) => Promise<boolean>;
export function createVoiceProcessor({
	store,
	dialogue,
	larm,
	advance,
	createSpeech,
	controllers,
	audio,
	languageRequests,
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
	controllers: Map<string, AbortController>;
	audio: Map<string, Speech>;
	languageRequests: Map<string, string>;
	linkRunInTransaction: (db: Database, id: string, runId: string) => void;
}) {
	return async function process(
		turn: VoiceTurn,
		wav: Uint8Array,
		controller: AbortController,
	) {
		return withLogContext(
			{
				utteranceId: turn.utteranceId,
				sessionId: turn.sessionId,
				generation: turn.generation,
			},
			async () => {
				const started = performance.now();
				log.info("voice.processing_started", { bytes: wav.length });
				try {
					const asrId = store.read((db) =>
						larm.requestFor?.(db, turn.utteranceId, "asr"),
					);
					const asrReceipt =
						asrId && larm.executeRequest
							? await larm.executeRequest(asrId, wav, controller.signal)
							: undefined;
					const text = asrReceipt
						? (asrReceipt.value as string)
						: await larm.transcribe(wav, controller.signal);
					if (controller.signal.aborted) return;
					if (!text.trim()) {
						await advance(
							turn.utteranceId,
							"completed",
							{ text: "" },
							asrReceipt,
						);
						await store.write((db) => {
							larm.skipInTransaction?.(db, turn.utteranceId, "llm");
							larm.skipInTransaction?.(db, turn.utteranceId, "tts");
						});
						log.info("voice.input_ignored", { reason: "empty_transcript" });
						return;
					}
					if (
						!larm.captureControlInTransaction ||
						!larm.executeControl ||
						!larm.bindInTransaction ||
						!asrReceipt
					)
						throw new Error("asr_language_unverified");
					const languageId = await store.write((db) => {
						controller.signal.throwIfAborted();
						return larm.captureControlInTransaction!(db, {
							subject: `voice:${turn.utteranceId}:language`,
							policySubject: turn.utteranceId,
							deadline: Date.now() + 8000,
							maxOutputTokens: 256,
						});
					});
					languageRequests.set(turn.utteranceId, languageId);
					let languageReceipt: Receipt;
					const timeout = new AbortController(),
						timer = setTimeout(() => timeout.abort(), 8000);
					const languageSignal = AbortSignal.any([
						controller.signal,
						timeout.signal,
					]);
					try {
						languageReceipt = await larm.executeControl(
							languageId,
							transcriptLanguageMessages(text),
							languageSignal,
						);
						languageSignal.throwIfAborted();
					} catch {
						controller.signal.throwIfAborted();
						throw new Error("asr_language_unverified");
					} finally {
						clearTimeout(timer);
					}
					const languages = store.read((db) =>
						larm.snapshotFor?.(db, turn.utteranceId),
					)?.general.asrLanguages;
					if (!languages) throw new Error("asr_language_unverified");
					const status = transcriptLanguageStatus(
						parseTranscriptLanguage(languageReceipt.value),
						languages,
					);
					if (status !== "allowed")
						throw new Error(
							status === "not_allowed"
								? "asr_language_not_allowed"
								: "asr_language_unverified",
						);
					if (
						!(await advance(
							turn.utteranceId,
							"responding",
							{ text },
							asrReceipt,
							{ receipt: languageReceipt, turn, signal: controller.signal },
						))
					)
						return;
					controller.signal.throwIfAborted();
					if (!larm.validRequest?.(asrId!) || !larm.validRequest?.(languageId))
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
							{ validationRequestIds: [languageId] },
							(db, accepted) =>
								linkRunInTransaction(db, turn.utteranceId, accepted.id),
						);
					} catch (error) {
						// Cancelled meanwhile: the run was rolled back with the link.
						if (
							error instanceof Error &&
							error.message === "voice_turn_inactive"
						)
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
					await advance(
						turn.utteranceId,
						speech!.chunks.size ? "ready" : "played",
					);
					if (!speech!.chunks.size) audio.delete(turn.utteranceId);
				} catch (error) {
					const code = toErrorCode(error, "voice_failed");
					if (!controller.signal.aborted) {
						let current: VoiceTurn | null = null;
						try {
							current = store.read((db) => get(db, turn.utteranceId));
						} catch {
							/* The store may be closing; the log still records the code. */
						}
						log.error(
							"voice.processing_failed",
							{
								runId: current?.runId ?? undefined,
								phase: current?.status,
								reason: code,
							},
							error,
						);
					}
					audio.delete(turn.utteranceId);
					if (!controller.signal.aborted)
						await advance(turn.utteranceId, "failed", { error: code }).catch(
							() => {},
						);
				} finally {
					controller.abort();
					if (controller.signal.aborted) audio.get(turn.utteranceId)?.wake();
					const languageId = languageRequests.get(turn.utteranceId);
					languageRequests.delete(turn.utteranceId);
					controllers.delete(turn.utteranceId);
					let status: VoiceTurn["status"] | undefined;
					try {
						status = store.read((db) => get(db, turn.utteranceId))?.status;
					} catch {
						/* The store may be closing. */
					}
					log.info("voice.processing_ended", {
						status,
						durationMs: Math.round(performance.now() - started),
					});
					if (languageId) {
						try {
							await store.write((db) =>
								larm.cancelRequestsInTransaction?.(db, [languageId]),
							);
						} catch (error) {
							log.warn(
								"voice.cleanup_failed",
								{ reason: toErrorCode(error, "cleanup_failed") },
								error,
							);
						}
						larm.flushCancelledRequests?.([languageId]);
					}
				}
			},
		);
	};
}
