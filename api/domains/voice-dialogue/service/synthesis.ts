import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { DialogueService } from "../../dialogue";
import type { InferencePort } from "../../inference";
import { toErrorCode } from "../../../infrastructure/error-code";
import type { SpeechPreparation } from "../../delivery";
import type { Speech } from "./speech-state";
import { createSpeechQueue } from "./speech-queue";
import { get, update } from "../repository";
import { getLogger } from "../../../infrastructure/logger";
const log = getLogger("voice-dialogue");

export function createSpeechSynthesis({
	store,
	dialogue,
	larm,
	audio,
	clock,
	canSpeak,
	makeRoomForSpeech,
}: {
	store: SqliteStore;
	dialogue: DialogueService;
	larm: InferencePort;
	audio: Map<string, Speech>;
	clock: () => string;
	canSpeak: (id: string, runId: string, signal: AbortSignal) => boolean;
	makeRoomForSpeech: () => void;
}) {
	return function createSpeech(
		id: string,
		runId: string,
		controller: AbortController,
		preparation: SpeechPreparation = {},
		sequence = { generation: 0, nextIndex: 0 },
	): Speech {
		makeRoomForSpeech();
		const state = createSpeechQueue({
			controller,
			preparation,
			sequence,
			clock,
			canSpeak: () => canSpeak(id, runId, controller.signal),
			async synthesize(text, n, clausePreparation) {
				const requestId = larm.captureSpeechChunkInTransaction
					? await store.write((db) =>
							larm.captureSpeechChunkInTransaction!(db, id, n),
						)
					: undefined;
				const receipt =
					requestId && larm.executeRequest
						? await larm.executeRequest(
								requestId,
								text,
								controller.signal,
								clausePreparation,
							)
						: undefined;
				const wav = receipt
					? (receipt.value as Uint8Array)
					: await larm.speak(text, controller.signal);
				return { requestId, receipt, wav };
			},
			publish(_chunk, { receipt }, adopt) {
				return store.write((db) => {
					const turn = get(db, id);
					if (
						!turn ||
						!["responding", "synthesizing", "ready"].includes(turn.status) ||
						controller.signal.aborted
					)
						return false;
					if (receipt && !larm.acceptInTransaction?.(db, receipt))
						throw new Error("permission_revoked");
					if (receipt?.delivery && preparation.deliveryScope !== "chunk")
						dialogue.recordAnswerDeliveryInTransaction?.(
							db,
							runId,
							receipt.delivery,
						);
					adopt();
					return update(db, id, turn.revision, turn.status, clock());
				});
			},
			ready(chunk, first, elapsedMs) {
				if (first)
					log.info("voice.first_chunk_ready", {
						utteranceId: id,
						runId,
						inferenceId: chunk.requestId,
						durationMs: elapsedMs,
					});
				log.debug("voice.chunk_ready", {
					utteranceId: id,
					runId,
					inferenceId: chunk.requestId,
					count: chunk.index,
					bytes: chunk.wav.length,
				});
			},
			skipped(n, error) {
				log.warn("voice.speech_skipped", {
					utteranceId: id,
					runId,
					count: n,
					reason: toErrorCode(error, "tts_failed"),
				});
			},
		});
		audio.set(id, state);
		return state;
	};
}
