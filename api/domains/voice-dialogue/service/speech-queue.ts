import type { Receipt } from "../../inference";
import type { SpeechPreparation, SpeechDelivery } from "../../delivery";
import type { Speech, SpeechChunk } from "./speech-state";
import { SpeechSentences } from "./sentences";

export type SpeechResult = {
	wav: Uint8Array;
	requestId?: string;
	receipt?: Receipt;
	delivery?: SpeechDelivery;
};

/** The bounded clause queue shared by microphone replies and typed replies. */
export function createSpeechQueue(options: {
	controller: AbortController;
	preparation: SpeechPreparation;
	sequence: { generation: number; nextIndex: number };
	clock: () => string;
	canSpeak: () => boolean;
	synthesize: (
		text: string,
		index: number,
		preparation: SpeechPreparation,
	) => Promise<SpeechResult>;
	/** Calls adopt inside the source's acceptance transaction, before observers are notified. */
	publish: (
		chunk: SpeechChunk,
		result: SpeechResult,
		adopt: () => void,
	) => Promise<boolean>;
	ready?: (chunk: SpeechChunk, first: boolean, elapsedMs: number) => void;
	skipped?: (index: number, error: unknown) => void;
}): Speech {
	const { controller, preparation, sequence } = options;
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
		skipError: unknown;
	const wakes = new Set<() => void>();
	const wake = () => {
		for (const listener of wakes) listener();
		wakes.clear();
	};
	const state: Speech = {
		createdAtMs: Date.parse(options.clock()),
		generation: sequence.generation,
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
				if (!options.canSpeak()) throw new Error("permission_revoked");
				// A failed clause is not spoken: no retry and no other voice (spec tts-single-lane §4.6).
				// The turn goes on with the next clause and fails only if nothing could be spoken.
				const n = sequence.nextIndex++;
				let synthesized: SpeechResult;
				try {
					synthesized = await options.synthesize(text, n, clausePreparation);
				} catch (error) {
					if (
						controller.signal.aborted ||
						(error instanceof Error && error.message === "permission_revoked")
					)
						throw error;
					skipError ??= error;
					state.skipped++;
					wake();
					options.skipped?.(n, error);
					continue;
				}
				if (!options.canSpeak()) throw new Error("permission_revoked");
				const chunk: SpeechChunk = {
					index: n,
					text,
					wav: synthesized.wav,
					requestId: synthesized.requestId,
					delivery: synthesized.delivery ?? synthesized.receipt?.delivery,
				};
				const published = await options.publish(chunk, synthesized, () => {
					state.chunks.set(n, chunk);
					publishedOrders.set(n, order);
				});
				if (!published) {
					state.chunks.delete(n);
					publishedOrders.delete(n);
					return;
				}
				options.ready?.(chunk, !spoken, performance.now() - synthesisStarted);
				spoken = true;
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
}
