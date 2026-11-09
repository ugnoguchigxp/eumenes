import { expect, test } from "bun:test";
import { startRouter, VECTOR, weigh, traceOf } from "./router.fixture";
import { DIRECT_ROUTER_MODEL, IMAGE, choice } from "./generation.fixture";

test("a multi-score turn can ask about its whole work instead of starting the automatic pipeline", async () => {
	const planner = {
		...IMAGE,
		id: "fake.plan",
		revisionId: "toolchain:fake.plan@1",
		functionName: "fake_plan",
		title: "実行",
		execution: "pipeline" as const,
	};
	const editor = {
		...IMAGE,
		id: "fake.edit-work",
		revisionId: "toolchain:fake.edit-work@1",
		functionName: "fake_edit_work",
		title: "共同編集",
		execution: "session" as const,
	};
	const r = await startRouter(
		{},
		{ cards: [IMAGE, editor, planner], routerModel: DIRECT_ROUTER_MODEL },
	);
	try {
		r.h.state.vector = VECTOR;
		r.scripts.push(weigh({ [IMAGE.id]: 0.9, [editor.id]: 0.95 }));
		r.h.state.steps.push(
			choice({ choice: "ask", say: "まず案を一緒に作りますか？" }),
		);
		const run = await r.h.say("画像と文章を含む作品の進め方を相談したい");
		expect(r.h.dialogue.answerText(run.id)).toBe("まず案を一緒に作りますか？");
		expect(r.h.todos()).toHaveLength(0);
		expect(traceOf(r.h).row).toBe(9);
		expect(r.h.state.calls).toHaveLength(1);
		const offered = r.h.state.calls[0]!.messages.at(-1)!.content;
		expect(offered).toContain(planner.id);
		expect(offered).toContain(editor.id);
		const [owners, related] = offered.split("## Related candidates");
		expect(owners).not.toContain(IMAGE.id);
		expect(related).toContain(IMAGE.id);
	} finally {
		await r.h.close();
	}
});
