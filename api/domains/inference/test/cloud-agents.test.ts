import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AccountInfo, query } from "@anthropic-ai/claude-agent-sdk";
import { defaults } from "../../settings";
import { settingsSchema, type Connection } from "../../settings/contracts";
import {
	codexReplyPrefix,
	createCloudAgents,
	type CloudAgentCall,
	type CloudAgents,
} from "../adapters/cloud-agents";
import { cloudRequest, type CloudEnv } from "../service/cloud";
import type { RequestRow } from "../repository";

const connectionId = crypto.randomUUID();
const resourceId = crypto.randomUUID();
function withConnection(connection: Partial<Connection>, purpose = "llm") {
	const s = defaults({});
	return {
		...s,
		connections: [
			{
				id: connectionId,
				name: "agent",
				baseUrl: "https://api.anthropic.com",
				enabled: true,
				epoch: 0,
				envRef: null,
				...connection,
			},
		],
		resources: [
			{
				id: resourceId,
				connectionId,
				purpose,
				model: "claude-opus-5-5",
				contextWindow: purpose === "llm" ? 1_000_000 : null,
				voice: purpose === "tts" ? "v" : null,
			},
		],
	};
}

test("agent connections serve the conversation purpose only", () => {
	expect(
		settingsSchema.safeParse(
			withConnection({ kind: "claude-agent-sdk", auth: "subscription" }),
		).success,
	).toBe(true);
	expect(
		settingsSchema.safeParse(withConnection({ kind: "codex-sdk" }, "tts"))
			.success,
	).toBe(false);
	// Saved connections without a kind stay openai-compatible.
	expect(settingsSchema.safeParse(withConnection({}, "tts")).success).toBe(
		true,
	);
});

test("Claude Agent SDK connections must name their auth; other kinds must not", () => {
	for (const auth of ["subscription", "api-key"] as const)
		expect(
			settingsSchema.safeParse(
				withConnection({ kind: "claude-agent-sdk", auth }),
			).success,
		).toBe(true);
	expect(
		settingsSchema.safeParse(
			withConnection({ kind: "codex-sdk", auth: "api-key" }),
		).success,
	).toBe(false);
});

function fakeEnv(agents: CloudAgents, credential: string | null = null) {
	const usage: unknown[][] = [];
	const env = {
		store: {
			write: async (fn: (db: unknown) => unknown) =>
				fn({
					query: () => ({ run: (...args: unknown[]) => usage.push(args) }),
				}),
		},
		settings: { credential: () => credential },
		agents,
	} as unknown as CloudEnv;
	return { env, usage };
}
const row = {
	id: "req",
	purpose: "llm",
	contextPolicy: "trim",
	subject: "conversation:1",
} as unknown as RequestRow;
const resource = {
	id: resourceId,
	connectionId,
	purpose: "llm" as const,
	model: "claude-opus-5-5",
	contextWindow: 1_000_000,
	voice: null,
};

test("an agent connection answers through the agent runner and records usage with its billing path", async () => {
	let seen: CloudAgentCall | undefined;
	const { env, usage } = fakeEnv(
		{
			async run(call) {
				seen = call;
				call.onDelta?.("hello");
				return {
					text: "hello",
					inputTokens: 3,
					outputTokens: 1,
					cacheReadTokens: 20,
					cacheCreationTokens: 5,
					costUsd: 0.25,
				};
			},
		},
		"key",
	);
	const deltas: string[] = [];
	const text = await cloudRequest(
		env,
		row,
		[
			{ role: "system", content: "be brief" },
			{ role: "user", content: "hi" },
		],
		{
			id: connectionId,
			kind: "claude-agent-sdk",
			auth: "api-key",
			name: "agent",
			baseUrl: "https://api.anthropic.com",
			enabled: true,
			epoch: 0,
			envRef: null,
		},
		resource,
		new AbortController().signal,
		"attempt",
		(d) => deltas.push(d),
	);
	expect(text).toBe("hello");
	expect(deltas).toEqual(["hello"]);
	expect(seen?.kind).toBe("claude-agent-sdk");
	expect(seen?.credential).toBe("key");
	expect(seen?.auth).toBe("api-key");
	expect(usage).toEqual([[3, 1, 20, 5, 0.25, "claude-api-key", "attempt"]]);
});

