import type { RunSpeechDeps } from "./run-speech";
import type { RunSpeechEvent, RunSpeechPlayed } from "../contracts";
import type { Speech } from "./speech-state";
import { createSpeechQueue } from "./speech-queue";
import { recordRunSpeech } from "./run-speech-record";
import { spokenPrefix, spokenText } from "./spoken-text";
import { spokenBySpeaker } from "./speech-claims";
import { toErrorCode } from "../../../infrastructure/error-code";
import { getLogger } from "../../../infrastructure/logger";
const log = getLogger("voice-dialogue");

export function createRunSpeechSession(
	deps: RunSpeechDeps,
	input: {
		id: string;
		runId: string;
		screenId: string;
		signal: AbortSignal;
		remove: () => void;
	},
) {
	const { store, dialogue, larm } = deps;
	const { id: sessionId, runId, screenId } = input;
	const identity = { runId, sessionId };
	let emit: (event: RunSpeechEvent) => void = () => {};
	let end = () => {};
	let closed = false,
		adopted = false,
		recording = false;
	let generationId = "",
		prefix = "";
	let speech: Speech | undefined;
	let generation = new AbortController();
	const sequence = { generation: 0, nextIndex: 0 };
	const past: Speech[] = [];
	const cleanups: Array<() => void> = [];
	const register = (stop: () => void) => {
		if (closed) stop();
		else cleanups.push(stop);
	};
	const acknowledged = new Set<number>();
	const currentRequest = (ref?: string | null) =>
		!ref || !!(larm.liveRequest?.(ref) ?? larm.validRequest?.(ref));
	const valid = () => {
		const run = dialogue.get(runId);
		if (
			closed ||
			deps.externalActive() ||
			!run ||
			!["queued", "running", "completed"].includes(run.status) ||
			!larm.isPlaybackScreen?.(screenId) ||
			!spokenBySpeaker(run, dialogue)
		)
			return false;
		const ref = store.read((db) => larm.requestFor?.(db, runId, "llm"));
		return (
			currentRequest(ref) &&
			[...(speech?.chunks.values() ?? [])].every((chunk) =>
				currentRequest(chunk.requestId),
			)
		);
	};
	async function record(full: boolean) {
		const heard = [...past, ...(speech ? [speech] : [])]
			.flatMap((s) => s.played)
			.sort((a, b) => a.index - b.index)
			.map((c) => c.text)
			.join("");
		await recordRunSpeech(deps, runId, heard, full);
	}
	function close(reason?: string) {
		if (closed) return;
		closed = true;
		for (const cleanup of cleanups.splice(0)) cleanup();
		generation.abort(new Error(reason ?? "speech_finished"));
		speech?.chunks.clear();
		input.remove();
		emit(
			reason
				? { ...identity, type: "error", reason }
				: { ...identity, type: "finished" },
		);
		end();
		if (!recording) {
			recording = true;
			void record(false);
		}
	}
	function finishIfPlayed() {
		if (!closed && adopted && speech?.finished && !speech.chunks.size) {
			recording = true;
			const full = speech.skipped === 0;
			void record(full);
			close();
		}
	}
	function append(body: string, final = false) {
		if (!body.startsWith(prefix)) {
			if (!final || spokenText(body) !== spokenText(prefix))
				throw new Error("speech_stream_diverged");
			body = prefix;
		}
		prefix = body;
		speech!.append(spokenPrefix(body, final), final);
	}
	function start(next: string, signal?: AbortSignal) {
		generation.abort(new Error("generation_replaced"));
		if (speech) {
			speech.chunks.clear();
			past.push(speech);
		}
		generation = new AbortController();
		const local = generation;
		generationId = next;
		prefix = "";
		sequence.generation++;
		if (signal) {
			const abort = () => {
				if (local !== generation || closed) return;
				// A replacement follows synchronously; do not close the session between its generations.
				if (
					signal.reason instanceof Error &&
					signal.reason.message === "generation_replaced"
				) {
					local.abort(signal.reason);
					speech?.chunks.clear();
				} else close(toErrorCode(signal.reason, "generation_cancelled"));
			};
			signal.addEventListener("abort", abort, { once: true });
			cleanups.push(() => signal.removeEventListener("abort", abort));
			if (signal.aborted) {
				abort();
				return;
			}
		}
		emit({ ...identity, type: "generation", generationId });
		const run = dialogue.get(runId)!;
		speech = createSpeechQueue({
			controller: local,
			sequence,
			clock: deps.clock,
			preparation: {
				deliveryScope: "chunk",
				context: dialogue.answerContext(runId) ?? undefined,
				collection: {
					conversationId: run.conversationId,
					turnId: runId,
					granularity: "chunk",
					chunkOrder: null,
				},
			},
			canSpeak: () => !local.signal.aborted && local === generation && valid(),
			async synthesize(text, index, preparation) {
				log.debug("voice.chunk_synthesis_started", { runId, count: index });
				const result = larm.speakWithDelivery
					? await larm.speakWithDelivery(text, local.signal, preparation)
					: { wav: await larm.speak(text, local.signal) };
				if (result.wav.length > 4_000_000) throw new Error("audio_too_large");
				return result;
			},
			async publish(chunk, _result, accept) {
				if (
					local.signal.aborted ||
					local !== generation ||
					!valid() ||
					!currentRequest(chunk.requestId)
				)
					throw new Error("permission_revoked");
				accept();
				return true;
			},
			ready(chunk, first, elapsed) {
				if (closed || local !== generation || local.signal.aborted) return;
				log.info("voice.chunk_ready", {
					runId,
					count: chunk.index,
					inferenceId: chunk.requestId,
					bytes: chunk.wav.length,
				});
				if (first)
					log.info("voice.first_chunk_ready", { runId, durationMs: elapsed });
				emit({
					...identity,
					type: "audio",
					generationId: next,
					index: chunk.index,
					text: chunk.text,
					wav: Buffer.from(chunk.wav).toString("base64"),
					delivery: chunk.delivery,
				});
			},
			skipped(index, error) {
				log.warn("voice.speech_skipped", {
					runId,
					count: index,
					reason: toErrorCode(error, "tts_failed"),
				});
			},
		});
		const current = speech;
		void current.work.then(() => {
			if (closed || local !== generation || local.signal.aborted) return;
			if (current.error) close(toErrorCode(current.error, "tts_failed"));
			else finishIfPlayed();
		});
	}
	return {
		runId,
		screenId,
		close,
		connect(send: typeof emit, finish: () => void) {
			emit = send;
			end = finish;
			emit({ ...identity, type: "start" });
			const aborted = () => close("cancelled");
			input.signal.addEventListener("abort", aborted, { once: true });
			cleanups.push(() => input.signal.removeEventListener("abort", aborted));
			const timer = setTimeout(() => close("speech_timeout"), 600_000);
			cleanups.push(() => clearTimeout(timer));
			if (input.signal.aborted || !valid()) {
				close("permission_revoked");
				return () => {};
			}
			register(
				dialogue.subscribeAnswerStream(runId, (body) => {
					if (closed) return;
					try {
						if (generationId !== body.generationId)
							start(body.generationId, body.signal);
						if (!closed && speech) append(body.text);
					} catch (error) {
						close(toErrorCode(error, "tts_failed"));
					}
				}),
			);
			register(
				dialogue.subscribeProgress(runId, (value) => {
					if (closed) return;
					try {
						if (["failed", "cancelled", "interrupted"].includes(value.status)) {
							close(value.error ?? "generation_cancelled");
							return;
						}
						if (value.status !== "completed" || adopted) return;
						adopted = true;
						if (!speech) start(crypto.randomUUID());
						append(
							dialogue.get(runId)?.answerMessageId ? value.text : prefix,
							true,
						);
						finishIfPlayed();
					} catch (error) {
						close(toErrorCode(error, "tts_failed"));
					}
				}),
			);
			register(
				store.onCommit(() => {
					if (!closed && !valid()) close("permission_revoked");
				}),
			);
			const changed = larm.onChange?.(() => {
				if (!closed && !valid()) close("permission_revoked");
			});
			if (changed) register(changed);
			return () => close("disconnected");
		},
		async played(value: RunSpeechPlayed) {
			log.info("voice.playback_report_received", {
				runId,
				sessionId,
				chunkIndex: value.index,
			});
			if (!valid() || value.generationId !== generationId || !speech)
				throw new Error("speech_session_stale");
			if (acknowledged.has(value.index)) return;
			const current = speech,
				chunk = current.chunks.get(value.index);
			if (!chunk) throw new Error("speech_session_stale");
			// Serialize receipt handling with source invalidation and other playback acknowledgements.
			const accepted = await store.write(
				() => valid() && current === speech && current.chunks.has(value.index),
			);
			if (
				accepted &&
				!closed &&
				current === speech &&
				!acknowledged.has(value.index)
			) {
				if (value.audible)
					current.played.push({ index: chunk.index, text: chunk.text });
				else current.skipped++;
				current.played.sort((a, b) => a.index - b.index);
				acknowledged.add(value.index);
				current.chunks.delete(value.index);
				current.markPlayed(value.index);
				current.wake();
				log.info("voice.playback_report_accepted", {
					runId,
					sessionId,
					chunkIndex: value.index,
				});
			}
			finishIfPlayed();
		},
	};
}
