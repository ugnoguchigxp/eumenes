import { readBounded } from "../../../infrastructure/bounded-read";
import type { Connection, Resource } from "../../settings/contracts";
import { isWav } from "../service/wav";
import { decodeSpeechAsWav } from "./speech-audio";
import {
	object,
	speechContract,
	workersSchema,
	workersUrl,
} from "./workers-ai";

/** Normalize the provider's encoded audio at the backend boundary. No files or remote inputs. */
export async function workersAudio(bytes: Uint8Array, signal: AbortSignal) {
	signal.throwIfAborted();
	if (isWav(bytes)) return bytes;
	const decoder = Bun.which("ffmpeg");
	if (!decoder) throw new Error("workers_ai_audio_decoder_unavailable");
	return decodeSpeechAsWav(bytes, signal, decoder);
}

export async function workersSpeechRequest(
	send: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
	connection: Connection,
	token: string,
	resource: Resource,
	input: string | Uint8Array,
	signal: AbortSignal,
) {
	if (resource.purpose === "llm")
		throw new Error("workers_ai_purpose_unsupported");
	const schema = await workersSchema(
		send,
		connection,
		token,
		resource.model,
		signal,
	);
	const contract = speechContract(schema, resource.purpose);
	if (!contract.supported) throw new Error(contract.reason!);
	const body: Record<string, unknown> = {};
	if (resource.purpose === "asr") {
		body.audio =
			contract.audioType === "base64"
				? Buffer.from(input as Uint8Array).toString("base64")
				: [...(input as Uint8Array)];
	} else {
		body[contract.textKey!] = input;
		if (contract.wav) {
			body.encoding = "linear16";
			body.container = "wav";
		}
	}
	for (const [key, value, choices, required] of [
		[
			contract.voiceKey,
			resource.voice,
			contract.voices,
			contract.voiceRequired,
		],
		[
			contract.languageKey,
			resource.language,
			contract.languages,
			contract.languageRequired,
		],
	] as const) {
		if (key && value) {
			if (choices.length && !choices.includes(value))
				throw new Error("workers_ai_option_invalid");
			body[key] = value;
		} else if (key && required) throw new Error("workers_ai_option_required");
	}
	// A model identifier must remain a path beneath /ai/run, never an arbitrary URL.
	if (
		!/^@[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(resource.model)
	)
		throw new Error("workers_ai_model_invalid");
	const response = await send(workersUrl(connection, `run/${resource.model}`), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal,
		redirect: "error",
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`workers_ai_http_${response.status}`);
	}
	let bytes = await readBounded(response.body, {
		limit: resource.purpose === "tts" ? 24_000_000 : 1_000_000,
		tooLarge: "response_too_large",
		missing: "workers_ai_invalid_response",
	});
	signal.throwIfAborted();
	if (
		resource.purpose === "tts" &&
		!response.headers.get("content-type")?.includes("json")
	)
		return workersAudio(bytes, signal);
	let json: Record<string, unknown>;
	try {
		json = object(JSON.parse(new TextDecoder().decode(bytes)));
	} catch {
		throw new Error("workers_ai_invalid_response");
	}
	if (json.success !== true) throw new Error("workers_ai_request_failed");
	const result = object(json.result);
	if (resource.purpose === "asr") {
		if (typeof result.text !== "string")
			throw new Error("invalid_response_text");
		return result.text;
	}
	if (
		typeof result.audio !== "string" ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(result.audio)
	)
		throw new Error("invalid_tts_audio");
	bytes = new Uint8Array(Buffer.from(result.audio, "base64"));
	return workersAudio(bytes, signal);
}
