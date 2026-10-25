import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	TODO_RESULT_CHARS,
	TODO_TITLE_CHARS,
	createAgencyWork,
	hostTodoOf,
	resultLine,
} from "./work";

type Todo = Parameters<typeof hostTodoOf>[0];
const todo = (over: Partial<Todo>): Todo => ({
	id: "w1",
	ref: 1,
	title: "夜のドライブ向けの曲を作って",
	status: "todo",
	createdAt: "1970-01-01T00:00:00.200Z",
	changedAt: "1970-01-01T00:00:09.000Z",
	result: null,
	...over,
});

test("an open TODO is offered to the agency as todo, dated when it was requested", () => {
	expect(hostTodoOf(todo({}))).toEqual({
		id: "w1",
		title: "夜のドライブ向けの曲を作って",
		status: "todo",
		requestedAt: 200,
	});
	expect(hostTodoOf(todo({ title: "あ".repeat(100) }))?.title.length).toBe(
		TODO_TITLE_CHARS,
	);
});

test("a TODO that waits for the user is offered as waiting, with the question the sub-agent asked", () => {
	expect(
		hostTodoOf(
			todo({ status: "waiting", questionId: "q1", question: "どの曲調?" }),
		),
	).toEqual({
		id: "w1",
		title: "夜のドライブ向けの曲を作って",
		status: "waiting",
		question: "どの曲調?",
		requestedAt: 200,
	});
	// One line, bounded: a long or multi-line question never fills the prompt.
	const asked = hostTodoOf(
		todo({ status: "waiting", question: `一行目\n二行目 ${"あ".repeat(300)}` }),
	);
	const line = asked?.status === "waiting" ? asked.question! : "";
	expect(line.startsWith("一行目 二行目 あ")).toBe(true);
	expect(line.endsWith("…")).toBe(true);
	expect(line.length).toBe(TODO_RESULT_CHARS);
});

test("a finished TODO is offered as done with how it ended, its one-line result and when it finished", () => {
	expect(
		hostTodoOf(
			todo({
				status: "done",
				outcome: "succeeded",
				result: { summary: "晴れ、最高26度" },
				changedAt: "1970-01-01T00:00:12.000Z",
			}),
		),
	).toEqual({
		id: "w1",
		title: "夜のドライブ向けの曲を作って",
		status: "done",
		outcome: "succeeded",
		result: "晴れ、最高26度",
		requestedAt: 200,
		doneAt: 12_000,
	});
	// A partial result stays partial; any other end (including none recorded) is a failure to the agency.
	expect(
		hostTodoOf(todo({ status: "done", outcome: "partial" }))?.outcome,
	).toBe("partial");
	expect(hostTodoOf(todo({ status: "done", outcome: "failed" }))?.outcome).toBe(
		"failed",
	);
	expect(hostTodoOf(todo({ status: "done" }))?.outcome).toBe("failed");
	// Without a result the TODO still reports; the line is left out, never invented.
	expect(
		hostTodoOf(todo({ status: "done", outcome: "failed" })),
	).not.toHaveProperty("result");
});

test("work the user cancelled is not reported back to the agency", () => {
	expect(hostTodoOf(todo({ status: "done", outcome: "cancelled" }))).toBeNull();
});

test("the one-line result takes the result's own words first, then its claims, then its data", () => {
	expect(resultLine(null)).toBeUndefined();
	expect(resultLine(undefined)).toBeUndefined();
	expect(resultLine("そのままの\n文")).toBe("そのままの 文");
	expect(resultLine({ answer: "答え", summary: "要約" })).toBe("答え");
	expect(resultLine({ summary: "要約" })).toBe("要約");
	expect(resultLine({ text: "  ", title: "題" })).toBe("題");
	expect(
		resultLine({ claims: [{ text: "主張A" }, { text: "主張B" }, { n: 1 }] }),
	).toBe("主張A 主張B");
	expect(resultLine({ kind: "timer_action", action: "started" })).toBe(
		'{"kind":"timer_action","action":"started"}',
	);
	const long = resultLine({ summary: "あ".repeat(500) })!;
	expect(long.length).toBe(TODO_RESULT_CHARS);
	expect(long.endsWith("…")).toBe(true);
});

test("the agency reads the TODOs of the conversation from the dialogue ledger: open, asking and finished, without the cancelled", () => {
	const asked: string[] = [];
	const work = createAgencyWork({
		dialogue: {
			todosInTransaction: (_db: Database, conversationId: string) => {
				asked.push(conversationId);
				return [
					todo({ id: "a" }),
					todo({ id: "b", status: "done", outcome: "succeeded" }),
					todo({ id: "c", status: "waiting", question: "どれ?" }),
					todo({ id: "d", status: "done", outcome: "cancelled" }),
				];
			},
		},
	});
	const db = new Database(":memory:");
	try {
		expect(
			work.todosInTransaction(db, "c1").map((t) => [t.id, t.status]),
		).toEqual([
			["a", "todo"],
			["b", "done"],
			["c", "waiting"],
		]);
		expect(asked).toEqual(["c1"]);
	} finally {
		db.close();
	}
});
