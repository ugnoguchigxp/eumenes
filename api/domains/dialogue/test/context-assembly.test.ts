/**
 * The invariants every rendering of a conversation context keeps (the ContextWindow design, section 5.5), checked
 * on the real handler's lists (the scenarios of the golden tests) and on a hand-made assembly.
 */
import { expect, test } from "bun:test";
import {
	CONVERSATION_HOST_RULES,
	type ContextAssembly,
} from "../service/context-assembly";
import { renderContext } from "../service/context-render";
import { SCENARIOS, runScenario, TURN_TEXTS } from "./context-golden.fixture";

const INPUT = "今日のニュースは？";

/**
 * The user messages outside the history that are not the current request. Every format but `current` wraps
 * them (invariant 2); the `current` format still sends the operation and research results as bare JSON.
 */
function unwrappedUserMessages(
	messages: Array<{ role: string; content: string }>,
	history: ReadonlySet<string>,
) {
	return messages.filter(
		(m) => m.role === "user" && m.content !== INPUT && !history.has(m.content),
	);
}
const RESULT_KEYS = [
	"actionResult",
	"recognitionResult",
	"delegationResult",
	"drawingResult",
	"imageResult",
	"musicResult",
	"commandQuestion",
	"report",
];

for (const name of [
	"all-layers",
	"all-layers-selection",
	"research-success",
	"results-together",
	"command-question",
]) {
	test(`the current request is designated, last of what the model is sent, and the history is ledger history: ${name}`, async () => {
		const scenario = SCENARIOS[name]!;
		const captured = await runScenario(scenario);
		const { prepared, assembly } = captured;
		// 1. The designated position holds the input; in every list the model gets, the input is last, right after its marker.
		expect(
			prepared.messages[prepared.currentRequest.messageIndex]!.content,
		).toBe(INPUT);
		for (const call of captured.calls) {
			const last = call.messages.at(-1)!;
			expect(last).toEqual({ role: "user", content: INPUT });
			const marker = call.messages.at(-2)!;
			expect(marker.role).toBe("system");
			expect(marker.content).toStartWith(
				`CURRENT_REQUEST={"messageId":"<uuid>"}`,
			);
		}
		// 3. Every history message is a message of the ledger, in the order of the ledger.
		if (scenario.memory === "layers")
			for (const turn of assembly.history.turns) {
				expect(captured.ledgerMessageIds).toContain(turn.messageId);
				expect(turn.at).toBeString();
			}
		expect(assembly.history.turns.length).toBeGreaterThan(0);
		// 2. For the `current` format the bare messages are exactly the results; a wrapping format returns none.
		const history = new Set(
			assembly.history.turns
				.filter((t) => t.role === "user")
				.map((t) => t.content),
		);
		for (const text of TURN_TEXTS) history.add(text);
		for (const message of unwrappedUserMessages(prepared.messages, history)) {
			const json = JSON.parse(message.content) as Record<string, unknown>;
			expect(RESULT_KEYS.some((key) => key in json)).toBe(true);
		}
	}, 30_000);
}

test("the session split, the position of the input and the cache marks come from the render", () => {
	const turn = (
		role: "user" | "assistant",
		content: string,
		layer: "keep" | "unprocessed",
		messageId: string,
	) => ({ role, content, layer, messageId, at: "2026-10-01T00:00:00.000Z" });
	const assembly: ContextAssembly = {
		stage: "initial",
		persona: { agentName: "", userName: "", persona: "butler" },
		hostRules: CONVERSATION_HOST_RULES,
		stable: [
			{
				source: "memory.long_term",
				authority: "reference",
				freshness: "stable",
				body: {
					kind: "lines",
					header: "長期",
					sections: [{ items: ["- 好み"] }],
				},
			},
			{
				source: "goals",
				authority: "reference",
				freshness: "stable",
				body: { kind: "text", text: "目標" },
			},
		],
		history: {
			turns: [
				turn("user", "保持の質問", "keep", "m1"),
				turn("assistant", "保持の答え", "keep", "m2"),
				turn("user", "未処理の質問", "unprocessed", "m3"),
				turn("assistant", "未処理の答え", "unprocessed", "m4"),
			],
		},
		working: [
			{
				source: "memory.summary",
				authority: "reference",
				freshness: "past",
				body: { kind: "text", text: "要約" },
			},
		],
		volatile: [
			{
				source: "operation.image",
				authority: "host_record",
				freshness: "this_turn",
				body: { kind: "json", value: { ok: true } },
			},
		],
		input: { role: "user", content: "今回" },
	};
	const rendered = renderContext(assembly, "current");
	const contents = rendered.messages.map((m) => m.content);
	expect(contents.slice(1, 3).map((text) => JSON.parse(text))).toEqual([
		{
			context: {
				source: "memory.long_term",
				authority: "reference",
				freshness: "stable",
			},
			content: "長期\n- 好み",
		},
		{
			context: { source: "goals", authority: "reference", freshness: "stable" },
			content: "目標",
		},
	]);
	expect(contents.slice(3, 5)).toEqual(["保持の質問", "保持の答え"]);
	expect(JSON.parse(contents[5]!).content).toEndWith(
		"これまでの経緯（要約）\n要約",
	);
	expect(contents.slice(6)).toEqual([
		"未処理の質問",
		"未処理の答え",
		'{"imageResult":{"ok":true}}',
		"今回",
	]);
	// Persona, long-term memory and goals are the instructions; four messages are ledger history.
	expect(rendered.sessionContext).toEqual({
		instructionCount: 3,
		historyCount: 4,
	});
	expect(rendered.messages[rendered.currentRequestIndex]).toBe(assembly.input);
	expect(rendered.blockIndex["operation.image"]).toBe(8);
	// The marks end the system part, the stable part and the history.
	expect(rendered.cacheBreakpoints).toEqual([
		{ id: "B1", index: 0 },
		{ id: "B2", index: 2 },
		{ id: "B3", index: 7 },
	]);
	// The rule of the image result is in the system part whether or not there is a result: the block is data only.
	const without = renderContext({ ...assembly, volatile: [] }, "current");
	expect(rendered.messages[0]).toEqual(without.messages[0]!);
	expect(rendered.messages[0]!.content).toContain(
		"imageResultがあるときは、画像担当の操作は終了しています",
	);
});
