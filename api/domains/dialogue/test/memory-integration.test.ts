import { afterEach, expect, test } from "bun:test";
import {
	appendFileSync,
	copyFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations as memoryPackageMigrations } from "eumenes-memory/sqlite";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import {
	migration as conversationMigration,
	avatarMotionMigration,
	answerDeliveryMigration,
	createConversationService,
} from "../../conversation";
import {
	createContinuityService,
	migration as continuityMigration,
} from "../../continuity";
import {
	createDialogueService,
	migration as dialogueMigration,
	queueLinkMigration,
} from "..";
import type { LarmPort } from "../../larm";
import { createQueue, migration as queueMigration } from "../../queue";
import {
	createMemoryService,
	migration as memoryMigration,
} from "../../memory";

const MIGRATIONS = [
	conversationMigration,
	avatarMotionMigration,
	answerDeliveryMigration,
	dialogueMigration,
	queueMigration,
	queueLinkMigration,
	continuityMigration,
	memoryMigration,
	...memoryPackageMigrations,
];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
	for (let i = 0; i < 300; i++) {
		if (check()) return;
		await pause(10);
	}
	throw new Error("timeout");
}
const recalledBlock = (seen: { role: string; content: string }[][]) =>
	seen.at(-1)?.find((m) => m.content.includes("保存された参照情報"));
type Harness = Awaited<ReturnType<typeof setup>>;
const open: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of open.splice(0)) await close();
});

async function setup(
	options: {
		dir?: string;
		answer?: (messages: { role: string; content: string }[]) => Promise<string>;
		keepJournal?: boolean;
	} = {},
) {
	const dir = options.dir ?? mkdtempSync(join(tmpdir(), "eumenes-memory-"));
	const file = join(dir, "db.sqlite3");
	const journalPath = join(dir, "journal.jsonl");
	const seen: { role: string; content: string }[][] = [];
	const larm: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		answer: async (messages) => {
			seen.push(messages.map((m) => ({ ...m })));
			return options.answer ? options.answer(messages) : "了解です";
		},
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		close: async () => {},
	};
	const store: SqliteStore = openStore(file, MIGRATIONS);
	const conversation = createConversationService(store);
	const continuity = createContinuityService(store);
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath,
	});
	const recovery = await memory.recover();
	const queue = createQueue(store);
	queue.start();
	const dialogue = createDialogueService(
		store,
		conversation,
		larm,
		queue,
		undefined,
		undefined,
		memory,
	);
	const harness = {
		dir,
		file,
		journalPath,
		store,
		conversation,
		continuity,
		memory,
		dialogue,
		seen,
		recovery,
		async ask(text: string) {
			const run = await dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text,
			});
			await until(() =>
				["completed", "failed", "cancelled"].includes(
					dialogue.get(run.id)?.status ?? "",
				),
			);
			return dialogue.get(run.id)!;
		},
		async close() {
			await queue.close(100);
			await store.close();
		},
	};
	open.push(async () => {
		await harness.close().catch(() => {});
		if (!options.dir) rmSync(dir, { recursive: true, force: true });
	});
	return harness;
}

async function seedFact(h: Harness, text = "私は辛いものが好きです") {
	const run = await h.ask(text);
	const message = h.conversation
		.get("main")
		.messages.find((m) => m.id === run.inputMessageId)!;
	return h.memory.remember({
		conversationId: "main",
		messageId: message.id,
		quote: "辛いものが好き",
		kind: "preference",
		semanticKey: "food.spicy",
		text: "辛いものが好き",
		polarity: "affirmed",
	});
}

test("a remembered fact is recalled in the next answer with a usage receipt, and Memory OFF injects nothing", async () => {
	const h = await setup();
	expect(h.recovery.healthy).toBe(true);
	const item = await seedFact(h);
	expect(item).toMatchObject({ kind: "preference", status: "active" });
	const run = await h.ask("おすすめの料理は？");
	expect(run.status).toBe("completed");
	const last = h.seen.at(-1)!;
	const block = last.find((m) => m.content.includes("保存された参照情報"));
	expect(block?.role).toBe("system");
	expect(block?.content).toContain("辛いものが好き");
	const receipt = h.memory.usage(run.id);
	expect(receipt).toMatchObject({ viewSchema: 2, packageVersion: "0.1.0" });
	expect(receipt?.itemIds).toContain(item.id);

	await h.memory.setEnabled(false);
	const off = await h.ask("もう一度");
	expect(off.status).toBe("completed");
	expect(
		h.seen.at(-1)!.some((m) => m.content.includes("保存された参照情報")),
	).toBe(false);
	expect(h.memory.usage(off.id)).toBeNull();
});

test("continuity (goal / open question) is part of the recalled context", async () => {
	const h = await setup();
	await h.continuity.add("main", { kind: "goal", text: "Rustへ移行する" });
	await h.ask("続きを");
	const block = h.seen.at(-1)!.find((m) => m.content.includes("参照情報"));
	expect(block?.content).toContain("目的: Rustへ移行する");
});

