import {
	createSdkMcpServer,
	query,
	tool,
	type AccountInfo,
	type Options,
	type Query,
	type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { NativeToolCall } from "../../../infrastructure/chat-stream";
import { getLogger } from "../../../infrastructure/logger";
import { systemContext } from "../../../infrastructure/system-context";
import type { AgentAuth } from "../../settings/contracts";
import {
	AGENT_ROOT_PREFIX,
	hostHistoryStore,
	trackClaudeRoot,
	transcriptEntries,
} from "./claude-session";
import { callId } from "./cloud-agent-shared";

import {
	checkedText,
	fail,
	promptParts,
	removeRoot,
	type CloudAgentCall,
	type CloudAgentResult,
} from "./cloud-agent-shared";
const log = getLogger("inference");
function zodShape(parameters: Record<string, unknown>): z.ZodRawShape {
	const properties = (parameters.properties ?? {}) as Record<string, unknown>;
	const required = new Set(
		Array.isArray(parameters.required) ? parameters.required : [],
	);
	return Object.fromEntries(
		Object.entries(properties).map(([key, schema]) => {
			let type: z.ZodType;
			try {
				type = z.fromJSONSchema(
					schema as Parameters<typeof z.fromJSONSchema>[0],
				);
			} catch {
				type = z.unknown();
			}
			return [key, required.has(key) ? type : type.optional()];
		}),
	);
}

/** Anthropic clients append /v1 themselves; accept a base saved with it. */
export const anthropicBase = (url: string) => url.replace(/\/v1\/?$/, "");

/** Only the API key and protocol headers leave the process; ambient
 * ANTHROPIC_AUTH_TOKEN / ANTHROPIC_CUSTOM_HEADERS must not reach the connection's host. */
const anthropicHeader =
	/^(x-api-key|anthropic-[a-z0-9-]+|content-type|accept|user-agent|x-stainless-[a-z0-9-]+|idempotency-key|x-client-request-id)$/;
export function anthropicFetch(
	send: (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => Promise<Response> = fetch,
) {
	return (input: RequestInfo | URL, init?: RequestInit) => {
		const headers = new Headers();
		for (const [name, value] of new Headers(init?.headers))
			if (anthropicHeader.test(name)) headers.set(name, value);
		return send(input, { ...init, headers });
	};
}

/**
 * What the CLI must report about the credential it was given before it may receive a message.
 * One table for both routes: exactly one credential source is reported (`apiKeySource` for a key,
 * `tokenSource` for the OAuth token, the other absent or `"none"`), on the first-party API. A mixture, an
 * `ANTHROPIC_AUTH_TOKEN`, a cloud provider and the legacy `"oauth"` never match.
 */
const unset = (value: string | undefined) =>
	value === undefined || value === "none";
const authObservation: Record<AgentAuth, (account: AccountInfo) => boolean> = {
	"api-key": (a) =>
		a.apiKeySource === "ANTHROPIC_API_KEY" &&
		unset(a.tokenSource) &&
		a.apiProvider === "firstParty",
	// `subscriptionType` is not required: the real subscription route has not been observed.
	subscription: (a) =>
		a.tokenSource === "CLAUDE_CODE_OAUTH_TOKEN" &&
		unset(a.apiKeySource) &&
		a.apiProvider === "firstParty",
};
const observedAuthMatches = (auth: AgentAuth, account: AccountInfo) =>
	authObservation[auth](account);

const claudeEnvKeys = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"TMPDIR",
	"LANG",
	"LC_ALL",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
];

/**
 * The CLI's environment for one call: exactly one credential for the chosen route.
 * ANTHROPIC_AUTH_TOKEN, cloud-provider variables and the ambient CLAUDE_CONFIG_DIR never pass;
 * the config directory is the call's own, so no stored login can answer instead.
 */
export function claudeAgentEnv(
	environment: Readonly<Record<string, string | undefined>>,
	input: {
		auth: AgentAuth;
		credential: string;
		baseUrl: string;
		configDir: string;
		/** Fixes the SDK's session project key (`[A-Za-z0-9_-]`, no `:`) instead of deriving it from the cwd. */
		projectDirName?: string;
	},
): Record<string, string> {
	const env: Record<string, string> = {
		CLAUDE_AGENT_SDK_CLIENT_APP: "eumenes",
		CLAUDE_CONFIG_DIR: input.configDir,
		...(input.projectDirName
			? { CLAUDE_CODE_PROJECT_DIR_NAME: input.projectDirName }
			: {}),
	};
	for (const key of claudeEnvKeys)
		if (environment[key] !== undefined) env[key] = environment[key]!;
	if (input.auth === "api-key") {
		env.ANTHROPIC_API_KEY = input.credential;
		env.ANTHROPIC_BASE_URL = anthropicBase(input.baseUrl);
	} else env.CLAUDE_CODE_OAUTH_TOKEN = input.credential;
	return env;
}

/** A per-call working directory and config directory, removed afterwards. */
export async function withClaudeDirs<T>(
	run: (dirs: { cwd: string; configDir: string }) => Promise<T>,
): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), AGENT_ROOT_PREFIX));
	const untrack = trackClaudeRoot(root);
	try {
		const cwd = join(root, "work");
		const configDir = join(root, "config");
		await mkdir(cwd);
		await mkdir(configDir);
		return await run({ cwd, configDir });
	} finally {
		await removeRoot(root, untrack);
	}
}

