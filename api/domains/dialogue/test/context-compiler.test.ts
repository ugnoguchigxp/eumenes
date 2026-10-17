import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { configureLogging } from "../../../infrastructure/logger";
import { createConversationService } from "../../conversation";
import { createContinuityService } from "../../continuity";
import { createMemoryService } from "../../memory";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { memoryMigrations, saveItem } from "./memory-seed";
import type { WindowSnapshot } from "../../memory";
import type { Run } from "../contracts";
import {
	agentLinkMigration,
	migration,
	queueLinkMigration,
	worldStateMigration,
} from "..";
import { insert } from "../repository";
import type { ContextBlock } from "../../inference";
import { compileAssembly } from "../service/context-compiler";
import { renderContext } from "../service/context-render";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	configureLogging({ level: "silent" });
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const at = "2026-10-13T00:00:00.000Z";
const tokens = (text: string) => estimateTextTokens(text);

/** A conversation on a real store with memory; exchanges are added one by one and the current run is last. */
async function setup() {
	configureLogging({ level: "silent" });
	const dir = mkdtempSync(join(tmpdir(), "eumenes-compiler-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), [
		...memoryMigrations,
		migration,
		queueLinkMigration,
		agentLinkMigration,
		worldStateMigration,
	]);
	stores.push(store);
	const conversation = createConversationService(store);
	const continuity = createContinuityService(store, () => at);
	let counter = 0;
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: join(dir, "journal.jsonl"),
		clock: () => at,
		id: () => `id-${++counter}`,
	});
	expect((await memory.recover()).healthy).toBe(true);
	let n = 0;
	const h = {
		store,
		conversation,
		memory,
		/** A finished run with its messages, registered in the exchange ledger the way a run's end does. */
		async exchange(
			user: string,
			answer: string | null,
			options: {
				status?: Run["status"];
				sourceKind?: Run["sourceKind"];
				register?: boolean;
			} = {},
		) {
			const i = ++n;
			const runId = `r${i}`;
			const status =
				options.status ?? (answer === null ? "failed" : "completed");
			await store.write((db) => {
				conversation.appendInTransaction(db, {
					id: `u${i}`,
					conversationId: "main",
					role: "user",
					text: user,
					createdAt: at,
					runId,
				});
				if (answer !== null)
					conversation.appendInTransaction(db, {
						id: `a${i}`,
						conversationId: "main",
						role: "assistant",
						text: answer,
						createdAt: at,
						runId,
					});
				insert(db, {
					id: runId,
					agentTaskId: null,
					specialistSessionId: null,
					requestId: `req${i}`,
					conversationId: "main",
					utteranceId: null,
					status,
					revision: 1,
					inputMessageId: `u${i}`,
					answerMessageId: answer === null ? null : `a${i}`,
					error: null,
					jobId: null,
					deadlineAt: null,
					sourceKind: options.sourceKind ?? "manual",
					scheduleId: null,
					occurrenceId: null,
					createdAt: at,
					updatedAt: at,
				});
				if (options.register !== false)
					memory.recordExchangeInTransaction(db, {
						conversationId: "main",
						runId,
						inputMessageId: `u${i}`,
						answerMessageId: answer === null ? null : `a${i}`,
						outcome: answer === null ? "failed" : "answered",
					});
			});
			return { input: `u${i}`, answer: answer === null ? null : `a${i}` };
		},
		/** The run being prepared: its input is the last message. */
		async current(text = "今回の入力") {
			const i = ++n;
			await store.write((db) => {
				conversation.appendInTransaction(db, {
					id: `u${i}`,
					conversationId: "main",
					role: "user",
					text,
					createdAt: at,
					runId: `r${i}`,
				});
				insert(db, {
					id: `r${i}`,
					agentTaskId: null,
					specialistSessionId: null,
					requestId: `req${i}`,
					conversationId: "main",
					utteranceId: null,
					status: "running",
					revision: 1,
					inputMessageId: `u${i}`,
					answerMessageId: null,
					error: null,
					jobId: null,
					deadlineAt: null,
					sourceKind: "manual",
					scheduleId: null,
					occurrenceId: null,
					createdAt: at,
					updatedAt: at,
				});
			});
			return store.read(
				(db) =>
					db.query("SELECT * FROM dialogue_runs WHERE id = ?").get(`r${i}`) as {
						id: string;
					},
			).id;
		},
		/** The steward's verdict on an exchange, with the marks that go with it. */
		dispose: (
			inputMessageId: string,
			disposition: "keep" | "summarize" | "drop",
		) =>
			store.write((db) => {
				memory.setDispositionInTransaction(db, inputMessageId, disposition);
				memory.markExchangeStepInTransaction(
					db,
					inputMessageId,
					"curated",
					"done",
				);
				memory.markExchangeStepInTransaction(
					db,
					inputMessageId,
					"disposed",
					"done",
				);
			}),
		publish: () =>
			store.write((db) => memory.publishWindowInTransaction(db, "main", {})),
		/**
		 * compileAssembly as the prepare phase calls it (the stored window or none, and memory), with the assembly
		 * rendered in the `current` format: the list the model is sent, the notices and the prefetch before the input.
		 */
		async compile(
			runId: string,
			options: {
				window?: WindowSnapshot | null;
				goals?: ContextBlock | null;
				/** The whole memory and history budget (tokens); absent: the largest (128k). */
				memoryHistoryTokens?: number;
				/** Replaces the conversation service (a test counts the messages read). */
				conversation?: typeof conversation;
			} = {},
		) {
			return store.write((db) => {
				const run = db
					.query("SELECT * FROM dialogue_runs WHERE id = ?")
					.get(runId) as Record<string, unknown>;
				const window =
					options.window !== undefined
						? options.window
						: memory.windowForRunInTransaction(db, "main");
				const compiled = compileAssembly(
					db,
					{
						id: runId,
						conversationId: "main",
						inputMessageId: run.input_message_id as string,
					} as Run & { seq?: number },
					options.conversation ?? conversation,
					undefined,
					window,
					memory,
					options.goals ?? null,
					false,
					options.memoryHistoryTokens,
				);
				return {
					...compiled,
					messages: renderContext(compiled.assembly, "current").messages,
				};
			});
		},
	};
	return h;
}
const texts = (messages: { content: string }[]) =>
	messages.map((m) => m.content);

