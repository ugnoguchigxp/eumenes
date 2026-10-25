import { afterEach, expect, test } from "bun:test";
import { caseSchema } from "../../eval/context/case-schema";
import {
	type Materialized,
	applySeed,
	generationTime,
	materialize,
} from "../../eval/context/materialize";
import { messageIssues } from "../../eval/context/message-invariants";
import { promptHash } from "../../eval/context/prefix-stability";
import { createSession } from "../../eval/context/session";
import { FIXED_TRIGGER_TEXT } from "../../service/context-system";
import { makeCase } from "./case-fixtures";
import { openSeedWiring } from "./store-wiring";
import { sectionLines } from "../generation.fixture";

const open: Materialized[] = [];
afterEach(async () => {
	for (const m of open.splice(0)) await m.close();
});
const prepared = async (testCase: Parameters<typeof materialize>[0]) => {
	const m = await materialize(testCase, await openSeedWiring());
	open.push(m);
	return m;
};
/** The material document (the second message) of a materialized case. */
const docOf = (m: Materialized): string => m.input.messages[1]!.content;
/** The lines of one tagged section of the material document. */
const sect = (m: Materialized, name: string) => sectionLines(docOf(m), name);
/** The lines of the `<now>` block (the third message). */
const nowOf = (m: Materialized) =>
	sectionLines(m.input.messages[2]!.content, "now");

const T = (minute: number) =>
	new Date(Date.UTC(2026, 9, 12, 0, minute)).toISOString();
const user = (minute: number, text: string, key?: string) => ({
	type: "said",
	by: "user",
	at: T(minute),
	text,
	...(key ? { key } : {}),
});
const agent = (minute: number, text: string, extra = {}) => ({
	type: "said",
	by: "agent",
	at: T(minute),
	text,
	origin: "reply",
	...extra,
});

const fullCase = caseSchema.parse({
	id: "ctx-f1-dev-01",
	family: "F1",
	split: "dev",
	seed: {
		persona: { agentName: "", userName: "", persona: "maid" },
		longTerm: [
			{ kind: "preference", key: "food.spicy", text: "辛い物が好き" },
			{ kind: "habit", key: "food.noodle", text: "昼は麺を食べる" },
			{
				kind: "constraint",
				key: "notify.night",
				text: "夜は通知を控える",
				published: false,
			},
		],
		tendencies: [
			{ text: "刺激の強い食事を好む傾向", from: ["food.spicy", "food.noodle"] },
		],
		notes: [
			{ kind: "decision", text: "旅行は十一月" },
			{ kind: "memo", text: "来週は出張" },
		],
		episode: [
			{
				kind: "summary",
				text: "旅行先は京都に決まった",
				events: [user(0, "旅行先は？"), agent(1, "京都です")],
			},
			{ kind: "unsummarized", events: [user(2, "どの季節がいい？")] },
		],
		events: [
			user(10, "宿を調べて", "ask"),
			{
				type: "acted",
				at: T(11),
				fields: { action: "delegate", toolchain: "web_research", todo: "@w1" },
			},
			agent(12, "調べますね。", { origin: "announcement" }),
			agent(30, "そういえば、紅葉が見頃です。夜は", {
				origin: "spontaneous",
				heard: "partial",
				deliveredText: "そういえば、紅葉が見頃です。",
				about: ["@ask"],
			}),
			agent(31, "いま話しているところ", { heard: null, speaking: true }),
		],
		work: [
			{
				key: "w1",
				toolchain: "web_research",
				request: "宿の候補を調べる",
				at: T(11),
				updatedAt: T(20),
				status: "done",
				outcome: "succeeded",
				result: { claims: [{ text: "三件見つかった" }] },
			},
			{
				key: "w2",
				toolchain: "image_studio",
				request: "海の絵を描く",
				at: T(11),
				updatedAt: T(21),
				status: "done",
				outcome: "succeeded",
				result: { claims: [] },
				archived: true,
			},
		],
		confirmations: [
			{
				toolchain: "code_workspace",
				request: "設定を書き換える",
				impact: "modify_existing",
			},
		],
		pending: [{ at: T(40), text: "もう一つ" }],
		goals: [{ text: "来週までに資料を作る", priority: 70 }],
		world: [{ name: "音声サービス" }],
		notices: ["メモの保存に失敗しました"],
		agencyInterests: ["紅葉の名所"],
	},
	input: "最新の質問",
	expect: {
		checks: [{ kind: "brief_spoken_reply" }],
		rubric: [{ axis: "follows_current_request", condition: "x" }],
	},
});

