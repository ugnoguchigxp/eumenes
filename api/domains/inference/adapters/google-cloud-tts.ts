import { z } from "zod";
import { readBounded } from "../../../infrastructure/bounded-read";
import { googleCloudTts, type Resource } from "../../settings/contracts";
import type { ConnectionModels } from "../contracts";
import { isWav } from "../service/wav";
import { decodeSpeechAsWav } from "./speech-audio";

type Send = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const catalogSchema = z.object({
	voices: z
		.array(
			z.object({
				name: z.string().min(1).max(200),
				languageCodes: z.array(z.string()),
				ssmlGender: z.string(),
			}),
		)
		.default([]),
});
const audioSchema = z.object({ audioContent: z.base64() });
const maxAudioBytes = 16_000_000;

async function request(
	send: Send,
	key: string,
	path: string,
	signal: AbortSignal,
	limit: number,
	body?: unknown,
): Promise<unknown> {
	const response = await send(`${googleCloudTts.baseUrl}/${path}`, {
		method: body ? "POST" : "GET",
		headers: {
			"x-goog-api-key": key,
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
		signal,
		redirect: "error",
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`cloud_http_${response.status}`);
	}
	const bytes = await readBounded(response.body, {
		limit,
		tooLarge: "response_too_large",
		missing: "invalid_response",
	});
	signal.throwIfAborted();
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new Error("invalid_response_json");
	}
}

export async function googleCloudTtsModels(
	send: Send,
	key: string,
	signal: AbortSignal,
): Promise<ConnectionModels> {
	const language = googleCloudTts.language;
	const payload = await request(
		send,
		key,
		`voices?languageCode=${language}`,
		signal,
		1_000_000,
	);
	const catalog = catalogSchema.safeParse(payload);
	if (!catalog.success) throw new Error("invalid_response_json");
	// Google identifies the voice family in the catalog name.
	const prefix = `${language}-Chirp3-HD-`;
	const voices = catalog.data.voices
		.filter(
			(v) =>
				v.languageCodes.includes(language) &&
				v.ssmlGender === "FEMALE" &&
				v.name.startsWith(prefix),
		)
		.map((v) => v.name)
		.sort();
	return {
		models: voices.map((voice) => ({
			id: voice,
			displayName: voice.slice(prefix.length),
			contextWindow: null,
			purpose: "tts",
			speech: {
				supported: true,
				reason: null,
				voices: [voice],
				languages: [language],
				voiceRequired: true,
				languageRequired: true,
				voiceDefault: voice,
				languageDefault: language,
				voiceSelectable: false,
				languageSelectable: false,
			},
		})),
		account: { auth: "api-key", subscriptionType: null },
	};
}

export async function googleCloudSpeech(
	send: Send,
	key: string,
	resource: Resource,
	text: string,
	signal: AbortSignal,
) {
	const decoder = Bun.which("ffmpeg");
	const payload = await request(
		send,
		key,
		"text:synthesize",
		signal,
		Math.ceil(maxAudioBytes / 3) * 4 + 1024,
		{
			input: { text },
			voice: {
				name: resource.model,
				languageCode: resource.language,
				ssmlGender: "FEMALE",
			},
			audioConfig: {
				audioEncoding: decoder ? "MP3" : "LINEAR16",
				...(resource.speed === undefined
					? {}
					: { speakingRate: resource.speed }),
			},
		},
	);
	const result = audioSchema.safeParse(payload);
	if (!result.success) throw new Error("invalid_tts_audio");
	const audio = Buffer.from(result.data.audioContent, "base64");
	if (audio.length > maxAudioBytes) throw new Error("response_too_large");
	if (isWav(audio)) return audio;
	if (!decoder) throw new Error("invalid_tts_audio");
	return decodeSpeechAsWav(audio, signal, decoder);
}
