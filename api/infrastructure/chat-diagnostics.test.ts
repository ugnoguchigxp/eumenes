import { expect, test } from "bun:test";
import { readChatResponse, type ChatDiagnostics } from "./chat-stream";

for (const [finish, done, text, failure] of [
	["stop", true, "private-output", undefined],
	["length", true, "private-output", "output_limit"],
	["content_filter", true, "private-output", "content_filter"],
	["stop", false, "private-output", "missing_end"],
	["stop", true, "", "empty_output"],
	["private-finish", true, "private-output", undefined],
] as const)
	test(`read diagnostics distinguish ${failure ?? finish} without exposing provider data`, async () => {
		const diagnostics: ChatDiagnostics[] = [];
		const body = JSON.stringify({
			choices: [{ delta: { content: text }, finish_reason: finish }],
			usage: {
				prompt_tokens: 23,
				completion_tokens: -1,
				credential: "private-token",
			},
			timings: { cache_n: 19, prompt_ms: 10, private: "private-input" },
		});
		const response = new Response(
			`data: ${body}\n\n${done ? "data: [DONE]\n\n" : ""}`,
			{ headers: { "content-type": "text/event-stream" } },
		);
		const result = readChatResponse(
			response,
			new AbortController().signal,
			undefined,
			(value) => diagnostics.push(value),
		);
		if (failure) await expect(result).rejects.toThrow("chat_stream_incomplete");
		else expect((await result).text).toBe(text);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			finishReason: finish === "private-finish" ? "unknown" : finish,
			streamDone: done ? 1 : 0,
			promptTokens: 23,
			providerCachedTokens: 19,
		});
		expect(diagnostics[0]?.streamFailure).toBe(failure);
		expect(diagnostics[0]?.completionTokens).toBeUndefined();
		for (const secret of [
			"private-output",
			"private-token",
			"private-input",
			"private-finish",
		])
			expect(JSON.stringify(diagnostics)).not.toContain(secret);
	});

test("diagnostic observer failure cannot turn a rejected tool call into success", async () => {
	const response = Response.json({
		choices: [
			{
				message: {
					tool_calls: [{ id: "x", function: { name: "op", arguments: "" } }],
				},
			},
		],
	});
	const diagnostics: ChatDiagnostics[] = [];
	await expect(
		readChatResponse(
			response,
			new AbortController().signal,
			undefined,
			(value) => {
				diagnostics.push(value);
				throw new Error("observer");
			},
		),
	).rejects.toThrow("chat_tool_calls_invalid");
	expect(diagnostics[0]?.streamFailure).toBe("invalid_tool_calls");
});

test("partial usage frames retain all known safe counters even when the stream fails", async () => {
	const diagnostics: ChatDiagnostics[] = [];
	const frames = [
		{ usage: { prompt_tokens: 23 } },
		{
			usage: {
				completion_tokens: 4,
				prompt_tokens_details: { cached_tokens: 19 },
			},
		},
		{
			choices: [
				{ delta: { content: "private-output" }, finish_reason: "length" },
			],
		},
	];
	const response = new Response(
		frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") +
			"data: [DONE]\n\n",
		{ headers: { "content-type": "text/event-stream" } },
	);
	await expect(
		readChatResponse(response, new AbortController().signal, undefined, (d) =>
			diagnostics.push(d),
		),
	).rejects.toThrow("chat_stream_incomplete");
	expect(diagnostics[0]).toMatchObject({
		promptTokens: 23,
		completionTokens: 4,
		cachedTokens: 19,
		streamFailure: "output_limit",
	});
});

test("a later finish frame cannot relabel an observed content filter as an output limit", async () => {
	const diagnostics: ChatDiagnostics[] = [];
	const frames = [
		{
			choices: [
				{
					delta: { content: "private-output" },
					finish_reason: "content_filter",
				},
			],
		},
		{ choices: [{ finish_reason: "stop" }] },
	];
	const response = new Response(
		frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") +
			"data: [DONE]\n\n",
		{ headers: { "content-type": "text/event-stream" } },
	);
	await expect(
		readChatResponse(response, new AbortController().signal, undefined, (d) =>
			diagnostics.push(d),
		),
	).rejects.toThrow("chat_stream_incomplete");
	expect(diagnostics[0]?.streamFailure).toBe("content_filter");
});
