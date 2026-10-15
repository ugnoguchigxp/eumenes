import { readBounded } from "../../../infrastructure/bounded-read";
import type { Connection } from "../../settings/contracts";

type Json = Record<string, unknown>;
export const object = (value: unknown): Json =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Json)
		: {};
export const strings = (value: unknown): string[] =>
	Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string")
		: [];

/** Fixed provider origin; only the saved account and catalog model identify a resource. */
export function workersUrl(connection: Connection, path: string) {
	if (
		connection.kind !== "cloudflare-workers-ai" ||
		!connection.accountId ||
		!/^[a-fA-F0-9]{32}$/.test(connection.accountId) ||
		connection.baseUrl !== "https://api.cloudflare.com/client/v4"
	)
		throw new Error("workers_ai_invalid_connection");
	return new URL(
		`https://api.cloudflare.com/client/v4/accounts/${connection.accountId}/ai/${path}`,
	);
}

export async function workersJson(
	send: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
	url: URL,
	token: string,
	signal: AbortSignal,
) {
	const response = await send(url, {
		headers: { Authorization: `Bearer ${token}` },
		signal,
		redirect: "error",
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`workers_ai_http_${response.status}`);
	}
	const bytes = await readBounded(response.body, {
		limit: 2_000_000,
		missing: "workers_ai_invalid_response",
		tooLarge: "response_too_large",
	});
	let json: Json;
	try {
		json = object(JSON.parse(new TextDecoder().decode(bytes)));
	} catch {
		throw new Error("workers_ai_invalid_response");
	}
	if (json.success !== true) throw new Error("workers_ai_request_failed");
	signal.throwIfAborted();
	return json;
}

export async function workersSchema(
	send: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
	connection: Connection,
	token: string,
	model: string,
	signal: AbortSignal,
) {
	const url = workersUrl(connection, "models/schema");
	url.searchParams.set("model", model);
	return object((await workersJson(send, url, token, signal)).result);
}

const variants = (schema: Json): Json[] =>
	[...(((schema.oneOf ?? schema.anyOf) as unknown[]) ?? [schema])].map(object);
const stringField = (fields: Json, key: string) =>
	object(fields[key]).type === "string";

/** Recognize documented wire contracts, never model ids or natural-language descriptions. */
export function speechContract(schema: Json, purpose: "asr" | "tts") {
	const input =
		variants(object(schema.input)).find((v) => v.type === "object") ?? {};
	const fields = object(input.properties);
	const required = strings(input.required);
	const audio = variants(object(fields.audio));
	const audioType = audio.some((v) => v.type === "string")
		? "base64"
		: audio.some(
					(v) =>
						v.type === "array" &&
						["number", "integer"].includes(String(object(v.items).type)),
			  )
			? "bytes"
			: null;
	const textKey = ["text", "prompt"].find((key) => stringField(fields, key));
	const voiceKey = ["speaker", "voice"].find((key) => stringField(fields, key));
	const languageKey = ["language", "lang"].find((key) =>
		stringField(fields, key),
	);
	const voice = object(fields[voiceKey ?? ""]);
	const language = object(fields[languageKey ?? ""]);
	const wav =
		strings(object(fields.container).enum).includes("wav") &&
		strings(object(fields.encoding).enum).includes("linear16");
	const outputs = variants(object(schema.output));
	const mp3 = outputs.some(
		(v) =>
			v.contentType === "audio/mpeg" ||
			object(object(v.properties).audio).type === "string",
	);
	const textOutput = outputs.some((v) =>
		stringField(object(v.properties), "text"),
	);
	const known =
		purpose === "asr"
			? ["audio", languageKey]
			: [
					textKey,
					voiceKey,
					languageKey,
					...(wav ? ["container", "encoding"] : []),
				];
	const unknownRequired = required.some((key) => !known.includes(key));
	const supported =
		!unknownRequired &&
		(purpose === "asr"
			? !!audioType && textOutput
			: !!textKey && (wav || (mp3 && !!Bun.which("ffmpeg"))));
	return {
		supported,
		reason: supported
			? null
			: purpose === "tts" && mp3 && !wav && !Bun.which("ffmpeg")
				? "workers_ai_audio_decoder_unavailable"
				: "workers_ai_schema_unsupported",
		audioType,
		textKey,
		voiceKey,
		languageKey,
		wav,
		voices: strings(voice.enum),
		languages: strings(language.enum),
		voiceRequired: !!voiceKey && required.includes(voiceKey),
		languageRequired: !!languageKey && required.includes(languageKey),
		voiceDefault: typeof voice.default === "string" ? voice.default : null,
		languageDefault:
			typeof language.default === "string" ? language.default : null,
	};
}
