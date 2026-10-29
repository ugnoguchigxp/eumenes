import { afterEach, expect, test } from "bun:test";
import { REASONING_ALLOWANCE_TOKENS } from "../service/attempt-work";
import type { NativeTool } from "../../../infrastructure/chat-stream";
import {
	operationOutputContract,
	operationOutputReceipt,
	operationOutputMessages,
} from "../contracts/operation-output";
import type { Receipt } from "../contracts";
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
const receipt = (value: unknown): Receipt => ({
	requestId: "r",
	attemptId: "a",
	value: JSON.stringify(value),
});
test("schema transforms never rewrite literal data or properties named like schema keywords", () => {
	const literal = {
		type: "object",
		properties: { note: { type: "string" } },
		$ref: "#/literal",
		$schema: "literal-data",
	};
	const offered: NativeTool[] = [
		{
			type: "function",
			function: {
				name: "literal",
				description: "literal",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						$schema: { type: "string" },
						payload: { const: literal },
					},
					required: ["$schema", "payload"],
				},
			},
		},
	];
	const schema = operationOutputContract(offered).outputSchema!;
	expect(JSON.stringify(schema)).toContain(JSON.stringify(literal));
	expect(JSON.stringify(schema)).toContain('"$schema":{"type":"string"}');
});
test("open objects retain additional argument keys allowed by their source contract", () => {
	const open: NativeTool[] = [
		{
			type: "function",
			function: {
				name: "open",
				description: "open",
				parameters: {
					type: "object",
					properties: { label: { type: "string" } },
					required: ["label"],
					additionalProperties: { type: "integer" },
				},
			},
		},
	];
	expect(JSON.stringify(operationOutputContract(open).outputSchema)).toContain(
		'"additionalProperties":{"type":"integer"}',
	);
	expect(
		JSON.parse(
			operationOutputReceipt(
				receipt({
					call: { name: "open", arguments: { label: "x", count: 2 } },
				}),
				open,
			).toolCalls![0]!.arguments,
		),
	).toEqual({ label: "x", count: 2 });
});
test("recursive root references and boolean schemas normalize only absent optional values", () => {
	const recursive: NativeTool[] = [
		{
			type: "function",
			function: {
				name: "recursive",
				description: "recursive",
				parameters: {
					type: "object",
					additionalProperties: false,
					required: ["name"],
					properties: {
						name: { type: "string" },
						child: { $ref: "#" },
						forbidden: false,
						referenced: { $ref: "#/$defs/never" },
						free: true,
					},
					$defs: { never: false },
				},
			},
		},
	];
	const result = operationOutputReceipt(
		receipt({
			call: {
				name: "recursive",
				arguments: {
					name: "outer",
					child: { name: "inner", child: null, forbidden: null, free: null },
					forbidden: null,
					referenced: null,
					free: null,
				},
			},
		}),
		recursive,
	);
	expect(JSON.parse(result.toolCalls![0]!.arguments)).toEqual({
		name: "outer",
		child: { name: "inner", free: null },
		free: null,
	});
});

test("the model sees the same operation names, descriptions and argument schema without replacing the current request", () => {
	const original = [
		{ role: "system" as const, content: "role" },
		{ role: "user" as const, content: "current" },
	];
	const output = operationOutputMessages(
		original,
		operationOutputContract(tools),
	);
	expect(output[0]!.content).toStartWith(original[0]!.content);
	expect(output.at(-1)).toBe(original.at(-1));
	expect(output[0]!.role).toBe("system");
	expect(output[0]!.content).toContain("OUTPUT_SCHEMA=");
	expect(output[0]!.content).toContain("Choose one offered item");
	expect(output[0]!.content).toContain(
		'"name":{"type":"string","enum":["choose"]}',
	);
	expect(original).toHaveLength(2);
	expect(output).toHaveLength(2);
	expect(original[0]!.content).toBe("role");
});

test("schema constrains each operation with its own arguments and normalizes optional null without dropping nullable data", () => {
	const contract = operationOutputContract(tools);
	expect(contract.outputSchema).toMatchObject({
		required: ["call"],
		additionalProperties: false,
		properties: {
			call: {
				anyOf: [
					{
						properties: {
							name: { enum: ["choose"] },
							arguments: {
								required: ["item", "optional", "unknown", "nullable"],
								additionalProperties: false,
							},
						},
					},
				],
			},
		},
	});
	const normalized = operationOutputReceipt(
		receipt({
			call: {
				name: "choose",
				arguments: {
					item: "one",
					optional: null,
					unknown: null,
					nullable: null,
				},
			},
		}),
		tools,
	);
	expect(normalized.requestId).toBe("r");
	expect(normalized.attemptId).toBe("a");
	expect(normalized.value).toBe("");
	expect(JSON.parse(normalized.toolCalls![0]!.arguments)).toEqual({
		item: "one",
		nullable: null,
		unknown: null,
	});
});

test("representation conversion preserves unknown operations and invalid business values for the owning validator", () => {
	const normalized = operationOutputReceipt(
		receipt({ call: { name: "not_offered", arguments: { item: 42 } } }),
		tools,
	);
	expect(normalized.toolCalls![0]).toMatchObject({
		name: "not_offered",
		arguments: '{"item":42}',
	});
	for (const bad of [
		{ call: [] },
		{ call: { name: "choose", arguments: [] } },
		{ call: { name: "choose", arguments: {}, execute: true } },
		{ call: { name: "choose", arguments: {} }, approved: true },
	])
		expect(() => operationOutputReceipt(receipt(bad), tools)).toThrow();
});

test("nested nullable unions and local schema references keep their source meaning", () => {
	const nested: NativeTool[] = [
		{
			type: "function",
			function: {
				name: "nested",
				description: "nested",
				parameters: {
					type: "object",
					properties: {
						payload: { anyOf: [{ $ref: "#/$defs/entry" }, { type: "null" }] },
					},
					required: ["payload"],
					additionalProperties: false,
					$defs: {
						entry: {
							type: "object",
							additionalProperties: false,
							properties: {
								tag: { type: "string", const: "a" },
								note: { type: "string" },
							},
							required: ["tag"],
						},
					},
				},
			},
		},
	];
	const contract = operationOutputContract(nested);
	expect(JSON.stringify(contract.outputSchema)).toContain(
		'"$ref":"#/properties/call/anyOf/0/properties/arguments/$defs/entry"',
	);
	const decoded = operationOutputReceipt(
		receipt({
			call: {
				name: "nested",
				arguments: { payload: { tag: "a", note: null } },
			},
		}),
		nested,
	);
	expect(JSON.parse(decoded.toolCalls![0]!.arguments)).toEqual({
		payload: { tag: "a" },
	});
	const nullValue = operationOutputReceipt(
		receipt({ call: { name: "nested", arguments: { payload: null } } }),
		nested,
	);
	expect(JSON.parse(nullValue.toolCalls![0]!.arguments)).toEqual({
		payload: null,
	});
});

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
		operationOutputContract(tools),
	);
	expect(seen).toMatchObject({
		jsonOutput: true,
		toolOutputFormat: "json-schema",
		jsonSchema: operationOutputContract(tools).outputSchema,
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
		operationOutputContract(tools),
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
