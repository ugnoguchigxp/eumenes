import {
	voiceTurnSchema,
	type VoiceTurn,
} from "../api/domains/voice-dialogue/contracts";
import { readSse } from "./sse";
import type { Transport } from "./transport";

/** One result subscription. Reopening it is an explicit draft recovery, never an automatic send. */
export async function watchVoiceInput(
	transport: Transport,
	id: string,
	signal: AbortSignal,
	receive: (turn: VoiceTurn) => void,
) {
	let revision = -1;
	let owner: string | undefined;
	const result = await readSse(
		(attempt) =>
			transport.call(
				`/api/voice/turns/${encodeURIComponent(id)}/input-events`,
				{
					signal: attempt,
					headers: { Accept: "text/event-stream" },
				},
			),
		{
			signal,
			idleMs: 45_000,
			connectMs: 10_000,
			maxFrame: 64_000,
			errors: {
				invalid: "invalid_voice_input_stream",
				tooLarge: "voice_input_frame_too_large",
			},
			onEvent({ data }) {
				if (!data) return;
				const turn = voiceTurnSchema.parse(JSON.parse(data));
				const nextOwner = `${turn.sessionId}:${turn.generation}:${turn.sequence}`;
				if (turn.utteranceId !== id || (owner && owner !== nextOwner))
					throw new Error("voice_input_stream_mismatch");
				owner = nextOwner;
				if (turn.revision <= revision) return;
				revision = turn.revision;
				signal.throwIfAborted();
				receive(turn);
				return turn.status !== "recognizing";
			},
		},
	);
	signal.throwIfAborted();
	if (result !== "stopped") throw new Error("voice_input_disconnected");
}
