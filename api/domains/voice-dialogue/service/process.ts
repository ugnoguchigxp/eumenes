import type { Database } from "bun:sqlite";
import type { SpeechPreparation } from "../../delivery";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { DialogueService } from "../../dialogue";
import type { InferencePort, Receipt } from "../../inference";
import type { VoiceTurn } from "../contracts";
import { get } from "../repository";
import { withLogContext, getLogger } from "../../../infrastructure/logger";
import { toErrorCode } from "../../../infrastructure/error-code";
import { recognizeInput } from "./recognize";
import { createVoiceResponder } from "./respond";
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
	const respond = createVoiceResponder({
		store,
		dialogue,
		larm,
		advance,
		createSpeech,
		audio,
		linkRunInTransaction,
	});
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
					const { text, asrId, asrReceipt, languageId, languageReceipt } =
						await recognizeInput({
							store,
							larm,
							turn,
							wav,
							controller,
							languageRequests,
						});
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
						!(await advance(
							turn.utteranceId,
							"responding",
							{ text },
							asrReceipt,
							{ receipt: languageReceipt!, turn, signal: controller.signal },
						))
					)
						return;
					await respond(turn, text, asrId!, languageId!, controller);
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
