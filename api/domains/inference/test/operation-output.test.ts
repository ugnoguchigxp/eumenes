import { afterEach, expect, test } from "bun:test";
import { REASONING_ALLOWANCE_TOKENS } from "../service/attempt-work";
import type { NativeTool } from "../../../infrastructure/chat-stream";
import type { ControlContract } from "../contracts";
import { cleanup, messages, setup } from "./inference.fixture";

afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
const tools: NativeTool[] = [
	{
		type: "function",
		function: {
			name: "choose",
			description: "Choose one offered item",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					item: { type: "string", enum: ["one", "two"] },
					optional: { type: "string" },
					unknown: {},
					nullable: { anyOf: [{ type: "string" }, { type: "null" }] },
				},
				required: ["item", "nullable"],
			},
		},
	},
];
const decision: ControlContract = {
	instructions: "Choose one offered operation.",
	outputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["call"],
		properties: {
			call: {
				type: "object",
				required: ["name", "arguments"],
				properties: {
					name: { const: "choose" },
					arguments: { type: "object" },
				},
			},
		},
	},
};

test("a structured decision shares the answer request, snapshot and authority and never invokes speech judgement", async () => {
	let judged = 0;
	let seen: unknown;
	let seenMessages: unknown;
	const h = await setup({
		dataset: true,
		judge: async () => {
			judged++;
			throw new Error("unexpected_judge");
		},
		local: async (m, _s, options) => {
			seenMessages = m;
			seen = options;
			return JSON.stringify({
				call: {
					name: "choose",
					arguments: { item: "one", optional: null, nullable: null },
				},
			});
		},
	});
	const id = await h.store.write((db) =>
		h.inference.captureInTransaction(
			db,
			"decision-root",
			"llm",
			Date.now() + 10000,
		),
	);
	const before = h.store.read((db) =>
		db
			.query(
				"SELECT mode,snapshot,deadline,parents FROM inference_requests WHERE id=?",
			)
			.get(id),
	);
	const result = await h.inference.executeStream(
		id,
		messages,
		AbortSignal.timeout(1000),
		() => {},
		undefined,
		tools,
		{ sessionRole: "auxiliary" },
		decision,
	);
	expect(seen).toMatchObject({
		jsonOutput: true,
		toolOutputFormat: "json-schema",
		jsonSchema: decision.outputSchema,
	});
	expect(JSON.stringify(seenMessages)).toContain("OUTPUT_SCHEMA=");
	expect(
		h.store.read((db) =>
			db
				.query(
					"SELECT mode,snapshot,deadline,parents FROM inference_requests WHERE id=?",
				)
				.get(id),
		),
	).toEqual(before);
	expect(result.requestId).toBe(id);
	expect(result.delivery).toBeUndefined();
	expect(judged).toBe(0);
	expect(h.calls).toEqual([]);
	expect(
		await h.store.write((db) => h.inference.acceptInTransaction(db, result)),
	).toBe(true);
});

test("cancelling a structured decision fences a late provider and refuses its adoption", async () => {
	let release!: (v: string) => void;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const h = await setup({
		local: async () => {
			started();
			return new Promise<string>((resolve) => {
				release = resolve;
			});
		},
	});
	const id = await h.store.write((db) =>
		h.inference.captureInTransaction(
			db,
			"cancelled-decision",
			"llm",
			Date.now() + 10000,
		),
	);
	const abort = new AbortController();
	const pending = h.inference.executeStream(
		id,
		messages,
		abort.signal,
		() => {},
		undefined,
		tools,
		{ sessionRole: "auxiliary" },
		decision,
	);
	await ready;
	abort.abort();
	release(
		JSON.stringify({ call: { name: "choose", arguments: { item: "one" } } }),
	);
	await expect(pending).rejects.toThrow();
	expect(h.inference.usage().some((r) => r.accepted)).toBe(false);
});

test("a spoken call's session reaches the provider: speech sampling, a required call and its own output bound", async () => {
	let seen: unknown;
	const h = await setup({
		local: async (_m, _s, options) => {
			seen = options;
			return "はい。";
		},
	});
	const id = await h.store.write((db) =>
		h.inference.captureInTransaction(
			db,
			"spoken-root",
			"llm",
			Date.now() + 10000,
		),
	);
	await h.inference.executeStream(
		id,
		messages,
		AbortSignal.timeout(1000),
		() => {},
		undefined,
		tools,
		{
			sessionRole: "main",
			toolChoice: "required",
			outputLimit: 1024,
		},
	);
	expect(seen).toMatchObject({
		toolChoice: "required",
		maxOutputTokens: 1024 + REASONING_ALLOWANCE_TOKENS,
	});
});
