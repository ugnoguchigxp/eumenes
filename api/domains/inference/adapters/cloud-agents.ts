import Anthropic from "@anthropic-ai/sdk";
import type { BetaManagedAgentsCustomToolInputSchema } from "@anthropic-ai/sdk/resources/beta/agents/agents";
import {
	createSdkMcpServer,
	query,
	tool,
	type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type {
	NativeTool,
	NativeToolCall,
} from "../../../infrastructure/chat-stream";
import type { ConnectionKind } from "../../settings/contracts";
import { getLogger } from "../../../infrastructure/logger";
import type { Messages } from "../contracts";
import { runCodexTurn } from "./codex-app-server";
import { codexRuntime, type CodexRuntime } from "./codex-sdk";

export type CloudAgentKind = Exclude<ConnectionKind, "openai-compatible">;
export type CloudAgentCall = {
	kind: CloudAgentKind;
	model: string;
	baseUrl: string;
	/** Null: the SDK's own login (Codex / Claude Code); Managed Agents requires a key. */
	credential: string | null;
	agentId?: string | null;
	environmentId?: string | null;
	messages: Messages;
	tools?: NativeTool[];
	signal: AbortSignal;
	onDelta?: (text: string) => void;
};
export type CloudAgentResult = {
	text: string;
	toolCalls?: NativeToolCall[];
	inputTokens?: number | null;
	outputTokens?: number | null;
};
export type CloudAgents = {
	run(call: CloudAgentCall): Promise<CloudAgentResult>;
};

const log = getLogger("inference");
const outputLimit = 262_144;
const code = /^[a-z][a-z0-9_]{0,100}$/;
const fail = (reason: string) => new Error(`cloud_agent_${reason}`);

/** Leading system messages become the instructions; the rest is one prompt.
 * A multi-turn history is passed as JSON so message text cannot forge turns. */
function promptParts(messages: Messages) {
	let i = 0;
	while (i < messages.length && messages[i]!.role === "system") i++;
	const system = messages
		.slice(0, i)
		.map((m) => m.content)
		.join("\n\n");
	const turns = messages.slice(i);
	const prompt =
		turns.length === 1 && turns[0]!.role === "user"
			? turns[0]!.content
			: "The conversation so far, oldest first, as JSON. Write only the next assistant turn.\n" +
				JSON.stringify(turns.map(({ role, content }) => ({ role, content })));
	if (!prompt.trim()) throw fail("empty_prompt");
	return {
		system: system || "You are a helpful assistant.",
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
		"\n\nFUNCTIONS: When one of these functions should handle the request, set tool to {name, arguments} and reply to null; otherwise set reply to your answer and tool to null.\n" +
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
	const cwd = await mkdtemp(join(tmpdir(), "eumenes-agent-"));
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
				...(tools ? { outputSchema: codexChoiceSchema(tools) } : {}),
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
		await rm(cwd, { recursive: true, force: true });
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
const anthropicBase = (url: string) => url.replace(/\/v1\/?$/, "");

/** Only the API key and protocol headers leave the process; ambient
 * ANTHROPIC_AUTH_TOKEN / ANTHROPIC_CUSTOM_HEADERS must not reach the connection's host. */
const anthropicHeader =
	/^(x-api-key|anthropic-[a-z0-9-]+|content-type|accept|user-agent|x-stainless-[a-z0-9-]+|idempotency-key|x-client-request-id)$/;
function anthropicFetch(input: RequestInfo | URL, init?: RequestInit) {
	const headers = new Headers();
	for (const [name, value] of new Headers(init?.headers))
		if (anthropicHeader.test(name)) headers.set(name, value);
	return fetch(input, { ...init, headers });
}

// USER / LOGNAME: on macOS the Claude Code login is read from the keychain entry keyed by the user name.
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
	"CLAUDE_CONFIG_DIR",
];

async function runClaudeAgent(
	environment: Readonly<Record<string, string | undefined>>,
	call: CloudAgentCall,
): Promise<CloudAgentResult> {
	const { system, prompt } = promptParts(call.messages);
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
	const env: Record<string, string> = {
		CLAUDE_AGENT_SDK_CLIENT_APP: "eumenes",
	};
	for (const key of claudeEnvKeys)
		if (environment[key] !== undefined) env[key] = environment[key]!;
	if (call.credential) {
		env.ANTHROPIC_API_KEY = call.credential;
		env.ANTHROPIC_BASE_URL = anthropicBase(call.baseUrl);
	}
	// Text streams with or without tools; a captured call ends the turn and the
	// caller withdraws any text that preceded it.
	const stream = !!call.onDelta;
	const cwd = await mkdtemp(join(tmpdir(), "eumenes-agent-"));
	const onAbort = () => abortController.abort();
	call.signal.addEventListener("abort", onAbort, { once: true });
	let q: ReturnType<typeof query> | undefined;
	let result: SDKResultMessage | undefined;
	let streamed = 0;
	try {
		q = query({
			prompt,
			options: {
				abortController,
				cwd,
				env,
				model: call.model,
				systemPrompt: tools.length
					? `${system}\n\nCall at most one function per turn.`
					: system,
				tools: [],
				allowedTools: tools.map((t) => `mcp__eumenes__${t.function.name}`),
				mcpServers: server ? { eumenes: server } : {},
				strictMcpConfig: true,
				settingSources: [],
				persistSession: false,
				permissionMode: "dontAsk",
				includePartialMessages: stream,
				maxTurns: tools.length ? 2 : 1,
			},
		});
		for await (const message of q) {
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
	} catch (error) {
		if (!captured) throw error;
	} finally {
		call.signal.removeEventListener("abort", onAbort);
		q?.close();
		await rm(cwd, { recursive: true, force: true });
	}
	call.signal.throwIfAborted();
	if (captured) return { text: "", toolCalls: [captured] };
	if (!result) throw fail("incomplete_turn");
	if (result.subtype !== "success" || result.is_error)
		throw fail(result.subtype === "success" ? "failed" : result.subtype);
	const text = checkedText(result.result);
	if (!text.trim()) throw fail("empty_output");
	if (call.onDelta && !streamed) call.onDelta(text);
	return {
		text,
		inputTokens: result.usage.input_tokens,
		outputTokens: result.usage.output_tokens,
	};
}

async function runManagedAgents(
	call: CloudAgentCall,
): Promise<CloudAgentResult> {
	if (!call.credential) throw new Error("cloud_credential_unavailable");
	if (!call.agentId || !call.environmentId) throw fail("unconfigured");
	const client = new Anthropic({
		apiKey: call.credential,
		authToken: null,
		baseURL: anthropicBase(call.baseUrl),
		fetch: anthropicFetch,
		maxRetries: 1,
	});
	const { system, prompt } = promptParts(call.messages);
	const tools = call.tools ?? [];
	// Overrides replace the stored toolset: the session sees only host functions.
	const session = await client.beta.sessions.create(
		{
			agent: {
				type: "agent_with_overrides",
				id: call.agentId,
				model: call.model,
				system,
				tools: tools.map((t) => ({
					type: "custom" as const,
					name: t.function.name,
					description: t.function.description,
					input_schema: t.function
						.parameters as BetaManagedAgentsCustomToolInputSchema,
				})),
				mcp_servers: [],
				skills: [],
			},
			environment_id: call.environmentId,
			title: "Eumenes conversation",
		},
		// A retried create after a lost response would leave an orphan session.
		{ signal: call.signal, maxRetries: 0 },
	);
	let settled = false;
	try {
		// Stream first: events emitted before the stream opens arrive late in one batch.
		const events = await client.beta.sessions.events.stream(
			session.id,
			undefined,
			{ signal: call.signal },
		);
		await client.beta.sessions.events.send(
			session.id,
			{
				events: [
					{ type: "user.message", content: [{ type: "text", text: prompt }] },
				],
			},
			{ signal: call.signal },
		);
		let text = "";
		for await (const event of events) {
			if (event.type === "agent.message") {
				for (const block of event.content)
					if (block.type === "text") {
						text = checkedText(text + block.text);
						if (!tools.length) call.onDelta?.(block.text);
					}
			} else if (event.type === "agent.custom_tool_use") {
				settled = true;
				call.signal.throwIfAborted();
				return {
					text: "",
					toolCalls: [
						{
							id: event.id,
							name: event.name,
							arguments: JSON.stringify(event.input),
						},
					],
				};
			} else if (
				(event.type === "agent.tool_use" ||
					event.type === "agent.mcp_tool_use") &&
				event.evaluated_permission === "ask"
			) {
				// Nobody approves sandbox tools on a conversation turn.
				await client.beta.sessions.events.send(
					session.id,
					{
						events: [
							{
								type: "user.tool_confirmation",
								tool_use_id: event.id,
								result: "deny",
							},
						],
					},
					{ signal: call.signal },
				);
			} else if (event.type === "session.error") {
				throw fail("session_error");
			} else if (event.type === "session.status_idle") {
				if (event.stop_reason.type === "requires_action") continue;
				settled = true;
				if (event.stop_reason.type !== "end_turn")
					throw fail(event.stop_reason.type);
				break;
			} else if (event.type === "session.status_terminated") {
				settled = true;
				throw fail("session_terminated");
			}
		}
		call.signal.throwIfAborted();
		if (!text.trim()) throw fail("empty_output");
		if (tools.length) call.onDelta?.(text);
		return { text, inputTokens: null, outputTokens: null };
	} finally {
		// One session per turn; cleanup must not depend on the turn's signal.
		void cleanupSession(client, session.id, settled);
	}
}

async function cleanupSession(
	client: Anthropic,
	sessionId: string,
	settled: boolean,
) {
	const options = { timeout: 15_000, maxRetries: 1 };
	if (!settled)
		await client.beta.sessions.events
			.send(sessionId, { events: [{ type: "user.interrupt" }] }, options)
			.catch(() => {});
	try {
		await client.beta.sessions.delete(sessionId, undefined, options);
	} catch {
		try {
			await client.beta.sessions.archive(sessionId, undefined, options);
		} catch {
			log.warn("inference.cloud_agent_session_leaked", {
				reason: "cloud_agent_session_cleanup_failed",
			});
		}
	}
}

function safeAgentError(error: unknown) {
	if (error instanceof Error && code.test(error.message)) return error;
	if (error instanceof Anthropic.APIError && typeof error.status === "number")
		return new Error(`cloud_agent_http_${error.status}`);
	return fail("failed");
}

/** Agent SDKs as cloud LLM providers. Process environment comes from Config. */
export function createCloudAgents(
	environment: Readonly<Record<string, string | undefined>>,
	options: { codexExecutable?: string } = {},
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
				if (call.kind === "claude-agent-sdk")
					return await runClaudeAgent(environment, call);
				return await runManagedAgents(call);
			} catch (error) {
				call.signal.throwIfAborted();
				throw safeAgentError(error);
			}
		},
	};
}
