import { expect, test } from "bun:test";
import { imageLarmFixture } from "./chat-input.fixture";
import type { ChatMessage } from "../contracts";
import { chatRequest } from "../service/chat-request";
import { operationSchema } from "../service/operation-schema";
import { waitFor } from "../../../infrastructure/wait-for";

const messages: ChatMessage[] = [
	{ role: "system", content: "画像を説明" },
	{
		role: "user",
		content: "",
		images: [
			{
				mime: "image/png",
				bytes: new Uint8Array(180000),
				width: 20,
				height: 20,
			},
		],
	},
];

test.each([undefined, "remaining-context"])(
	"claim output policy %s controls the wire limit and formal input budget",
	async (outputLimit) => {
		const f = imageLarmFixture({ outputLimit });
		try {
			await f.p.answer(messages, new AbortController().signal, {
				maxOutputTokens: 11200,
			});
			const count = f.requests.find((r) => r.operation === "count")!;
			const generation = f.requests.find((r) => r.operation === "generate")!;
			expect(count.body).toBe(generation.body);
			expect(JSON.parse(generation.body).max_tokens).toBe(
				outputLimit ? 11200 : 4096,
			);
		} finally {
			await f.p.close();
		}
	},
);

test("an unknown claim output policy is rejected before counting or generating", async () => {
	const f = imageLarmFixture({ outputLimit: "unsupported-policy" });
	try {
		await expect(
			f.p.answer(messages, new AbortController().signal, {
				maxOutputTokens: 11200,
			}),
		).rejects.toThrow("larm_invalid_context_window");
		expect(f.requests).toHaveLength(0);
	} finally {
		await f.p.close();
	}
});
test("a schema operation omits native tools while existing combined requests keep them", () => {
	const provider = {
		model: "fixture",
		contextWindow: { outputReserveTokens: 4096 },
	};
	const tools = [
		{
			type: "function" as const,
			function: {
				name: "choose",
				description: "Choose",
				parameters: {
					type: "object",
					properties: {},
					additionalProperties: false,
				},
			},
		},
	];
	const options = {
		tools,
		jsonOutput: true,
		jsonSchema: {
			type: "object",
			properties: { done: { type: "boolean" } },
			required: ["done"],
			additionalProperties: false,
		},
	};
	const body = chatRequest(provider, messages.slice(0, 1), true, {
		...options,
		toolOutputFormat: "json-schema",
	});
	expect(body).not.toHaveProperty("tools");
	expect(body).not.toHaveProperty("tool_choice");
	expect(body.response_format).toMatchObject({
		type: "json_schema",
		json_schema: { strict: true, schema: options.jsonSchema },
	});
	expect(
		chatRequest(provider, messages.slice(0, 1), true, options).tools,
	).toEqual(tools);
});

