import {
	runSpeechEventSchema,
	type RunSpeechEvent,
} from "../api/domains/voice-dialogue/contracts";
import { readSse } from "./sse";
import { json, type Transport } from "./transport";

/** One claimed audio stream; a disconnect is terminal so reconnect cannot repeat a spoken clause. */
export async function watchRunSpeech(
	transport: Transport,
	runId: string,
	screenId: string,
	signal: AbortSignal,
	receive: (event: RunSpeechEvent) => void,
) {
	let sessionId: string | undefined;
	let generationId: string | undefined;
	let lastIndex = -1;
	const retired = new Set<string>();
	const result = await readSse(
		(attempt) =>
			transport.call(`/api/voice/runs/${encodeURIComponent(runId)}/speech`, {
				...json({ screenId }),
				signal: attempt,
				headers: {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
				},
			}),
		{
			signal,
			idleMs: 45_000,
			connectMs: 15_000,
			maxFrame: 5_500_000,
			errors: {
				invalid: "invalid_speech_stream",
				tooLarge: "speech_frame_too_large",
			},
			onEvent({ data }) {
				if (!data) return;
				const event = runSpeechEventSchema.parse(JSON.parse(data));
				if (
					event.runId !== runId ||
					(sessionId && event.sessionId !== sessionId)
				)
					throw new Error("speech_stream_mismatch");
				if (!sessionId) {
					if (event.type !== "start") throw new Error("invalid_speech_stream");
					sessionId = event.sessionId;
				}
				if (event.type === "generation") {
					if (
						retired.has(event.generationId) ||
						event.generationId === generationId
					)
						return;
					if (generationId) retired.add(generationId);
					generationId = event.generationId;
				} else if (event.type === "audio") {
					if (retired.has(event.generationId) || event.index <= lastIndex)
						return;
					if (event.generationId !== generationId)
						throw new Error("speech_generation_mismatch");
					lastIndex = event.index;
				}
				receive(event);
				if (event.type === "error") throw new Error(event.reason);
				return event.type === "finished";
			},
		},
	);
	signal.throwIfAborted();
	if (result !== "stopped") throw new Error("speech_stream_disconnected");
}
