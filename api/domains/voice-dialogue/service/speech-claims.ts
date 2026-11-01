import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { DialogueService } from "../../dialogue";
import type { Run } from "../../dialogue/contracts";
import type { InferencePort } from "../../inference";
import { get } from "../repository";
import { getLogger } from "../../../infrastructure/logger";
const log = getLogger("voice-dialogue");

const CLAIM_MS = 600_000;
const MAX_CLAIMS = 512;

/**
 * Eumenes speaks as one: the conversation agent, or the specialist the conversation is switched to
 * (spec tts-single-lane §4.1). A specialist's answer that completes after the conversation came back
 * is not read; the conversation agent reports it.
 */
export function spokenBySpeaker(
	run: Run,
	dialogue: Pick<DialogueService, "specialistSession">,
) {
	if (!run.specialistSessionId) return true;
	const session = dialogue.specialistSession?.(run.conversationId);
	return session?.id === run.specialistSessionId && session.state === "active";
}

/**
 * An automatic speech or notice is played once, on the playback screen (spec tts-single-lane §4.3).
 * The first claim of a source wins; claims are kept in memory for ten minutes.
 */
export function createSpeechClaims({
	store,
	dialogue,
	larm,
	now = Date.now,
}: {
	store: SqliteStore;
	dialogue: DialogueService;
	larm: InferencePort;
	now?: () => number;
}) {
	const claims = new Map<string, number>();
	function refusal(screenId: string, sourceKey: string) {
		if (!larm.isPlaybackScreen?.(screenId)) return "not_playback_screen";
		const runKey = /^run:([^:]+):/.exec(sourceKey);
		if (runKey) {
			const run = dialogue.get(runKey[1]!);
			// A light message (announcement) is read while its run is still going; an answer is read only once adopted.
			const announcement = sourceKey.startsWith(
				`run:${runKey[1]}:announcement:`,
			);
			if (!run || (!announcement && run.status !== "completed"))
				return "speech_not_speaker";
			// A voice turn speaks its own answer in chunks on the screen that holds the microphone.
			if (
				run.utteranceId &&
				store.read((db) => get(db, run.utteranceId!))?.runId === run.id
			)
				return "speech_owned_by_voice_turn";
			if (!spokenBySpeaker(run, dialogue)) return "speech_not_speaker";
		}
		for (const [key, at] of claims)
			if (at + CLAIM_MS <= now()) claims.delete(key);
		if (claims.has(sourceKey)) return "speech_already_claimed";
		return null;
	}
	return {
		claim(screenId: string, sourceKey: string) {
			const reason = refusal(screenId, sourceKey);
			if (reason) {
				log.info("voice.speech_claim_rejected", {
					screenId,
					subjectId: sourceKey,
					reason,
				});
				throw new Error(reason);
			}
			if (claims.size >= MAX_CLAIMS) claims.delete(claims.keys().next().value!);
			claims.set(sourceKey, now());
			log.info("voice.speech_claimed", { screenId, subjectId: sourceKey });
		},
	};
}