export type GatedQuery = {
	q: Query;
	account: AccountInfo;
	/** Lets the withheld first user message (if any) reach the model. */
	release(): void;
	/** Ends the query without anything having been sent. */
	close(): void;
};

/**
 * Starts a streaming-input query and checks the credential's observed route before the first
 * user message is yielded. A mismatch closes the query without sending and throws
 * `cloud_agent_auth_mismatch`. `prompt: null` never sends a turn (metadata queries).
 */
export async function startGatedQuery(
	startQuery: typeof query,
	auth: AgentAuth,
	prompt: string | null,
	options: Options,
	connectionId?: string,
): Promise<GatedQuery> {
	const gate = Promise.withResolvers<boolean>();
	async function* messages() {
		if (!(await gate.promise) || prompt === null) return;
		yield {
			type: "user" as const,
			message: { role: "user" as const, content: prompt },
			parent_tool_use_id: null,
		};
	}
	const q = startQuery({ prompt: messages(), options });
	const close = () => {
		gate.resolve(false);
		q.close();
	};
	let account: AccountInfo;
	try {
		account = await q.accountInfo();
	} catch (error) {
		close();
		throw error;
	}
	if (!observedAuthMatches(auth, account)) {
		close();
		log.warn("inference.cloud_agent_auth_mismatch", {
			reason: "cloud_agent_auth_mismatch",
			auth,
			...(connectionId ? { connectionId } : {}),
			apiProvider: account.apiProvider ?? "unknown",
			apiKeySource: account.apiKeySource ?? "unknown",
			tokenSource: account.tokenSource ?? "unknown",
		});
		throw fail("auth_mismatch");
	}
	return { q, account, release: () => gate.resolve(true), close };
}

