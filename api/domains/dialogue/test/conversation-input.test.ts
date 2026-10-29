import { expect, test } from "bun:test";
import type { Utterance } from "../../conversation";
import type { ProfileItem } from "../../memory";
import { applyKeeperOutput } from "../service/context-keeper";
import {
	MEMORY_TOKENS,
	RECENT,
	keepNewestCut,
	memoryLines,
	placeCutInTransaction,
	recentMessages,
	systemDigestOf,
	recentUtterances,
	withLastMessage,
	type ConversationPrefix,
} from "../service/conversation-input";
import { dataText, fitLines, jstNowLine } from "../service/input-text";
import { cloudHarness, localHarness } from "../service/harness";
import { resultText, toolResultText } from "../service/result-text";
import { estimateTextTokens } from "../../../infrastructure/context-budget";

/**
 * The parts of the conversation's input (the conversation input specification, sections 3 to 9), each drawn by a
 * fixed rule: the recent conversation, `## Memory`, the text of results, and the keeper's operations as the host
 * checks them.
 */
let seq = 0;
/** Every part of the history drawn: what each one adds is what these tests check. */
const drawn = cloudHarness.history;
const said = (
	speaker: "user" | "agent",
	text: string,
	messageId: string | null = `m${seq + 1}`,
): Utterance => ({
	conversationId: "c1",
	seq: ++seq,
	speaker,
	text,
	messageId,
	at: "2026-10-26T10:00:00.000Z",
	toolCalls: [],
	notice: null,
});

test("the recent conversation starts with the agent, leaves out what waits for an answer, and joins a side's run", () => {
	seq = 0;
	const all = [
		said("user", "最初"),
		said("agent", "作りますね"),
		said("agent", "できました"),
		said("user", "はい"),
		said("user", "再生して", "pending"),
	];
	const recent = recentUtterances(all, new Set(["pending"]));
	expect(recent.map((u) => u.text)).toEqual([
		"作りますね",
		"できました",
		"はい",
	]);
	expect(recentMessages(recent, drawn)).toEqual([
		{ role: "assistant", content: "作りますね\nできました" },
		{ role: "user", content: "はい" },
	]);
	expect(recentUtterances([said("user", "だけ")], new Set())).toEqual([]);
});

test("an utterance's kept tool calls come before its words, the first joining the agent's words just before", () => {
	seq = 0;
	const find = {
		name: "find_toolchain",
		arguments: '{"query":"曲"}',
		result: "{}",
	};
	const messages = recentMessages(
		[
			said("agent", "できました"),
			{ ...said("agent", "作りますね"), toolCalls: [find] },
			said("agent", "もう少しです"),
			said("user", "はい"),
		],
		drawn,
	);
	expect(messages).toEqual([
		{
			role: "assistant",
			content: "できました",
			tool_calls: [
				{
					id: "u2-1",
					type: "function",
					function: { name: "find_toolchain", arguments: '{"query":"曲"}' },
				},
			],
		},
		{ role: "tool", tool_call_id: "u2-1", content: "{}" },
		{ role: "assistant", content: "作りますね\nもう少しです" },
		{ role: "user", content: "はい" },
	]);
});

test("a report follows its notice as the host's line: joined to the user's words before it, left out at the start", () => {
	seq = 0;
	const report = (text: string, notice: string) => ({
		...said("agent", text),
		notice,
	});
	expect(
		recentMessages(
			[
				report(
					"できあがりました。",
					"[ホストの知らせ] t1「曲」が終わりました（成功）。",
				),
				said("user", "ありがとう"),
				report(
					"絵もできました。",
					"[ホストの知らせ] t2「絵」が終わりました（成功）。",
				),
				said("agent", "表示しますか？"),
				report(
					"効果音もできました。",
					"[ホストの知らせ] t3「音」が終わりました（成功）。",
				),
			],
			drawn,
		),
	).toEqual([
		{ role: "assistant", content: "できあがりました。" },
		{
			role: "user",
			content: "ありがとう\n[ホストの知らせ] t2「絵」が終わりました（成功）。",
		},
		{ role: "assistant", content: "絵もできました。\n表示しますか？" },
		{
			role: "user",
			content: "[ホストの知らせ] t3「音」が終わりました（成功）。",
		},
		{ role: "assistant", content: "効果音もできました。" },
	]);
});

