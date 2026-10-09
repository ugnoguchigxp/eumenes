import { readChatResponse } from "../../../infrastructure/chat-stream";
import { readBounded } from "../../../infrastructure/bounded-read";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { SettingsService, Connection, Resource } from "../../settings";
import type { Messages } from "../contracts";
import type { RequestRow } from "../repository";

export type CloudEnv = {
	store: SqliteStore;
	settings: Pick<SettingsService, "credential">;
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

function bounded(response: Response, limit: number) {
	return readBounded(response.body, {
		limit,
		tooLarge: "response_too_large",
		missing: "invalid_response",
	});
}

/** One cloud provider call (LLM/ASR/TTS); usage is recorded on the attempt. */
export async function cloudRequest(
	env: CloudEnv,
	row: RequestRow,
	input: Messages | string | Uint8Array,
	connection: Connection,
	resource: Resource,
	signal: AbortSignal,
	attemptId: string,
	onDelta?: (text: string) => void,
) {
	const credential = env.settings.credential(connection);
	if (!credential) throw new Error("cloud_credential_unavailable");
	const base = new URL(
		connection.baseUrl.endsWith("/")
			? connection.baseUrl
			: `${connection.baseUrl}/`,
	);
	const init: RequestInit = {
		method: "POST",
		signal,
		redirect: "error",
		headers: { Authorization: `Bearer ${credential}` },
	};
	if (row.purpose === "asr") {
		const form = new FormData();
		form.append(
			"file",
			new Blob([new Uint8Array(input as Uint8Array)], { type: "audio/wav" }),
			"speech.wav",
		);
		form.append("model", resource.model);
		form.append("response_format", "json");
		init.body = form;
	} else {
		let body: unknown;
		if (row.purpose === "tts")
			body = {
				model: resource.model,
				input,
				voice: resource.voice,
				...((resource.speed ?? 1) !== 1 ? { speed: resource.speed } : {}),
				response_format: "wav",
			};
		else {
			const messages = [...(input as Messages)];
			const reserve = Math.min(
				4096,
				Math.floor((resource.contextWindow ?? 0) / 4),
			);
			const budget = (resource.contextWindow ?? 0) - reserve - 512;
			const estimate = () =>
				new TextEncoder().encode(JSON.stringify(messages)).length +
				messages.length * 16;
			while (
				row.contextPolicy !== "exact" &&
				messages.length > 2 &&
				estimate() > budget
			)
				messages.splice(1, Math.min(2, messages.length - 2));
			if (estimate() > budget) throw new Error("context_window_exceeded");
			body = {
				model: resource.model,
				messages,
				stream: !!onDelta,
				max_tokens: reserve,
			};
		}
		init.headers = { ...init.headers, "Content-Type": "application/json" };
		init.body = JSON.stringify(body);
	}
	const path =
		row.purpose === "llm"
			? "chat/completions"
			: row.purpose === "asr"
				? "audio/transcriptions"
				: "audio/speech";
	const response = await (env.fetch ?? fetch)(new URL(path, base), init);
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`cloud_http_${response.status}`);
	}
	if (row.purpose === "llm") {
		const result = await readChatResponse(response, signal, onDelta);
		const count = (v: unknown) =>
			typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
		signal.throwIfAborted();
		await env.store.write((db) =>
			db
				.query(
					"UPDATE inference_attempts SET input_tokens=?,output_tokens=? WHERE id=?",
				)
				.run(
					count(result.usage?.prompt_tokens),
					count(result.usage?.completion_tokens),
					attemptId,
				),
		);
		return result.text;
	}

	const bytes = await bounded(
		response,
		row.purpose === "tts" ? 16_000_000 : 1_000_000,
	);
	if (row.purpose === "tts") {
		if (
			bytes.length < 44 ||
			new TextDecoder().decode(bytes.subarray(0, 4)) !== "RIFF" ||
			new TextDecoder().decode(bytes.subarray(8, 12)) !== "WAVE"
		)
			throw new Error("invalid_tts_audio");
		return bytes;
	}
	let json: Record<string, unknown>;
	try {
		json = JSON.parse(new TextDecoder().decode(bytes)) as Record<
			string,
			unknown
		>;
	} catch {
		throw new Error("invalid_response_json");
	}
	const value =
		row.purpose === "asr"
			? json.text
			: (
					json.choices as Array<{ message?: { content?: unknown } }> | undefined
				)?.[0]?.message?.content;
	if (
		typeof value !== "string" ||
		(!value.trim() &&
			!(row.purpose === "asr" && row.subject.startsWith("probe:")))
	)
		throw new Error("invalid_response_text");
	const usage = json.usage as
		| { prompt_tokens?: unknown; completion_tokens?: unknown }
		| undefined;
	signal.throwIfAborted();
	const count = (v: unknown) =>
		typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
	await env.store.write((db) =>
		db
			.query(
				"UPDATE inference_attempts SET input_tokens=?,output_tokens=? WHERE id=?",
			)
			.run(
				count(usage?.prompt_tokens),
				count(usage?.completion_tokens),
				attemptId,
			),
	);
	return value;
}
