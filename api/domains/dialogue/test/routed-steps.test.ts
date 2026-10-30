import { expect, test } from "bun:test";
import { pendingTurn } from "../service/routed-steps";
import type { Turn } from "../service/routed-turn";

/**
 * The pending turn's answer to a work's question (the local harness rebuild plan, section 4.4), on a turn whose choice
 * and host operation are given: the host's words never follow an operation that handed the run over.
 */
function pending(outcome: { result: Record<string, unknown>; end?: true }) {
	const spoken: string[] = [];
	const turn = {
		routed: {
			state: "",
			previousReply: null,
			asked: null,
			pending: {
				confirmations: [],
				questions: [{ ref: 1, title: "曲を作る", question: "曲調は？" }],
			},
			todos: [],
			resources: [],
		},
		utterance: "明るいので",
		choose: async () => ({ choice: "answer", todo: "t1", text: "明るい曲調" }),
		act: async () => ({ outcome }),
		speak: (text: string) => {
			spoken.push(text);
		},
	};
	return { turn: turn as unknown as Turn, spoken };
}

test("an answer that resumes a command's work under the run says nothing now: the work's report is the answer", async () => {
	const { turn, spoken } = pending({ result: { ok: true }, end: true });
	expect(await pendingTurn(turn)).toBe("done");
	expect(spoken).toEqual([]);
});

test("an answer a task takes in its own control is told as passed on; a refused one gets the host's words", async () => {
	const passed = pending({ result: { ok: true } });
	expect(await pendingTurn(passed.turn)).toBe("done");
	expect(passed.spoken).toEqual(["伝えました。"]);
	const refused = pending({ result: { ok: false, code: "question_not_open" } });
	await pendingTurn(refused.turn);
	expect(refused.spoken).toEqual([
		"うまく頼めませんでした。もう一度言ってもらえますか。",
	]);
});
