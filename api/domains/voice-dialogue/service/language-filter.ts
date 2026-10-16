import { measureStage } from "../../../infrastructure/performance";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { InferencePort } from "../../inference";
import type { VoiceTurn } from "../contracts";
import {
	inAllowedLanguages,
	parseTranscriptLanguages,
	scriptLanguage,
	transcriptLanguageMessages,
} from "./transcript-language";

/**
 * Whether a transcript is in a language the user allows (`general.asrLanguages`, captured
 * with the turn). Kana settles Japanese at once; anything else gets one control judgment.
 * Anything unjudged counts as not allowed: ASR turns noise into text of arbitrary languages.
 */
export function createLanguageFilter({
	store,
	larm,
}: {
	store: SqliteStore;
	larm: InferencePort;
}) {
	return async function allowed(
		turn: VoiceTurn,
		text: string,
		signal: AbortSignal,
	) {
		const languages = store.read((db) =>
			larm.snapshotFor?.(db, turn.utteranceId),
		)?.general.asrLanguages;
		if (!languages) throw new Error("permission_revoked");
		const script = scriptLanguage(text);
		if (script) return languages.includes(script);
		if (!larm.captureControlInTransaction || !larm.executeControl) return false;
		const id = await store.write((db) =>
			larm.captureControlInTransaction!(db, {
				subject: `voice:${turn.utteranceId}:language`,
				policySubject: turn.utteranceId,
				deadline: Date.now() + 8000,
				maxOutputTokens: 128,
			}),
		);
		try {
			const receipt = await measureStage(
				"voice-dialogue",
				"input_language",
				() =>
					larm.executeControl!(
						id,
						transcriptLanguageMessages(text),
						AbortSignal.any([signal, AbortSignal.timeout(8000)]),
					),
				{ utteranceId: turn.utteranceId },
			);
			const accepted = await store.write(
				(db) => larm.acceptInTransaction?.(db, receipt) ?? false,
			);
			return (
				accepted &&
				inAllowedLanguages(parseTranscriptLanguages(receipt.value), languages)
			);
		} catch {
			signal.throwIfAborted();
			return false;
		} finally {
			await store
				.write((db) => larm.cancelRequestsInTransaction?.(db, [id]))
				.catch(() => {});
			larm.flushCancelledRequests?.([id]);
		}
	};
}
