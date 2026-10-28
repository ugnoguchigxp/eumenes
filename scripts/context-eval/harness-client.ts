/**
 * The model calls of the harness measurement, timed. A client answers one call of the conversation (messages in,
 * words and tool calls out) the way the product's call does, and records what the call cost. Two paths: the saved
 * LARM connection (`scripts/live-larm.ts`, in this process) and the Codex SDK path (`cloud-agents`); the Codex
 * model is only ever an argument of the run. Nothing here names a model or a profile.
 */
import type { NativeToolCall } from "../../api/infrastructure/chat-stream";
import type { ChatMessage } from "../../api/domains/dialogue/service/context";
import { generationTools } from "../../api/domains/dialogue/service/generation-tools";

export type Reasoning = "off" | "low" | "medium" | "high";
export const REASONINGS: readonly Reasoning[] = [
	"off",
	"low",
	"medium",
	"high",
];

/** What the harness decides about one call. */
export type CallSettings = { reasoning: Reasoning; outputLimit: number };

/** One timed model call. Times are milliseconds from the request. */
export type CallMetrics = {
	/** performance.now() when the request went out. */
	startedAt: number;
	/** The first words of the reply (not a tool call). */
	firstContentMs: number | null;
	/** The model name the server reports. */
	model: string | null;
	reasoningChars: number;
	firstTokenMs: number | null;
	firstTextMs: number | null;
	totalMs: number;
	outputTokens: number;
	tokensFrom: "usage" | "chunks";
	promptTokens: number | null;
	cachedPromptTokens: number | null;
	/** The output limit the request carried (null when the path sends none). */
	requestedLimit: number | null;
	finishReason: string | null;
	tokensPerSecond: number | null;
};

export type ModelClient = {
	connect(): Promise<void>;
	close(): Promise<void>;
	stream(
		messages: ChatMessage[],
		settings: CallSettings,
		signal: AbortSignal,
		onDelta: (text: string) => void,
	): Promise<{ text: string; toolCalls: NativeToolCall[] }>;
	/** The calls timed since the last take (waits for their streams to end). */
	take(): Promise<CallMetrics[]>;
};

type Usage = {
	completion_tokens?: number;
	prompt_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number };
};

/** Folds the data lines of one chat stream into the call's metrics. */
export function readStreamLine(
	m: CallMetrics,
	line: string,
	now: number,
	state: { chunks: number; usageOut: number | null },
): void {
	if (!line.startsWith("data: {")) return;
	let item: {
		model?: string;
		usage?: Usage;
		choices?: Array<{
			finish_reason?: string | null;
			delta?: {
				reasoning_content?: string;
				reasoning?: string;
				content?: string;
				tool_calls?: unknown[];
			};
		}>;
	};
	try {
		item = JSON.parse(line.slice(6));
	} catch {
		return;
	}
	m.model ??= item.model ?? null;
	if (item.usage) {
		state.usageOut = item.usage.completion_tokens ?? null;
		m.promptTokens = item.usage.prompt_tokens ?? null;
		m.cachedPromptTokens =
			item.usage.prompt_tokens_details?.cached_tokens ?? null;
	}
	const choice = item.choices?.[0];
	if (choice?.finish_reason) m.finishReason = choice.finish_reason;
	const delta = choice?.delta ?? {};
	const thought = delta.reasoning_content ?? delta.reasoning ?? "";
	const text = delta.content ?? "";
	const call = delta.tool_calls?.length ? 1 : 0;
	if (thought || text || call) {
		state.chunks++;
		m.firstTokenMs ??= now;
	}
	m.reasoningChars += thought.length;
	if (text || call) m.firstTextMs ??= now;
	if (text.trim()) m.firstContentMs ??= now;
}

/** Closes the metrics of a finished stream: output tokens (usage, else one per chunk) and tokens per second. */
export function finishMetrics(
	m: CallMetrics,
	state: { chunks: number; usageOut: number | null },
): void {
	m.outputTokens = state.usageOut ?? state.chunks;
	m.tokensFrom = state.usageOut !== null ? "usage" : "chunks";
	const span =
		m.firstTokenMs === null ? 0 : (m.totalMs - m.firstTokenMs) / 1000;
	m.tokensPerSecond =
		span > 0 && m.outputTokens > 1 ? (m.outputTokens - 1) / span : null;
}

/**
 * A fetch for the LARM client that times each chat call from its own stream. It asks for usage in the stream
 * (`stream_options.include_usage`) and otherwise leaves the request as it is.
 */
