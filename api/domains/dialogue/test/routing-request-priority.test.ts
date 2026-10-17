import { expect, test } from "bun:test";
import { prepareRouting } from "../service/delegate-conversation";
import type { DialogueDeps } from "../service/context";
import type { Run } from "../contracts";

for (const currentText of [
	"日曜日の朝にぴったりな音楽を作って",
	"では同じ条件でもう一つ作って",
])
	test(`retrieval uses the current request while earlier turns remain available as context: ${currentText}`, () => {
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
		const result = prepareRouting(
			{} as never,
			deps,
			{ id: "run", conversationId: "main", sourceKind: "manual" } as Run,
			messages,
			current,
			{ dots: false },
		);
		expect(result?.routing.query).toBe(currentText);
		expect(result?.routing.available).toEqual(["music.create"]);
		expect(messages[0]!.content).toBe("前は画像についてWeb検索して");
		expect(messages.at(-1)).toBe(current);
	});
