import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ResourceKind } from "../../domains/resources";
import {
	TODO_RESULT_CHARS,
	TODO_TITLE_CHARS,
	createAgencyWork,
	hostTodoOf,
	resultLine,
} from "./work";

type Todo = Parameters<typeof hostTodoOf>[0];

const WORDS = { open: "表示する", play: "再生する", read: "内容を伝える" };
const kinds: Record<string, ResourceKind> = {
	image: {
		kind: "image",
		label: "画像",
		owner: "image",
		actions: ["open", "read"],
		defaultAction: "open",
		actionLabels: WORDS,
	},
	"music.track": {
		kind: "music.track",
		label: "曲",
		owner: "music",
		actions: ["open", "play", "read"],
		defaultAction: "play",
		actionLabels: WORDS,
	},
	report: {
		kind: "report",
		label: "調査報告",
		owner: "web-research",
		actions: ["open", "read"],
		defaultAction: "read",
		actionLabels: WORDS,
	},
};
const lookup = { kind: (kind: string) => kinds[kind] ?? null };
const host = (item: Todo) => hostTodoOf(item, lookup);
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
	expect(host(todo({}))).toEqual({
		id: "w1",
		title: "夜のドライブ向けの曲を作って",
		status: "todo",
		requestedAt: 200,
	});
	expect(host(todo({ title: "あ".repeat(100) }))?.title.length).toBe(
		TODO_TITLE_CHARS,
	);
});

test("a TODO that waits for the user is offered as waiting, with the question the sub-agent asked", () => {
	expect(
		host(todo({ status: "waiting", questionId: "q1", question: "どの曲調?" })),
	).toEqual({
		id: "w1",
		title: "夜のドライブ向けの曲を作って",
		status: "waiting",
		question: "どの曲調?",
		requestedAt: 200,
	});
	// One line, bounded: a long or multi-line question never fills the prompt.
	const asked = host(
		todo({ status: "waiting", question: `一行目\n二行目 ${"あ".repeat(300)}` }),
	);
	const line = asked?.status === "waiting" ? asked.question! : "";
	expect(line.startsWith("一行目 二行目 あ")).toBe(true);
	expect(line.endsWith("…")).toBe(true);
	expect(line.length).toBe(TODO_RESULT_CHARS);
});

test("a finished TODO is offered as done with how it ended, its one-line result and when it finished", () => {
	expect(
		host(
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
	expect(host(todo({ status: "done", outcome: "partial" }))?.outcome).toBe(
		"partial",
	);
	expect(host(todo({ status: "done", outcome: "failed" }))?.outcome).toBe(
		"failed",
	);
	expect(host(todo({ status: "done" }))?.outcome).toBe("failed");
	// Without a result the TODO still reports; the line is left out, never invented.
	expect(host(todo({ status: "done", outcome: "failed" }))).not.toHaveProperty(
		"result",
	);
});

test("work the user cancelled is not reported back to the agency", () => {
	expect(host(todo({ status: "done", outcome: "cancelled" }))).toBeNull();
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
		resources: lookup,
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

test("the title names the toolchain the work went to, within the title length", () => {
	expect(host(todo({ toolchainTitle: "画像の作成" }))?.title).toBe(
		"[画像の作成] 夜のドライブ向けの曲を作って",
	);
	const long = host(
		todo({ toolchainTitle: "画像の作成", title: "あ".repeat(100) }),
	)!.title;
	expect(long.length).toBe(TODO_TITLE_CHARS);
	expect(long.startsWith("[画像の作成] あ")).toBe(true);
});

test("a finished TODO lists what the host can do with what it made: the kind's default first, repeats dropped", () => {
	const done = (links: Array<{ uri: string; kind: string; label: string }>) =>
		host(todo({ status: "done", outcome: "succeeded", links }));
	const image = { uri: "eumenes://image/i1", kind: "image", label: "夜景" };
	const track = {
		uri: "eumenes://music.track/m1",
		kind: "music.track",
		label: "曲",
	};
	const report = { uri: "eumenes://report/r1", kind: "report", label: "調査" };
	expect(done([image])?.nextActions).toEqual(["表示する"]);
	expect(done([track])?.nextActions).toEqual(["再生する", "表示する"]);
	expect(done([image, track])?.nextActions).toEqual(["表示する", "再生する"]);
	expect(done([report])?.nextActions).toEqual(["内容を伝える", "表示する"]);
	// Nothing made, or a kind that is not registered: no next action is offered.
	expect(done([])).not.toHaveProperty("nextActions");
	expect(
		done([{ uri: "eumenes://x/1", kind: "x", label: "?" }]),
	).not.toHaveProperty("nextActions");
	// An open TODO has none to offer yet.
	expect(host(todo({ links: [image] }))).not.toHaveProperty("nextActions");
});

test("the agency never sees a resource URI: the result line names it by its label", () => {
	const made = {
		status: "done" as const,
		outcome: "succeeded" as const,
		links: [{ uri: "eumenes://image/i1", kind: "image", label: "夜景" }],
	};
	expect(
		host(todo({ ...made, result: { image: "eumenes://image/i1", n: 1 } }))
			?.result,
	).toBe('{"image":"夜景","n":1}');
	expect(
		host(todo({ ...made, result: { summary: "eumenes://image/zzz を作った" } }))
			?.result,
	).toBe("リソース を作った");
});
