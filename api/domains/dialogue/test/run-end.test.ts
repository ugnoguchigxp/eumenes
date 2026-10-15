import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureLogging } from "../../../infrastructure/logger";
import { openStore } from "../../../infrastructure/sqlite";
import { createConversationService } from "../../conversation";
import { createContinuityService } from "../../continuity";
import type { LarmPort } from "../../larm";
import { createMemoryService } from "../../memory";
import { memoryMigrations } from "./memory-seed";
import { createQueue, migration as queueMigration } from "../../queue";
import {
	agentLinkMigration,
	createDialogueService,
	migration,
	queueLinkMigration,
	worldStateMigration,
	type StewardRunEnd,
} from "..";
import { insert } from "../repository";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
	for (let i = 0; i < 300; i++) {
		if (check()) return;
		await pause(10);
	}
	throw new Error("timeout");
}
const open: Array<() => Promise<void>> = [];
afterEach(async () => {
	configureLogging({ level: "silent" });
	for (const close of open.splice(0)) await close();
});

type Answer = (text: string) => Promise<string>;
/** Dialogue on a real store with memory, and a steward that only records what it is told (and what the ledger held then). */
async function setup(answer: Answer = async () => "了解です") {
	configureLogging({ level: "silent" });
	const dir = mkdtempSync(join(tmpdir(), "eumenes-run-end-"));
	const store = openStore(join(dir, "db.sqlite3"), [
		...memoryMigrations,
		migration,
		queueMigration,
		queueLinkMigration,
		agentLinkMigration,
		worldStateMigration,
	]);
	const conversation = createConversationService(store);
	const continuity = createContinuityService(store);
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: join(dir, "journal.jsonl"),
	});
	await memory.recover();
	const queue = createQueue(store);
	queue.start();
	const told: Array<
		StewardRunEnd & {
			ledgerRows: Array<{ outcome: string; answer: string | null }>;
		}
	> = [];
	const larm: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		answer: async (messages) => answer(messages.at(-1)?.content ?? ""),
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		close: async () => {},
	};
	const dialogue = createDialogueService({
		store,
		conversation,
		larm,
		queue,
		memory,
		steward: {
			runEndedInTransaction(db, input) {
				told.push({
					...input,
					ledgerRows: memory
						.exchangesInTransaction(db, input.conversationId)
						.filter((row) => row.runId === input.runId)
						.map((row) => ({
							outcome: row.outcome,
							answer: row.answerMessageId,
						})),
				});
			},
		},
	});
	open.push(async () => {
		await queue.close(100).catch(() => {});
		await store.close().catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		store,
		conversation,
		memory,
		dialogue,
		told,
		submit: (text: string) =>
			dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text,
			}),
		settled: async (runId: string) => {
			await until(() =>
				["completed", "failed", "cancelled", "interrupted"].includes(
					dialogue.get(runId)?.status ?? "",
				),
			);
			return dialogue.get(runId)!;
		},
		ledger: () => memory.exchanges("main"),
	};
}

test("a completed run registers its exchange with the adopted answer, then the steward hears of it", async () => {
	const h = await setup();
	const run = await h.settled((await h.submit("こんにちは")).id);
	expect(run.status).toBe("completed");
	const rows = h.ledger();
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		runId: run.id,
		inputMessageId: run.inputMessageId,
		answerMessageId: run.answerMessageId,
		outcome: "answered",
	});
	// The steward was told in the same transaction, after the ledger held the exchange.
	expect(h.told).toEqual([
		{
			runId: run.id,
			conversationId: "main",
			state: "completed",
			ledgerRows: [{ outcome: "answered", answer: run.answerMessageId }],
		},
	]);
});

