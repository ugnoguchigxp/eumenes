import { expect, test } from "bun:test";
import { readChatResponse } from "./chat-stream";
const encode = (text: string) => new TextEncoder().encode(text);
const delta = (content: string) =>
	`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\r\n\r\n`;
test("provider UTF-8 splits publish answer text before completion and exclude reasoning fields", async () => {
	let sink!: ReadableStreamDefaultController<Uint8Array>;
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start: (c) => {
				sink = c;
			},
		}),
		{ headers: { "Content-Type": "text/event-stream" } },
	);
	const parts: string[] = [];
	let finished = false;
	const work = readChatResponse(response, new AbortController().signal, (x) =>
		parts.push(x),
	).then((value) => {
		finished = true;
		return value;
	});
	for (const b of encode(delta("こんにちは")))
		sink.enqueue(new Uint8Array([b]));
	sink.enqueue(
		encode(
			'data: {"choices":[{"index":0,"delta":{"reasoning_content":"hidden"}}]}\n\n',
		),
	);
	for (let i = 0; i < 100 && !parts.length; i++) await Bun.sleep(1);
	expect(parts).toEqual(["こんにちは"]);
	expect(finished).toBe(false);
	sink.enqueue(encode(delta("。") + "data: [DONE]\n\n"));
	sink.close();
	expect((await work).text).toBe("こんにちは。");
});
test("a disconnected stream is not adopted as a complete answer", async () => {
	const response = new Response(encode(delta("途中")), {
		headers: { "Content-Type": "text/event-stream" },
	});
	const parts: string[] = [];
	await expect(
		readChatResponse(response, new AbortController().signal, (x) =>
			parts.push(x),
		),
	).rejects.toThrow("chat_stream_incomplete");
	expect(parts).toEqual(["途中"]);
});
test("cancellation closes a blocked reader and prevents late content", async () => {
	let closed = false;
	const response = new Response(
		new ReadableStream<Uint8Array>({
			cancel: () => {
				closed = true;
			},
		}),
		{ headers: { "Content-Type": "text/event-stream" } },
	);
	const controller = new AbortController(),
		parts: string[] = [];
	const work = readChatResponse(response, controller.signal, (x) =>
		parts.push(x),
	);
	controller.abort();
	await expect(work).rejects.toThrow();
	expect(closed).toBe(true);
	expect(parts).toHaveLength(0);
});

test("native tool calls survive split SSE arguments without publishing control data", async () => {
	const chunks = [
		{
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{
								index: 0,
								id: "call1",
								function: { name: "research", arguments: '{"kind":"web",' },
							},
						],
					},
				},
			],
		},
		{
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{
								index: 0,
								function: { arguments: '"question":"明日の鎌倉の天気"}' },
							},
						],
					},
					finish_reason: "tool_calls",
				},
			],
		},
	];
	const response = new Response(
		chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
			"data: [DONE]\n\n",
		{ headers: { "content-type": "text/event-stream" } },
	);
	const visible: string[] = [];
	const result = await readChatResponse(
		response,
		new AbortController().signal,
		(t) => visible.push(t),
	);
	expect(result.text).toBe("");
	expect(visible).toEqual([]);
	expect(result.toolCalls?.[0]?.name).toBe("research");
	expect(JSON.parse(result.toolCalls![0]!.arguments).question).toBe(
		"明日の鎌倉の天気",
	);
});
test("truncated native control is rejected before any operation can be adopted", async () => {
	const response = new Response(
		JSON.stringify({
			choices: [
				{
					message: {
						tool_calls: [
							{
								id: "call1",
								function: { name: "research", arguments: '{"kind":' },
							},
						],
					},
					finish_reason: "length",
				},
			],
		}),
		{ headers: { "content-type": "application/json" } },
	);
	await expect(
		readChatResponse(response, new AbortController().signal),
	).rejects.toThrow("chat_stream_incomplete");
});
