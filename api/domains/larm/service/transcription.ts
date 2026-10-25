import type { LarmCallOptions } from "../contracts";
import type { Provider } from "./profiles";
import type { createInfer } from "./infer";
import { readJson, record } from "./guards";
import { asrWavSegments } from "./asr-wav";
import { getLogger } from "../../../infrastructure/logger";

const log = getLogger("larm");

/**
 * A transcript the provider reports in a language outside the accepted ones is noise (ASR turns
 * keyboard clicks into short text of arbitrary languages) and counts as nothing heard. A provider
 * that reports no language is taken as heard.
 */
function heard(body: Record<string, unknown>, options?: LarmCallOptions) {
	const text = body.text;
	if (typeof text !== "string") throw new Error("larm_invalid_contract");
	// Only a plain language name or code is read (and logged); anything else counts as unreported.
	const reported =
		typeof body.language === "string" ? body.language.trim().toLowerCase() : "";
	const language = /^[a-z][a-z -]{0,31}$/.test(reported) ? reported : null;
	const accepted =
		!language ||
		!options?.asrAcceptedLanguages ||
		options.asrAcceptedLanguages.includes(language);
	// kind: the language the provider detected; next: the language it was fixed to.
	log.info("larm.asr_transcribed", {
		...(language ? { kind: language } : {}),
		...(options?.asrLanguage ? { next: options.asrLanguage } : {}),
		outcome: accepted ? "heard" : "language_not_allowed",
	});
	return accepted ? text : "";
}

/** One adopted transcript, even when the provider needs several bounded audio requests. */
export async function transcribeWav(
	provider: Provider,
	wav: Uint8Array,
	infer: ReturnType<typeof createInfer>,
	signal: AbortSignal,
	connectionId: string,
	options?: LarmCallOptions,
) {
	if (wav.length < 44 || wav.length > 4_000_000)
		throw new Error("audio_size_invalid");
	const texts: string[] = [];
	for (const segment of asrWavSegments(wav)) {
		signal.throwIfAborted();
		const form = new FormData();
		form.append("model", provider.model);
		form.append("response_format", "json");
		if (options?.asrLanguage) form.append("language", options.asrLanguage);
		form.append(
			"file",
			new Blob([new Uint8Array(segment)], { type: "audio/wav" }),
			"speech.wav",
		);
		const response = await infer(
			provider,
			"audio/transcriptions",
			{ method: "POST", body: form },
			signal,
			connectionId,
			options,
		);
		texts.push(heard(record(await readJson(response)), options));
		if (texts.join("\n").length > 4096)
			throw new Error("larm_invalid_contract");
	}
	signal.throwIfAborted();
	return texts.join("\n");
}
