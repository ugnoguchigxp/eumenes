import { readChatResponse } from "../../../infrastructure/chat-stream";
import { readBounded } from "../../../infrastructure/bounded-read";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	isAgentConnection,
	type SettingsService,
	type Connection,
	type Resource,
} from "../../settings";
import type { CloudAgentKind, CloudAgents } from "../adapters/cloud-agents";
import type { Messages } from "../contracts";
import type { RequestRow } from "../repository";

export type CloudEnv = {
	store: SqliteStore;
	settings: Pick<SettingsService, "credential">;
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	agents?: CloudAgents;
};

function bounded(response: Response, limit: number) {
	return readBounded(response.body, {
		limit,
		tooLarge: "response_too_large",
		missing: "invalid_response",
	});
}

/** Drops the oldest turns (after the first message) until the estimate fits the window. */
function fitMessages(row: RequestRow, resource: Resource, input: Messages) {
	const messages = [...input];
	const reserve = Math.min(4096, Math.floor((resource.contextWindow ?? 0) / 4));
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
	return { messages, reserve };
}

async function recordUsage(
	env: CloudEnv,
	attemptId: string,
	input: unknown,
	output: unknown,
) {
	const count = (v: unknown) =>
		typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
	await env.store.write((db) =>
		db
			.query(
				"UPDATE inference_attempts SET input_tokens=?,output_tokens=? WHERE id=?",
			)
			.run(count(input), count(output), attemptId),
	);
}

/** An agent SDK connection (Codex / Claude Agent SDK / Managed Agents) answering one LLM turn. */
async function agentRequest(
	env: CloudEnv,
	row: RequestRow,
	input: Messages,
	connection: Connection,
	resource: Resource,
	credential: string | null,
	signal: AbortSignal,
	attemptId: string,
	onDelta?: (text: string) => void,
	options?: import("../../larm").LarmCallOptions,
) {
	if (row.purpose !== "llm") throw new Error("cloud_agent_purpose_unsupported");
	if (!env.agents) throw new Error("cloud_agent_unavailable");
	const result = await env.agents.run({
		kind: connection.kind as CloudAgentKind,
		model: resource.model,
		baseUrl: connection.baseUrl,
		credential,
		agentId: connection.agentId,
		environmentId: connection.environmentId,
		messages: fitMessages(row, resource, input).messages,
		tools: options?.tools,
		signal,
		onDelta,
	});
	signal.throwIfAborted();
	if (result.toolCalls?.length) {
		if (!options?.tools?.length || !options.onToolCalls)
			throw new Error("chat_tool_calls_unexpected");
		options.onToolCalls(result.toolCalls);
	}
	await recordUsage(env, attemptId, result.inputTokens, result.outputTokens);
	return result.text;
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
	options?: import("../../larm").LarmCallOptions,
) {
	const credential = env.settings.credential(connection);
	if (isAgentConnection(connection))
		return agentRequest(
			env,
			row,
			input as Messages,
			connection,
			resource,
			credential,
			signal,
			attemptId,
			onDelta,
			options,
		);
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
			const { messages, reserve } = fitMessages(
				row,
				resource,
				input as Messages,
			);
			body = {
				model: resource.model,
				messages,
				...(options?.tools?.length
					? {
							tools: options.tools,
							tool_choice: "auto",
							parallel_tool_calls: false,
						}
					: {}),
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
		if (result.toolCalls?.length) {
			if (!options?.tools?.length || !options.onToolCalls)
				throw new Error("chat_tool_calls_unexpected");
			options.onToolCalls(result.toolCalls);
		}
		signal.throwIfAborted();
		await recordUsage(
			env,
			attemptId,
			result.usage?.prompt_tokens,
			result.usage?.completion_tokens,
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
	await recordUsage(
		env,
		attemptId,
		usage?.prompt_tokens,
		usage?.completion_tokens,
	);
	return value;
}