test("layers in order: system, long-term, kept exchanges, working memory (summary, short-term), unprocessed exchanges, the input; the tail is decided here", async () => {
	const h = await setup();
	const summarized = await h.exchange("要約済みの質問", "要約済みの答え");
	const kept = await h.exchange("保持の質問", "保持の答え");
	const undecided = await h.exchange("未処理の質問", "未処理の答え");
	const latest = await h.exchange("最新の質問", "最新の答え");
	await h.dispose(kept.input, "keep");
	await h.dispose(summarized.input, "summarize");
	await h.store.write((db) =>
		h.memory.writeSummaryInTransaction(db, {
			conversationId: "main",
			text: "要約の本文",
			included: [summarized.input],
			expectedRevision: 0,
		}),
	);
	const save = (key: string, text: string) =>
		saveItem(h.store, h.memory, {
			conversationId: "main",
			messageId: kept.input,
			quote: "保持の質問",
			kind: "preference",
			semanticKey: key,
			text,
		});
	await save("k1", "長期に入る好み");
	await h.store.write((db) =>
		h.memory.publishWindowInTransaction(db, "main", {
			republishLongTerm: true,
		}),
	);
	await save("k2", "最近覚えた好み");
	await h.publish();
	const run = await h.current("今回の入力");
	const compiled = await h.compile(run);
	const { messages } = compiled;
	// system, long-term, kept exchanges, working memory (summary, short-term), unprocessed exchanges, the input
	expect(messages).toHaveLength(11);
	expect(messages[0]!.role).toBe("system");
	expect(messages[1]!.content).toContain("長期に入る好み");
	expect(texts(messages.slice(2, 4))).toEqual(["保持の質問", "保持の答え"]);
	expect(messages[4]!.content).toContain("これまでの経緯（要約）\n要約の本文");
	expect(messages[5]!.content).toContain("最近覚えた好み");
	expect(messages[5]!.content).not.toContain("長期に入る好み");
	expect(texts(messages.slice(6, 10))).toEqual([
		"未処理の質問",
		"未処理の答え",
		"最新の質問",
		"最新の答え",
	]);
	// The summarized exchange is in the summary only.
	expect(texts(messages)).not.toContain("要約済みの質問");
	expect(messages.at(-1)).toEqual({ role: "user", content: "今回の入力" });
	expect(compiled.shownMessageIds).toEqual([
		kept.input,
		kept.answer!,
		undecided.input,
		undecided.answer!,
		latest.input,
		latest.answer!,
		run.replace("r", "u"),
	]);
	// Nothing is added for this call: no notice, no prefetch.
	expect(compiled.assembly.volatile).toEqual([]);
});

