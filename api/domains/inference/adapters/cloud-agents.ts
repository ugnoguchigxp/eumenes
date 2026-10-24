import { systemContext } from "../../../infrastructure/system-context";
import Anthropic from "@anthropic-ai/sdk";
import {
	createSdkMcpServer,
	query,
	tool,
	type AccountInfo,
	type Options,
	type Query,
	type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type {
	NativeTool,
	NativeToolCall,
} from "../../../infrastructure/chat-stream";
import type { AgentAuth, ConnectionKind } from "../../settings/contracts";
import { getLogger } from "../../../infrastructure/logger";
import type { Messages } from "../contracts";
import { runCodexTurn } from "./codex-app-server";
import {
	AGENT_ROOT_PREFIX,
	hostHistoryStore,
	normalizeHistory,
	splitMessages,
	trackClaudeRoot,
	transcriptEntries,
	type ContextSplit,
} from "./claude-session";
import { codexRuntime, type CodexRuntime } from "./codex-sdk";

export type CloudAgentKind = Extract<
	ConnectionKind,
	"codex-sdk" | "claude-agent-sdk"
>;
/**
 * A Claude Agent SDK call that belongs to a session of the host's ledger. `main` resumes from the history the host
 * assembled (`context` says where `messages` splits); `subagent` keeps one session id per task and no history.
 */
export type AgentSessionCall = {
	id: string;
	role: "main" | "subagent";
	context?: ContextSplit;
	/** The SDK asked to delete the session: drops the ledger row. */
	drop(): Promise<void>;
};
export type CloudAgentCall = {
	kind: CloudAgentKind;
	/** The saved connection (log correlation only). */
	connectionId?: string;
	session?: AgentSessionCall;
	model: string;
	baseUrl: string;
	/** Null: Codex keeps its own login; a Claude Agent SDK call without a credential fails. */
	credential: string | null;
	/** Claude Agent SDK only: which credential `credential` is (an API key or a `claude setup-token` OAuth token). */
	auth?: AgentAuth;
	messages: Messages;
	tools?: NativeTool[];
	/** JSON Schema the final text must satisfy (control requests). */
	outputSchema?: Record<string, unknown>;
	reasoningEffort?: "low";
	signal: AbortSignal;
	onDelta?: (text: string) => void;
};
type CloudAgentResult = {
	text: string;
	toolCalls?: NativeToolCall[];
	inputTokens?: number | null;
	outputTokens?: number | null;
	cacheReadTokens?: number | null;
	cacheCreationTokens?: number | null;
	/** Reported only on the API-key path; a subscription call has no per-call price. */
	costUsd?: number | null;
	/** The model's input context window as the CLI reported it (learned after a turn). */
	contextWindow?: number | null;
};
export type CloudAgents = {
	run(call: CloudAgentCall): Promise<CloudAgentResult>;
};

const log = getLogger("inference");
const outputLimit = 262_144;
const code = /^[a-z][a-z0-9_]{0,100}$/;
const fail = (reason: string) => new Error(`cloud_agent_${reason}`);

/**
 * Leading system messages become the instructions; the rest is one prompt. A multi-turn prompt is passed as JSON
 * so message text cannot forge turns. With a session context the history is split off first and the prompt is
 * this turn's input only.
 */
export function promptParts(messages: Messages, context?: ContextSplit) {
	const parts = splitMessages(messages, context, () =>
		fail("invalid_session_context"),
	);
	const { turns: history, pending } = normalizeHistory(parts.history);
	const turns = [...pending, ...parts.turn];
	const prompt =
		turns.length === 1 && turns[0]!.role === "user"
			? turns[0]!.content
			: (context
					? systemContext("inference.contexts.cloud-agents.turn-context", {}) +
						"\n"
					: systemContext(
							"inference.contexts.cloud-agents.conversation-context",
							{},
						) + "\n") +
				JSON.stringify(
					turns.map((turn) => {
						const { role, content } = turn;
						const message = turn as Partial<Messages[number]>;
						return {
							role,
							content,
							...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
							...(message.tool_call_id
								? { tool_call_id: message.tool_call_id }
								: {}),
						};
					}),
				);
	if (!prompt.trim()) throw fail("empty_prompt");
	return {
		system:
			parts.instructions.join("\n\n") ||
			systemContext("inference.contexts.cloud-agents.default-system", {}),
		history,
		prompt,
	};
}

function checkedText(text: string) {
	if (Buffer.byteLength(text) > outputLimit) throw fail("output_limit");
	return text;
}

const callId = () => `call_${crypto.randomUUID()}`;

/** Codex has no host-defined functions: a strict output schema chooses reply or call. */
function codexChoiceSchema(tools: NativeTool[]) {
	return {
		type: "object",
		additionalProperties: false,
		required: ["reply", "tool"],
		properties: {
			reply: { type: ["string", "null"] },
			tool: {
				anyOf: [
					{ type: "null" },
					{
						type: "object",
						additionalProperties: false,
						required: ["name", "arguments"],
						properties: {
							name: { type: "string", enum: tools.map((t) => t.function.name) },
							arguments: {
								type: "string",
								description: "The function arguments as one JSON object.",
							},
						},
					},
				],
			},
		},
	};
}
function codexFunctions(tools: NativeTool[]) {
	return (
		systemContext("inference.contexts.cloud-agents.function-selection", {}) +
		"\n" +
		JSON.stringify(tools.map((t) => t.function))
	);
}
function codexChoice(final: string, tools: NativeTool[]): CloudAgentResult {
	let value: {
		reply?: unknown;
		tool?: { name?: unknown; arguments?: unknown };
	};
	try {
		value = JSON.parse(final);
	} catch {
		throw fail("invalid_output");
	}
	const call = value?.tool;
	if (call && typeof call === "object") {
		const name = call.name;
		if (
			typeof name !== "string" ||
			!tools.some((t) => t.function.name === name) ||
			typeof call.arguments !== "string"
		)
			throw fail("invalid_tool_call");
		let args: unknown;
		try {
			args = JSON.parse(call.arguments);
		} catch {
			throw fail("invalid_tool_call");
		}
		if (!args || typeof args !== "object" || Array.isArray(args))
			throw fail("invalid_tool_call");
		return {
			text: "",
			toolCalls: [{ id: callId(), name, arguments: JSON.stringify(args) }],
		};
	}
	if (typeof value?.reply !== "string" || !value.reply.trim())
		throw fail("empty_output");
	return { text: value.reply };
}
const jsonEscapes: Record<string, string> = {
	'"': '"',
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};
/**
 * The decoded part of `reply` that a partial `{"reply": "...` choice already fixes,
 * so a reply streams while the call path stays silent. Stops before an incomplete escape.
 */
export function codexReplyPrefix(partial: string): string {
	const head = /^\s*\{\s*"reply"\s*:\s*"/.exec(partial);
	if (!head) return "";
	let out = "";
	for (let i = head[0].length; i < partial.length;) {
		const c = partial[i]!;
		if (c === '"') break;
		if (c !== "\\") {
			out += c;
			i++;
			continue;
		}
		const e = partial[i + 1];
		if (e === undefined) break;
		if (e !== "u") {
			const decoded = jsonEscapes[e];
			if (decoded === undefined) break;
			out += decoded;
			i += 2;
			continue;
		}
		const hex = partial.slice(i + 2, i + 6);
		if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
		const code = parseInt(hex, 16);
		if (code >= 0xd800 && code <= 0xdbff) {
			// Emit a surrogate pair only when its low half has arrived.
			const low = /^\\u([dD][c-fC-F][0-9a-fA-F]{2})/.exec(
				partial.slice(i + 6, i + 12),
			);
			if (!low) break;
			out += String.fromCharCode(code, parseInt(low[1]!, 16));
			i += 12;
			continue;
		}
		out += String.fromCharCode(code);
		i += 6;
	}
	return out;
}

async function runCodex(
	runtime: CodexRuntime,
	call: CloudAgentCall,
): Promise<CloudAgentResult> {
	const cwd = await mkdtemp(join(tmpdir(), AGENT_ROOT_PREFIX));
	const untrack = trackClaudeRoot(cwd);
	try {
		const { system, prompt } = promptParts(call.messages);
		const tools = call.tools?.length ? call.tools : undefined;
		// Without a key the CLI keeps its own login; a key binds the saved API host.
		const keyed: CodexRuntime = call.credential
			? {
					command: runtime.command,
					env: { ...runtime.env, CODEX_API_KEY: call.credential },
					extraArgs: ["-c", `openai_base_url=${JSON.stringify(call.baseUrl)}`],
				}
			: runtime;
		let streamed = "";
		const result = await runCodexTurn(
			keyed,
			{
				cwd,
				model: call.model,
				instructions: system + (tools ? codexFunctions(tools) : ""),
				prompt,
				...(call.reasoningEffort
					? { reasoningEffort: call.reasoningEffort }
					: {}),
				...(tools
					? { outputSchema: codexChoiceSchema(tools) }
					: call.outputSchema
						? { outputSchema: call.outputSchema }
						: {}),
				signal: call.signal,
				onMessage: (text) => {
					// With tools the turn is a JSON choice: only its reply text streams.
					const visible = tools ? codexReplyPrefix(checkedText(text)) : text;
					if (!call.onDelta || !visible.startsWith(streamed)) return;
					const delta = visible.slice(streamed.length);
					if (delta) call.onDelta(delta);
					streamed = visible;
				},
			},
			fail,
		);
		call.signal.throwIfAborted();
		const final = checkedText(result.text);
		const choice = tools ? codexChoice(final, tools) : { text: final };
		if (!choice.toolCalls && !choice.text.trim()) throw fail("empty_output");
		// Deliver whatever the stream did not cover (no deltas, or a final tail).
		if (
			call.onDelta &&
			choice.text.startsWith(streamed) &&
			choice.text.length > streamed.length
		)
			call.onDelta(choice.text.slice(streamed.length));
		return {
			...choice,
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
		};
	} finally {
		await removeRoot(cwd, untrack);
	}
}

/**
 * Removes a per-call directory and then releases its protection from the sweep. A removal that fails (the sweep
 * collects it later) is logged without the path and never turns the call's result into a failure.
 */
async function removeRoot(root: string, untrack: () => void) {
	try {
		await rm(root, { recursive: true, force: true, maxRetries: 3 });
	} catch (error) {
		log.warn("inference.agent_dir_remove_failed", {
			reason: (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown",
		});
	} finally {
		untrack();
	}
}

/** Conversation tool schemas are flat objects; each property converts on its own. */
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

async function runClaudeAgent(
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
		| Record<string, { contextWindow?: unknown } | undefined>
		| undefined;
	const value = usage?.[model]?.contextWindow;
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: null;
}

export function safeAgentError(error: unknown) {
	if (error instanceof Error && code.test(error.message)) return error;
	if (error instanceof Anthropic.APIError && typeof error.status === "number")
		return new Error(`cloud_agent_http_${error.status}`);
	return fail("failed");
}

/** Agent SDKs as cloud LLM providers. Process environment comes from Config. */
export function createCloudAgents(
	environment: Readonly<Record<string, string | undefined>>,
	options: {
		codexExecutable?: string;
		/** Test seam for the Claude Agent SDK entry point. */
		claudeQuery?: typeof query;
	} = {},
): CloudAgents {
	const codex = codexRuntime(environment, options.codexExecutable);
	return {
		async run(call) {
			call.signal.throwIfAborted();
			try {
				if (call.kind === "codex-sdk") {
					if (!codex) throw fail("codex_unavailable");
					return await runCodex(codex, call);
				}
				return await runClaudeAgent(
					environment,
					call,
					options.claudeQuery ?? query,
				);
			} catch (error) {
				call.signal.throwIfAborted();
				throw safeAgentError(error);
			}
		},
	};
}