test("agent tool calls are forwarded to the conversation", async () => {
	const { env } = fakeEnv({
		async run() {
			return {
				text: "",
				toolCalls: [
					{ id: "c1", name: "web_search", arguments: '{"request":"x"}' },
				],
			};
		},
	});
	const received: unknown[] = [];
	const tools = [
		{
			type: "function" as const,
			function: {
				name: "web_search",
				description: "search",
				parameters: {
					type: "object",
					properties: { request: { type: "string" } },
					required: ["request"],
				},
			},
		},
	];
	await cloudRequest(
		env,
		row,
		[{ role: "user", content: "search x" }],
		{
			id: connectionId,
			kind: "codex-sdk",
			name: "codex",
			baseUrl: "https://api.openai.com/v1",
			enabled: true,
			epoch: 0,
			envRef: null,
		},
		resource,
		new AbortController().signal,
		"attempt",
		undefined,
		{ tools, onToolCalls: (calls) => received.push(...calls) },
	);
	expect(received).toEqual([
		{ id: "c1", name: "web_search", arguments: '{"request":"x"}' },
	]);
});

test("a call that may make no tool call reaches the agent without tools (the SDKs take no tool choice)", async () => {
	const sent: Array<CloudAgentCall["tools"]> = [];
	const { env } = fakeEnv({
		async run(call) {
			sent.push(call.tools);
			return { text: "わかっていることだけお伝えします。" };
		},
	});
	const tools = [
		{
			type: "function" as const,
			function: {
				name: "web_search",
				description: "search",
				parameters: { type: "object", properties: {}, required: [] },
			},
		},
	];
	const connection = {
		id: connectionId,
		kind: "codex-sdk" as const,
		name: "codex",
		baseUrl: "https://api.openai.com/v1",
		enabled: true,
		epoch: 0,
		envRef: null,
	};
	for (const toolChoice of [undefined, "none"] as const)
		await cloudRequest(
			env,
			row,
			[{ role: "user", content: "search x" }],
			connection,
			resource,
			new AbortController().signal,
			"attempt",
			undefined,
			{ tools, onToolCalls: () => {}, ...(toolChoice ? { toolChoice } : {}) },
		);
	expect(sent).toEqual([tools, undefined]);
});

test("a Codex choice streams only its decoded reply, growing monotonically", () => {
	const reply = 'こんにちは\n"引用" 😀 end';
	const full = JSON.stringify({ reply, tool: null });
	let previous = "";
	for (let i = 0; i <= full.length; i++) {
		const visible = codexReplyPrefix(full.slice(0, i));
		expect(visible.startsWith(previous)).toBe(true);
		previous = visible;
	}
	expect(previous).toBe(reply);
	expect(
		codexReplyPrefix(
			JSON.stringify({ reply: null, tool: { name: "x", arguments: "{}" } }),
		),
	).toBe("");
});

type FakeParams = Parameters<typeof query>[0];
/** A stand-in for the SDK's `query`: reports `account`, drains the prompt iterable like the real
 * streaming input does, and answers once a user message has arrived. */
function fakeClaude(
	account: AccountInfo,
	resultExtra: Record<string, unknown> = {},
) {
	const seen = {
		params: undefined as FakeParams | undefined,
		yielded: [] as unknown[],
		closed: false,
		configDirExistedDuringRun: false,
	};
	const claudeQuery = ((params: FakeParams) => {
		seen.params = params;
		const drained = (async () => {
			for await (const message of params.prompt as AsyncIterable<unknown>) {
				seen.yielded.push(message);
				seen.configDirExistedDuringRun = existsSync(
					params.options!.env!.CLAUDE_CONFIG_DIR!,
				);
			}
		})();
		return {
			accountInfo: async () => account,
			close: () => {
				seen.closed = true;
			},
			async *[Symbol.asyncIterator]() {
				await drained;
				yield {
					type: "result",
					subtype: "success",
					is_error: false,
					result: "hi",
					total_cost_usd: 0.5,
					...resultExtra,
					usage: {
						input_tokens: 7,
						output_tokens: 2,
						cache_read_input_tokens: 40,
						cache_creation_input_tokens: 9,
					},
				};
			},
		};
	}) as unknown as typeof query;
	return { claudeQuery, seen };
}
const ambient = {
	PATH: "/bin",
	HOME: "/home/x",
	ANTHROPIC_API_KEY: "ambient-key",
	ANTHROPIC_AUTH_TOKEN: "ambient-token",
	ANTHROPIC_BASE_URL: "https://ambient.invalid",
	CLAUDE_CODE_OAUTH_TOKEN: "ambient-oauth",
	CLAUDE_CONFIG_DIR: "/ambient/config",
	CLAUDE_CODE_USE_BEDROCK: "1",
	AWS_ACCESS_KEY_ID: "aws",
	GOOGLE_APPLICATION_CREDENTIALS: "/gcp.json",
};
const claudeCall = (over: Partial<CloudAgentCall>): CloudAgentCall => ({
	kind: "claude-agent-sdk",
	model: "model-a",
	baseUrl: "https://gateway.example/v1",
	credential: "secret",
	auth: "api-key",
	messages: [
		{ role: "system", content: "be brief" },
		{ role: "user", content: "hi" },
	],
	signal: new AbortController().signal,
	...over,
});
const apiKeyAccount: AccountInfo = {
	apiKeySource: "ANTHROPIC_API_KEY",
	apiProvider: "firstParty",
};
const subscriptionAccount: AccountInfo = {
	tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
	apiKeySource: "none",
	apiProvider: "firstParty",
};

