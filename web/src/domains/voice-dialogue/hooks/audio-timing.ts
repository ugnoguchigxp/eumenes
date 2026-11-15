import { browserTiming, type TimingIdentity } from "../../../performance";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";

export const chunkTiming = (utteranceId: string, chunkIndex: number) => ({
	utteranceId,
	chunkIndex,
});

/** Browser-local operational timings; no text, audio or provider details. */
export function speechTrace(
	stage: "received" | "report_sent" | "report_completed" | "report_failed",
	identity: TimingIdentity,
	durationMs?: number,
) {
	try {
		console.info(
			"eumenes.speech_transport",
			JSON.stringify({
				stage,
				at: Date.now(),
				runId: identity.runId,
				utteranceId: identity.utteranceId,
				chunkIndex: identity.chunkIndex,
				durationMs,
			}),
		);
	} catch {
		// A diagnostic sink must never change playback or receipt handling.
	}
}

export async function reportPlayed<T>(
	identity: TimingIdentity,
	send: () => Promise<T>,
) {
	const started = performance.now();
	speechTrace("report_sent", identity);
	try {
		const result = await send();
		speechTrace("report_completed", identity, performance.now() - started);
		return result;
	} catch (error) {
		speechTrace("report_failed", identity, performance.now() - started);
		throw error;
	} finally {
		browserTiming("playback_report", identity, started);
	}
}

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
	speechTrace("received", identity);
	return bytes;
}
