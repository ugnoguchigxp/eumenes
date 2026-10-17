import { expect, test } from "bun:test";
import { prepareRouting } from "../service/delegate-conversation";
import type { DialogueDeps } from "../service/context";
import type { Run } from "../contracts";

for (const currentText of [
	"日曜日の朝にぴったりな音楽を作って",
	"では同じ条件でもう一つ作って",
])
	test(`routing hands the first round its own input and keeps the messages as they are: ${currentText}`, () => {
		const current = { role: "user" as const, content: currentText };
		const messages = [
			{ role: "user" as const, content: "前は画像についてWeb検索して" },
			{ role: "assistant" as const, content: "過去の調査結果" },
			current,
		];
		const deps = {
			agents: {},
			music: {},
			toolchains: {
				catalogInTransaction: () => [
					{ id: "music.create", runtime: { requires: "music" } },
				],
			},
		} as unknown as DialogueDeps;
		const analysis = {
			persona: { agentName: "", userName: "", persona: "butler" as const },
			previous: [
				{ role: "user" as const, content: "前は画像についてWeb検索して" },
				{ role: "assistant" as const, content: "過去の調査結果" },
			],
		};
		const result = prepareRouting(
			{} as never,
			deps,
			{ id: "run", conversationId: "main", sourceKind: "manual" } as Run,
			messages,
			current,
			{ dots: false },
			analysis,
		);
		// The search text is the analysis' goal, decided in the execute phase; nothing of the utterance is fixed here.
		expect(result?.routing).not.toHaveProperty("query");
		expect(result?.routing.analysis).toBe(analysis);
		expect(result?.routing.available).toEqual(["music.create"]);
		expect(messages[0]!.content).toBe("前は画像についてWeb検索して");
		expect(messages.at(-1)).toBe(current);
	});