test("section 2.3: dropped exchanges are out, unsummarized ones stay verbatim, a skipped summary keeps them; the newest two are always in", async () => {
	const h = await setup();
	const dropped = await h.exchange("捨てた質問", "捨てた答え");
	const waiting = await h.exchange("要約待ちの質問", "要約待ちの答え");
	const skipped = await h.exchange("要約を諦めた質問", "要約を諦めた答え");
	const newest1 = await h.exchange("最新その1", "答え1");
	const newest2 = await h.exchange("最新その2", "答え2");
	await h.dispose(dropped.input, "drop");
	await h.dispose(waiting.input, "summarize");
	await h.dispose(skipped.input, "summarize");
	await h.store.write((db) =>
		h.memory.markExchangeStepInTransaction(
			db,
			skipped.input,
			"summarized",
			"skipped",
		),
	);
	await h.dispose(newest1.input, "drop");
	await h.dispose(newest2.input, "drop");
	await h.publish();
	const compiled = await h.compile(await h.current());
	const shown = texts(compiled.messages);
	expect(shown).not.toContain("捨てた質問");
	expect(shown).toContain("要約を諦めた質問");
	expect(shown).toContain("要約待ちの質問");
	// Dropped, but the newest two exchanges are always sent.
	for (const text of ["最新その1", "答え1", "最新その2", "答え2"])
		expect(shown).toContain(text);
});

test("the same question five times leaves one exchange in L3", async () => {
	const h = await setup();
	const asked = [];
	for (let i = 0; i < 5; i++)
		asked.push(await h.exchange("今日の天気は？", "晴れです"));
	for (const exchange of asked.slice(0, 4))
		await h.dispose(exchange.input, "drop");
	await h.dispose(asked[4]!.input, "keep");
	const window = await h.publish();
	expect(window.history.keep).toEqual([
		{ inputMessageId: asked[4]!.input, answerMessageId: asked[4]!.answer },
	]);
});

test("without memory or a window every earlier run is sent in order, with no count limit; cancelled runs and runs the ledger never took stay", async () => {
	const h = await setup();
	for (let i = 1; i <= 13; i++)
		await h.exchange(`質問${i}`, `回答${i}`, { register: false });
	const compiled = await h.compile(await h.current(), { window: null });
	const history = compiled.messages.slice(1, -1);
	expect(history).toHaveLength(26);
	expect(history[0]!.content).toBe("質問1");
	expect(compiled.assembly.stable).toEqual([]);
	expect(compiled.assembly.working).toEqual([]);
	expect(compiled.messages.at(-1)!.content).toBe("今回の入力");
	expect(compiled.messages.map((m) => m.role).slice(0, 3)).toEqual([
		"system",
		"user",
		"assistant",
	]);
});

test("blocked messages are never shown, with a window and without one; the answer to a scheduled prompt is", async () => {
	const h = await setup();
	const scheduled = await h.exchange(
		"毎朝の定期プロンプト",
		"おはようございます",
		{
			sourceKind: "schedule",
			register: false,
		},
	);
	await h.store.write((db) =>
		h.memory.blockMessagesInTransaction(db, {
			conversationId: "main",
			messageIds: [scheduled.input],
			reason: "scheduled_prompt",
		}),
	);
	const forgotten = await h.exchange("忘れる話", "忘れる答え");
	await h.exchange("残る話", "残る答え");
	await h.memory.forget({
		conversationId: "main",
		itemIds: [],
		messageIds: [forgotten.input],
	});
	const run = await h.current();
	for (const window of [undefined, null]) {
		const shown = texts(
			(await h.compile(run, window === null ? { window } : {})).messages,
		);
		expect(shown).not.toContain("毎朝の定期プロンプト");
		expect(shown).not.toContain("忘れる話");
		expect(shown).not.toContain("忘れる答え");
		expect(shown).toContain("おはようございます");
		expect(shown).toContain("残る話");
	}
});

