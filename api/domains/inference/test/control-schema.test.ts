import type { query } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Connection, Resource } from "../../settings/contracts";
import { type CloudAgentCall } from "../adapters/cloud-agent-shared";
import { createCloudAgents } from "../adapters/cloud-agents";
import { fakeCodex } from "./codex.fixture";
import type { RequestRow } from "../repository";
import { cloudRequest, type CloudEnv } from "../service/cloud";

// The schema of a structured-output control request (the options execute.ts builds for it) reaches every route.
const schema = {
	type: "object",
	properties: { done: { type: "boolean" } },
	required: ["done"],
	additionalProperties: false,
};
const options = { jsonOutput: true, jsonSchema: schema };
const connectionId = crypto.randomUUID();
const row = {
	id: "req",
	purpose: "llm",
	mode: "control",
	contextPolicy: "exact",
	subject: "background:control",
} as unknown as RequestRow;
const resource = {
	id: crypto.randomUUID(),
	connectionId,
	purpose: "llm",
	model: "fixture-model",
	contextWindow: 100_000,
	voice: null,
} as Resource;
const connection = (kind?: Connection["kind"]): Connection => ({
	id: connectionId,
	name: "fixture",
	baseUrl: "https://api.example.test/v1",
	enabled: true,
	epoch: 0,
	envRef: null,
	...(kind ? { kind } : {}),
});
const messages = [
	{ role: "system" as const, content: "system" },
	{ role: "user" as const, content: "go" },
];
function env(extra: Partial<CloudEnv>) {
	return {
		store: {
			write: async (fn: (db: unknown) => unknown) =>
				fn({ query: () => ({ run: () => {} }) }),
		},
		settings: { credential: () => "fixture-key" },
		...extra,
	} as unknown as CloudEnv;
}

test("OpenAI-compatible cloud sends the schema as response_format and leaves ordinary turns alone", async () => {
	const bodies: Record<string, unknown>[] = [];
	const fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)));
		return Response.json({
			choices: [{ message: { content: '{"done":true}' } }],
		});
	};
	const signal = new AbortController().signal;
	await cloudRequest(
		env({ fetch }),
		row,
		messages,
		connection(),
		resource,
		signal,
		"a1",
		undefined,
		options,
	);
	await cloudRequest(
		env({ fetch }),
		row,
		messages,
		connection(),
		resource,
		signal,
		"a2",
	);
	expect(bodies[0]!.response_format).toMatchObject({
		type: "json_schema",
		json_schema: { name: "control", strict: true, schema },
	});
	expect("response_format" in bodies[1]!).toBe(false);
});

test("Codex and Claude agent connections receive the schema in the call", async () => {
	const seen: CloudAgentCall[] = [];
	const agents = {
		async run(call: CloudAgentCall) {
			seen.push(call);
			return { text: '{"done":true}' };
		},
	};
	for (const kind of ["codex-sdk", "claude-agent-sdk"] as const)
		await cloudRequest(
			env({ agents }),
			row,
			messages,
			connection(kind),
			resource,
			new AbortController().signal,
			"a",
			undefined,
			options,
		);
	expect(seen.map((c) => c.outputSchema)).toEqual([schema, schema]);
});

test("schema-constrained operation choices suppress native tools on every cloud route", async () => {
	const tools = [
		{
			type: "function" as const,
			function: { name: "choose", description: "choose", parameters: schema },
		},
	];
	const operationOptions = {
		...options,
		tools,
		toolOutputFormat: "json-schema" as const,
	};
	const seen: CloudAgentCall[] = [];
	let body: Record<string, unknown> = {};
	const operationRow = { ...row, mode: "answer" as const };
	await cloudRequest(
		env({
			fetch: async (_url, init) => {
				body = JSON.parse(String(init?.body));
				return Response.json({
					choices: [{ message: { content: '{"done":true}' } }],
				});
			},
		}),
		operationRow,
		messages,
		connection(),
		resource,
		AbortSignal.timeout(1000),
		"operation",
		undefined,
		operationOptions,
	);
	expect(body.response_format).toMatchObject({ type: "json_schema" });
	expect(body).not.toHaveProperty("tools");
	expect(body).not.toHaveProperty("tool_choice");
	for (const kind of ["codex-sdk", "claude-agent-sdk"] as const) {
		await cloudRequest(
			env({
				agents: {
					async run(call) {
						seen.push(call);
						return { text: '{"done":true}' };
					},
				},
			}),
			operationRow,
			messages,
			connection(kind),
			resource,
			AbortSignal.timeout(1000),
			"operation",
			undefined,
			operationOptions,
		);
	}
	expect(seen.map((c) => c.outputSchema)).toEqual([schema, schema]);
	expect(seen.every((c) => c.tools === undefined)).toBe(true);
});

