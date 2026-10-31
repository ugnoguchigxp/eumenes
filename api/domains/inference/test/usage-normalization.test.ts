import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations as settingsMigrations } from "../../settings";
import type { Connection, Resource } from "../../settings";
import { claudeUsage } from "../adapters/cloud-agents";
import { migrations } from "../repository";
import type { RequestRow } from "../repository";
import { chatUsage, cloudRequest, type CloudEnv } from "../service/cloud";

function expectSubset(usage: ReturnType<typeof claudeUsage>) {
	expect(
		(usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0),
	).toBeLessThanOrEqual(usage.inputTokens ?? 0);
}

test("Claude usage records the total input; the cache counters are subsets of it", () => {
	const usage = claudeUsage({
		input_tokens: 7,
		output_tokens: 2,
		cache_read_input_tokens: 40,
		cache_creation_input_tokens: 9,
	});
	expect(usage).toEqual({
		inputTokens: 56,
		outputTokens: 2,
		cacheReadTokens: 40,
		cacheCreationTokens: 9,
	});
	expectSubset(usage);
});

test("Claude usage treats a missing counter as 0 in the sum and keeps it null", () => {
	const readOnly = claudeUsage({
		input_tokens: 5,
		output_tokens: 1,
		cache_read_input_tokens: 30,
		cache_creation_input_tokens: null,
	});
	expect(readOnly).toEqual({
		inputTokens: 35,
		outputTokens: 1,
		cacheReadTokens: 30,
		cacheCreationTokens: null,
	});
	expectSubset(readOnly);
	expect(claudeUsage({ input_tokens: 5, output_tokens: 1 })).toEqual({
		inputTokens: 5,
		outputTokens: 1,
		cacheReadTokens: null,
		cacheCreationTokens: null,
	});
	expect(claudeUsage({})).toEqual({
		inputTokens: null,
		outputTokens: null,
		cacheReadTokens: null,
		cacheCreationTokens: null,
	});
	// Only cached input: the sum still counts it.
	const cached = claudeUsage({
		input_tokens: null,
		cache_read_input_tokens: 12,
	});
	expect(cached.inputTokens).toBe(12);
	expectSubset(cached);
});

test("OpenAI-compatible usage keeps prompt_tokens as the total and reads cached_tokens as its subset", () => {
	expect(
		chatUsage({
			prompt_tokens: 100,
			completion_tokens: 4,
			prompt_tokens_details: { cached_tokens: 64 },
		}),
	).toEqual({ input: 100, output: 4, cacheRead: 64, cacheCreation: null });
	for (const details of [
		undefined,
		null,
		{},
		{ cached_tokens: null },
		{ cached_tokens: -1 },
		{ cached_tokens: 1.5 },
		{ cached_tokens: "3" },
		// More than the total input cannot be a subset of it.
		{ cached_tokens: 101 },
	])
		expect(
			chatUsage({ prompt_tokens: 100, prompt_tokens_details: details })
				.cacheRead,
		).toBeNull();
	expect(chatUsage(undefined)).toEqual({
		input: undefined,
		output: undefined,
		cacheRead: null,
		cacheCreation: null,
	});
});

const row = {
	id: "req",
	purpose: "llm",
	contextPolicy: "trim",
	subject: "conversation:1",
} as unknown as RequestRow;
const connection = {
	id: "c",
	name: "fixture",
	baseUrl: "https://api.example.test/v1",
	enabled: true,
	epoch: 0,
	envRef: null,
} as Connection;
const resource = {
	id: "r",
	connectionId: "c",
	purpose: "llm" as const,
	model: "fixture-model",
	contextWindow: 100_000,
	voice: null,
} as Resource;
const messages = [
	{ role: "system" as const, content: "system" },
	{ role: "user" as const, content: "go" },
];
function chatEnv(respond: (body: Record<string, unknown>) => Response) {
	const recorded: unknown[][] = [];
	const bodies: Record<string, unknown>[] = [];
	const env = {
		store: {
			write: async (fn: (db: unknown) => unknown) =>
				fn({
					query: () => ({ run: (...args: unknown[]) => recorded.push(args) }),
				}),
		},
		settings: { credential: () => "fixture-key" },
		fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			bodies.push(body);
			return respond(body);
		},
	} as unknown as CloudEnv;
	return { env, recorded, bodies };
}
const usage = {
	prompt_tokens: 120,
	completion_tokens: 3,
	prompt_tokens_details: { cached_tokens: 100 },
};

