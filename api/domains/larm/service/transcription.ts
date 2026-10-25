import type { LarmCallOptions } from "../contracts";
import type { Provider } from "./profiles";
import type { createInfer } from "./infer";
import { readJson, record } from "./guards";
import { asrWavSegments } from "./asr-wav";

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
		const text = record(await readJson(response)).text;
		if (typeof text !== "string") throw new Error("larm_invalid_contract");
		texts.push(text);
		if (texts.join("\n").length > 4096)
			throw new Error("larm_invalid_contract");
	}
	signal.throwIfAborted();
	return texts.join("\n");
}