export async function runClaudeAgent(
	environment: Readonly<Record<string, string | undefined>>,
	call: CloudAgentCall,
	startQuery: typeof query,
): Promise<CloudAgentResult> {
	if (!call.auth) throw fail("unconfigured");
	if (!call.credential) throw new Error("cloud_credential_unavailable");
	const { auth, credential } = call;
	const session = call.session;
	const { system, history, prompt } = promptParts(
		call.messages,
		session?.role === "main" ? session.context : undefined,
	);
	const tools = call.tools ?? [];
	let captured: NativeToolCall | undefined;
	const abortController = new AbortController();
	// A function call ends the turn: the host, not the agent, executes it.
	const server = tools.length
		? createSdkMcpServer({
				name: "eumenes",
				tools: tools.map((t) =>
					tool(
						t.function.name,
						t.function.description,
						zodShape(t.function.parameters),
						async (args) => {
							captured ??= {
								id: callId(),
								name: t.function.name,
								arguments: JSON.stringify(args),
							};
							abortController.abort();
							return {
								content: [{ type: "text", text: "Accepted by the host." }],
							};
						},
					),
				),
			})
		: undefined;
	// Text streams with or without tools; a captured call ends the turn and the
	// caller withdraws any text that preceded it.
	const stream = !!call.onDelta;
	const onAbort = () => abortController.abort();
	call.signal.addEventListener("abort", onAbort, { once: true });
	let gated: GatedQuery | undefined;
	let result: SDKResultMessage | undefined;
	let streamed = 0;
	try {
		await withClaudeDirs(async ({ cwd, configDir }) => {
			gated = await startGatedQuery(
				startQuery,
				auth,
				prompt,
				{
					abortController,
					cwd,
					env: claudeAgentEnv(environment, {
						auth,
						credential,
						baseUrl: call.baseUrl,
						configDir,
						...(session ? { projectDirName: `eumenes-${session.role}` } : {}),
					}),
					model: call.model,
					systemPrompt: tools.length
						? system +
							"\n\n" +
							systemContext(
								"inference.contexts.cloud-agents.single-function",
								{},
							)
						: system,
					tools: [],
					allowedTools: tools.map((t) => `mcp__eumenes__${t.function.name}`),
					mcpServers: server ? { eumenes: server } : {},
					strictMcpConfig: true,
					settingSources: [],
					permissionMode: "dontAsk",
					includePartialMessages: stream,
					...(call.outputSchema && !tools.length
						? {
								outputFormat: {
									type: "json_schema",
									schema: call.outputSchema,
								},
							}
						: {}),
					// The structured-output tool call and its retries need turns of their own.
					maxTurns: tools.length ? 2 : call.outputSchema ? 3 : 1,
					...(session
						? {
								// The host's history is the only history: `load` answers with it, the SDK's own record is dropped.
								persistSession: true,
								sessionStore: hostHistoryStore({
									sessionId: session.id,
									entries: transcriptEntries(session.id, history, {
										cwd,
										model: call.model,
									}),
									onDelete: session.drop,
								}),
								...(history.length
									? { resume: session.id }
									: { sessionId: session.id }),
								// The window is budgeted by the host; an overflow is a plain failure.
								settings: { autoCompactEnabled: false },
							}
						: { persistSession: false }),
				},
				call.connectionId,
			);
			gated.release();
			try {
				for await (const message of gated.q) {
					if (
						stream &&
						message.type === "stream_event" &&
						message.parent_tool_use_id === null &&
						message.event.type === "content_block_delta" &&
						message.event.delta.type === "text_delta"
					) {
						streamed += message.event.delta.text.length;
						call.onDelta!(message.event.delta.text);
					}
					if (message.type === "assistant" && message.error)
						throw fail(message.error);
					if (message.type === "result") result = message;
				}
			} finally {
				gated.close();
			}
		});
	} catch (error) {
		if (!captured) throw error;
	} finally {
		call.signal.removeEventListener("abort", onAbort);
	}
	call.signal.throwIfAborted();
	if (captured) return { text: "", toolCalls: [captured] };
	if (!result) throw fail("incomplete_turn");
	if (result.subtype !== "success" || result.is_error)
		throw fail(result.subtype === "success" ? "failed" : result.subtype);
	const text = checkedText(
		call.outputSchema && !tools.length && result.structured_output !== undefined
			? JSON.stringify(result.structured_output)
			: result.result,
	);
	if (!text.trim()) throw fail("empty_output");
	if (call.onDelta && !streamed) call.onDelta(text);
	return {
		text,
		...claudeUsage(result.usage),
		costUsd: auth === "api-key" ? result.total_cost_usd : null,
		contextWindow: modelContextWindow(result, call.model),
	};
}

/**
 * Claude's `input_tokens` counts only the part after the last cache breakpoint; the recorded input is the total
 * (`input + cache read + cache creation`), and the cache counters are subsets of it. A counter the provider did not
 * report stays null; it counts as 0 in the sum.
 */
export function claudeUsage(usage: {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
}): {
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheCreationTokens: number | null;
} {
	const count = (v: number | null | undefined) =>
		typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
	const input = count(usage.input_tokens);
	const cacheRead = count(usage.cache_read_input_tokens);
	const cacheCreation = count(usage.cache_creation_input_tokens);
	return {
		inputTokens:
			input === null && cacheRead === null && cacheCreation === null
				? null
				: (input ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0),
		outputTokens: count(usage.output_tokens),
		cacheReadTokens: cacheRead,
		cacheCreationTokens: cacheCreation,
	};
}

/** The context window the CLI reported for the model of this call (positive integers only). */
function modelContextWindow(result: SDKResultMessage, model: string) {
	const usage = result.modelUsage as
		Record<string, { contextWindow?: unknown } | undefined> | undefined;
	const value = usage?.[model]?.contextWindow;
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: null;
}
