import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import { deliveryAvatarCue, type AvatarCue } from "../../avatar";
import type { RunSpeechEvent } from "../../../../../api/domains/voice-dialogue/contracts";
import { reportPlayed, speechTrace } from "./audio-timing";

export type StreamedSpeechChunk = {
	text: string;
	wav: Uint8Array;
	motion: AvatarCue["motion"];
	emotion?: AvatarCue["emotion"];
	index: number;
	signal: AbortSignal;
	played: (audible: boolean) => Promise<unknown>;
};

/** Starts synthesis immediately; the consumer may wait for the screen's output to become free. */
export function createRunSpeechSource(
	client: VoiceDialogueClient,
	runId: string,
	screenId: string,
) {
	const lifetime = new AbortController();
	const receipts = new AbortController();
	let generation = new AbortController();
	const chunks: StreamedSpeechChunk[] = [];
	let finished = false,
		ended = false,
		error: unknown;
	let notify = () => {};
	let ready!: (value: boolean) => void;
	const readyPromise = new Promise<boolean>((resolve) => {
		ready = resolve;
	});
	const stop = () => {
		lifetime.abort();
		// The final receipt may still be receiving its HTTP response when the
		// server's finished event arrives. It already accepted all played clauses.
		if (!finished) receipts.abort();
		generation.abort();
		chunks.length = 0;
		ended = true;
		ready(false);
		notify();
	};
	const receive = (event: RunSpeechEvent) => {
		if (lifetime.signal.aborted || finished) return;
		if (event.type === "generation") {
			generation.abort();
			generation = new AbortController();
			chunks.length = 0;
			notify();
		} else if (event.type === "audio") {
			const identity = { runId, chunkIndex: event.index };
			speechTrace("received", identity);
			const signal = generation.signal;
			const cue = deliveryAvatarCue(
				`stream:${runId}:${event.index}`,
				event.delivery,
			);
			chunks.push({
				text: event.text,
				wav: Uint8Array.from(atob(event.wav), (c) => c.charCodeAt(0)),
				motion: cue.motion,
				emotion: cue.emotion,
				index: event.index,
				signal,
				played: (audible) =>
					reportPlayed(identity, () =>
						client.runSpeechPlayed(
							runId,
							event.sessionId,
							{
								screenId,
								generationId: event.generationId,
								index: event.index,
								audible,
							},
							receipts.signal,
						),
					),
			});
			ready(true);
			notify();
		} else if (event.type === "finished") {
			finished = true;
			ended = true;
			ready(false);
			notify();
		}
	};
	void client
		.watchRunSpeech(runId, screenId, lifetime.signal, receive)
		.catch((cause) => {
			if (!lifetime.signal.aborted) {
				error = cause;
				generation.abort();
				chunks.length = 0;
			}
			ended = true;
			ready(false);
			notify();
		});
	return {
		runId,
		ready: readyPromise,
		stop,
		hasBufferedChunk: () => chunks.length > 0,
		async next(): Promise<StreamedSpeechChunk | null> {
			for (;;) {
				if (error) throw error;
				if (chunks.length) return chunks.shift()!;
				if (ended) return null;
				await new Promise<void>((resolve) => {
					notify = resolve;
				});
			}
		},
	};
}
export type RunSpeechSource = ReturnType<typeof createRunSpeechSource>;
