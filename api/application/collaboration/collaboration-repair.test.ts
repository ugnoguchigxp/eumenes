import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { searchThenDelegate } from "../toolchain/conversation-script.fixture";

test("an incorrectly scalar output.from is refused with its position and repaired within the same bounded draft turn", async () => {
	const request = "今回の手順の下書きを一緒に作って";
	const definition = {
		request,
		steps: [
			{
				id: "first",
				bundle: "timers.manage",
				task: "タイマーの一覧を確認",
				from: ["request"],
				result: "現在の一覧",
			},
		],
		output: { from: ["first"], deliver: "確認結果を伝える" },
	};
	let calls = 0;
	const prompts: string[] = [];
	const h = await harness({
		pipelines: true,
		timers: true,
		discoveryTarget: () => "collaborate_pipeline",
		firstRound: (_t, _q, messages) =>
			searchThenDelegate((c) => c.id === "collaboration.pipeline", request, {
				announcement: "一緒に作成します。",
				impact: "create",
			})(messages),
		specialist: (messages) => {
			prompts.push(messages.map((m) => m.content).join("\n"));
			return {
				action: "invoke",
				tool: "doc.write",
				arguments: {
					baseRevision: 0,
					title: "今回の手順",
					content:
						++calls === 1
							? {
									...definition,
									output: { ...definition.output, from: "first" },
								}
							: definition,
				},
				text: "手順の下書きを作りました。",
			};
		},
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: request,
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		expect(calls).toBe(2);
		expect(prompts[1]).toContain('"path":"output.from"');
		expect(prompts[1]).toContain('"rule":"invalid_type"');
		const session = h.dialogue.specialistSession("main")!;
		const doc = h.store.read((db) =>
			h.toolchain.collaboration.works.document(db, session.workRef),
		)!;
		expect(doc.revision).toBe(1);
		expect(JSON.parse(doc.text)).toEqual(definition);
		expect(h.toolchain.agents.executions.list("main")).toHaveLength(0);
	} finally {
		await h.close();
	}
});
