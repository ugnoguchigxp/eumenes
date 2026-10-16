import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { configureLogging } from "../../../infrastructure/logger";
import { createConversationService } from "../../conversation";
import { createContinuityService } from "../../continuity";
import {
	HISTORY_MAX_BYTES,
	HISTORY_MESSAGE_MAX_BYTES,
	createMemoryService,
} from "../../memory";
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
import {
	TURN_WINDOW,
	clipHistoryText,
	compileContext,
} from "../service/context-compiler";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	configureLogging({ level: "silent" });
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const at = "2026-10-13T00:00:00.000Z";
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

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
		/** compileContext as the prepare phase calls it: with the stored window (or none) and memory. */
		async compile(
			runId: string,
			options: {
				window?: WindowSnapshot | null;
				goals?: { role: "system"; content: string } | null;
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
				return compileContext(
					db,
					{
						id: runId,
						conversationId: "main",
						inputMessageId: run.input_message_id as string,
					} as Run & { seq?: number },
					conversation,
					undefined,
					window,
					memory,
					options.goals,
				);
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
	const { sections } = compiled;
	expect(sections.longTerm).toHaveLength(1);
	expect(sections.longTerm[0]!.content).toContain("長期に入る好み");
	expect(texts(sections.history)).toEqual(["保持の質問", "保持の答え"]);
	expect(sections.working[0]!.content).toContain(
		"これまでの経緯（要約）\n要約の本文",
	);
	expect(sections.working[1]!.content).toContain("最近覚えた好み");
	expect(sections.working[1]!.content).not.toContain("長期に入る好み");
	expect(texts(sections.unprocessed)).toEqual([
		"未処理の質問",
		"未処理の答え",
		"最新の質問",
		"最新の答え",
	]);
	// The summarized exchange is in the summary only.
	expect(texts(compiled.messages)).not.toContain("要約済みの質問");
	expect(compiled.messages[0]).toBe(sections.system);
	expect(compiled.messages.at(-1)).toEqual({
		role: "user",
		content: "今回の入力",
	});
	const order = [
		...sections.longTerm,
		...sections.history,
		...sections.working,
		...sections.unprocessed,
	];
	expect(compiled.messages.slice(1, -1)).toEqual(order);
	expect(compiled.shownMessageIds).toEqual([
		kept.input,
		kept.answer!,
		undecided.input,
		undecided.answer!,
		latest.input,
		latest.answer!,
		run.replace("r", "u"),
	]);
	expect(sections.tail).toEqual([]);
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
	expect(compiled.sections.history.map((m) => m.content)).toContain(
		"要約を諦めた質問",
	);
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

test("without memory or a window the newest TURN_WINDOW runs are sent in order; cancelled runs and runs the ledger never took stay", async () => {
	const h = await setup();
	for (let i = 1; i <= TURN_WINDOW + 3; i++)
		await h.exchange(`質問${i}`, `回答${i}`, { register: false });
	const compiled = await h.compile(await h.current(), { window: null });
	const history = compiled.messages.slice(1, -1);
	expect(history).toHaveLength(TURN_WINDOW * 2);
	expect(history[0]!.content).toBe("質問4");
	expect(compiled.sections.longTerm).toEqual([]);
	expect(compiled.sections.working).toEqual([]);
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

test("over HISTORY_MAX_BYTES the oldest exchanges go first, L3 and unprocessed alike, and the newest two always stay", async () => {
	const h = await setup();
	const big = Math.floor(HISTORY_MAX_BYTES / 3);
	const made = [];
	for (let i = 1; i <= 6; i++)
		made.push(await h.exchange(`質問${i}`, `回答${i}:` + "a".repeat(big)));
	// An older exchange kept in L3 competes with the unprocessed ones by age.
	await h.dispose(made[0]!.input, "keep");
	await h.dispose(made[2]!.input, "keep");
	await h.publish();
	const compiled = await h.compile(await h.current());
	const history = compiled.messages.slice(1, -1);
	expect(history.reduce((n, m) => n + bytes(m.content), 0)).toBeLessThanOrEqual(
		HISTORY_MAX_BYTES,
	);
	expect(history.length % 2).toBe(0);
	expect(texts(history)).toContain("質問6");
	expect(texts(history)).not.toContain("質問1");
	expect(texts(history)).not.toContain("質問3");
	expect(texts(history).slice(-2)[0]).toBe("質問6");
});

test("a message over 12KB is shown as head 8KB, a marker and the tail; Japanese text is cut on character boundaries and the stored message is unchanged", async () => {
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
	for (const [shown, original] of [
		[user.content, long],
		[answer.content, answerText],
	] as const) {
		expect(bytes(shown)).toBeLessThanOrEqual(HISTORY_MESSAGE_MAX_BYTES);
		expect(shown).toMatch(/\n（中略：約\d+文字）\n/);
		expect(shown).not.toContain("�");
		expect(shown.startsWith(original.slice(0, 2000))).toBe(true);
		expect(shown.endsWith(original.slice(-500))).toBe(true);
		const [head, tail] = shown.split(/\n（中略：約\d+文字）\n/);
		expect(bytes(head!)).toBeLessThanOrEqual(8 * 1024);
		expect(bytes(head!)).toBeGreaterThan(8 * 1024 - 4);
		expect(original.startsWith(head!)).toBe(true);
		expect(original.endsWith(tail!)).toBe(true);
	}
	// The conversation itself is untouched.
	const stored = h.conversation
		.get("main")
		.messages.find((m) => m.id === made.input)!;
	expect(stored.text).toBe(long);
});

test("when the newest two exchanges are all long the history still stays within 48KB and the current input is never cut", async () => {
	const h = await setup();
	const long = (label: string) => `${label}:` + "あいうえお".repeat(4000);
	await h.exchange(long("古い質問"), long("古い答え"));
	await h.exchange(long("質問A"), long("答えA"));
	await h.exchange(long("質問B"), long("答えB"));
	const input = "今回の長い入力。".repeat(3000);
	const compiled = await h.compile(await h.current(input));
	const history = compiled.messages.slice(1, -1);
	expect(history.reduce((n, m) => n + bytes(m.content), 0)).toBeLessThanOrEqual(
		HISTORY_MAX_BYTES,
	);
	expect(history).toHaveLength(4);
	expect(history.map((m) => m.content.slice(0, 3))).toEqual([
		"質問A",
		"答えA",
		"質問B",
		"答えB",
	]);
	expect(compiled.messages.at(-1)!.content).toBe(input);
});

test("clipHistoryText leaves short text alone and cuts a multibyte text exactly at the limit", () => {
	expect(clipHistoryText("短い")).toBe("短い");
	const exact = "あ".repeat(HISTORY_MESSAGE_MAX_BYTES / 3);
	expect(clipHistoryText(exact)).toBe(exact);
	const clipped = clipHistoryText(
		"あ".repeat(HISTORY_MESSAGE_MAX_BYTES / 3 + 1),
	);
	expect(bytes(clipped)).toBeLessThanOrEqual(HISTORY_MESSAGE_MAX_BYTES);
	expect(clipped).not.toContain("�");
	// Four-byte characters (emoji) are not split either.
	const emoji = clipHistoryText("😀".repeat(5000));
	expect(emoji).not.toContain("�");
	expect(bytes(emoji)).toBeLessThanOrEqual(HISTORY_MESSAGE_MAX_BYTES);
});

test("notices and prefetched text are the tail, notices first; a prefetch standing on a shown message is dropped for the turn", async () => {
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
				bytes: 9,
			},
		}),
	);
	const run = await h.current();
	const compiled = await h.compile(run, { window });
	expect(compiled.prefetchDropped).toBe(false);
	expect(compiled.sections.tail).toHaveLength(2);
	expect(compiled.sections.tail[0]!.content).toContain(
		"記憶の担当からの連絡です",
	);
	expect(compiled.sections.tail[0]!.content).toContain("- 一件目\n- 二件目");
	expect(compiled.sections.tail[1]!.content).toBe("昔のやり取り");
	// Now the pinned message is among the shown ones.
	const overlapping = await h.store.write((db) =>
		h.memory.publishWindowInTransaction(db, "main", {
			prefetch: {
				text: "重複",
				pins: [{ messageId: shown.input, digest: "d" }],
				bytes: 6,
			},
		}),
	);
	const dropped = await h.compile(run, { window: overlapping });
	expect(dropped.prefetchDropped).toBe(true);
	expect(texts(dropped.sections.tail)).not.toContain("重複");
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
	const goals = { role: "system" as const, content: "目標の層" };
	await h.publish();
	const run = await h.current("今回の入力");
	const withGoals = await h.compile(run, { goals });
	const order = texts(withGoals.messages);
	const at = order.indexOf("目標の層");
	expect(at).toBe(order.findIndex((t) => t.includes("長期に入る好み")) + 1);
	expect(order.indexOf("保持の質問")).toBeGreaterThan(at);
	expect(withGoals.sections.goals).toEqual([goals]);
	// Without goals nothing is added and the other layers are as before.
	const without = await h.compile(run);
	expect(without.sections.goals).toEqual([]);
	expect(texts(without.messages)).toEqual(
		order.filter((t) => t !== "目標の層"),
	);
});