test("operation grammar projects string bounds without changing the authoritative schema or other constraints", () => {
	const source = {
		type: "object",
		additionalProperties: false,
		properties: {
			query: {
				type: "string",
				minLength: 1,
				maxLength: 2000,
				description: "用途",
			},
			list: {
				type: "array",
				maxItems: 4,
				items: { type: "string", enum: ["one", "two"] },
			},
		},
		required: ["query", "list"],
	};
	const projected = operationSchema(source) as typeof source;
	expect(projected.properties.query).not.toHaveProperty("maxLength");
	expect(projected.properties.query).not.toHaveProperty("minLength");
	expect(projected.properties.query.description).toContain("maxLength=2000");
	expect(projected.properties.query.description).toContain("用途");
	expect(projected.properties.list).toEqual(source.properties.list);
	expect(projected.required).toEqual(source.required);
	expect(projected.additionalProperties).toBe(false);
	expect(source.properties.query.maxLength).toBe(2000);
});
test("image wire conversion preserves assistant tool_calls and ordinary string messages", () => {
	const calls = [
		{
			id: "tool-1",
			type: "function" as const,
			function: { name: "observe", arguments: "{}" },
		},
	];
	const body = chatRequest(
		{ model: "claimed", contextWindow: { outputReserveTokens: 4096 } },
		[...messages, { role: "assistant", content: "", tool_calls: calls }],
		false,
	);
	expect(body.messages[0]).toEqual({ role: "system", content: "画像を説明" });
	expect(body.messages[2]).toEqual({
		role: "assistant",
		content: "",
		tool_calls: calls,
	});
});
test("formal counting uses the complete identical request, images, tools, output and stream; bytes are not tokens", async () => {
	const f = imageLarmFixture();
	const deltas: string[] = [];
	try {
		await f.p.answerStream!(
			messages,
			AbortSignal.timeout(5000),
			(x) => deltas.push(x),
			{
				maxOutputTokens: 128,
				jsonOutput: true,
				jsonSchema: {
					type: "object",
					properties: { answer: { type: "string" } },
					required: ["answer"],
					additionalProperties: false,
				},
				contextPolicy: "exact",
				tools: [
					{
						type: "function",
						function: {
							name: "observe",
							description: "fixture",
							parameters: { type: "object" },
						},
					},
				],
			},
		);
		expect(f.requests.map((r) => r.operation)).toEqual(["count", "generate"]);
		expect(f.requests[0]!.body).toBe(f.requests[1]!.body);
		expect(f.requests[0]!.token).toBe("Bearer claim-1");
		const sent = JSON.parse(f.requests[1]!.body);
		expect(sent.messages[1].content[0].type).toBe("image_url");
		expect(sent.messages[1].content[0].image_url.url).toStartWith(
			"data:image/png;base64,",
		);
		expect(sent.max_tokens).toBe(128);
		expect(sent.response_format).toEqual({
			type: "json_schema",
			json_schema: {
				name: "control",
				strict: true,
				schema: {
					type: "object",
					properties: { answer: { type: "string" } },
					required: ["answer"],
					additionalProperties: false,
				},
			},
		});
		expect(sent.temperature).toBe(0);
		expect(sent.tools[0].function.name).toBe("observe");
		expect(sent.stream).toBe(true);
		expect(deltas.join("")).toBe("画像を確認しました。");
	} finally {
		await f.p.close();
	}
});
for (const [label, options, error] of [
	["fits false", { fits: false }, "context_budget_exceeded"],
	["count unavailable", { countError: true }, "chat_token_count_unavailable"],
	["unsupported capability", { vision: false }, "image_not_supported"],
	["final body exceeds limit", { maxBody: 100 }, "body_too_large"],
] as const)
	test(`${label} prevents inference without dropping images`, async () => {
		const f = imageLarmFixture(options);
		try {
			await expect(
				f.p.answer(messages, AbortSignal.timeout(5000)),
			).rejects.toThrow(error);
			expect(f.requests.filter((r) => r.operation === "generate")).toHaveLength(
				0,
			);
		} finally {
			await f.p.close();
		}
	});
for (const stage of ["count", "generate"] as const)
	test(`cancels during ${stage} and does not retry`, async () => {
		const f = imageLarmFixture({ gate: stage });
		const abort = new AbortController();
		try {
			const work = f.p.answer(messages, abort.signal);
			const result = Promise.allSettled([work]);
			await waitFor(() => f.requests.some((r) => r.operation === stage));
			abort.abort();
			expect((await result)[0]!.status).toBe("rejected");
			expect(f.requests.filter((r) => r.operation === stage)).toHaveLength(1);
		} finally {
			await f.p.close();
		}
	});
test("renew reclaims the credential before counting and generation", async () => {
	const f = imageLarmFixture({ renew: true });
	try {
		await f.p.connect();
		await f.p.answer(messages, AbortSignal.timeout(5000));
		expect(f.requests.map((r) => r.token)).toEqual([
			"Bearer claim-2",
			"Bearer claim-2",
		]);
	} finally {
		await f.p.close();
	}
});

test("unknown generation result is not automatically retried", async () => {
	const f = imageLarmFixture({ generationNetworkError: true });
	try {
		await expect(
			f.p.answer(messages, AbortSignal.timeout(5000)),
		).rejects.toThrow("fetch failed");
		expect(f.requests.map((r) => r.operation)).toEqual(["count", "generate"]);
	} finally {
		await f.p.close();
	}
});

test("claim image limits cover all history and stop before counting", async () => {
	const f = imageLarmFixture();
	try {
		const nine = Array.from({ length: 9 }, () => messages[1]!);
		await expect(f.p.answer(nine, AbortSignal.timeout(5000))).rejects.toThrow(
			"image_count_exceeded",
		);
		expect(f.requests).toHaveLength(0);
	} finally {
		await f.p.close();
	}
});
