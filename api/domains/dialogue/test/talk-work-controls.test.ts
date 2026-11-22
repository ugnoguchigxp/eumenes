import { expect, test } from "bun:test";
import { createWorkControls } from "../service/talk-work-controls";
import type { Turn } from "../service/routed-turn";

/** A turn with only the records the controls read their definitions from. */
function turnOf(
	todos: Array<{
		ref: number;
		title: string;
		request?: string;
		open: boolean;
		tasks?: Array<{
			taskId: string;
			revision: number;
			title: string;
			state: "running";
			reason: string;
		}>;
	}>,
	questions: Array<{ ref: number; title: string; question: string }> = [],
) {
	return {
		routed: {
			pending: { confirmations: [], questions },
			todos,
			switching: null,
		},
		input: { retained: [] },
	} as unknown as Turn;
}

const workTool = (turn: Turn) =>
	createWorkControls(turn).tools.find(({ name }) => name === "work")!;

test("the work tool's schema stays completely static in KV cache across 0, 1, and many TODOs with tasks", () => {
	const task = {
		taskId: "task-a",
		revision: 1,
		title: "下絵",
		state: "running" as const,
		reason: "構図を詰めている",
	};
	const none = workTool(turnOf([]));
	const one = workTool(
		turnOf([{ ref: 1, title: "壁紙の作成", request: "猫の壁紙", open: true }]),
	);
	const many = workTool(
		turnOf(
			[
				{
					ref: 1,
					title: "旅行の下調べ",
					request: "京都の旅行を調べて".repeat(50),
					open: true,
					tasks: [task],
				},
				{ ref: 2, title: "別の仕事", open: false },
			],
			[{ ref: 1, title: "旅行の下調べ", question: "いつ行きますか？" }],
		),
	);
	expect(one).toEqual(none);
	expect(many).toEqual(none);
	const text = JSON.stringify([none, one, many]);
	for (const body of ["猫の壁紙", "京都", "いつ行きますか", "下絵", "構図"])
		expect(text).not.toContain(body);
});