test("a non-stream chat response records the total input and the cached tokens", async () => {
	const { env, recorded, bodies } = chatEnv(() =>
		Response.json({ choices: [{ message: { content: "hi" } }], usage }),
	);
	await cloudRequest(
		env,
		row,
		messages,
		connection,
		resource,
		new AbortController().signal,
		"a1",
	);
	expect("stream_options" in bodies[0]!).toBe(false);
	// input, output, cache read, cache creation
	expect(recorded[0]!.slice(0, 4)).toEqual([120, 3, 100, null]);
});

test("a streamed chat response asks for usage and records it from the final chunk", async () => {
	const frames = [
		{ choices: [{ index: 0, delta: { content: "h" } }] },
		{ choices: [{ index: 0, delta: { content: "i" }, finish_reason: "stop" }] },
		{ choices: [], usage },
	];
	const { env, recorded, bodies } = chatEnv(
		() =>
			new Response(
				frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") +
					"data: [DONE]\n\n",
				{ headers: { "content-type": "text/event-stream" } },
			),
	);
	const deltas: string[] = [];
	const text = await cloudRequest(
		env,
		row,
		messages,
		connection,
		resource,
		new AbortController().signal,
		"a2",
		(d) => deltas.push(d),
	);
	expect(text).toBe("hi");
	expect(bodies[0]!.stream).toBe(true);
	expect(bodies[0]!.stream_options).toEqual({ include_usage: true });
	expect(recorded[0]!.slice(0, 4)).toEqual([120, 3, 100, null]);
});

test("a chat response without usage details leaves the cache counters null", async () => {
	const { env, recorded } = chatEnv(() =>
		Response.json({
			choices: [{ message: { content: "hi" } }],
			usage: { prompt_tokens: 9, completion_tokens: 1 },
		}),
	);
	await cloudRequest(
		env,
		row,
		messages,
		connection,
		resource,
		new AbortController().signal,
		"a3",
	);
	expect(recorded[0]!.slice(0, 4)).toEqual([9, 1, null, null]);
});

test("the total-input migration adds the cache counters for Claude Agent SDK attempts only", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-total-input-"));
	const path = join(dir, "test.db");
	const before = [
		...settingsMigrations,
		...migrations.slice(
			0,
			migrations.findIndex((m) => m.id === "inference/0012-total-input-tokens"),
		),
	];
	let store = openStore(path, before);
	try {
		await store.write((db) => {
			db.query("INSERT INTO settings_document(id,document) VALUES(1,?)").run(
				JSON.stringify({
					connections: [
						{ id: "sdk", kind: "claude-agent-sdk" },
						{ id: "codex", kind: "codex-sdk" },
						{ id: "plain" },
					],
				}),
			);
			db.query(
				"INSERT INTO inference_requests(id,subject,purpose,snapshot,deadline) VALUES('r','s','llm','{}',1)",
			).run();
			const insert = db.query(
				"INSERT INTO inference_attempts(id,request_id,source,connection_id,status,started,input_tokens,cache_read_tokens,cache_creation_tokens) VALUES(?,'r','cloud',?,'succeeded',1,?,?,?)",
			);
			insert.run("sdk-both", "sdk", 7, 40, 9);
			insert.run("sdk-read", "sdk", 5, 30, null);
			insert.run("sdk-nocache", "sdk", 11, null, null);
			insert.run("codex", "codex", 7, 40, 9);
			insert.run("plain", "plain", 7, 40, 9);
			insert.run("gone", "removed-connection", 7, 40, 9);
			insert.run("unlinked", null, 7, 40, 9);
		});
		await store.close();
		store = openStore(path, [...settingsMigrations, ...migrations]);
		const rows = () =>
			store.read((db) =>
				db
					.query("SELECT id,input_tokens FROM inference_attempts ORDER BY id")
					.all(),
			);
		const expected = [
			{ id: "codex", input_tokens: 7 },
			{ id: "gone", input_tokens: 7 },
			{ id: "plain", input_tokens: 7 },
			{ id: "sdk-both", input_tokens: 56 },
			{ id: "sdk-nocache", input_tokens: 11 },
			{ id: "sdk-read", input_tokens: 35 },
			{ id: "unlinked", input_tokens: 7 },
		];
		expect(rows()).toEqual(expected);
		// Applied once: reopening does not add the counters again.
		await store.close();
		store = openStore(path, [...settingsMigrations, ...migrations]);
		expect(rows()).toEqual(expected);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
