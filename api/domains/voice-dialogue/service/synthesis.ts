import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { DialogueService } from "../../dialogue";
import type { InferencePort, Receipt } from "../../inference";
import { isRetryableSpeechError } from "../../inference";
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
		const pending: Array<{
			text: string;
			preparation: SpeechPreparation;
			order: number;
		}> = [];
		let chunkOrder = 0;
		const publishedOrders = new Map<number, number>();
		const playedOrders = new Set<number>();
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
			played: [],
			wake,
			async waitForPlayback(signal) {
				const through = chunkOrder;
				if (!through) throw new Error("announcement_audio_missing");
				const scoped = AbortSignal.any([signal, controller.signal]);
				while (
					Array.from({ length: through }, (_, i) => i).some(
						(i) => !playedOrders.has(i),
					)
				) {
					scoped.throwIfAborted();
					if (state.error || state.skipped)
						throw new Error("announcement_audio_failed");
					await new Promise<void>((resolve) => {
						const finish = () => {
							scoped.removeEventListener("abort", finish);
							wakes.delete(finish);
							resolve();
						};
						wakes.add(finish);
						scoped.addEventListener("abort", finish, { once: true });
						if (scoped.aborted) finish();
					});
				}
				scoped.throwIfAborted();
			},
			markPlayed(n) {
				const order = publishedOrders.get(n);
				if (order === undefined) return;
				playedOrders.add(order);
				publishedOrders.delete(n);
				wake();
			},
			work: Promise.resolve(),
			append(text, final = false, flush = false) {
				if (state.error || controller.signal.aborted) return;
				for (const clause of sentences.append(text, final || flush)) {
					const order = chunkOrder++;
					pending.push({
						order,
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
											chunkOrder: order,
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
		const discard = () => {
			pending.length = 0;
			state.chunks.clear();
			publishedOrders.clear();
			wake();
		};
		controller.signal.addEventListener("abort", discard, { once: true });
		if (controller.signal.aborted) discard();
		state.work = (async () => {
			while (!controller.signal.aborted) {
				if (pending.length && state.chunks.size < 3) {
					const {
						text,
						preparation: clausePreparation,
						order,
					} = pending.shift()!;
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
							if (!isRetryableSpeechError(error)) break;
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
						wake();
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
						publishedOrders.set(n, order);
						return update(db, id, turn.revision, turn.status, clock());
					});
					if (!published) {
						state.chunks.delete(n);
						publishedOrders.delete(n);
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
		})()
			.catch((error) => {
				state.error = error instanceof Error ? error : new Error("tts_failed");
				discard();
			})
			.finally(() => controller.signal.removeEventListener("abort", discard));
		return state;
	};
}
