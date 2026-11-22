import { imageMessageParts } from "../../../infrastructure/chat-image-parts";
import {
	inputMessages,
	observeModelInput,
} from "../../../infrastructure/model-input";
import { cloudImages, checkImageRequest } from "./cloud-images";
import type { ConnectionModelsService } from "./connection-models";
import { workersSpeechRequest } from "../adapters/workers-ai-speech";
import { googleCloudSpeech } from "../adapters/google-cloud-tts";
import { isWav } from "./wav";
import { readChatResponse } from "../../../infrastructure/chat-stream";
import { readBounded } from "../../../infrastructure/bounded-read";
import {
	exchangeEnd,
	estimateMessageTokens,
	OUTPUT_RESERVE_DEFAULT_TOKENS,
} from "../../../infrastructure/context-budget";
import { getLogger } from "../../../infrastructure/logger";
import { measureSyncStage } from "../../../infrastructure/performance";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { billingPath, googleCloudTts } from "../../settings/contracts";
import {
	isAgentConnection,
	type SettingsService,
	type Connection,
	type Resource,
} from "../../settings";
import type {
	AgentSessionCall,
	CloudAgentKind,
	CloudAgents,
} from "../adapters/cloud-agents";
import type { CallSession, Messages } from "../contracts";
import type { RequestRow } from "../repository";
import {
	acquireAgentSession,
	dropAgentSession,
	learnContextWindow,
} from "./agent-session";
import type { CallSessionRole } from "./attempt-record";

const log = getLogger("inference");
/** Tokens kept free below the window for the estimate's error. */
const FIT_MARGIN_TOKENS = 512;

export type CloudEnv = {
	store: SqliteStore;
	settings: Pick<SettingsService, "credential">;
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	agents?: CloudAgents;
	models?: ConnectionModelsService;
};

function bounded(response: Response, limit: number) {
	return readBounded(response.body, {
		limit,
		tooLarge: "response_too_large",
		missing: "invalid_response",
	});
}

/**
 * Fits the messages to the resource's window by the token estimate. The answer's reservation and a margin come off
 * the window as a whole (the reservation belongs to the current task's half, so it never shrinks the memory and
 * history budget the host assembled for).
 * - A request the server may trim drops the oldest turns (after the first message) until it fits, or fails with
 *   `context_window_exceeded` when nothing more can go.
 * - An `exact` request was fitted by the host; the estimate is not exact, so one that is still over drops the oldest
 *   adopted history turns (never the system part, this turn's data or the request), logs the count, and is sent as it
 *   is when nothing more can go: the provider alone may reject it. `context` is the split of the list after that.
 */
function fitMessages(
	row: RequestRow,
	resource: Resource,
	input: Messages,
	context?: NonNullable<CallSession["context"]>,
) {
	const messages = [...input];
	const window = resource.contextWindow ?? 0;
	// A control request's own output limit (a long draft) within a quarter of the window; else the default.
	const reserve = row.outputLimit
		? Math.min(row.outputLimit, Math.floor(window / 4))
		: Math.min(OUTPUT_RESERVE_DEFAULT_TOKENS, Math.floor(window / 4));
	const budget = window - reserve - FIT_MARGIN_TOKENS;
	// Image requests stay intact; the provider enforces the image-token budget (D2).
	if (input.some((m) => m.images?.length))
		return { messages, reserve, context };
	const sizes = messages.map((message) => estimateMessageTokens([message]));
	let tokens = sizes.reduce((sum, size) => sum + size, 0);
	let split = context;
	if (row.contextPolicy !== "exact") {
		while (messages.length > 2 && tokens > budget) {
			// Whole exchanges go, the oldest first; the first message and the last one stay.
			const roles = messages.slice(1, -1).map((m) => m.role);
			const count = exchangeEnd(roles, 0, roles.length);
			messages.splice(1, count);
			tokens -= sizes.splice(1, count).reduce((sum, size) => sum + size, 0);
		}
		if (tokens > budget) throw new Error("context_window_exceeded");
	} else if (tokens > budget) {
		// The adopted history: the first `historyCount` non-system messages after the instructions. The first
		// `protectedCount` of them hold `## Memory`: they stay, and the oldest exchanges go from after them.
		const at: number[] = [];
		for (
			let i = split?.instructionCount ?? 0;
			split && i < messages.length && at.length < split.historyCount;
			i++
		)
			if (messages[i]!.role !== "system") at.push(i);
		at.splice(0, split?.protectedCount ?? 0);
		const gone = new Set<number>();
		const roles = at.map((i) => messages[i]!.role);
		// Whole exchanges go, the oldest first, so the history never starts with an assistant message.
		while (tokens > budget && gone.size < at.length)
			for (const i of at.slice(
				gone.size,
				exchangeEnd(roles, gone.size, at.length),
			)) {
				gone.add(i);
				tokens -= sizes[i]!;
			}
		if (gone.size > 0) {
			for (let i = messages.length - 1; i >= 0; i--)
				if (gone.has(i)) messages.splice(i, 1);
			split = { ...split!, historyCount: split!.historyCount - gone.size };
		}
		log.warn("inference.exact_context_over_window", {
			droppedMessages: gone.size,
			promptTokens: tokens,
			limit: budget,
			reason: tokens > budget ? "still_over" : "history_dropped",
		});
	}
	return { messages, reserve, context: split };
}

