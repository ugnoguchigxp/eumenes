/**
 * The model calls of the harness measurement, timed. A client answers one call of the routed turn (the talk call, or
 * the silent choice held to a schema) the way the product's call does, and records what the call cost. It is the saved
 * LARM connection (`scripts/live-larm.ts`, in this process). Nothing here names a model or a profile.
 */
import type { ChatMessage } from "../../api/domains/dialogue/service/context";

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

/** Which call of a routed turn a timed call was: the silent `choice` held to a schema, or the `talk` call. */
export type CallKind = "choice" | "talk";
export type TaggedCall = { kind: CallKind; metrics: CallMetrics };

export type ModelClient = {
	connect(): Promise<void>;
	close(): Promise<void>;
	/** The talk call: one streamed call that offers no tools; its words. */
	talk(
		messages: ChatMessage[],
		settings: CallSettings,
		signal: AbortSignal,
		onDelta: (text: string) => void,
	): Promise<string>;
	/**
	 * The silent choice call: strict JSON by `schema` and no native tools field (what may be chosen is the schema's
	 * branches), as the app calls LARM for a schema.
	 */
	decide(
		messages: ChatMessage[],
		settings: CallSettings,
		signal: AbortSignal,
		schema: Record<string, unknown>,
	): Promise<string>;
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
		const state = { chunks: 0, usageOut: null as number | null };
		const metricsReader = forMetrics.getReader();
		const callerReader = forCaller.getReader();
		let stopped = false;
		pending.push(
			(async () => {
				const decoder = new TextDecoder();
				let rest = "";
				try {
					while (!stopped) {
						const { value, done: end } = await metricsReader.read();
						if (end) break;
						const now = performance.now() - started;
						rest += decoder.decode(value, { stream: true });
						const lines = rest.split("\n");
						rest = lines.pop() ?? "";
						for (const line of lines) readStreamLine(m, line, now, state);
					}
				} catch {
					// A stream that broke ends the call where it broke.
				}
				m.totalMs ||= performance.now() - started;
				// A call the reader stopped before the server finished (a failed check) has no finish reason.
				if (stopped) m.finishReason ??= "stopped";
				finishMetrics(m, state);
				done.push(m);
			})(),
		);
		// The reader of the answer may stop the call; the timing then ends there too, not when the server stops.
		const answer = new ReadableStream<Uint8Array>({
			async pull(controller) {
				const { value, done: end } = await callerReader.read();
				if (end) controller.close();
				else controller.enqueue(value);
			},
			cancel(reason) {
				stopped = true;
				m.totalMs = performance.now() - started;
				void metricsReader.cancel(reason).catch(() => {});
				return callerReader.cancel(reason);
			},
		});
		return new Response(answer, {
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
	/** The options every call of the conversation carries: the harness's reasoning and output limit. */
	const base = (settings: CallSettings) => ({
		sessionRole: "main" as const,
		maxOutputTokens: settings.outputLimit,
		contextPolicy: "exact" as const,
		reasoning: settings.reasoning,
	});
	return {
		connect: () => live.connect(),
		close: () => live.close(),
		take: timed.take,
		talk: (messages, settings, signal, onDelta) =>
			live.answerStream!(messages, signal, onDelta, base(settings)),
		// Streamed like every call, but nothing flows to a speaker and the tools field is left out.
		decide: (messages, settings, signal, schema) =>
			live.answerStream!(messages, signal, () => {}, {
				...base(settings),
				jsonOutput: true,
				jsonSchema: schema,
				toolOutputFormat: "json-schema",
			}),
	};
}
