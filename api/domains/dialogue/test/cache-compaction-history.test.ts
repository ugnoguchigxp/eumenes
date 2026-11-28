import { afterEach, expect, test } from "bun:test";
import { planWindow, REFERENCE_WINDOW_TOKENS } from "../../inference";
import {
	conversationPrefixFrom,
	placeCutInTransaction,
	workingLimits,
} from "../service/conversation-input";
import { conversationHarness } from "../service/harness";
import {
	agencyOf,
	choice,
	IMAGE,
	reply,
	setup,
	type Harness,
} from "./generation.fixture";
import { saveItem } from "./memory-seed";

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

test("the working epoch keeps prior turns byte-identical across 6 turns, with a read marked and its result left out", async () => {
	h = await setup({ memory: true });
	h.state.steps.push(
		...reply("こんにちは。"),
		choice({ choice: "none" }),
		{ calls: [{ name: "read_memory", args: { query: "鎌倉" } }] },
		{ text: "鎌倉のカフェがお好きですね。" },
		...reply("了解しました。"),
		...reply("進めます。"),
		...reply("確認しました。"),
		...reply("承知しました。"),
	);
	const r1 = await h.say("ターン1です");
	await saveItem(h.store, h.memory!, {
		conversationId: "main",
		kind: "preference",
		semanticKey: "preference.cafe",
		text: "鎌倉のカフェが好き",
		messageId: r1.inputMessageId,
	});
	await h.say("私の好みは？");
	await h.say("ターン3です");
	await h.say("ターン4です");
	await h.say("ターン5です");
	await h.say("ターン6です");

	// Turn 3 through Turn 6 must share the exact same prefix (system + memory + turns 1..2 with the read's mark).
	const talkCalls = h.state.calls.filter((c) =>
		c.messages.at(-1)?.content.includes("## User\nターン"),
	);
	expect(talkCalls.length).toBeGreaterThanOrEqual(5);
	const t3 = talkCalls[1]!.messages;
	const t6 = talkCalls.at(-1)!.messages;
	// Every message of Turn 3 before its trailing `## User / ## State` message must appear byte-for-byte in Turn 6.
	const stableLen = t3.length - 1;
	expect(stableLen).toBeGreaterThanOrEqual(5);
	expect(t6.slice(0, stableLen)).toEqual(t3.slice(0, stableLen));
	// Turn 6 names the Turn 2 `read_memory` call under the reply that made it; the result is not carried.
	expect(t6.some((m) => (m.role as string) === "tool")).toBe(false);
	expect(
		t6.some((m) =>
			m.content.includes("鎌倉のカフェがお好きですね。\n[道具: read_memory]"),
		),
	).toBe(true);
});

test("hard limit cut promotes a valid staged summary in 0ms and renders `## Summary` below `## Memory`", async () => {
	h = await setup({ memory: true });
	h.state.steps.push(
		...reply("承知しました。"),
		...reply("続けます。"),
		...reply("了解です。"),
	);
	const r1 = await h.say("最初の話題: 鎌倉のカフェ企画");
	const r2 = await h.say("水彩風イラストにしたい");
	await h.say("色味も調整しよう");

	const limits = {
		...workingLimits(
			planWindow({ window: REFERENCE_WINDOW_TOKENS, fixed: 3000 }),
		),
		hardUsers: 2,
		lowUtterances: 2,
		lowTokens: 1000,
	};

	// Stage a pre-computed LLM summary covering up through the first exchange (seq 2).
	const actualSystem = h.state.calls.at(-1)!.messages[0]!.content;
	const cutBefore = h.store.read((db) =>
		h!.conversation.input.cutInTransaction(db, "main"),
	)!;
	await h.store.write((db) =>
		h!.conversation.input.saveStagedSummaryInTransaction!(db, {
			id: "sum-staged-1",
			conversationId: "main",
			baseCutRevision: cutBefore.revision,
			coveredFromSeq: 1,
			coveredThroughSeq: 2,
			text: "対象範囲: 11-22 10:00〜10:05\n- 話題: 鎌倉のカフェ企画で水彩風を検討。",
			sourceRefs: [r1.inputMessageId, r2.inputMessageId],
			tokenEstimate: 40,
			kind: "llm",
			at: new Date().toISOString(),
		}),
	);

	// Trigger Hard limit cut: staged summary is promoted to active without any synchronous LLM call.
	const placed = await h.store.write((db) =>
		placeCutInTransaction(
			{
				store: h!.store,
				conversation: h!.conversation,
				memory: h!.memory,
				clock: () => new Date().toISOString(),
				id: () => crypto.randomUUID(),
			} as never,
			db,
			"main",
			{
				system: actualSystem,
				window: h!.memory!.storedWindowInTransaction(db, "main"),
				nowMs: Date.now(),
				pending: new Set(),
				limits,
			},
		),
	);
	expect(placed.reason).toBe("over_limit");
	expect(placed.cut.seq).toBe(2);

	const active = h.store.read((db) =>
		h!.conversation.input.activeSummaryInTransaction!(db, "main"),
	);
	expect(active?.id).toBe("sum-staged-1");
	expect(active?.state).toBe("active");
	expect(active?.kind).toBe("llm");

	// Prefix now places `## Summary` inside the semi-static `messages[1]` block right below `## Memory`.
	const prefix = h.store.read((db) =>
		conversationPrefixFrom(
			{
				store: h!.store,
				conversation: h!.conversation,
				memory: h!.memory,
			} as never,
			db,
			"main",
			{
				harness: conversationHarness,
				system: "sys",
				window: h!.memory!.storedWindowInTransaction(db, "main"),
				pending: new Set(),
			},
		),
	);
	expect(prefix.summary).toContain("## Summary");
	expect(prefix.summary).toContain("鎌倉のカフェ企画で水彩風を検討");
	expect(prefix.messages[1]!.content).toStartWith("## Memory");
	expect(prefix.messages[1]!.content).toContain("## Summary");
	expect(prefix.summarySourceRefs).toContain(r1.inputMessageId);

	// Forgetting a source message immediately retracts the summary and hides it from the prefix.
	await h.memory!.forget({
		conversationId: "main",
		messageIds: [r1.inputMessageId],
		itemIds: [],
	});
	const afterForget = h.store.read((db) =>
		h!.conversation.input.activeSummaryInTransaction!(db, "main"),
	);
	expect(afterForget).toBeNull();
});

