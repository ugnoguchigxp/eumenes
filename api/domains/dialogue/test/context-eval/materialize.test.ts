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
/** The last message of a materialized case: `## State`, then `## Host notice` or `## User`. */
const lastOf = (m: Materialized): string => m.input.messages.at(-1)!.content;
/** The lines of one `## ` section of the last message. */
const sect = (m: Materialized, heading: string) =>
	sectionLines(lastOf(m), heading);
/** The `## Memory` lines (its own message, or the head of the last one). */
const memoryOf = (m: Materialized) =>
	m.input.messages.flatMap((message) =>
		sectionLines(message.content, "Memory"),
	);
/** The recent conversation: every message between the system part and the last one. */
const recentOf = (m: Materialized) =>
	m.input.messages
		.slice(1, -1)
		.filter((message) => !message.content.startsWith("## Memory\n"));
/** Every message as text. */
const allOf = (m: Materialized) =>
	m.input.messages.map((message) => message.content).join("\n");

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

test("a case becomes the production messages: the system part, the recent conversation, then State and the user's words", async () => {
	const m = await prepared(fullCase);
	expect(messageIssues(m.input)).toEqual([]);
	expect(m.input.messages[0]!.role).toBe("system");
	expect(m.input.final.kind).toBe("utterances");
	// The pending utterance and the input, one line each in `## User`, as they were said.
	expect(sect(m, "User")).toEqual(["もう一つ", "最新の質問"]);
	expect(lastOf(m)).toStartWith("## State\n今: ");
});

test("`## Memory` is the published leanings: a waiting memory, the notes, goals and World are not in the input", async () => {
	const m = await prepared(fullCase);
	const memory = memoryOf(m).join("\n");
	expect(memory).toContain("辛い物が好き（本人の発言）");
	expect(memory).toContain("刺激の強い食事を好む傾向（観察）");
	expect(memory).not.toContain("夜は通知を控える");
	const all = allOf(m);
	for (const absent of [
		"旅行は十一月",
		"来週は出張",
		"来週までに資料を作る",
		"音声サービス",
	])
		expect(all).not.toContain(absent);
	// Nothing older than the cut is put in by the host: the history toolchain reads it.
	expect(all).not.toContain("京都です");
});

test("the recent conversation is what reached the user: a partial delivery as heard, nothing being spoken, no notice or tool line", async () => {
	const m = await prepared(fullCase);
	const recent = recentOf(m);
	expect(recent.map((message) => message.role)).toEqual(["assistant"]);
	// The announcement and the spontaneous utterance, joined as one run of the agent's; the heard part only.
	expect(recent[0]!.content).toBe("調べますね。\nそういえば、紅葉が見頃です。");
	const all = allOf(m);
	expect(all).not.toContain("いま話しているところ");
	expect(all).not.toContain("メモの保存に失敗しました");
	expect(all).not.toContain("web_research「");
	// The first user utterance came before any of the agent's: the recent conversation starts with the agent.
	expect(recent.some((message) => message.content === "宿を調べて")).toBe(
		false,
	);
});

test("TODOs and confirmations come from the work ledger as lines of `## State`", async () => {
	const m = await prepared(fullCase);
	const state = sect(m, "State");
	expect(state).toContain("- t1 宿の候補を調べる 完了 未報告");
	expect(state).toContain(
		"- c1 確認待ち code_workspace「設定を書き換える」（変更）",
	);
	expect(state.join("\n")).not.toMatch(/海の絵を描く 完了 未報告/);
	// No result is shown in this input: nothing it shows may be reported with its sources.
	expect(m.input.shown.todos).toEqual([]);
});

test("a generation without an utterance answers a host notice, with the TODO in `## State`", async () => {
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
	expect(sect(m, "Host notice")).toEqual(["- kind: todo_changed"]);
	expect(sect(m, "User")).toEqual([]);
	expect(sect(m, "State")).toContain("- t1 調べる 完了 未報告");
});

test("the input is deterministic, and outside text keeps its characters but can not open a heading", async () => {
	const testCase = makeCase(
		"ctx-f1-dev-01",
		"これは <b>テスト</b> & 確認\u2028# です",
	);
	const a = await prepared(testCase);
	const b = await prepared(testCase);
	expect(promptHash(a.input.messages)).toBe(promptHash(b.input.messages));
	expect(sect(a, "User")).toEqual(["これは <b>テスト</b> & 確認", "\\# です"]);
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
	expect(memoryOf(withMemory).join("\n")).toContain("紅茶は<熱め>が好き");
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

test("a generation after a long silence cuts the recent conversation to the newest few first, and says why", async () => {
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
		expect(first.cut).toBeNull();
		await session.settle(first, { text: "どうぞ" });
		const later = await session.generate({
			at: new Date(Date.parse(T(3)) + 3 * 3_600_000).toISOString(),
			utterance: "三時間後",
		});
		expect(later.cut).toMatchObject({ reason: "resumed" });
		// The newest four from an agent's utterance stay, in the order they were said.
		expect(later.input.messages.slice(2, -1).map((m) => m.content)).toEqual([
			"はい",
			"一つ目",
			"どうぞ",
		]);
		expect(
			sectionLines(later.input.messages.at(-1)!.content, "State")[0],
		).toMatch(/（前の発言から3時間）$/);
	} finally {
		await wiring.close();
	}
});