test("an api-key call passes only the key and endpoint, with its own config directory", async () => {
	const { claudeQuery, seen } = fakeClaude(apiKeyAccount);
	const result = await createCloudAgents(ambient, { claudeQuery }).run(
		claudeCall({}),
	);
	const env = seen.params!.options!.env!;
	expect(env.ANTHROPIC_API_KEY).toBe("secret");
	expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.example");
	expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("eumenes");
	for (const key of [
		"ANTHROPIC_AUTH_TOKEN",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"CLAUDE_CODE_USE_BEDROCK",
		"AWS_ACCESS_KEY_ID",
		"GOOGLE_APPLICATION_CREDENTIALS",
	])
		expect(env[key]).toBeUndefined();
	expect(env.CLAUDE_CONFIG_DIR).not.toBe("/ambient/config");
	expect(env.CLAUDE_CONFIG_DIR!.startsWith(tmpdir())).toBe(true);
	expect(seen.configDirExistedDuringRun).toBe(true);
	expect(existsSync(env.CLAUDE_CONFIG_DIR!)).toBe(false);
	expect(seen.yielded).toHaveLength(1);
	expect(seen.params!.options!.persistSession).toBe(false);
	expect(result).toEqual({
		text: "hi",
		// 7 uncached + 40 read + 9 written
		inputTokens: 56,
		outputTokens: 2,
		cacheReadTokens: 40,
		cacheCreationTokens: 9,
		costUsd: 0.5,
		contextWindow: null,
	});
});

test("a subscription call passes only the OAuth token and reports no per-call cost", async () => {
	const { claudeQuery, seen } = fakeClaude(subscriptionAccount);
	const result = await createCloudAgents(ambient, { claudeQuery }).run(
		claudeCall({ auth: "subscription", credential: "oauth-secret" }),
	);
	const env = seen.params!.options!.env!;
	expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-secret");
	for (const key of [
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_BASE_URL",
		"ANTHROPIC_AUTH_TOKEN",
		"CLAUDE_CODE_USE_BEDROCK",
	])
		expect(env[key]).toBeUndefined();
	expect(env.CLAUDE_CONFIG_DIR).not.toBe("/ambient/config");
	expect(result.costUsd).toBeNull();
	expect(result.cacheReadTokens).toBe(40);
});

test("a Claude call without a credential or auth never starts the CLI and never falls back to a login", async () => {
	let started = false;
	const claudeQuery = (() => {
		started = true;
		throw new Error("must not start");
	}) as unknown as typeof query;
	const agents = createCloudAgents(ambient, { claudeQuery });
	await expect(agents.run(claudeCall({ credential: null }))).rejects.toThrow(
		"cloud_credential_unavailable",
	);
	await expect(agents.run(claudeCall({ auth: undefined }))).rejects.toThrow(
		"cloud_agent_unconfigured",
	);
	expect(started).toBe(false);
});

