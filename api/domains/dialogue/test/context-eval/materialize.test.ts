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

const open: Materialized[] = [];
afterEach(async () => {
	for (const m of open.splice(0)) await m.close();
});
const prepared = async (testCase: Parameters<typeof materialize>[0]) => {
	const m = await materialize(testCase, await openSeedWiring());
	open.push(m);
	return m;
};
type Doc = Record<string, any>;
const docOf = (m: Materialized): Doc =>
	JSON.parse(m.input.messages[1]!.content) as Doc;

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
		recall: [{ at: T(5), user: "旅行は？", assistant: "京都です" }],
	},
	input: "最新の質問",
	expect: {
		checks: [{ kind: "brief_spoken_reply" }],
		rubric: [{ axis: "follows_current_request", condition: "x" }],
	},
});

test("a case becomes the production messages: system, the material document, then the newest utterances", async () => {
	const m = await prepared(fullCase);
	expect(messageIssues(m.input)).toEqual([]);
	const [system, doc, ...newest] = m.input.messages;
	expect(system!.role).toBe("system");
	expect(doc!.role).toBe("user");
	// The pending utterance and the input, each its own message, with times because there are several.
	expect(newest).toHaveLength(2);
	expect(newest[0]!.content).toMatch(/^\[.+\] もう一つ$/);
	expect(newest[1]!.content).toMatch(/^\[.+\] 最新の質問$/);
	expect(m.input.final.kind).toBe("utterances");
	expect(Object.keys(docOf(m))).toEqual([
		"profile",
		"episode",
		"log",
		"active",
		"state",
		"now",
		"work",
	]);
});

test("State goes through the memory service: the published profile, a waiting memory, tendencies and notes", async () => {
	const m = await prepared(fullCase);
	const doc = docOf(m);
	const profile = JSON.stringify(doc.profile);
	expect(profile).toContain("辛い物が好き");
	expect(profile).toContain("刺激の強い食事を好む傾向");
	expect(profile).not.toContain("夜は通知を控える");
	expect(JSON.stringify(doc.state.newMemories)).toContain("夜は通知を控える");
	expect(doc.state.decisions.map((d: { text: string }) => d.text)).toEqual([
		"旅行は十一月",
	]);
	expect(doc.state.notes.map((d: { text: string }) => d.text)).toEqual([
		"来週は出張",
	]);
	expect(doc.now.notices).toEqual(["メモの保存に失敗しました"]);
	expect(doc.now.agency).toEqual(["紅葉の名所"]);
	expect(JSON.stringify(doc.now.recall)).toContain("京都です");
	expect(JSON.stringify(doc.state.goals)).toContain("来週までに資料を作る");
	expect(JSON.stringify(doc.now.records)).toContain("音声サービス");
});

test("the log carries the events as appended, a partial delivery with its delivered text, and what is being spoken", async () => {
	const m = await prepared(fullCase);
	const doc = docOf(m);
	const log = doc.log as Array<Record<string, any>>;
	const spontaneous = log.find((e) => e.origin === "spontaneous")!;
	const delivered = log.find(
		(e) => e.type === "delivered" && e.ref === spontaneous.id,
	)!;
	expect(delivered).toMatchObject({
		heard: "partial",
		deliveredText: "そういえば、紅葉が見頃です。",
	});
	expect(spontaneous.about).toEqual([
		log.find((e) => e.text === "宿を調べて")!.id,
	]);
	// The utterance still being delivered is named in `now`; it has no delivered event yet.
	const speaking = log.find((e) => e.text === "いま話しているところ")!;
	expect(doc.now.speaking).toBe(speaking.id);
	// The announced work is the TODO the delegation names.
	const acted = log.find((e) => e.type === "acted")!;
	expect(acted.todo).toBe(doc.state.todos[0].id);
	// Handled events precede the pending ones: those are the newest messages, not in the log.
	expect(JSON.stringify(log)).not.toContain("もう一つ");
	expect(doc.now.trigger).toEqual([
		{ kind: "utterance", events: expect.any(Array) },
	]);
});

test("earlier history is the episode: a summary and an unsummarized mark; its events are gone from the log", async () => {
	const m = await prepared(fullCase);
	const doc = docOf(m);
	expect(doc.episode.map((s: { kind: string }) => s.kind)).toEqual([
		"summary",
		"unsummarized",
	]);
	expect(doc.episode[0]).toMatchObject({
		text: "旅行先は京都に決まった",
		count: 3,
	});
	expect(JSON.stringify(doc.log)).not.toContain("旅行先は？");
	expect(JSON.stringify(doc.log)).not.toContain("どの季節がいい？");
});

test("TODOs come from the work ledger: open ones in state, results in active, the archived gone, a confirmation pending, the toolchain retained", async () => {
	const m = await prepared(fullCase);
	const doc = docOf(m);
	expect(doc.state.todos).toHaveLength(1);
	expect(doc.state.todos[0]).toMatchObject({
		title: "宿の候補を調べる",
		status: "done",
		outcome: "succeeded",
	});
	expect(doc.active).toHaveLength(1);
	expect(doc.active[0]).toMatchObject({
		todo: doc.state.todos[0].id,
		status: "done",
		authority: "host_record",
		certainty: "unverified",
	});
	expect(JSON.stringify(doc.active[0])).toContain("三件見つかった");
	expect(JSON.stringify(doc.state.todos)).not.toContain("海の絵を描く");
	expect(doc.state.pendingConfirmation).toEqual([
		expect.objectContaining({
			toolchain: "code_workspace",
			impact: "modify_existing",
		}),
	]);
	expect(doc.state.retained.map((r: { id: string }) => r.id).sort()).toEqual([
		"image_studio",
		"web_research",
	]);
	expect(m.input.shown.todos).toEqual([doc.state.todos[0].id]);
});

test("a generation without an utterance shows the host's fixed text and the trigger with resolved ids", async () => {
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
	expect(m.input.messages.slice(2)).toEqual([
		{ role: "user", content: FIXED_TRIGGER_TEXT },
	]);
	const doc = docOf(m);
	expect(doc.now.trigger).toEqual([
		{
			kind: "todo_changed",
			todos: [{ id: doc.state.todos[0].id, status: "done" }],
		},
	]);
	// The user's utterance was handled: it is in the log, not a newest message.
	expect(doc.log[0]).toMatchObject({
		type: "said",
		by: "user",
		text: "調べて",
	});
});

test("the document is deterministic and escapes only markup characters and line separators", async () => {
	const testCase = makeCase(
		"ctx-f1-dev-01",
		"これは <b>テスト</b> & 確認\u2028です",
	);
	const a = await prepared(testCase);
	const b = await prepared(testCase);
	expect(promptHash(a.input.messages)).toBe(promptHash(b.input.messages));
	const text = a.input.messages[1]!.content;
	expect(text).not.toMatch(/[<>&\u2028]/);
	expect(a.input.messages[2]!.content).toContain("<b>");
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
	const profile = withMemory.input.messages[1]!.content;
	expect(profile).toContain("紅茶は");
	expect(profile).toContain("\\u003c熱め\\u003e");
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
		const log = JSON.parse(later.input.messages[1]!.content).log as Array<{
			text?: string;
		}>;
		expect(log.map((e) => e.text).filter(Boolean)).toEqual([
			"こんにちは",
			"はい",
			"一つ目",
			"どうぞ",
		]);
	} finally {
		await wiring.close();
	}
});
