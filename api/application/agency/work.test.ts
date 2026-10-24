import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createAgencyWork, hostTodoOf } from "./work";

type Todo = Parameters<typeof hostTodoOf>[0];
const todo = (over: Partial<Todo>): Todo => ({
	id: "w1",
	title: "夜のドライブ向けの曲を作って",
	status: "todo",
	revision: 1,
	createdAt: "1970-01-01T00:00:00.200Z",
	updatedAt: "1970-01-01T00:00:09.000Z",
	...over,
});

test("an open TODO is offered to the agency as todo, dated when it was requested; waiting is still open", () => {
	expect(hostTodoOf(todo({}))).toEqual({
		id: "w1",
		title: "夜のドライブ向けの曲を作って",
		status: "todo",
		requestedAt: 200,
	});
	expect(
		hostTodoOf(
			todo({ status: "waiting", questionId: "q1", question: "どの曲調?" }),
		),
	).toEqual({
		id: "w1",
		title: "夜のドライブ向けの曲を作って",
		status: "todo",
		requestedAt: 200,
	});
	expect(hostTodoOf(todo({ title: "あ".repeat(100) }))?.title.length).toBe(60);
});

test("a finished TODO is never offered, so the agency cannot report its result", () => {
	expect(hostTodoOf(todo({ status: "done", outcome: "succeeded" }))).toBeNull();
});

test("the agency reads only the open TODOs of the conversation from the dialogue ledger", () => {
	const asked: string[] = [];
	const work = createAgencyWork({
		dialogue: {
			todosInTransaction: (_db: Database, conversationId: string) => {
				asked.push(conversationId);
				return [
					todo({ id: "a" }),
					todo({ id: "b", status: "done", outcome: "succeeded" }),
					todo({ id: "c", status: "waiting" }),
				];
			},
		},
	});
	const db = new Database(":memory:");
	try {
		expect(work.todosInTransaction(db, "c1").map((t) => t.id)).toEqual([
			"a",
			"c",
		]);
		expect(asked).toEqual(["c1"]);
	} finally {
		db.close();
	}
});
