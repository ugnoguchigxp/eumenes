import { afterEach, expect, test } from "bun:test";
import { runRespond } from "eumenes-agency";
import {
	configureLogging,
	getLogger,
	withLogContext,
} from "../../../infrastructure/logger";
import { codexCall, fakeCodex, user } from "./codex.fixture";

afterEach(() => configureLogging({ level: "silent" }));

test("reused Codex notifications retain the current caller's correlation, including usage and streamed text", async () => {
	const lines: string[] = [];
	configureLogging({
		level: "info",
		destination: { write: (line) => void lines.push(line) },
	});
	const codex = await fakeCodex();
	try {
		const agents = codex.agents(codex.host());
		await codex.behave({ deltas: 1 });
		for (const id of ["first", "second", "third"]) {
			await withLogContext({ runId: id, attemptId: `attempt-${id}` }, () =>
				agents.run(
					codexCall([user(id)], {
						onDelta: () => getLogger("test").info("test.delta"),
						onUsage: () => getLogger("test").info("test.usage"),
					}),
				),
			);
		}
		const events = lines.map((line) => JSON.parse(line));
		for (const event of ["test.delta", "test.usage"]) {
			expect(
				events
					.filter((entry) => entry.event === event)
					.map((entry) => [entry.runId, entry.attemptId]),
			).toEqual(
				["first", "second", "third"].map((id) => [id, `attempt-${id}`]),
			);
		}
	} finally {
		await codex.cleanup();
	}
});

test("a Codex tool preamble reaches the user before the tool and remains in the final conversation exactly once", async () => {
	const codex = await fakeCodex();
	try {
		const agents = codex.agents(codex.host());
		const preamble = "記録を確認します。";
		const answer = "記録では未完了です。";
		const events: string[] = [];
		await codex.behave({
			text: JSON.stringify({
				reply: preamble,
				tool: { name: "read_records", arguments: "{}" },
			}),
		});
		const reply = await runRespond({
			messages: [
				{ role: "system", content: "Use the provided records." },
				user("進み具合を確認して。"),
			],
			chat: {
				async complete(request, onDelta, signal) {
					const result = await agents.run({
						...codexCall([], { signal, onDelta, requestId: "reply-request" }),
						messages: request.messages.map((message) => ({
							...message,
							tool_calls: message.tool_calls?.map((call) => ({ ...call })),
						})),
						tools: request.tools.map((tool) => ({
							type: "function" as const,
							function: tool,
						})),
					});
					return { text: result.text, toolCalls: result.toolCalls ?? [] };
				},
			},
			tools: {
				tools: [
					{
						name: "read_records",
						description: "Read records",
						parameters: { type: "object", properties: {} },
					},
				],
				async call() {
					events.push("tool");
					await codex.behave({
						text: JSON.stringify({ reply: answer, tool: null }),
					});
					return { content: "pending" };
				},
			},
			emotion: false,
			maxToolCalls: 2,
			signal: new AbortController().signal,
			onDelta: (text) => events.push(text),
		});
		expect(events).toEqual([preamble, "tool", answer]);
		expect(reply.text).toBe(preamble + answer);
		expect(reply.calls).toHaveLength(1);
		const turns = await codex.of("turn/start");
		expect(turns).toHaveLength(2);
		expect(turns[1]!.params.threadId).toBe(turns[0]!.params.threadId);
		expect(turns[1]!.params.input[0].text).toContain("pending");
		expect(turns[1]!.params.input[0].text).not.toContain(preamble);
	} finally {
		await codex.cleanup();
	}
});