test("a case becomes the production messages: system, the material document, <now>, then the newest utterances", async () => {
	const m = await prepared(fullCase);
	expect(messageIssues(m.input)).toEqual([]);
	expect(m.input.messages.map((message) => message.role)).toEqual([
		"system",
		"user",
		"user",
		"user",
		"user",
	]);
	expect(m.input.messages[2]!.content.startsWith("<now>\n")).toBe(true);
	// The pending utterance and the input, each its own message, with times because there are several.
	const newest = m.input.messages.slice(3).map((message) => message.content);
	expect(newest[0]).toMatch(/^\[.+\] もう一つ$/);
	expect(newest[1]).toMatch(/^\[.+\] 最新の質問$/);
	expect(m.input.final.kind).toBe("utterances");
	// The four tagged sections, in the layout's order (memory, history, log, state).
	const order = ["<memory>", "<history>", "<log>", "<state>"].map((tag) =>
		docOf(m).indexOf(tag),
	);
	expect(order.every((at) => at >= 0)).toBe(true);
	expect([...order].sort((a, b) => a - b)).toEqual(order);
});

test("State goes through the memory service: the published profile, a waiting memory, tendencies and notes", async () => {
	const m = await prepared(fullCase);
	const memory = sect(m, "memory").join("\n");
	expect(memory).toContain("辛い物が好き");
	expect(memory).toContain("刺激の強い食事を好む傾向");
	expect(memory).not.toContain("夜は通知を控える");
	const state = sect(m, "state");
	expect(
		state.some((line) => /^n\d+ 反映待ちの記憶 .*夜は通知を控える/.test(line)),
	).toBe(true);
	expect(state).toContain("m1 決定 旅行は十一月");
	expect(state.some((line) => line.startsWith("m2 メモ 来週は出張"))).toBe(
		true,
	);
	expect(nowOf(m)).toContain("agency 紅葉の名所");
	// The recall is gone: no earlier exchange is put in the prompt by the host.
	expect(
		m.input.messages.map((message) => message.content).join("\n"),
	).not.toContain("京都です");
	expect(state).toContain("g1 目標 来週までに資料を作る");
	expect(nowOf(m).join("\n")).toContain("音声サービス");
});

test("the log carries the events as lines, a partial delivery with its delivered text, and what is being spoken", async () => {
	const m = await prepared(fullCase);
	const log = sect(m, "log");
	// The spontaneous utterance is a line of its own; its partial delivery is a line that gives the heard text.
	const spontaneous = log.find((line) =>
		line.includes("自分（自分から）: そういえば、紅葉が見頃です。"),
	);
	expect(spontaneous).toBeDefined();
	const id = spontaneous!.split(" ")[0]!;
	// The delivery is a line of its own: it refers to the utterance by its number.
	expect(
		log.some((line) =>
			line.endsWith(`届かず ${id} 途中まで「そういえば、紅葉が見頃です。」`),
		),
	).toBe(true);
	// The utterance still being delivered is named in <now>; it has no delivered line yet.
	const speaking = log.find((line) =>
		line.endsWith("自分: いま話しているところ"),
	)!;
	expect(nowOf(m)).toContain(`話し中 ${speaking.split(" ")[0]}`);
	// The delegation is a line naming the TODO it opened.
	expect(log.some((line) => /依頼 t1 web_research/.test(line))).toBe(true);
	// Handled events precede the pending ones: those are the newest messages, not in the log.
	expect(log.join("\n")).not.toContain("もう一つ");
	expect(
		nowOf(m).some((line) => line.startsWith("きっかけ 利用者の発言 ")),
	).toBe(true);
	// The memory request's outcome is a log line of its own (the steward's notice).
	expect(
		log.some((line) =>
			line.endsWith("記憶の依頼の結果: メモの保存に失敗しました"),
		),
	).toBe(true);
});

test("earlier history is the episode: a summary and an unsummarized mark; its events are gone from the log", async () => {
	const m = await prepared(fullCase);
	const history = sect(m, "history");
	expect(history).toHaveLength(2);
	expect(history[0]).toMatch(/^s1 .*旅行先は京都に決まった$/);
	expect(history[1]).toMatch(/^s2 .* 要約なし（1件/);
	const log = sect(m, "log").join("\n");
	expect(log).not.toContain("旅行先は？");
	expect(log).not.toContain("どの季節がいい？");
});

test("TODOs come from the work ledger: open ones in state, results as log lines, the archived gone, a confirmation pending, the toolchain retained", async () => {
	const m = await prepared(fullCase);
	const state = sect(m, "state");
	const todos = state.filter((line) => /^t\d+ /.test(line));
	expect(todos).toHaveLength(1);
	expect(todos[0]).toMatch(
		/^t1 完了 宿の候補を調べる \(成功, 結果 e\d+, 未伝達\)$/,
	);
	const results = sect(m, "log").filter((line) => /結果 t1 成功: /.test(line));
	expect(results).toHaveLength(1);
	expect(results[0]).toContain("三件見つかった");
	expect(state.join("\n")).not.toContain("海の絵を描く");
	expect(state).toContain(
		"c1 確認待ち code_workspace「設定を書き換える」(変更)",
	);
	expect(state.some((line) => line.startsWith("担当 web_research "))).toBe(
		true,
	);
	expect(state.some((line) => line.startsWith("担当 image_studio "))).toBe(
		true,
	);
	expect(m.input.shown.todos).toHaveLength(1);
});

