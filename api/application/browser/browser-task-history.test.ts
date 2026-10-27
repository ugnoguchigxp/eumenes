import { afterEach, expect, test } from "bun:test";
import {
	approvalRows,
	begin,
	cleanup,
	ended,
	finish,
	invoke,
	lastResult,
	onPage,
	OWNER,
	setup,
	start,
	tag,
	type Message,
	type S,
} from "./browser-task.fixture";

afterEach(cleanup);

const KEYWORD = "猫 癒し";
const variables = (value: string) => [
	{ name: "keyword", label: "検索語", value },
];
const script = (extra: Record<string, unknown> = {}, value = KEYWORD) =>
	invoke("browser.page.script", {
		expectedRevision: 0,
		title: "動画を検索して再生する",
		summary: `${value}で検索します`,
		variables: variables(value),
		steps: [{ label: "検索する", expectation: "結果が出る", state: "running" }],
		...extra,
	});
const typeVariable = onPage("browser.page.type", () => ({
	ref: "e2",
	element: "検索ボックス",
	variable: "keyword",
	purpose: "検索",
	submit: false,
}));
const reference = (messages: Message[]) =>
	tag(
		messages.find((m) => m.content.includes("REFERENCE="))!.content,
		"REFERENCE",
	);
const histories = (s: S) => s.service.listHistories(OWNER);

test("a finished search becomes a history; the next run reads it, follows it and types its variable without asking", async () => {
	const s = await setup([
		script(),
		typeVariable,
		finish("再生しました。"),
		// The second run: the catalog is in REFERENCE and the tool reads the procedure.
		(messages) => {
			const entry = reference(messages).history[0];
			expect(entry).toMatchObject({
				title: "動画を検索して再生する",
				request: "{{keyword}}の動画を再生して",
				variables: [{ name: "keyword", label: "検索語" }],
				steps: ["検索する"],
				runs: 1,
				lastOutcome: "completed",
			});
			return invoke("browser.page.history", { historyId: entry.historyId });
		},
		(messages) => {
			const read = lastResult(messages);
			expect(read.ok).toBe(true);
			expect(read.history).toMatchObject({
				title: "動画を検索して再生する",
				variables: [{ name: "keyword", label: "検索語" }],
				actions: [
					{ seq: 1, kind: "type", step: "検索する", variable: "keyword" },
				],
			});
			expect(JSON.stringify(read)).not.toContain(KEYWORD);
			return script(
				{ historyId: read.history.historyId, summary: "犬で検索します" },
				"犬",
			);
		},
		typeVariable,
		finish("再生しました。"),
	]);
	const first = await start(s, { request: `${KEYWORD}の動画を再生して` });
	await ended(s, first.taskId);
	expect(s.service.taskStatus(OWNER, first.taskId).state).toBe("completed");
	expect(s.typed).toEqual([KEYWORD]);
	expect(histories(s)).toHaveLength(1);
	const id = histories(s)[0]!.historyId;

	const second = await begin(s, first.tabRef, {
		request: "おすすめの動画を再生して",
	});
	await ended(s, second);
	const done = s.service.taskStatus(OWNER, second);
	expect(done.state).toBe("completed");
	// "犬" is not in the request, yet it was typed with no approval: the history allowed it.
	expect(s.typed).toEqual([KEYWORD, "犬"]);
	expect(approvalRows(s)).toEqual([]);
	expect(done.history).toEqual({
		historyId: id,
		title: "動画を検索して再生する",
	});
	expect(histories(s)).toHaveLength(1);
	expect(histories(s)[0]).toMatchObject({ revision: 2, runCount: 2 });
	const stored = JSON.stringify(
		s.store.read((db) => db.query("SELECT * FROM browser_histories").all()),
	);
	expect(stored).not.toContain("犬");
	expect(stored).not.toContain(KEYWORD);
});

test("the first time, a variable value the request does not contain is shown to the user before it is typed", async () => {
	const s = await setup([script({}, "犬"), typeVariable, finish("届かない")]);
	const { taskId } = await start(s, { request: "おすすめの動画を再生して" });
	await ended(s, taskId);
	expect(s.service.taskStatus(OWNER, taskId).state).toBe("needs_input");
	expect(s.typed).toEqual([]);
	const row = s.store.read((db) =>
		db
			.query(
				"SELECT kind,status,value,variable FROM browser_approvals WHERE kind='input_value'",
			)
			.get(),
	);
	expect(row).toEqual({
		kind: "input_value",
		status: "pending",
		value: "犬",
		variable: "keyword",
	});
	expect(histories(s)).toHaveLength(0);
});

test("a variable the Script does not declare, an unknown history and a title with a value are refusals the model can answer", async () => {
	const s = await setup([
		typeVariable,
		(messages) => {
			expect(lastResult(messages)).toMatchObject({
				ok: false,
				error: "script_variable_unknown",
			});
			return invoke("browser.page.history", {
				historyId: crypto.randomUUID(),
			});
		},
		(messages) => {
			expect(lastResult(messages)).toMatchObject({
				ok: false,
				error: "browser_history_not_found",
			});
			return script({ title: `${KEYWORD}を検索する` });
		},
		(messages) => {
			expect(lastResult(messages)).toMatchObject({
				ok: false,
				error: "script_title_has_value",
			});
			return finish("終わります。");
		},
	]);
	const { taskId } = await start(s, { request: `${KEYWORD}の動画` });
	await ended(s, taskId);
	expect(s.service.taskStatus(OWNER, taskId).state).toBe("completed");
});

test("the operator is offered the history tool, and the type tool offers a variable but no input ref until the user approved a value", async () => {
	const s = await setup([finish("見ました。")]);
	const { taskId } = await start(s);
	await ended(s, taskId);
	const [system] = s.model.state.calls[0]!;
	const tools = JSON.parse(
		system!.content
			.split("\n")
			.find((line) => line.startsWith("TOOLS="))!
			.slice(6),
	) as Array<{
		id: string;
		inputSchema: { properties: Record<string, unknown> };
	}>;
	expect(tools.map((t) => t.id)).toContain("browser.page.history");
	const type = tools.find((t) => t.id === "browser.page.type")!;
	expect(Object.keys(type.inputSchema.properties)).toEqual(
		expect.arrayContaining(["variable", "value", "quote"]),
	);
	expect(type.inputSchema.properties).not.toHaveProperty("inputValueRef");
	const script = tools.find((t) => t.id === "browser.page.script")!;
	expect(Object.keys(script.inputSchema.properties)).toEqual(
		expect.arrayContaining(["title", "historyId", "variables"]),
	);
	// Without a history REFERENCE has no catalog.
	expect(reference(s.model.state.calls[0]!)).not.toHaveProperty("history");
});
