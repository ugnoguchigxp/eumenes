import { expect, test } from "bun:test";
import type { Utterance } from "../../conversation";
import type { ProfileItem, WindowSnapshot } from "../../memory";
import {
	RECENT,
	keepNewestCut,
	placeCutInTransaction,
	recentMessages,
	systemDigestOf,
	recentUtterances,
	withLastMessage,
	type ConversationPrefix,
} from "../service/conversation-input";
import {
	currentProfileItems,
	memoryDigestOf,
	memoryLines,
} from "../service/memory-lines";
import { dataText, fitLines, jstNowLine } from "../service/input-text";
import { resultText, toolResultText } from "../service/result-text";
import { estimateTextTokens } from "../../../infrastructure/context-budget";

/**
 * The parts of the conversation's input (the conversation input specification, sections 3 to 9), each drawn by a
 * fixed rule: the recent conversation, `## Memory` and the text of results.
 */
let seq = 0;
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

test("the recent conversation keeps its opening, excludes pending input, and joins a side's run", () => {
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
		"最初",
		"作りますね",
		"できました",
		"はい",
	]);
	expect(recentMessages(recent)).toEqual([
		{ role: "user", content: "最初" },
		{ role: "assistant", content: "作りますね\nできました" },
		{ role: "user", content: "はい" },
	]);
	expect(
		recentUtterances([said("user", "だけ")], new Set()).map((u) => u.text),
	).toEqual(["だけ"]);
});