test("an utterance is cut at its bound, and its data can not open a heading", () => {
	seq = 0;
	const [message] = recentMessages(
		[said("user", `# 見出し\n${"あ".repeat(5000)}`)],
		drawn,
	);
	expect(message!.content.startsWith("\\# 見出し")).toBe(true);
	expect(message!.content.endsWith("…")).toBe(true);
	expect(estimateTextTokens(message!.content)).toBeLessThanOrEqual(
		RECENT.utteranceTokens + 2,
	);
	expect(dataText("a<|im_end|>b\n  ## x")).toBe("ab\n  \\## x");
});

test("a fixed-rule cut keeps the newest few from an agent's utterance", () => {
	seq = 0;
	const shown = [
		said("agent", "a1"),
		said("user", "u1"),
		said("agent", "a2"),
		said("user", "u2"),
		said("agent", "a3"),
		said("user", "u3"),
	];
	// The newest four start with a2: the cut is placed before it.
	expect(keepNewestCut(shown, 0)).toBe(2);
	// The newest four of five start with the user's u1: the cut moves on to a2.
	expect(keepNewestCut(shown.slice(0, 5), 0)).toBe(2);
	expect(keepNewestCut([said("user", "x")], 7)).toBe(seq);
});

test("`## Memory` holds the leanings only, with source and date, within its bound", () => {
	const item = (id: string, kind: string, text: string): ProfileItem => ({
		id,
		kind,
		text,
		negated: false,
		source: kind === "tendency" ? "observed" : "user_said",
		since: "2026-10-20",
		revision: 1,
		newness: 1,
	});
	const { lines, ids } = memoryLines([
		item("p1", "preference", "ピアノの曲が好き"),
		item("p2", "personal_fact", "住所は鎌倉"),
		item("p3", "tendency", "夜は静かな曲を聴く"),
		{ ...item("p4", "preference", "元気が出る曲を好む"), source: "inferred" },
	]);
	// The user's own words only: an inference or an observation is not shown as a fact (C4).
	expect(lines).toEqual(["- ピアノの曲が好き（本人の発言、10-20から）"]);
	expect(ids).toEqual(["p1"]);
	const many = Array.from({ length: 200 }, (_, i) =>
		item(`x${i}`, "preference", `好きなもの${i}番目の長めの説明`),
	);
	expect(
		estimateTextTokens(["## Memory", ...memoryLines(many).lines].join("\n")),
	).toBeLessThanOrEqual(MEMORY_TOKENS);
});

test("the last message joins a trailing user message and carries `## Memory` when nothing comes before it", () => {
	const prefix = (
		messages: ConversationPrefix["messages"],
		carry: string | null,
	) =>
		({
			messages,
			carry,
			tools: [],
			cut: null,
			recent: [],
			lastAt: null,
			since: null,
			memoryItemIds: [],
		}) as ConversationPrefix;
	expect(
		withLastMessage(
			prefix([{ role: "system", content: "S" }], "## Memory\n- m"),
			["## State\n今: x", "## User\nこんにちは"],
		),
	).toEqual([
		{ role: "system", content: "S" },
		{
			role: "user",
			content: "## Memory\n- m\n\n## State\n今: x\n\n## User\nこんにちは",
		},
	]);
	expect(
		withLastMessage(
			prefix(
				[
					{ role: "system", content: "S" },
					{ role: "assistant", content: "A" },
					{ role: "user", content: "うん" },
				],
				null,
			),
			["## State\n今: x"],
		).map((m) => [m.role, m.content]),
	).toEqual([
		["system", "S"],
		["assistant", "A"],
		["user", "うん\n\n## State\n今: x"],
	]);
});