type AttemptUsage = {
	reasoning?: unknown;
	model?: string | null;
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheCreation?: unknown;
	costUsd?: unknown;
};

/**
 * OpenAI-compatible `usage`: `prompt_tokens` already includes the cached part, so it is the total input and
 * `prompt_tokens_details.cached_tokens` is the subset read from the cache. The API reports no cache writes.
 */
export function chatUsage(usage: unknown): AttemptUsage {
	const value = (usage ?? {}) as {
		prompt_tokens?: unknown;
		completion_tokens?: unknown;
		prompt_tokens_details?: { cached_tokens?: unknown } | null;
	};
	const cached = value.prompt_tokens_details?.cached_tokens;
	return {
		input: value.prompt_tokens,
		output: value.completion_tokens,
		// A subset of the input: a larger value is not a usable count.
		cacheRead:
			typeof cached === "number" &&
			Number.isSafeInteger(cached) &&
			cached >= 0 &&
			typeof value.prompt_tokens === "number" &&
			cached <= value.prompt_tokens
				? cached
				: null,
		cacheCreation: null,
	};
}

/** Token counts, prompt-cache usage, cost and the billing path of the connection that served the attempt. */
async function recordUsage(
	env: CloudEnv,
	attemptId: string,
	connection: Connection,
	usage: AttemptUsage,
) {
	const count = (v: unknown) =>
		typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
	const cost =
		typeof usage.costUsd === "number" &&
		Number.isFinite(usage.costUsd) &&
		usage.costUsd >= 0
			? usage.costUsd
			: null;
	await env.store.write((db) =>
		db
			.query(
				"UPDATE inference_attempts SET input_tokens=?,output_tokens=?,cache_read_tokens=?,cache_creation_tokens=?,cost_usd=?,billing_path=?,reasoning_tokens=?,usage_model=?,usage_observed=1 WHERE id=?",
			)
			.run(
				count(usage.input),
				count(usage.output),
				count(usage.cacheRead),
				count(usage.cacheCreation),
				cost,
				billingPath(connection),
				count(usage.reasoning),
				usage.model === undefined ? null : usage.model,
				attemptId,
			),
	);
}

/**
 * The Claude Agent SDK session a call belongs to: `main` and `subagent` calls use the ledger's id for their
 * combination (the attempt row records it); a one-shot call, or another agent kind, has none.
 */
