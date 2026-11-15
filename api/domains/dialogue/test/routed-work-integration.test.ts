import { expect, test } from "bun:test";
import { IMAGE, setup } from "./generation.fixture";

test("clarifying a multi-step request holds every action and preserves the original request", async () => {
	const text = "画像と文章を含む作品の進め方を相談したい";
	const h = await setup({
		cards: [IMAGE],
		async selectRouter() {
			return JSON.stringify({
				decision: {
					clarify: {
						question: "まず案を一緒に作りますか？",
						unhandled: [text],
					},
				},
			});
		},
	});
	try {
		const run = await h.say(text);
		expect(h.dialogue.answerText(run.id)).toContain(
			"まず案を一緒に作りますか？",
		);
		expect(h.dialogue.answerText(run.id)).toContain(text);
		expect(h.todos()).toHaveLength(0);
		expect(h.state.searchSlots).toHaveLength(0);
	} finally {
		await h.close();
	}
});