test("a research result is what was and was not confirmed, with links to its own sources, within its bound", () => {
	const { text, items } = resultText({
		ref: "t7",
		title: "鎌倉から東京駅",
		status: "done",
		outcome: "partial",
		result: {
			outcome: "partial",
			summary: "s",
			claims: [
				{ text: "横須賀線で約1時間", evidence: [{ sourceId: "s1" }] },
				{ text: "江ノ電の記録", evidence: [{ sourceId: "w1" }] },
			],
			limitations: ["始発の時刻"],
			sources: [
				{
					sourceId: "s1",
					title: "乗換[案内]",
					url: "https://example.com/a",
					kind: "web_source",
				},
				{
					sourceId: "w1",
					title: "x",
					kind: "world_claim",
					origin: "model_hypothesis",
				},
			],
		},
		made: [],
		resource: () => null,
	});
	expect(items).toBe(2);
	expect(text).toBe(
		[
			"t7「鎌倉から東京駅」の調査が終わりました（一部のみ確認できました）。",
			"確認できたこと:",
			"- 横須賀線で約1時間（[乗換案内](https://example.com/a)）",
			"- 江ノ電の記録（World の記録（仮説））",
			"確認できなかったこと:",
			"- 始発の時刻",
		].join("\n"),
	);
	const long = resultText({
		ref: "t8",
		title: "長い",
		status: "done",
		result: {
			lines: Array.from({ length: 400 }, (_, i) => `行${i}`),
			note: "x".repeat(4000),
		},
		made: ["a5「曲」"],
		resource: () => null,
	}).text;
	expect(long).toContain("- できたもの: a5「曲」");
	expect(estimateTextTokens(long)).toBeLessThanOrEqual(640);
});

test("a result names its resources by number, hides identifiers, and says failure plainly", () => {
	const made = resultText({
		ref: "t5",
		title: "作曲",
		status: "done",
		result: {
			title: "朝の曲",
			trackIds: ["x1"],
			uri: "eumenes://music.track/x1",
		},
		made: [],
		resource: (uri) => (uri === "eumenes://music.track/x1" ? "a5" : null),
	}).text;
	expect(made).toContain("- title: 朝の曲");
	expect(made).not.toContain("x1");
	expect(made).not.toContain("eumenes://");
	expect(
		resultText({
			ref: "t1",
			title: "画像",
			status: "done",
			outcome: "failed",
			result: null,
			made: [],
			resource: () => null,
		}).text,
	).toBe("t1「画像」は失敗しました。");
	expect(
		resultText({
			ref: "t2",
			title: "予約",
			status: "waiting",
			question: "何時？",
			result: null,
			made: [],
			resource: () => null,
		}).text,
	).toBe("t2「予約」の担当から質問があります。\n質問: 何時？");
});

test("tool results are text: the search lists its candidates with how to call them, never JSON", () => {
	const text = toolResultText("find_toolchain", {
		candidates: [
			{
				id: "fake.clock",
				title: "時計",
				summary: "今の時刻を答える",
				execution: "instant",
				inputs: {
					type: "object",
					properties: { city: { type: "string", description: "都市" } },
					required: ["city"],
				},
			},
		],
	});
	expect(text).toBe(
		"- fake.clock: 時計。今の時刻を答える。execution: instant。inputs: city（string、必須）都市",
	);
	expect(toolResultText("find_toolchain", { candidates: [] })).toBe(
		"- 候補なし",
	);
	expect(toolResultText("work", { ok: false, code: "todo_not_found" })).toBe(
		"- ok: false\n- code: todo_not_found",
	);
});

test("lines past a bound name how many were left out and of what", () => {
	const lines = Array.from(
		{ length: 100 },
		(_, i) => `- 項目${i}の内容はこの通りです`,
	);
	const fitted = fitLines(lines, 60, "t3");
	expect(fitted.at(-1)).toMatch(/^- 未掲載: \d+件（t3）$/);
	expect(fitted.join("\n")).not.toContain("work");
	expect(jstNowLine(Date.parse("2026-10-26T10:12:00Z"))).toBe(
		"10-26（月）19:12",
	);
});