test("hard limit without staged summary installs mechanical fallback and 30-minute gap clears it", async () => {
	let nowMs = Date.now();
	h = await setup({ agency: agencyOf().agency });
	h.state.steps.push(
		choice({ choice: IMAGE.id }),
		...reply("了解です。"),
		...reply("次へ進みます。"),
	);
	await h.say("夕暮れの海辺イラストを描いて");
	nowMs += 60_000;
	await h.say("ありがとう");
	nowMs += 60_000;
	await h.say("もう一枚考えたい");

	const limits = {
		...workingLimits(
			planWindow({ window: REFERENCE_WINDOW_TOKENS, fixed: 3000 }),
		),
		hardUsers: 2,
		lowUtterances: 2,
		lowTokens: 1000,
	};
	const actualSystem = h.state.calls.at(-1)!.messages[0]!.content;
	const placed = await h.store.write((db) =>
		placeCutInTransaction(
			{
				store: h!.store,
				conversation: h!.conversation,
				clock: () => new Date(nowMs).toISOString(),
				id: () => crypto.randomUUID(),
			} as never,
			db,
			"main",
			{
				system: actualSystem,
				window: null,
				nowMs,
				pending: new Set(),
				limits,
			},
		),
	);
	expect(placed.reason).toBe("over_limit");
	const active = h.store.read((db) =>
		h!.conversation.input.activeSummaryInTransaction!(db, "main"),
	);
	expect(active?.kind).toBe("mechanical");
	expect(active?.text).toContain("delegate");

	// After a 30-minute silence (`resumed`), both working area and active summary are cleared.
	nowMs += 31 * 60_000;
	const resumed = await h.store.write((db) =>
		placeCutInTransaction(
			{
				store: h!.store,
				conversation: h!.conversation,
				clock: () => new Date(nowMs).toISOString(),
				id: () => crypto.randomUUID(),
			} as never,
			db,
			"main",
			{
				system: actualSystem,
				window: null,
				nowMs,
				pending: new Set(),
				limits,
			},
		),
	);
	expect(resumed.reason).toBe("resumed");
	expect(
		h.store.read((db) =>
			h!.conversation.input.activeSummaryInTransaction!(db, "main"),
		),
	).toBeNull();
});

test("read_history supports NFKC normalization, multi-token AND, partial fallback, and tool call tags", async () => {
	h = await setup({ memory: true });
	h.state.steps.push(
		choice({ choice: "none" }),
		{ calls: [{ name: "read_memory", args: { query: "鎌倉" } }] },
		{ text: "鎌倉のカフェとLARMの話を記録しました。" },
	);
	await h.say("ＬＡＲＭと鎌倉カフェの相談です");

	// Multi-token AND + NFKC case-insensitive query
	h.state.steps.push(
		choice({ choice: "none" }),
		{ calls: [{ name: "read_history", args: { query: "larm 鎌倉" } }] },
		{ text: "見つかりました。" },
	);
	await h.say("LARMと鎌倉の話を探して");
	const andResult = [...h.state.calls.at(-1)!.messages]
		.reverse()
		.find((m) => (m.role as string) === "tool")!;
	expect(andResult.content).toContain("ＬＡＲＭと鎌倉カフェの相談です");
	expect(andResult.content).toContain("[道具: read_memory]");
	expect(andResult.content).not.toContain("一部語句一致");

	// Partial fallback when multi-token AND has 0 hits
	h.state.steps.push(
		choice({ choice: "none" }),
		{
			calls: [{ name: "read_history", args: { query: "鎌倉 存在しない語句" } }],
		},
		{ text: "一部一致で見つかりました。" },
	);
	await h.say("鎌倉の別ログを探して");
	const partialResult = [...h.state.calls.at(-1)!.messages]
		.reverse()
		.find((m) => (m.role as string) === "tool")!;
	expect(partialResult.content).toContain("（一部語句一致）");
	expect(partialResult.content).toContain(
		"鎌倉のカフェとLARMの話を記録しました。",
	);
	expect(partialResult.content).toContain("[道具: read_memory]");
});
