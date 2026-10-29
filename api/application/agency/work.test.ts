import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	TODO_QUESTION_CHARS,
	TODO_TITLE_CHARS,
	createAgencyWork,
	hostTodoOf,
} from "./work";

type Todo = Parameters<typeof hostTodoOf>[0];

const todo = (over: Partial<Todo>): Todo => ({
	id: "w1",
	ref: 1,
	title: "夜のドライブ向けの曲を作って",
	status: "todo",
	createdAt: "1970-01-01T00:00:00.200Z",
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
	expect(line.length).toBe(TODO_QUESTION_CHARS);
});

test("finished work is never offered to the agency: its notice on screen tells it", () => {
	expect(hostTodoOf(todo({ status: "done", outcome: "succeeded" }))).toBeNull();
	expect(hostTodoOf(todo({ status: "done", outcome: "cancelled" }))).toBeNull();
});

test("the agency reads the TODOs of the conversation from the dialogue ledger: open and asking ones only", () => {
	const asked: string[] = [];
	const work = createAgencyWork({
		dialogue: {
			todosInTransaction: (_db: Database, conversationId: string) => {
				asked.push(conversationId);
				return [
					todo({ id: "a" }),
					todo({ id: "b", status: "done", outcome: "succeeded" }),
					todo({ id: "c", status: "waiting", question: "どれ?" }),
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
			["c", "waiting"],
		]);
		expect(asked).toEqual(["c1"]);
	} finally {
		db.close();
	}
});

test("the title names the toolchain the work went to, within the title length", () => {
	expect(hostTodoOf(todo({ toolchainTitle: "画像の作成" }))?.title).toBe(
		"[画像の作成] 夜のドライブ向けの曲を作って",
	);
	const long = hostTodoOf(
		todo({ toolchainTitle: "画像の作成", title: "あ".repeat(100) }),
	)!.title;
	expect(long.length).toBe(TODO_TITLE_CHARS);
	expect(long.startsWith("[画像の作成] あ")).toBe(true);
});