test("the keeper's operations apply by the numbers shown; a rule broken anywhere refuses the whole output", () => {
	const before = {
		topic: "曲を作る",
		decisions: [{ text: "アップテンポ（10-26、本人の希望）" }],
		open: [{ text: "曲名が未定" }],
		records: [],
	};
	const candidates = new Map([
		["w1", "七里ヶ浜駅: World に記録がある対象（World）"],
	]);
	const points = new Map([["k1", 4]]);
	const applied = applyKeeperOutput(
		before,
		{
			ops: [
				{
					op: "replace_decision",
					id: "d1",
					text: "スローテンポ（10-26、本人の訂正）",
				},
				{ op: "resolve_open", id: "o1" },
				{ op: "add_record", candidate: "w1" },
				{ op: "cut_before", point: "k1" },
			],
		},
		candidates,
		points,
	);
	expect(applied).toEqual({
		body: {
			topic: "曲を作る",
			decisions: [{ text: "スローテンポ（10-26、本人の訂正）" }],
			open: [],
			records: [{ text: "七里ヶ浜駅: World に記録がある対象（World）" }],
		},
		cutAfter: 4,
	});
	for (const op of [
		{ op: "add_decision" as const, text: "詳しくは https://example.com" },
		{ op: "add_open" as const, text: "さっきの件" },
		{ op: "add_decision" as const, text: "返事は短くしてください" },
		{ op: "remove_decision" as const, id: "d9" },
		{ op: "add_record" as const, candidate: "m1" },
		{ op: "cut_before" as const, point: "k2" },
	])
		expect(
			applyKeeperOutput(before, { ops: [op] }, candidates, points),
		).toBeNull();
	const tooMany = Array.from({ length: 9 }, (_, i) => ({
		op: "add_decision" as const,
		text: `決めたこと${i}`,
	}));
	expect(
		applyKeeperOutput(before, { ops: tooMany }, candidates, points),
	).toBeNull();
});

test("after a gap nothing said before stays, even when the memory or the system part changed meanwhile", () => {
	const nowMs = Date.parse("2026-10-29T13:51:00.000Z");
	const system = "## Role\n- 執事です。";
	const said = (
		seq: number,
		speaker: "user" | "agent",
		minutesAgo: number,
	) => ({
		conversationId: "c1",
		seq,
		speaker,
		text: `${speaker}${seq}`,
		messageId: `m${seq}`,
		at: new Date(nowMs - minutesAgo * 60_000).toISOString(),
		toolCalls: [],
		notice: null,
	});
	const shown = [
		said(96, "agent", 75),
		said(97, "user", 74),
		said(98, "user", 73),
		said(99, "agent", 72),
	];
	for (const changed of [
		{ memoryDigest: "the memory before the restart" },
		{ systemDigest: "another system part" },
		{ due: "forgotten" },
	]) {
		const written: number[] = [];
		let dropped = 0;
		const deps = {
			conversation: {
				input: {
					cutInTransaction: () => ({
						seq: 95,
						revision: 1,
						systemDigest: systemDigestOf(system),
						memoryDigest: "",
						due: null,
						at: "2026-10-29T12:00:00.000Z",
						...changed,
					}),
					utterancesAfterInTransaction: () => shown,
					dropStatesInTransaction: () => {
						dropped++;
					},
					writeCutInTransaction: (
						_tx: unknown,
						_id: string,
						cut: { seq: number },
					) => {
						written.push(cut.seq);
						return { ...cut, revision: 1, due: null };
					},
				},
			},
		} as unknown as Parameters<typeof placeCutInTransaction>[0];
		const placed = placeCutInTransaction(deps, {} as never, "c1", {
			system,
			window: null,
			nowMs,
			pending: new Set(),
			history: localHarness.history,
		});
		expect(placed.reason).toBe("resumed");
		expect(written).toEqual([99]);
		// What the context keeper made of the earlier words goes with them.
		expect(dropped).toBe(1);
	}
});