async function agentSession(
	env: CloudEnv,
	connection: Connection,
	resource: Resource,
	role: CallSessionRole | undefined,
	attemptId: string,
): Promise<AgentSessionCall | undefined> {
	if (
		!role ||
		role.sessionRole === "auxiliary" ||
		connection.kind !== "claude-agent-sdk" ||
		!connection.auth
	)
		return undefined;
	const id = await acquireAgentSession(env.store, {
		role: role.sessionRole,
		taskId: role.taskId,
		connectionId: connection.id,
		auth: connection.auth,
		model: resource.model,
	});
	await env.store.write((db) =>
		db
			.query("UPDATE inference_attempts SET agent_session_id=? WHERE id=?")
			.run(id, attemptId),
	);
	return {
		id,
		role: role.sessionRole,
		...(role.context ? { context: role.context } : {}),
		drop: () => dropAgentSession(env.store, id),
	};
}

/** An agent SDK connection (Codex / Claude Agent SDK) answering one LLM turn. */
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
	role?: CallSessionRole,
	nativeWebSearch?: true,
) {
	if (row.purpose !== "llm") throw new Error("cloud_agent_purpose_unsupported");
	if (!env.agents) throw new Error("cloud_agent_unavailable");
	// Fit first: dropping history turns changes the split the session resumes from.
	const fitted = measureSyncStage("inference", "context_fit", () =>
		fitMessages(row, resource, input, role?.context),
	);
	const session = await agentSession(
		env,
		connection,
		resource,
		role && fitted.context ? { ...role, context: fitted.context } : role,
		attemptId,
	);
	const observations: Promise<void>[] = [];
	log.info("inference.agent_tools_offered", {
		count: options?.tools?.length ?? 0,
		kind: options?.toolOutputFormat ?? "native",
	});
	const result = await env.agents
		.run({
			kind: connection.kind as CloudAgentKind,
			connectionId: connection.id,
			attemptId,
			requestId: row.id,
			...(session ? { session } : {}),
			model: resource.model,
			baseUrl: connection.baseUrl,
			credential,
			auth: connection.auth,
			nativeWebSearch,
			messages: fitted.messages,
			...(options?.observeInput
				? {
						observeInput: options.observeInput,
						omittedMessages: input.length - fitted.messages.length,
					}
				: {}),
			tools:
				options?.toolOutputFormat === "json-schema"
					? undefined
					: options?.tools,
			outputSchema: options?.jsonOutput ? options.jsonSchema : undefined,
			// The saved level, checked against this model before the attempt (`reasoningToSend`); an agent SDK takes it
			// by its own name.
			...(options?.reasoning && options.reasoning !== "off"
				? { reasoningEffort: options.reasoning }
				: {}),
			signal,
			onDelta,
			onUsage: (usage) => {
				const pending = recordUsage(env, attemptId, connection, {
					input: usage.inputTokens,
					output: usage.outputTokens,
					cacheRead: usage.cacheReadTokens,
					cacheCreation: usage.cacheCreationTokens,
					reasoning: usage.reasoningTokens,
					model: usage.usageModel,
				});
				// Attach immediately; drain before leaving even when the turn fails or is cancelled.
				pending.catch(() => {});
				observations.push(pending);
			},
		})
		.finally(async () => {
			await Promise.all(observations);
		});
	signal.throwIfAborted();
	if (result.toolCalls?.length) {
		if (!options?.tools?.length || !options.onToolCalls)
			throw new Error("chat_tool_calls_unexpected");
		options.onToolCalls(result.toolCalls);
	}
	if (session && result.contextWindow)
		await learnContextWindow(env.store, session.id, result.contextWindow);
	await recordUsage(env, attemptId, connection, {
		input: result.inputTokens,
		output: result.outputTokens,
		cacheRead: result.cacheReadTokens,
		cacheCreation: result.cacheCreationTokens,
		costUsd: result.costUsd,
		reasoning: result.reasoningTokens,
		model: result.usageModel,
	});
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
	role?: CallSessionRole,
	nativeWebSearch?: true,
) {
	if (
		nativeWebSearch &&
		(connection.kind !== "codex-sdk" || row.mode !== "control")
	)
		throw new Error("cloud_agent_web_search_unavailable");
	if (row.purpose === "llm")
		input = await cloudImages(
			input as Messages,
			connection,
			resource,
			env.models,
			signal,
		);
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
			role,
			nativeWebSearch,
		);
	if (!credential) throw new Error("cloud_credential_unavailable");
	if (connection.kind === googleCloudTts.kind) {
		if (row.purpose !== "tts" || typeof input !== "string")
			throw new Error("google_cloud_tts_purpose_unsupported");
		const audio = await googleCloudSpeech(
			env.fetch ?? fetch,
			credential,
			resource,
			input,
			signal,
		);
		await recordUsage(env, attemptId, connection, {});
		return audio;
	}
	if (connection.kind === "cloudflare-workers-ai") {
		const value = await workersSpeechRequest(
			env.fetch ?? fetch,
			connection,
			credential,
			resource,
			input as string | Uint8Array,
			signal,
		);
		await recordUsage(env, attemptId, connection, {});
		return value;
	}
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
	let observeHttp: (() => void) | undefined;
	if (row.purpose === "asr") {
		const form = new FormData();
		form.append(
			"file",
			new Blob([new Uint8Array(input as Uint8Array)], { type: "audio/wav" }),
			"speech.wav",
		);
		form.append("model", resource.model);
		form.append("response_format", "json");
		if (options?.asrLanguage) form.append("language", options.asrLanguage);
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
			const { messages, reserve } = measureSyncStage(
				"inference",
				"context_fit",
				() => fitMessages(row, resource, input as Messages, role?.context),
			);
			const request = {
				model: resource.model,
				messages: messages.map(imageMessageParts),
				...(options?.tools?.length && options.toolOutputFormat !== "json-schema"
					? {
							tools: options.tools,
							tool_choice: options.toolChoice ?? "auto",
							parallel_tool_calls: false,
						}
					: {}),
				// Only structured-output control requests carry a schema (see execute.ts), and it is strict like LARM's.
				...(options?.jsonOutput && options.jsonSchema
					? {
							response_format: {
								type: "json_schema",
								json_schema: {
									name: "control",
									strict: true,
									schema: options.jsonSchema,
								},
							},
						}
					: {}),
				stream: !!onDelta,
				// A stream reports usage only on request (in a final chunk without choices).
				...(onDelta ? { stream_options: { include_usage: true } } : {}),
				max_tokens: reserve,
			};
			body = request;
			if (options?.observeInput)
				observeHttp = () =>
					observeModelInput(options.observeInput, () => ({
						boundary: "cloud-http",
						messages: inputMessages(messages),
						tools: request.tools,
						format: request.response_format,
						maxOutputTokens: request.max_tokens,
						omittedMessages: (input as Messages).length - messages.length,
					}));
		}
		init.headers = { ...init.headers, "Content-Type": "application/json" };
		if (
			row.purpose === "llm" &&
			(input as Messages).some((m) => m.images?.length)
		)
			checkImageRequest(body);
		init.body = JSON.stringify(body);
	}
	const path =
		row.purpose === "llm"
			? "chat/completions"
			: row.purpose === "asr"
				? "audio/transcriptions"
				: "audio/speech";
	const url = new URL(path, base);
	if (!signal.aborted) observeHttp?.();
	const response = await (env.fetch ?? fetch)(url, init);
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
		await recordUsage(env, attemptId, connection, chatUsage(result.usage));
		return result.text;
	}

	const bytes = await bounded(
		response,
		row.purpose === "tts" ? 16_000_000 : 1_000_000,
	);
	if (row.purpose === "tts") {
		if (!isWav(bytes)) throw new Error("invalid_tts_audio");
		return bytes;
	}
	let json: { text?: unknown; usage?: unknown } | null;
	try {
		json = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new Error("invalid_response_json");
	}
	// The voice input service handles a successful transcription with no words.
	const value = json?.text;
	if (typeof value !== "string") throw new Error("invalid_response_text");
	signal.throwIfAborted();
	await recordUsage(env, attemptId, connection, chatUsage(json?.usage));
	return value;
}