test("an observation that does not prove the route closes the query before any message is sent", async () => {
	const cases: Array<[CloudAgentCall["auth"], AccountInfo]> = [
		["api-key", { apiKeySource: "none", apiProvider: "firstParty" }],
		["api-key", { apiKeySource: "apiKeyHelper", apiProvider: "firstParty" }],
		// A mixture of both credential sources, a bearer token or a cloud provider proves nothing.
		["api-key", { ...apiKeyAccount, tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" }],
		["api-key", { ...apiKeyAccount, tokenSource: "ANTHROPIC_AUTH_TOKEN" }],
		["api-key", { ...apiKeyAccount, apiProvider: "bedrock" }],
		["subscription", apiKeyAccount],
		// "none" alone is not enough, and the legacy "oauth" is never accepted.
		["subscription", { apiKeySource: "none", apiProvider: "firstParty" }],
		["subscription", { ...subscriptionAccount, apiKeySource: "oauth" }],
		[
			"subscription",
			{ ...subscriptionAccount, apiKeySource: "ANTHROPIC_API_KEY" },
		],
		[
			"subscription",
			{ ...subscriptionAccount, tokenSource: "ANTHROPIC_AUTH_TOKEN" },
		],
		["subscription", { ...subscriptionAccount, apiProvider: "bedrock" }],
		["subscription", { ...subscriptionAccount, apiProvider: "gateway" }],
	];
	for (const [auth, account] of cases) {
		const { claudeQuery, seen } = fakeClaude(account);
		await expect(
			createCloudAgents(ambient, { claudeQuery }).run(claudeCall({ auth })),
		).rejects.toThrow("cloud_agent_auth_mismatch");
		// Let a would-be send settle before asserting there was none.
		await Bun.sleep(0);
		expect(seen.yielded).toEqual([]);
		expect(seen.closed).toBe(true);
	}
});

const sessionMessages = [
	{ role: "system" as const, content: "base" },
	{ role: "system" as const, content: "long-term" },
	{ role: "user" as const, content: "u1" },
	{ role: "assistant" as const, content: "a1" },
	{ role: "system" as const, content: "summary" },
	{ role: "user" as const, content: "now" },
];
const split = { instructionCount: 2, historyCount: 2 };

test("a main call resumes from the host's history: instructions in the system prompt, this turn's input as the message", async () => {
	const { claudeQuery, seen } = fakeClaude(apiKeyAccount, {
		modelUsage: { "model-a": { contextWindow: 1_000_000 } },
	});
	let dropped = 0;
	const result = await createCloudAgents(ambient, { claudeQuery }).run(
		claudeCall({
			messages: sessionMessages,
			session: {
				id: "11111111-1111-4111-8111-111111111111",
				role: "main",
				context: split,
				drop: async () => {
					dropped++;
				},
			},
		}),
	);
	const options = seen.params!.options!;
	expect(options.env!.CLAUDE_CODE_PROJECT_DIR_NAME).toBe("eumenes-main");
	expect(options.env!.CLAUDE_CONFIG_DIR!.startsWith(tmpdir())).toBe(true);
	expect(options.persistSession).toBe(true);
	expect(options.resume).toBe("11111111-1111-4111-8111-111111111111");
	expect(options.sessionId).toBeUndefined();
	expect(options.settings).toEqual({ autoCompactEnabled: false });
	expect(options.systemPrompt).toBe("base\n\nlong-term");
	// The rest of the turn (summary, input) is one JSON message; the history never travels in it.
	const sent = (seen.yielded[0] as { message: { content: string } }).message
		.content;
	expect(sent).toContain("summary");
	expect(sent).toContain("now");
	expect(sent).not.toContain("u1");
	const store = options.sessionStore!;
	const key = {
		projectKey: "eumenes-main",
		sessionId: "11111111-1111-4111-8111-111111111111",
	};
	const loaded = (await store.load(key))!;
	expect(
		loaded.map((e) => [
			e.type,
			(e.message as { content: Array<{ text: string }> }).content[0]!.text,
		]),
	).toEqual([
		["user", "u1"],
		["assistant", "a1"],
	]);
	await store.append(key, [{ type: "user", uuid: "x" }]);
	expect(await store.load(key)).toEqual(loaded);
	await store.delete!(key);
	expect(dropped).toBe(1);
	expect(result.contextWindow).toBe(1_000_000);
});

test("a history ending on an unanswered user turn resumes without it and sends it before this turn's input", async () => {
	const { claudeQuery, seen } = fakeClaude(apiKeyAccount);
	await createCloudAgents(ambient, { claudeQuery }).run(
		claudeCall({
			messages: [
				{ role: "system" as const, content: "base" },
				{ role: "user" as const, content: "u1" },
				{ role: "assistant" as const, content: "a1" },
				{ role: "user" as const, content: "unanswered" },
				{ role: "user" as const, content: "now" },
			],
			session: {
				id: "11111111-1111-4111-8111-111111111112",
				role: "main",
				context: { instructionCount: 1, historyCount: 3 },
				drop: async () => {},
			},
		}),
	);
	const options = seen.params!.options!;
	const loaded = (await options.sessionStore!.load({
		projectKey: "eumenes-main",
		sessionId: "11111111-1111-4111-8111-111111111112",
	}))!;
	expect(loaded.map((e) => e.type)).toEqual(["user", "assistant"]);
	const sent = (seen.yielded[0] as { message: { content: string } }).message
		.content;
	expect(sent.indexOf("unanswered")).toBeGreaterThan(-1);
	expect(sent.indexOf("unanswered")).toBeLessThan(sent.indexOf("now"));
});

test("a single user message after the history is sent as it is", async () => {
	const { claudeQuery, seen } = fakeClaude(apiKeyAccount);
	await createCloudAgents(ambient, { claudeQuery }).run(
		claudeCall({
			messages: [
				{ role: "system", content: "base" },
				{ role: "user", content: "u1" },
				{ role: "assistant", content: "a1" },
				{ role: "user", content: "now" },
			],
			session: {
				id: "11111111-1111-4111-8111-111111111111",
				role: "main",
				context: { instructionCount: 1, historyCount: 2 },
				drop: async () => {},
			},
		}),
	);
	expect(
		(seen.yielded[0] as { message: { content: string } }).message.content,
	).toBe("now");
});

test("a main call without a history starts its session id; a context that does not fit starts nothing", async () => {
	const first = fakeClaude(apiKeyAccount);
	await createCloudAgents(ambient, { claudeQuery: first.claudeQuery }).run(
		claudeCall({
			session: {
				id: "22222222-2222-4222-8222-222222222222",
				role: "main",
				context: { instructionCount: 1, historyCount: 0 },
				drop: async () => {},
			},
		}),
	);
	const options = first.seen.params!.options!;
	expect(options.sessionId).toBe("22222222-2222-4222-8222-222222222222");
	expect(options.resume).toBeUndefined();
	const bad = fakeClaude(apiKeyAccount);
	await expect(
		createCloudAgents(ambient, { claudeQuery: bad.claudeQuery }).run(
			claudeCall({
				session: {
					id: "22222222-2222-4222-8222-222222222222",
					role: "main",
					context: { instructionCount: 1, historyCount: 5 },
					drop: async () => {},
				},
			}),
		),
	).rejects.toThrow("cloud_agent_invalid_session_context");
	expect(bad.seen.params).toBeUndefined();
});

test("a sub-agent call carries its whole context as the message and never resumes", async () => {
	const { claudeQuery, seen } = fakeClaude(apiKeyAccount);
	await createCloudAgents(ambient, { claudeQuery }).run(
		claudeCall({
			messages: sessionMessages,
			session: {
				id: "33333333-3333-4333-8333-333333333333",
				role: "subagent",
				drop: async () => {},
			},
		}),
	);
	const options = seen.params!.options!;
	expect(options.env!.CLAUDE_CODE_PROJECT_DIR_NAME).toBe("eumenes-subagent");
	expect(options.sessionId).toBe("33333333-3333-4333-8333-333333333333");
	expect(options.resume).toBeUndefined();
	expect(options.systemPrompt).toBe("base\n\nlong-term");
	expect(
		await options.sessionStore!.load({
			projectKey: "p",
			sessionId: "33333333-3333-4333-8333-333333333333",
		}),
	).toEqual([]);
	const sent = (seen.yielded[0] as { message: { content: string } }).message
		.content;
	for (const part of ["u1", "a1", "summary", "now"])
		expect(sent).toContain(part);
});

test("a one-shot call has no session options and no fixed project key", async () => {
	const { claudeQuery, seen } = fakeClaude(apiKeyAccount);
	await createCloudAgents(ambient, { claudeQuery }).run(claudeCall({}));
	const options = seen.params!.options!;
	expect(options.persistSession).toBe(false);
	expect(options.sessionStore).toBeUndefined();
	expect(options.resume).toBeUndefined();
	expect(options.sessionId).toBeUndefined();
	expect(options.env!.CLAUDE_CODE_PROJECT_DIR_NAME).toBeUndefined();
});