test("Claude Agent SDK gets outputFormat and its structured output becomes the text", async () => {
	const seen: { options?: Record<string, unknown> } = {};
	const claudeQuery = ((input: { options: Record<string, unknown> }) => {
		seen.options = input.options;
		const result = {
			type: "result",
			subtype: "success",
			is_error: false,
			result: input.options.outputFormat ? "" : "plain",
			structured_output: input.options.outputFormat
				? { done: true }
				: undefined,
			usage: { input_tokens: 1, output_tokens: 2 },
		};
		return {
			async *[Symbol.asyncIterator]() {
				yield result;
			},
			accountInfo: async () => ({
				apiKeySource: "ANTHROPIC_API_KEY",
				apiProvider: "firstParty",
			}),
			close() {},
		};
	}) as unknown as typeof query;
	const agents = createCloudAgents({}, { claudeQuery });
	const result = await agents.run({
		kind: "claude-agent-sdk",
		auth: "api-key",
		model: "fixture-model",
		baseUrl: "https://api.example.test",
		credential: "sk-test",
		messages,
		outputSchema: schema,
		signal: new AbortController().signal,
	});
	expect(seen.options?.outputFormat).toEqual({ type: "json_schema", schema });
	expect(result.text).toBe('{"done":true}');
	seen.options = undefined;
	await agents.run({
		kind: "claude-agent-sdk",
		auth: "api-key",
		model: "fixture-model",
		baseUrl: "https://api.example.test",
		credential: "sk-test",
		messages,
		signal: new AbortController().signal,
	});
	expect(Object.keys(seen.options ?? {})).not.toContain("outputFormat");
});

test("Codex SDK passes the schema even without tools, always names the thinking level, and runs in the dedicated home", async () => {
	const codex = await fakeCodex();
	try {
		const agents = codex.agents(codex.host());
		await codex.behave({ text: '{"done":true}' });
		for (const reasoningEffort of [undefined, "low"] as const) {
			const result = await agents.run({
				kind: "codex-sdk",
				model: "fixture-model",
				baseUrl: "https://api.example.test/v1",
				credential: null,
				messages,
				outputSchema: schema,
				...(reasoningEffort ? { reasoningEffort } : {}),
				signal: AbortSignal.timeout(5000),
			});
			expect(result.text).toBe('{"done":true}');
			const turn = (await codex.of("turn/start")).at(-1)!.params;
			expect(turn.outputSchema).toEqual(schema);
			// A call that names none sends the level it had under the person's own Codex settings.
			expect(turn.effort).toBe(reasoningEffort ?? "high");
		}
		const [spawn] = await codex.of("spawn");
		expect(spawn!.params.home).toBe(codex.home);
		expect(spawn!.params.cwd).toBe(
			await realpath(join(codex.home, "workspace")),
		);
		const argv: string[] = spawn!.params.argv;
		for (const setting of [
			"skills.include_instructions=false",
			"include_permissions_instructions=false",
			"include_collaboration_mode_instructions=false",
			"include_environment_context=false",
			"features.shell_snapshot=false",
			"features.shell_tool=false",
		])
			expect(argv).toContain(setting);
		expect(argv.some((a) => a.startsWith("mcp_servers"))).toBe(false);
		expect(await codex.of("config/read")).toEqual([]);
		const [thread] = await codex.of("thread/start");
		expect(thread!.params).toMatchObject({
			ephemeral: false,
			sandbox: "read-only",
			approvalPolicy: "never",
			cwd: join(codex.home, "workspace"),
			config: { features: { shell_tool: false, apps: false, plugins: false } },
		});
	} finally {
		await codex.cleanup();
	}
});