test("a generation without an utterance shows the host's fixed text and the trigger with the TODO's number", async () => {
	const testCase = makeCase("ctx-f12-dev-01", null, {
		seed: {
			events: [user(0, "調べて", "ask")],
			work: [
				{
					key: "w1",
					toolchain: "web_research",
					request: "調べる",
					at: T(1),
					status: "done",
					outcome: "succeeded",
					result: {},
				},
			],
		} as never,
		trigger: { kind: "todo_changed", todos: [{ id: "@w1", status: "done" }] },
		expect: {
			checks: [{ kind: "speaks" }],
			rubric: [{ axis: "speech_judgment", condition: "x" }],
		},
	});
	const m = await prepared(testCase);
	expect(m.input.final).toEqual({ kind: "fixed" });
	expect(m.input.messages.at(-1)).toEqual({
		role: "user",
		content: FIXED_TRIGGER_TEXT,
	});
	expect(nowOf(m)).toContain("きっかけ 仕事の変化 t1 完了");
	// The user's utterance was handled: it is a line of the log, not a newest message.
	expect(sect(m, "log").some((line) => line.endsWith("利用者: 調べて"))).toBe(
		true,
	);
});

test("the document is deterministic and replaces only markup characters and line breaks of outside text", async () => {
	const testCase = makeCase(
		"ctx-f1-dev-01",
		"これは <b>テスト</b> & 確認 です",
	);
	const a = await prepared(testCase);
	const b = await prepared(testCase);
	expect(promptHash(a.input.messages)).toBe(promptHash(b.input.messages));
	// The utterance itself is the newest message, as the user said it.
	expect(a.input.messages.at(-1)!.content).toContain("<b>");
	// The document's own tags are the only angle brackets it shows.
	expect(docOf(a)).not.toContain("<b>");
	const withMemory = await prepared(
		makeCase("ctx-f1-dev-02", "あ", {
			seed: {
				longTerm: [
					{
						kind: "preference",
						key: "k",
						text: "紅茶は<熱め>が好き",
						published: true,
					},
				],
			},
		}),
	);
	// Outside text in a line: `<` and `>` become full-width, so they can not forge a tag.
	expect(sect(withMemory, "memory").join("\n")).toContain(
		"紅茶は＜熱め＞が好き",
	);
});

test("a window the plan cannot use stops the case, and the store is closed", async () => {
	let closed = 0;
	const real = await openSeedWiring();
	const wiring = {
		...real,
		close: async () => {
			closed++;
			await real.close();
		},
	};
	const tiny = makeCase("ctx-f1-dev-01", "あ", { seed: { modelWindow: 2000 } });
	await expect(materialize(tiny, wiring)).rejects.toThrow(
		"context_eval_prepare_stale:window_too_small",
	);
	expect(closed).toBe(1);
});

test("a seed that fails to write closes the store before the error propagates", async () => {
	let closed = 0;
	const real = await openSeedWiring();
	const wiring = {
		...real,
		close: async () => {
			closed++;
			await real.close();
		},
	};
	const broken = makeCase("ctx-f1-dev-01", "あ", {
		seed: {
			tendencies: [{ text: "t", from: ["k", "k2"] }],
			longTerm: [{ kind: "preference", key: "k", text: "t", published: false }],
		},
	});
	await expect(materialize(broken, wiring)).rejects.toThrow();
	expect(closed).toBe(1);
});

test("the generation time is just after the newest thing the seed records", () => {
	expect(generationTime({})).toBe("2026-10-13T00:00:01.000Z");
	expect(
		generationTime({
			events: [user(0, "a") as never, user(30, "b") as never],
			pending: [{ at: T(45), text: "c" }],
		}),
	).toBe(new Date(Date.parse(T(45)) + 1000).toISOString());
});

test("a generation after a long silence re-constructs the window first, and says why", async () => {
	const wiring = await openSeedWiring();
	try {
		const session = createSession(wiring);
		const seed = caseSchema.parse({
			...fullCase,
			seed: { events: [user(0, "こんにちは"), agent(1, "はい")] },
			input: "x",
		}).seed;
		await applySeed(session, seed, T(2));
		const first = await session.generate({ at: T(3), utterance: "一つ目" });
		expect(first.reconstruction).toBeNull();
		await session.settle(first, { text: "どうぞ" });
		const later = await session.generate({
			at: new Date(Date.parse(T(3)) + 3 * 3_600_000).toISOString(),
			utterance: "三時間後",
		});
		expect(later.reconstruction).toMatchObject({ reason: "resumed" });
		// The handled utterance joined the log in receipt order, after the earlier events.
		const log = sectionLines(later.input.messages[1]!.content, "log");
		const at = (pattern: RegExp) => log.findIndex((line) => pattern.test(line));
		const positions = [
			at(/利用者: こんにちは$/),
			at(/自分: はい$/),
			at(/利用者: 一つ目$/),
			at(/自分: どうぞ$/),
		];
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
	} finally {
		await wiring.close();
	}
});
