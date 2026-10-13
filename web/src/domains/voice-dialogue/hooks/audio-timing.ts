import { browserTiming } from "../../../performance";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";

export const chunkTiming = (utteranceId: string, chunkIndex: number) => ({
	utteranceId,
	chunkIndex,
});

export async function timedVoiceAudio(
	client: VoiceDialogueClient,
	identity: ReturnType<typeof chunkTiming>,
) {
	const started = performance.now();
	const bytes = await client.voiceAudio(
		identity.utteranceId,
		identity.chunkIndex,
	);
	browserTiming("audio_fetch", identity, started);
	return bytes;
}