test("a correction during generation prevents adopting the answer", async () => {
	let release: (text: string) => void = () => {};
	let started: () => void = () => {};
	const startedPromise = new Promise<void>((resolve) => (started = resolve));
	const h = await setup({
		answer: (messages) => {
			if (!messages.some((m) => m.content.includes("保存された参照情報")))
				return Promise.resolve("先行");
			started();
			return new Promise((resolve) => (release = resolve));
		},
	});
	const item = await seedFact(h);
	const pending = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "好みを踏まえて",
	});
	await startedPromise;
	await h.memory.retract(item.id, item.revision);
	release("辛い料理を");
	await until(() => h.dialogue.get(pending.id)?.status === "failed");
	expect(h.dialogue.get(pending.id)?.error).toBe("memory_stale");
	expect(
		h.conversation.get("main").messages.some((m) => m.text === "辛い料理を"),
	).toBe(false);
	expect(h.memory.usage(pending.id)).toBeNull();
});

test("forgetting erases the value, survives restart, and is re-applied on a restored old database", async () => {
	const h = await setup();
	const item = await seedFact(h);
	const backup = join(h.dir, "backup.sqlite3");
	await h.store.write((db) => db.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
	copyFileSync(h.file, backup);

	const forgotten = await h.memory.forget(item.id);
	expect(forgotten.forgetId).toMatch(/^forget:/);
	expect(h.memory.list(true).map((i) => i.id)).not.toContain(item.id);
	expect(
		h.store.read((db) =>
			db.query("SELECT value_text FROM memory_state_item").all(),
		),
	).toEqual([{ value_text: null }]);
	const run = await h.ask("もう一度");
	expect(recalledBlock(h.seen)).toBeUndefined();
	expect(run.status).toBe("completed");
	const dir = h.dir;
	const journal = h.journalPath;
	await h.close();
	open.pop();

	// Restore the pre-forget database: the external journal must win.
	copyFileSync(backup, join(dir, "db.sqlite3"));
	const restored = await setup({ dir });
	expect(restored.recovery).toEqual({ healthy: true, reapplied: 1 });
	expect(restored.memory.list(true)).toEqual([]);
	expect(readFileSync(journal, "utf8").trim().split("\n")).toHaveLength(1);
	await restored.ask("復元後");
	expect(recalledBlock(restored.seen)).toBeUndefined();
	rmSync(dir, { recursive: true, force: true });
});

test("a tampered journal makes memory unavailable (fail closed) instead of being used", async () => {
	const h = await setup();
	await seedFact(h);
	const item = h.memory.list()[0]!;
	await h.memory.forget(item.id);
	const dir = h.dir;
	const journal = h.journalPath;
	await h.close();
	open.pop();
	const line = JSON.parse(readFileSync(journal, "utf8").trim());
	writeFileSync(
		journal,
		`${JSON.stringify({ ...line, forgetId: "forget:x" })}\n`,
	);
	const broken = await setup({ dir });
	expect(broken.recovery.healthy).toBe(false);
	await expect(
		broken.memory.remember({
			conversationId: "main",
			messageId: "none",
			quote: "x",
			kind: "preference",
			semanticKey: "k",
			text: "t",
			polarity: "affirmed",
		}),
	).rejects.toThrow("memory_unavailable");
	const run = await broken.ask("質問");
	expect(run.status).toBe("completed");
	expect(
		broken.seen.at(-1)!.some((m) => m.content.includes("保存された参照情報")),
	).toBe(false);
	rmSync(dir, { recursive: true, force: true });
	void appendFileSync;
});

test("stopping an item is reversible and removes it from the next answer; invalid sources are rejected", async () => {
	const h = await setup();
	const item = await seedFact(h);
	const stopped = await h.memory.stop(item.id, item.revision);
	expect(stopped.status).toBe("inactive");
	await h.ask("確認");
	expect(recalledBlock(h.seen)).toBeUndefined();
	const resumed = await h.memory.resume(item.id, stopped.revision);
	expect(resumed.status).toBe("active");
	const run = h.conversation.get("main").messages[0]!;
	await expect(
		h.memory.remember({
			conversationId: "main",
			messageId: run.id,
			quote: "存在しない引用",
			kind: "preference",
			semanticKey: "x",
			text: "x",
			polarity: "affirmed",
		}),
	).rejects.toThrow("invalid_memory_quote");
	await expect(
		h.memory.remember({
			conversationId: "other",
			messageId: run.id,
			quote: "辛い",
			kind: "preference",
			semanticKey: "x",
			text: "x",
			polarity: "affirmed",
		}),
	).rejects.toThrow("invalid_memory_source");
});

test("expired items are not recalled as current understanding", async () => {
	const h = await setup();
	const first = await h.ask("先月までZedを使っていた");
	const message = h.conversation
		.get("main")
		.messages.find((m) => m.id === first.inputMessageId)!;
	await h.memory.remember({
		conversationId: "main",
		messageId: message.id,
		quote: "Zedを使っていた",
		kind: "personal_fact",
		semanticKey: "editor",
		text: "Zedを使っている",
		polarity: "affirmed",
		validUntilMs: 1000,
	});
	await h.ask("エディタは？");
	expect(
		h.seen.at(-1)!.some((m) => m.content.includes("Zedを使っている")),
	).toBe(false);
	expect(h.memory.list().some((i) => i.text === "Zedを使っている")).toBe(true);
});
