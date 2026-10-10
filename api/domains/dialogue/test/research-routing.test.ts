import { expect, test } from "bun:test";
import { conversationTools, operation } from "../service/conversation-tools";

test("researcher selection follows the LLM tool call regardless of topic", () => {
	const tools = conversationTools(false, true);
	for (const question of [
		"WBSってなんだっけ？",
		"DeepSeek harnessってなに？詳細教えて",
		"今朝のニュースを複数資料で比較して",
	])
		for (const name of ["research", "research_web_luna"]) {
			const args =
				name === "research" ? { kind: "web", question } : { question };
			expect(
				operation(
					[{ id: "call", name, arguments: JSON.stringify(args) }],
					tools,
				),
			).toEqual({
				kind: "web",
				question,
				...(name === "research_web_luna" ? { researcher: "codex_luna" } : {}),
			});
		}
	const description = tools.find(
		(t) => t.function.name === "research_web_luna",
	)!.function.description;
	expect(description).toContain("簡単な語句確認はresearch");
	expect(description).toContain("リアルタイム情報も対象");
});

test("Luna is not callable when unavailable and cannot request history or coding scope", () => {
	const call = {
		id: "call",
		name: "research_web_luna",
		arguments: '{"question":"説明して"}',
	};
	expect(() => operation([call], conversationTools(false))).toThrow(
		"invalid_conversation_operation",
	);
	for (const kind of ["history", "coding"])
		expect(() =>
			operation(
				[
					{
						...call,
						arguments: JSON.stringify({ question: "説明して", kind }),
					},
				],
				conversationTools(false, true),
			),
		).toThrow();
	expect(() =>
		operation(
			[
				{
					...call,
					name: "research",
					arguments:
						'{"kind":"history","question":"以前の話","researcher":"codex_luna"}',
				},
			],
			conversationTools(false, true),
		),
	).toThrow();
});
