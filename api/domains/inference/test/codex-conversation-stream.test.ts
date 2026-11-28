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

test("a Codex call whose arguments are not a JSON object reaches the host's tool, and the repaired call continues the same thread", async () => {
	const lines: string[] = [];
	configureLogging({
		level: "warn",
		destination: { write: (line) => void lines.push(line) },
	});
	const codex = await fakeCodex();
	try {
		const agents = codex.agents(codex.host());
		const answer = "調べた結果です。";
		const seen: string[] = [];
		await codex.behave({
			text: JSON.stringify({
				reply: null,
				// The model put the query itself where the JSON object belongs.
				tool: { name: "lookup", arguments: "2005年の記録" },
			}),
		});
		const reply = await runRespond({
			messages: [
				{ role: "system", content: "Use the lookup." },
				user("調べて。"),
			],
			chat: {
				async complete(request, onDelta, signal) {
					const result = await agents.run({
						...codexCall([], { signal, onDelta, requestId: "repair-request" }),
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
						name: "lookup",
						description: "Look up",
						parameters: {
							type: "object",
							additionalProperties: false,
							required: ["query"],
							properties: { query: { type: "string" } },
						},
					},
				],
				async call(call) {
					seen.push(call.arguments);
					let valid = false;
					try {
						valid = typeof JSON.parse(call.arguments).query === "string";
					} catch {
						// The host refuses what it cannot read.
					}
					await codex.behave({
						text: JSON.stringify(
							valid
								? { reply: answer, tool: null }
								: {
										reply: null,
										tool: {
											name: "lookup",
											arguments: '{ "query": "2005年の記録" }',
										},
									},
						),
					});
					return { content: valid ? "found" : "refused: invalid_tool_call" };
				},
			},
			emotion: false,
			// The refused call counts: the answer after the repaired one still offers the tool.
			maxToolCalls: 3,
			signal: new AbortController().signal,
			onDelta: () => {},
		});
		expect(seen).toEqual(["2005年の記録", '{"query":"2005年の記録"}']);
		expect(reply.text).toBe(answer);
		const turns = await codex.of("turn/start");
		expect(turns).toHaveLength(3);
		expect(new Set(turns.map((turn) => turn.params.threadId)).size).toBe(1);
		expect(turns[1]!.params.input[0].text).toContain("invalid_tool_call");
		const warned = lines
			.map((line) => JSON.parse(line))
			.filter(
				(entry) => entry.event === "inference.codex_tool_arguments_invalid",
			);
		expect(warned.map((entry) => entry.kind)).toEqual(["lookup"]);
		expect(lines.join("")).not.toContain("2005");
	} finally {
		await codex.cleanup();
	}
});
