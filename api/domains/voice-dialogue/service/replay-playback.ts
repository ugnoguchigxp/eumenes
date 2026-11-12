import { SpeechSentences } from "./sentences";
import { spokenText } from "./spoken-text";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { SpeechPreparation } from "../../delivery";
import type { DialogueService } from "../../dialogue";
import type { Run } from "../../dialogue/contracts";
import type { InferencePort } from "../../inference";

/** The sentences an on-demand replay speaks, split as a live answer is. */
export const replaySentences = (text: string) =>
	new SpeechSentences().append(spokenText(text), true);

/** A completed handover's adopted announcement is spoken when it has no final-answer message. */
function replayTextMatches(
	run: Run | null | undefined,
	answer: string | null,
	text: string,
) {
	if (run?.status !== "completed") return false;
	const saved = run.answerMessageId ? answer : run.announcement;
	return replaySentences(saved ?? "").includes(text);
}

export function createReplaySpeech({
	store,
	dialogue,
	larm,
	externalActive,
}: {
	store: SqliteStore;
	dialogue: DialogueService;
	larm: InferencePort;
	externalActive: () => boolean;
}) {
	return async function replaySpeech(
		text: string,
		signal: AbortSignal,
		runId?: string,
		messageId?: string,
	) {
		if (externalActive()) throw new Error("live_legacy_voice_disabled");
		if (!text.trim() || text.length > 400)
			throw new Error("replay_text_invalid");
		const replayRun = runId ? dialogue.get(runId) : undefined;
		if (
			runId &&
			!replayTextMatches(replayRun, dialogue.answerText(runId), text)
		)
			throw new Error("replay_text_invalid");
		const context = runId ? dialogue.answerContext?.(runId) : undefined;
		const saved = replayRun?.answerMessageId
			? dialogue.answerDelivery(replayRun.id)
			: undefined;

		// A runless message's own feeling (agency utterance), only for a clause of that message.
		const own =
			!runId && messageId ? dialogue.hostMessageDelivery(messageId) : null;
		const hostDelivery =
			saved?.source === "host"
				? saved
				: own && replaySentences(own.text).includes(text)
					? own.delivery
					: undefined;
		const preparation: SpeechPreparation = {
			...(replayRun
				? {
						collection: {
							conversationId: replayRun.conversationId,
							turnId: replayRun.id,
							granularity: "answer",
							chunkOrder: null,
						},
					}
				: {}),
			...(context ? { context } : {}),
			...(hostDelivery ? { delivery: hostDelivery } : {}),
			deliveryScope: "chunk",
		};
		const speech = larm.speakWithDelivery
			? await larm.speakWithDelivery(text, signal, preparation)
			: { wav: await larm.speak(text, signal) };
		signal.throwIfAborted();
		if (runId && speech.delivery)
			await store.write((db) => {
				signal.throwIfAborted();
				dialogue.recordAnswerDeliveryInTransaction(db, runId, speech.delivery!);
			});
		// The bubble and the face show the answer's adopted emotion. Clause delivery still shapes TTS.
		const avatarDelivery =
			saved?.version === 2 && saved.source !== "fallback"
				? saved
				: speech.delivery;
		return { ...speech, avatarDelivery };
	};
}
