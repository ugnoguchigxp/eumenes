import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import {
	createCloudAgents,
	type CloudAgentCall,
} from "../adapters/cloud-agents";
import { cloudRequest, type CloudEnv } from "../service/cloud";
import type { RequestRow } from "../repository";
import type { Connection, Resource } from "../../settings/contracts";

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

test("Codex SDK passes the schema as turn outputSchema even without tools", async () => {
	const dir = await mkdtemp(join(tmpdir(), "eumenes-codex-schema-"));
	const record = join(dir, "turn.json");
	const command = join(dir, "codex");
	// A minimal app-server: answers the handshake, records turn/start, completes the turn.
	await writeFile(
		command,
		`#!${process.execPath}
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
	const m = JSON.parse(line);
	if (m.method === "initialize") out({ id: m.id, result: {} });
	else if (m.method === "thread/start") out({ id: m.id, result: { thread: { id: "t1" } } });
	else if (m.method === "turn/start") {
		writeFileSync(${JSON.stringify(record)}, JSON.stringify(m.params));
		out({ id: m.id, result: { turn: { id: "u1" } } });
		out({ method: "item/completed", params: { threadId: "t1", item: { type: "agentMessage", text: '{"done":true}' } } });
		out({ method: "turn/completed", params: { threadId: "t1", turn: { id: "u1", status: "completed" } } });
	}
});
`,
		{ mode: 0o700 },
	);
	try {
		const agents = createCloudAgents(
			{ PATH: "" },
			{ codexExecutable: command },
		);
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
			const turn = JSON.parse(await readFile(record, "utf8"));
			expect(turn.outputSchema).toEqual(schema);
			expect(turn.effort).toBe(reasoningEffort);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