test("over the memory and history budget the oldest exchanges go first, L3 and unprocessed alike, and the newest two always stay", async () => {
	const h = await setup();
	const made = [];
	for (let i = 1; i <= 6; i++)
		made.push(await h.exchange(`質問${i}`, `回答${i}:` + "a".repeat(4000)));
	// An older exchange kept in L3 competes with the unprocessed ones by age.
	await h.dispose(made[0]!.input, "keep");
	await h.dispose(made[2]!.input, "keep");
	await h.publish();
	// Each exchange is about 1,000 tokens: the budget holds a little over three of them.
	const budget = 3300;
	const compiled = await h.compile(await h.current(), {
		memoryHistoryTokens: budget,
	});
	const history = compiled.messages.slice(1, -1);
	expect(
		history.reduce((n, m) => n + tokens(m.content), 0),
	).toBeLessThanOrEqual(budget);
	expect(history.length % 2).toBe(0);
	expect(texts(history)).toContain("質問6");
	expect(texts(history)).not.toContain("質問1");
	expect(texts(history)).not.toContain("質問3");
	expect(texts(history).slice(-2)[0]).toBe("質問6");
	// The shown ids follow what stayed (a recall must not repeat them).
	expect(compiled.shownMessageIds).toContain(made[5]!.input);
	expect(compiled.shownMessageIds).not.toContain(made[0]!.input);
});

test("a long conversation is read newest first and only as far as the budget holds, with the ledger or without it", async () => {
	const h = await setup();
	const made = [];
	for (let i = 1; i <= 60; i++)
		made.push(await h.exchange(`質問${i}`, `回答${i}:` + "a".repeat(1000)));
	for (const made_ of made.slice(0, 30)) await h.dispose(made_.input, "keep");
	await h.publish();
	// Each exchange is about 260 tokens: the budget holds about four of them.
	const budget = 1100;
	for (const withWindow of [true, false]) {
		let reads = 0;
		const counting = {
			...h.conversation,
			messageInTransaction: (
				...args: Parameters<typeof h.conversation.messageInTransaction>
			) => {
				reads++;
				return h.conversation.messageInTransaction(...args);
			},
		};
		const compiled = await h.compile(await h.current(), {
			memoryHistoryTokens: budget,
			conversation: counting,
			...(withWindow ? {} : { window: null }),
		});
		const history = texts(compiled.messages).filter((t) =>
			/^(質問|回答)/.test(t),
		);
		expect(history).toContain("質問60");
		expect(history).not.toContain("質問1");
		expect(history.length % 2).toBe(0);
		// The 120 messages of the 60 exchanges are not all read: only the newest ones the budget can hold.
		expect(reads).toBeLessThan(40);
	}
});

test("the long-term memory, the summary and the notes come off the history's room before any exchange does", async () => {
	const h = await setup();
	for (let i = 1; i <= 4; i++)
		await h.exchange(`質問${i}`, `回答${i}:` + "a".repeat(2000));
	const window = await h.store.write((db) =>
		h.memory.publishWindowInTransaction(db, "main", {
			addNotices: ["あ".repeat(1500)],
		}),
	);
	const current = await h.current();
	const roomy = await h.compile(current, { window, memoryHistoryTokens: 4000 });
	const tight = await h.compile(current, { window, memoryHistoryTokens: 2500 });
	const shown = (c: typeof roomy) =>
		texts(c.messages).filter((t) => /^質問\d$/.test(t)).length;
	// The 1,500-token notice left 2,500 tokens of room against 1,000 in the tight case.
	expect(shown(roomy)).toBeGreaterThan(shown(tight));
	expect(shown(tight)).toBeGreaterThanOrEqual(2);
});

test("a long message is shown whole: nothing is cut by the size of one message, and the stored message is unchanged", async () => {
	const h = await setup();
	const long = "日本語の長い文章です。".repeat(3000);
	const answerText = "長い回答の本文。".repeat(2500);
	const made = await h.exchange(long, answerText);
	await h.exchange("次の質問", "次の答え");
	const compiled = await h.compile(await h.current());
	const user = compiled.messages.find((m) =>
		m.content.startsWith("日本語の長い"),
	)!;
	const answer = compiled.messages.find((m) =>
		m.content.startsWith("長い回答"),
	)!;
	expect(user.content).toBe(long);
	expect(answer.content).toBe(answerText);
	const stored = h.conversation
		.get("main")
		.messages.find((m) => m.id === made.input)!;
	expect(stored.text).toBe(long);
});

