import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { DialogueService } from "../../dialogue";
import type { InferencePort, Receipt } from "../../inference";
import type { SpeechPreparation } from "../../delivery";
import type { Speech } from "./speech-state";
import { SpeechSentences } from "./sentences";
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
	): Speech {
		makeRoomForSpeech();
		const pending: Array<{ text: string; preparation: SpeechPreparation }> = [];
		let chunkOrder = 0;
		let previousAssistantChunk: string | undefined;
		const sentences = new SpeechSentences(true);
		const synthesisStarted = performance.now();
		let inputDone = false,
			spoken = false,
			skipError: unknown,
			index = 0;
		const wakes = new Set<() => void>();
		const wake = () => {
			for (const listener of wakes) listener();
			wakes.clear();
		};
		const state: Speech = {
			createdAtMs: Date.parse(clock()),
			skipped: 0,
			chunks: new Map(),
			finished: false,
			wake,
			work: Promise.resolve(),
			append(text, final = false) {
				if (state.error || controller.signal.aborted) return;
				for (const clause of sentences.append(text, final)) {
					pending.push({
						text: clause,
						preparation: {
							...preparation,
							...(preparation.context
								? { context: { ...preparation.context } }
								: {}),
							...(preparation.collection
								? {
										collection: {
											...preparation.collection,
											granularity: "chunk",
											chunkOrder: chunkOrder++,
											previousAssistantChunk,
										},
									}
								: {}),
						},
					});
					previousAssistantChunk = clause;
				}
				inputDone = final;
				wake();
			},
		};
		audio.set(id, state);
		state.work = (async () => {
			while (!controller.signal.aborted) {
				if (pending.length && state.chunks.size < 3) {
					const { text, preparation: clausePreparation } = pending.shift()!;
					if (!canSpeak(id, runId, controller.signal))
						throw new Error("permission_revoked");
					// A transient LARM failure on one clause must not end the whole turn:
					// retry with a fresh chunk index (each attempt is its own request),
					// then skip the clause and keep speaking the rest.
					let synthesized:
						| {
								n: number;
								requestId?: string;
								receipt?: Receipt;
								wav: Uint8Array;
						  }
						| undefined;
					let lastError: unknown;
					for (let attempt = 0; attempt < 3 && !synthesized; attempt++) {
						const n = index++;
						try {
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
							synthesized = { n, requestId, receipt, wav };
						} catch (error) {
							if (
								controller.signal.aborted ||
								(error instanceof Error &&
									error.message === "permission_revoked")
							)
								throw error;
							lastError = error;
							// A text LARM cannot analyze fails identically every time.
							if (
								error instanceof Error &&
								error.message === "larm_inference_422"
							)
								break;
							log.warn(
								"voice.chunk_retry",
								{ utteranceId: id, runId, count: n, attempt: attempt + 1 },
								error,
							);
						}
					}
					if (!synthesized) {
						// The turn fails only if no clause could be spoken at all.
						skipError ??= lastError;
						state.skipped++;
						log.warn("voice.chunk_skipped", { utteranceId: id, runId });
						continue;
					}
					const { n, requestId, receipt, wav } = synthesized;
					if (!canSpeak(id, runId, controller.signal))
						throw new Error("permission_revoked");
					const published = await store.write((db) => {
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
						state.chunks.set(n, {
							index: n,
							text,
							wav,
							requestId,
							...(receipt?.delivery ? { delivery: receipt.delivery } : {}),
						});
						return update(db, id, turn.revision, turn.status, clock());
					});
					if (!published) {
						state.chunks.delete(n);
						return;
					}

					if (!spoken)
						log.info("voice.first_chunk_ready", {
							utteranceId: id,
							runId,
							inferenceId: requestId,
							durationMs: performance.now() - synthesisStarted,
						});
					spoken = true;
					log.debug("voice.chunk_ready", {
						utteranceId: id,
						runId,
						inferenceId: requestId,
						count: n,
						bytes: wav.length,
					});
					continue;
				}
				if (inputDone && !pending.length) {
					if (!spoken && skipError) throw skipError;
					state.finished = true;
					return;
				}
				await new Promise<void>((resolve) => {
					const finish = () => {
						controller.signal.removeEventListener("abort", finish);
						wakes.delete(finish);
						resolve();
					};
					wakes.add(finish);
					controller.signal.addEventListener("abort", finish, { once: true });
					if (controller.signal.aborted) finish();
				});
			}
		})().catch((error) => {
			state.error = error instanceof Error ? error : new Error("tts_failed");
			pending.length = 0;
			state.chunks.clear();
			wake();
		});
		return state;
	};
}
