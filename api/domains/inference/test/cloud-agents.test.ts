import { expect, test } from "bun:test";
import { defaults } from "../../settings";
import { settingsSchema, type Connection } from "../../settings/contracts";
import {
	codexReplyPrefix,
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
		settingsSchema.safeParse(withConnection({ kind: "claude-agent-sdk" }))
			.success,
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

test("Managed Agents connections require a stored agent and environment", () => {
	expect(
		settingsSchema.safeParse(withConnection({ kind: "claude-managed-agents" }))
			.success,
	).toBe(false);
	expect(
		settingsSchema.safeParse(
			withConnection({
				kind: "claude-managed-agents",
				agentId: "agent_01",
				environmentId: "env_01",
			}),
		).success,
	).toBe(true);
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

test("an agent connection answers through the agent runner without a key", async () => {
	let seen: CloudAgentCall | undefined;
	const { env, usage } = fakeEnv({
		async run(call) {
			seen = call;
			call.onDelta?.("hello");
			return { text: "hello", inputTokens: 3, outputTokens: 1 };
		},
	});
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
	expect(seen?.credential).toBeNull();
	expect(usage).toEqual([[3, 1, "attempt"]]);
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