test("when the newest two exchanges are all long they stay over a small budget and the current input is never cut", async () => {
	const h = await setup();
	const long = (label: string) => `${label}:` + "あいうえお".repeat(4000);
	await h.exchange(long("古い質問"), long("古い答え"));
	await h.exchange(long("質問A"), long("答えA"));
	await h.exchange(long("質問B"), long("答えB"));
	const input = "今回の長い入力。".repeat(3000);
	const compiled = await h.compile(await h.current(input), {
		memoryHistoryTokens: 10_000,
	});
	const history = compiled.messages.slice(1, -1);
	expect(history).toHaveLength(4);
	expect(history.map((m) => m.content.slice(0, 3))).toEqual([
		"質問A",
		"答えA",
		"質問B",
		"答えB",
	]);
	expect(compiled.messages.at(-1)!.content).toBe(input);
});

test("notices and prefetched text come right before the input, notices first; a prefetch standing on a shown message is dropped for the turn", async () => {
	const h = await setup();
	const shown = await h.exchange("見えている質問", "見えている答え");
	const hidden = await h.exchange("見えない質問", "見えない答え");
	await h.exchange("最新1", "答え1");
	await h.exchange("最新2", "答え2");
	await h.dispose(hidden.input, "drop");
	const window = await h.store.write((db) =>
		h.memory.publishWindowInTransaction(db, "main", {
			addNotices: ["一件目", "二件目"],
			prefetch: {
				text: "昔のやり取り",
				pins: [{ messageId: hidden.input, digest: "d" }],
				tokens: 9,
			},
		}),
	);
	const run = await h.current();
	const compiled = await h.compile(run, { window });
	expect(compiled.prefetchDropped).toBe(false);
	expect(compiled.assembly.volatile.map((b) => b.source)).toEqual([
		"memory.notice",
		"memory.recall",
	]);
	const tail = compiled.messages.slice(-3, -1);
	expect(tail[0]!.content).toContain("記憶の担当からの連絡です");
	expect(tail[0]!.content).toContain("- 一件目\n- 二件目");
	expect(tail[1]!.content).toBe("昔のやり取り");
	// Now the pinned message is among the shown ones.
	const overlapping = await h.store.write((db) =>
		h.memory.publishWindowInTransaction(db, "main", {
			prefetch: {
				text: "重複",
				pins: [{ messageId: shown.input, digest: "d" }],
				tokens: 6,
			},
		}),
	);
	const dropped = await h.compile(run, { window: overlapping });
	expect(dropped.prefetchDropped).toBe(true);
	expect(dropped.assembly.volatile.map((b) => b.source)).toEqual([
		"memory.notice",
	]);
	expect(texts(dropped.messages)).not.toContain("重複");
	expect(dropped.shownMessageIds).toContain(shown.input);
	expect(dropped.shownMessageIds).not.toContain(hidden.input);
});

test("the goals layer sits right after long-term memory and before the kept history", async () => {
	const h = await setup();
	const kept = await h.exchange("保持の質問", "保持の答え");
	await h.exchange("最新の質問", "最新の答え");
	await h.dispose(kept.input, "keep");
	await saveItem(h.store, h.memory, {
		conversationId: "main",
		messageId: kept.input,
		quote: "保持の質問",
		kind: "preference",
		semanticKey: "k1",
		text: "長期に入る好み",
	});
	await h.store.write((db) =>
		h.memory.publishWindowInTransaction(db, "main", {
			republishLongTerm: true,
		}),
	);
	const goals: ContextBlock = {
		source: "goals",
		authority: "reference",
		freshness: "stable",
		body: { kind: "text", text: "目標の層" },
	};
	await h.publish();
	const run = await h.current("今回の入力");
	const withGoals = await h.compile(run, { goals });
	const order = texts(withGoals.messages);
	const at = order.indexOf("目標の層");
	expect(at).toBe(order.findIndex((t) => t.includes("長期に入る好み")) + 1);
	expect(order.indexOf("保持の質問")).toBeGreaterThan(at);
	expect(withGoals.assembly.stable.at(-1)).toEqual(goals);
	// Without goals nothing is added and the other layers are as before.
	const without = await h.compile(run);
	expect(without.assembly.stable.map((b) => b.source)).toEqual([
		"memory.long_term",
	]);
	expect(texts(without.messages)).toEqual(
		order.filter((t) => t !== "目標の層"),
	);
});