export function createMetricsFetch() {
	const done: CallMetrics[] = [];
	const pending: Promise<void>[] = [];
	const timedFetch = (async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => {
		const url = String(input instanceof Request ? input.url : input);
		if (!url.endsWith("/chat/completions") || typeof init?.body !== "string")
			return fetch(input, init);
		const body = JSON.parse(init.body);
		if (body.stream) body.stream_options = { include_usage: true };
		const started = performance.now();
		const res = await fetch(input, { ...init, body: JSON.stringify(body) });
		if (!res.body) return res;
		const [forCaller, forMetrics] = res.body.tee();
		const m: CallMetrics = {
			startedAt: started,
			firstContentMs: null,
			model: null,
			reasoningChars: 0,
			firstTokenMs: null,
			firstTextMs: null,
			totalMs: 0,
			outputTokens: 0,
			tokensFrom: "chunks",
			promptTokens: null,
			cachedPromptTokens: null,
			requestedLimit:
				typeof body.max_tokens === "number" ? body.max_tokens : null,
			finishReason: null,
			tokensPerSecond: null,
		};
		pending.push(
			(async () => {
				const state = { chunks: 0, usageOut: null as number | null };
				const reader = forMetrics.getReader();
				const decoder = new TextDecoder();
				let rest = "";
				for (;;) {
					const { value, done: end } = await reader.read();
					if (end) break;
					const now = performance.now() - started;
					rest += decoder.decode(value, { stream: true });
					const lines = rest.split("\n");
					rest = lines.pop() ?? "";
					for (const line of lines) readStreamLine(m, line, now, state);
				}
				m.totalMs = performance.now() - started;
				finishMetrics(m, state);
				done.push(m);
			})(),
		);
		return new Response(forCaller, {
			status: res.status,
			statusText: res.statusText,
			headers: res.headers,
		});
	}) as typeof fetch;
	return {
		fetch: timedFetch,
		async take() {
			await Promise.all(pending.splice(0));
			return done.splice(0);
		},
	};
}

/** The saved LARM connection, in this process (no server is started). */
export async function createLarmClient(): Promise<ModelClient> {
	const { createLiveLarm } = await import("../live-larm");
	const timed = createMetricsFetch();
	const live = createLiveLarm(process.env, { fetch: timed.fetch });
	return {
		connect: () => live.connect(),
		close: () => live.close(),
		take: timed.take,
		async stream(messages, settings, signal, onDelta) {
			let toolCalls: NativeToolCall[] = [];
			const text = await live.answerStream!(messages, signal, onDelta, {
				tools: generationTools,
				onToolCalls: (calls) => {
					toolCalls = calls;
				},
				sessionRole: "main",
				maxOutputTokens: settings.outputLimit,
				contextPolicy: "exact",
				reasoning: settings.reasoning,
			});
			return { text, toolCalls };
		},
	};
}

/** The Codex SDK path the inference domain already has; `model` is the run's argument. */
export async function createCodexClient(model: string): Promise<ModelClient> {
	const { createCloudAgents } =
		await import("../../api/domains/inference/adapters/cloud-agents");
	const agents = createCloudAgents(process.env);
	const done: CallMetrics[] = [];
	return {
		async connect() {},
		async close() {},
		async take() {
			return done.splice(0);
		},
		async stream(messages, settings, signal, onDelta) {
			if (settings.reasoning === "off")
				throw new Error("harness_codex_reasoning_off_unsupported");
			const startedAt = performance.now();
			let firstContentMs: number | null = null;
			const r = await agents.run({
				kind: "codex-sdk",
				model,
				baseUrl: "",
				credential: null,
				messages,
				tools: generationTools,
				reasoningEffort: settings.reasoning,
				signal,
				onDelta: (delta) => {
					if (firstContentMs === null && delta.trim())
						firstContentMs = performance.now() - startedAt;
					onDelta(delta);
				},
			});
			const totalMs = performance.now() - startedAt;
			const out = r.outputTokens ?? 0;
			done.push({
				startedAt,
				firstContentMs,
				model,
				reasoningChars: 0,
				firstTokenMs: null,
				firstTextMs: firstContentMs ?? totalMs,
				totalMs,
				outputTokens: out,
				tokensFrom: "usage",
				promptTokens: r.inputTokens ?? null,
				cachedPromptTokens: r.cacheReadTokens ?? null,
				requestedLimit: null,
				finishReason: null,
				tokensPerSecond: out > 0 ? out / (totalMs / 1000) : null,
			});
			return { text: r.text, toolCalls: r.toolCalls ?? [] };
		},
	};
}