test("an utterance is cut at its bound, and its data can not open a heading", () => {
	seq = 0;
	const [message] = recentMessages([
		said("user", `# 見出し\n${"あ".repeat(5000)}`),
	]);
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

/** The memory's setting of `## Memory`: its bound and the kinds it holds. */
const WIDE = { alwaysTokens: 2000, alwaysScope: "facts" } as const;
const item = (
	id: string,
	kind: string,
	text: string,
	more: Partial<ProfileItem> = {},
): ProfileItem => ({
	id,
	kind,
	text,
	negated: false,
	source: kind === "tendency" ? "observed" : "user_said",
	since: "2026-10-20",
	revision: 1,
	newness: 1,
	...more,
});

test("`## Memory` holds the user's own statements of the scope's kinds, with source and date", () => {
	const profile: ProfileItem[] = [
		item("p1", "preference", "ピアノの曲が好き"),
		item("p2", "personal_fact", "住所は鎌倉"),
		item("p3", "tendency", "夜は静かな曲を聴く"),
		{ ...item("p4", "preference", "元気が出る曲を好む"), source: "inferred" },
		item("p5", "habit", "朝は散歩する"),
		item("p6", "constraint", "辛いものは食べない"),
	];
	const lines = (alwaysScope: "responses" | "leanings" | "facts") =>
		memoryLines(profile, { alwaysTokens: 2000, alwaysScope }).lines;
	// The user's own words only: an inference or an observation is not shown as a fact (C4).
	expect(lines("responses")).toEqual([
		"- ピアノの曲が好き（本人の発言、10-20から）",
		"- 辛いものは食べない（本人の発言、10-20から）",
	]);
	expect(lines("leanings")).toEqual([
		"- ピアノの曲が好き（本人の発言、10-20から）",
		"- 朝は散歩する（本人の発言、10-20から）",
		"- 辛いものは食べない（本人の発言、10-20から）",
	]);
	// The user's own facts join at the widest scope.
	expect(lines("facts")).toContain("- 住所は鎌倉（本人の発言、10-20から）");
	expect(memoryLines(profile, WIDE).ids).toEqual(["p1", "p2", "p5", "p6"]);
	// Each item leads with the short reference the memory handed out for it (numbers go on, they are not positions).
	expect(
		memoryLines(profile.slice(0, 1), WIDE, new Map([["p1", "m17"]])).lines,
	).toEqual(["- m17 ピアノの曲が好き（本人の発言、10-20から）"]);
});

test("`## Memory` leaves out an item marked sensitive, about another person or not to be brought up", () => {
	const profile: ProfileItem[] = [
		item("p1", "personal_fact", "通院している", { sensitive: true }),
		item("p2", "personal_fact", "妹は看護師", { aboutOther: true }),
		item("p3", "preference", "静かな曲が好き", { suppressed: true }),
		item("p4", "personal_fact", "住所は鎌倉"),
	];
	expect(memoryLines(profile, WIDE).ids).toEqual(["p4"]);
});

test("`## Memory` stays within the memory's bound, whatever the references' numbers, and keeps constraints before facts", () => {
	const many = Array.from({ length: 200 }, (_, i) =>
		item(`x${i}`, "preference", `好きなもの${i}番目の長めの説明`),
	);
	for (const alwaysTokens of [300, 2000]) {
		const budget = { alwaysTokens, alwaysScope: "facts" } as const;
		expect(
			estimateTextTokens(
				["## Memory", ...memoryLines(many, budget).lines].join("\n"),
			),
		).toBeLessThanOrEqual(alwaysTokens);
		// The references count in the bound, whatever their numbers: the same items are kept with long ones.
		const numbered = new Map(many.map((i, n) => [i.id, `m${10000 + n}`]));
		const withRefs = memoryLines(many, budget, numbered);
		expect(withRefs.ids).toEqual(memoryLines(many, budget).ids);
		expect(
			estimateTextTokens(["## Memory", ...withRefs.lines].join("\n")),
		).toBeLessThanOrEqual(alwaysTokens);
	}
	expect(
		memoryLines(many, { alwaysTokens: 2000, alwaysScope: "facts" }).ids.length,
	).toBeGreaterThan(
		memoryLines(many, { alwaysTokens: 300, alwaysScope: "facts" }).ids.length,
	);
	// A bound that holds one line keeps the constraint over the newer preference and the fact.
	const mixed = [
		item("fact", "personal_fact", "住所は鎌倉", { newness: 9 }),
		item("pref", "preference", "静かな曲が好き", { newness: 8 }),
		item("rule", "constraint", "辛いものは食べない", { newness: 1 }),
	];
	const one = estimateTextTokens(
		"## Memory\n- m00000 辛いものは食べない（本人の発言、10-20から）",
	);
	expect(
		memoryLines(mixed, { alwaysTokens: one, alwaysScope: "facts" }).ids,
	).toEqual(["rule"]);
});

test("the same records give the same text and digest, and another setting gives another digest", () => {
	const profile = [
		item("p1", "preference", "ピアノの曲が好き"),
		item("p2", "personal_fact", "住所は鎌倉"),
	];
	const window = { profile: { items: profile } } as unknown as WindowSnapshot;
	expect(memoryDigestOf(window, WIDE)).toBe(memoryDigestOf(window, WIDE));
	expect(memoryDigestOf(window, WIDE)).not.toBe(
		memoryDigestOf(window, { alwaysTokens: 2000, alwaysScope: "responses" }),
	);
	expect(memoryDigestOf(window, WIDE)).not.toBe(memoryDigestOf(null, WIDE));
	// A mark that takes an item out of the section changes what the cut stands on.
	const marked = {
		profile: { items: [profile[0]!, { ...profile[1]!, sensitive: true }] },
	} as unknown as WindowSnapshot;
	expect(memoryDigestOf(marked, WIDE)).not.toBe(memoryDigestOf(window, WIDE));
});

test("the last message joins a trailing user message and carries `## Memory` when nothing comes before it", () => {
	const prefix = (
		messages: ConversationPrefix["messages"],
		carry: string | null,
	) =>
		({
			messages,
			carry,
			cut: null,
			recent: [],
			lastAt: null,
			since: null,
			memoryItemIds: [],
			refsKey: null,
			memory: null,
			earlier: [],
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
		});
		expect(placed.reason).toBe("resumed");
		expect(written).toEqual([99]);
		// What the context keeper made of the earlier words goes with them.
		expect(dropped).toBe(1);
	}
});

test("a change of the memory's setting of `## Memory` that changes what it shows places a cut, one that does not changes nothing", () => {
	const system = "## Role\n- 執事です。";
	const nowMs = Date.parse("2026-10-29T13:51:00.000Z");
	const window = {
		profile: {
			items: [
				item("p1", "preference", "ピアノの曲が好き"),
				item("p2", "personal_fact", "住所は鎌倉"),
			],
		},
		republishRequested: false,
		newMemories: [],
	} as unknown as WindowSnapshot;
	const placedWith = (
		setting: typeof WIDE | { alwaysTokens: number; alwaysScope: "responses" },
	) => {
		const written: unknown[] = [];
		const deps = {
			memory: {
				inputBudgetInTransaction: () => setting,
				withheldMessagesInTransaction: () => [],
			},
			conversation: {
				input: {
					cutInTransaction: () => ({
						seq: 5,
						revision: 1,
						systemDigest: systemDigestOf(system),
						memoryDigest: memoryDigestOf(window, WIDE),
						due: null,
						at: "2026-10-29T13:50:00.000Z",
					}),
					utterancesAfterInTransaction: () => [
						{
							conversationId: "c1",
							seq: 6,
							speaker: "user",
							text: "こんにちは",
							messageId: "m6",
							at: "2026-10-29T13:50:30.000Z",
							toolCalls: [],
							notice: null,
						},
					],
					writeCutInTransaction: (_tx: unknown, _id: string, cut: object) => {
						written.push(cut);
						return { ...cut, revision: 2, due: null };
					},
				},
			},
		} as unknown as Parameters<typeof placeCutInTransaction>[0];
		const placed = placeCutInTransaction(deps, {} as never, "c1", {
			system,
			window,
			nowMs,
			pending: new Set(),
		});
		return { reason: placed.reason, written: written.length };
	};
	expect(placedWith(WIDE)).toEqual({ reason: null, written: 0 });
	expect(placedWith({ alwaysTokens: 2000, alwaysScope: "responses" })).toEqual({
		reason: "memory_changed",
		written: 1,
	});
});

test("the window's sources are captured once, and only a window with something stale in it is judged item by item", () => {
	const items = Array.from({ length: 50 }, (_, i) =>
		item(`x${i}`, "preference", `好きなもの${i}`),
	);
	const captured: string[][] = [];
	const staleId = "x7";
	const deps = (stale: boolean) =>
		({
			agency: {
				isCurrentInputInTransaction: (
					_tx: unknown,
					input: { sources: string[]; complete: boolean },
				) => !(stale && input.sources.includes(`memory:${staleId}`)),
			},
			memory: {
				referenceInputs: {
					captureInTransaction: (
						_tx: unknown,
						input: { itemIds: string[] },
					) => {
						captured.push(input.itemIds);
						return {
							sources: input.itemIds.map((id) => `memory:${id}`),
							complete: true,
						};
					},
				},
			},
		}) as unknown as Parameters<typeof currentProfileItems>[0];
	expect(
		currentProfileItems(deps(false), {} as never, "c1", items),
	).toHaveLength(50);
	expect(captured).toHaveLength(1);
	expect(captured[0]).toHaveLength(50);
	captured.length = 0;
	const kept = currentProfileItems(deps(true), {} as never, "c1", items);
	expect(kept.map((entry) => entry.id)).not.toContain(staleId);
	expect(kept).toHaveLength(49);
	// The item-by-item judgment is only for what the whole was not current.
	expect(captured).toHaveLength(51);
	expect(currentProfileItems({} as never, {} as never, "c1", items)).toBe(
		items,
	);
});