test("a failed run registers the user's message alone as a failed exchange", async () => {
	const h = await setup(async () => {
		throw new Error("model_down");
	});
	const run = await h.settled((await h.submit("予算は3万円以内")).id);
	expect(run.status).toBe("failed");
	expect(h.ledger()).toHaveLength(1);
	expect(h.ledger()[0]).toMatchObject({
		inputMessageId: run.inputMessageId,
		answerMessageId: null,
		outcome: "failed",
	});
	expect(h.told).toHaveLength(1);
	expect(h.told[0]).toMatchObject({ runId: run.id, state: "failed" });
	expect(h.told[0]!.ledgerRows).toEqual([{ outcome: "failed", answer: null }]);
});

test("a cancelled run registers no exchange but the steward is told", async () => {
	let started!: () => void;
	const startedPromise = new Promise<void>((resolve) => (started = resolve));
	const h = await setup(
		(text) =>
			new Promise<string>((_resolve, reject) => {
				started();
				setTimeout(() => reject(new Error(`never answered: ${text}`)), 5000);
			}),
	);
	const pending = await h.submit("やっぱりやめる");
	await startedPromise;
	await h.dialogue.cancel(pending.id);
	const run = await h.settled(pending.id);
	expect(run.status).toBe("cancelled");
	expect(h.ledger()).toEqual([]);
	expect(h.told).toHaveLength(1);
	expect(h.told[0]).toMatchObject({
		runId: pending.id,
		state: "cancelled",
		ledgerRows: [],
	});
});

test("the system's own prompts (a scheduled one) register no exchange, yet the steward is told", async () => {
	const h = await setup();
	const scheduled = await h.store.write((db) =>
		h.dialogue.promptTarget.materializeInTransaction(db, {
			occurrenceId: "occurrence-1",
			scheduleId: "schedule-1",
			payload: { conversationId: "main", text: "毎朝の定期プロンプト" },
		} as never),
	);
	const notice = { id: scheduled.subjectRef as string };
	const run = await h.settled(notice.id);
	expect(run.status).toBe("completed");
	expect(h.ledger()).toEqual([]);
	expect(h.told.map((entry) => [entry.runId, entry.state])).toEqual([
		[notice.id, "completed"],
	]);
	// The prompt is blocked from the memory layers; its answer is still the conversation's.
	expect(
		h.memory.blockedMessageIds([run.inputMessageId]).has(run.inputMessageId),
	).toBe(true);
});

test("a run left without a job when the backend restarts is interrupted: a failed exchange and the steward's notice", async () => {
	const h = await setup();
	await h.store.write((db) => {
		h.conversation.appendInTransaction(db, {
			id: "u-orphan",
			conversationId: "main",
			role: "user",
			text: "途中で止まった発言",
			createdAt: "2026-10-13T00:00:00.000Z",
			runId: "r-orphan",
		});
		insert(db, {
			id: "r-orphan",
			agentTaskId: null,
			requestId: "req-orphan",
			conversationId: "main",
			utteranceId: null,
			status: "running",
			revision: 1,
			inputMessageId: "u-orphan",
			answerMessageId: null,
			error: null,
			jobId: null,
			deadlineAt: null,
			sourceKind: "manual",
			scheduleId: null,
			occurrenceId: null,
			createdAt: "2026-10-13T00:00:00.000Z",
			updatedAt: "2026-10-13T00:00:00.000Z",
		});
	});
	await h.dialogue.recover();
	expect(h.dialogue.get("r-orphan")?.status).toBe("interrupted");
	expect(h.ledger()).toHaveLength(1);
	expect(h.ledger()[0]).toMatchObject({
		inputMessageId: "u-orphan",
		answerMessageId: null,
		outcome: "failed",
	});
	expect(h.told).toHaveLength(1);
	expect(h.told[0]).toMatchObject({ runId: "r-orphan", state: "interrupted" });
});

test("a run that already ended is not recorded twice", async () => {
	const h = await setup();
	const run = await h.settled((await h.submit("一度だけ")).id);
	await h.dialogue.cancel(run.id);
	expect(h.dialogue.get(run.id)?.status).toBe("completed");
	expect(h.told).toHaveLength(1);
	expect(h.ledger()).toHaveLength(1);
});
