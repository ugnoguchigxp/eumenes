import { measureStage } from "../../../infrastructure/performance";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { InferencePort, Receipt } from "../../inference";
import type { VoiceTurn } from "../contracts";
import {
	transcriptLanguageMessages,
	parseTranscriptLanguage,
	transcriptLanguageStatus,
	parseTranscriptAssessment,
	type TranscriptContext,
} from "./transcript-language";

/** One ASR and one control call. Staged inputs add endpoint decisions to the language control. */
export async function recognizeInput({
	store,
	larm,
	turn,
	wav,
	controller,
	languageRequests,
	context,
	onTranscript,
}: {
	store: SqliteStore;
	larm: InferencePort;
	turn: VoiceTurn;
	wav: Uint8Array;
	controller: AbortController;
	languageRequests: Map<string, string>;
	context?: (text: string) => TranscriptContext;
	onTranscript?: (text: string, receipt: Receipt) => Promise<void>;
}) {
	const asrId = store.read((db) =>
		larm.requestFor?.(db, turn.utteranceId, "asr"),
	);
	const asrReceipt =
		asrId && larm.executeRequest
			? await measureStage(
					"voice-dialogue",
					"asr",
					() => larm.executeRequest!(asrId, wav, controller.signal),
					{ utteranceId: turn.utteranceId },
				)
			: undefined;
	const text = asrReceipt
		? (asrReceipt.value as string)
		: await larm.transcribe(wav, controller.signal);
	controller.signal.throwIfAborted();
	if (asrReceipt) await onTranscript?.(text, asrReceipt);
	if (!text.trim()) return { text, asrId, asrReceipt };
	if (
		!larm.captureControlInTransaction ||
		!larm.executeControl ||
		!larm.bindInTransaction ||
		!asrReceipt
	)
		throw new Error("asr_language_unverified");
	const languageId = await store.write((db) => {
		controller.signal.throwIfAborted();
		return larm.captureControlInTransaction!(db, {
			subject: `voice:${turn.utteranceId}:language`,
			policySubject: turn.utteranceId,
			deadline: Date.now() + 8000,
			maxOutputTokens: context ? 512 : 256,
		});
	});
	languageRequests.set(turn.utteranceId, languageId);
	const timeout = new AbortController(),
		timer = setTimeout(() => timeout.abort(), 8000);
	const signal = AbortSignal.any([controller.signal, timeout.signal]);
	let languageReceipt: Receipt;
	try {
		languageReceipt = await measureStage(
			"voice-dialogue",
			"input_control",
			() =>
				larm.executeControl!(
					languageId,
					transcriptLanguageMessages(text, context?.(text)),
					signal,
				),
			{ utteranceId: turn.utteranceId },
		);
		signal.throwIfAborted();
	} catch {
		controller.signal.throwIfAborted();
		throw new Error("asr_language_unverified");
	} finally {
		clearTimeout(timer);
	}
	const result = context
		? parseTranscriptAssessment(languageReceipt.value)
		: parseTranscriptLanguage(languageReceipt.value);
	const languages = store.read((db) => larm.snapshotFor?.(db, turn.utteranceId))
		?.general.asrLanguages;
	if (!languages) throw new Error("asr_language_unverified");
	const status = transcriptLanguageStatus(result, languages);
	if (status !== "allowed")
		throw new Error(
			status === "not_allowed"
				? "asr_language_not_allowed"
				: "asr_language_unverified",
		);
	return {
		text,
		asrId,
		asrReceipt,
		languageId,
		languageReceipt,
		assessment: context
			? parseTranscriptAssessment(languageReceipt.value)
			: undefined,
	};
}
