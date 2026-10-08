import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import {
	migration as conversationMigration,
	avatarMotionMigration as conversationAvatarMotionMigration,
	answerDeliveryMigration as conversationAnswerDeliveryMigration,
	createConversationService,
} from "../../conversation";
import type { LarmPort } from "../../larm";
import type { InferencePort } from "../../inference";
import { createQueue, migration as queueMigration } from "../../queue";
import {
	createScheduler,
	migration as schedulerMigration,
} from "../../scheduler";
import { createDialogueService, migration, queueLinkMigration } from "..";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const migrations = [
	conversationMigration,
	conversationAvatarMotionMigration,
	conversationAnswerDeliveryMigration,
	migration,
	queueMigration,
	schedulerMigration,
	queueLinkMigration,
];
async function until(cond: () => boolean) {
	for (let i = 0; i < 300; i++) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("condition not reached");
}
type Call = { texts: string[]; resolve: (v: string) => void };
function setup(
	queueOptions: Parameters<typeof createQueue>[1] = {},
	overrides: Partial<InferencePort> = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-dq-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), migrations);
	stores.push(store);
	const calls: Call[] = [];
	const larm: LarmPort & InferencePort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		answer: (messages, signal) =>
			new Promise((resolve, reject) => {
				calls.push({
					texts: messages.map((m) => m.content.slice(0, 20)),
					resolve,
				});
				signal?.addEventListener("abort", () => reject(new Error("aborted")));
			}),
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		close: async () => {},
		...overrides,
	};
	const conversation = createConversationService(store);
	const queue = createQueue(store, queueOptions);
	const dialogue = createDialogueService(store, conversation, larm, queue);
	return { store, calls, conversation, queue, dialogue, larm };
}
const submit = (
	d: ReturnType<typeof setup>["dialogue"],
	text: string,
	conversationId = "main",
) => d.submit({ requestId: crypto.randomUUID(), conversationId, text });

test("a run only sees earlier accepted turns; later inputs never leak into it", async () => {
	const h = setup();
	h.queue.start();
	const a = await submit(h.dialogue, "A");
	const b = await submit(h.dialogue, "B");
	const c = await submit(h.dialogue, "C");
	expect([a, b, c].map((r) => r.jobId !== null)).toEqual([true, true, true]);
	await until(() => h.calls.length === 1);
	// B and C are waiting behind A (same conversation order), not running
	expect(h.dialogue.get(b.id)?.status).toBe("queued");
	h.calls[0]?.resolve("ansA");
	await until(() => h.calls.length === 2);
	h.calls[1]?.resolve("ansB");
	await until(() => h.calls.length === 3);
	h.calls[2]?.resolve("ansC");
	await until(() => h.dialogue.get(c.id)?.status === "completed");
	expect(h.calls[0]?.texts.slice(1)).toEqual(["A"]);
	expect(h.calls[1]?.texts.slice(1)).toEqual(["A", "ansA", "B"]);
	expect(h.calls[2]?.texts.slice(1)).toEqual(["A", "ansA", "B", "ansB", "C"]);
	await h.queue.close(100);
});

test("a failed earlier run leaves only its input in later history", async () => {
	const h = setup();
	h.queue.start();
	const a = await submit(h.dialogue, "A");
	await submit(h.dialogue, "B");
	await until(() => h.calls.length === 1);
	await h.dialogue.cancel(a.id);
	await until(() => h.calls.length === 2);
	expect(h.calls[1]?.texts.slice(1)).toEqual(["A", "B"]);
	await h.queue.close(100);
});

test("full queue rejects the submit and stores neither message nor run", async () => {
	const h = setup({ limits: { total: 1, background: 1, scope: 1 } });
	await submit(h.dialogue, "one");
	await expect(submit(h.dialogue, "two")).rejects.toThrow("queue_full");
	expect(h.conversation.get("main").messages.map((m) => m.text)).toEqual([
		"one",
	]);
	expect(h.dialogue.list("main")).toHaveLength(1);
});

test("restart: queued runs continue, a running run is interrupted, late result from the old owner is rejected", async () => {
	const h = setup();
	const a = await submit(h.dialogue, "A");
	const b = await submit(h.dialogue, "B");
	await h.queue.tick(); // claims A only (never started as a loop)
	await until(() => h.calls.length === 1);
	expect(h.dialogue.get(a.id)?.status).toBe("running");
	// "restart": new queue/service instances over the same database
	const queue2 = createQueue(h.store);
	const dialogue2 = createDialogueService(
		h.store,
		h.conversation,
		h.larm,
		queue2,
	);
	await dialogue2.recover();
	expect(await queue2.recover()).toBe(1);
	expect(dialogue2.get(a.id)?.status).toBe("interrupted");
	expect(dialogue2.get(b.id)?.status).toBe("queued");
	queue2.start();
	await until(() => h.calls.length === 2);
	h.calls[0]?.resolve("old answer");
	await new Promise((r) => setTimeout(r, 30));
	expect(dialogue2.get(a.id)?.status).toBe("interrupted");
	h.calls[1]?.resolve("ansB");
	await until(() => dialogue2.get(b.id)?.status === "completed");
	expect(h.conversation.get("main").messages.map((m) => m.text)).toEqual([
		"A",
		"B",
		"ansB",
	]);
	await queue2.close(100);
	await h.queue.close(100);
});

test("runs from before the queue existed are interrupted, not given a new job", async () => {
	const h = setup();
	const now = new Date().toISOString();
	await h.store.write((db) => {
		h.conversation.appendInTransaction(db, {
			id: "m",
			conversationId: "main",
			role: "user",
			text: "old",
			createdAt: now,
			runId: "legacy",
		});
		db.query(
			"INSERT INTO dialogue_runs (id,request_id,conversation_id,status,revision,input_message_id,created_at,updated_at,seq) VALUES ('legacy','r','main','running',0,'m',?,?,99)",
		).run(now, now);
	});
	await h.dialogue.recover();
	expect(h.dialogue.get("legacy")?.status).toBe("interrupted");
	expect(h.dialogue.get("legacy")?.jobId).toBeNull();
});

test("scheduled prompt creates exactly one background run per occurrence; interactive input is claimed first", async () => {
	const h = setup();
	const clock = { t: Date.parse("2026-02-01T00:00:00Z") };
	const scheduler = createScheduler(h.store, h.queue, {
		now: () => clock.t,
		sleep: () => new Promise(() => {}),
	});
	scheduler.registerTarget(h.dialogue.promptTarget);
	const schedule = await scheduler.create({
		requestId: crypto.randomUUID(),
		target: {
			kind: "dialogue.prompt",
			payload: { conversationId: "daily", text: "朝の確認" },
		},
		schedule: { type: "once", at: "2026-02-01T00:00:00Z" },
		misfirePolicy: "coalesce",
		graceMs: 1000,
	});
	await scheduler.tick();
	await scheduler.tick();
	const runs = h.dialogue.list("daily");
	expect(runs).toHaveLength(1);
	expect(runs[0]).toMatchObject({
		sourceKind: "schedule",
		scheduleId: schedule.id,
		status: "queued",
	});
	expect(h.conversation.get("daily").messages.map((m) => m.text)).toEqual([
		"朝の確認",
	]);
	expect(h.queue.list({ kind: "dialogue.generate" }).items[0]?.lane).toBe(
		"background",
	);
	// an interactive run in another conversation overtakes the waiting background run
	const live = await submit(h.dialogue, "今すぐ", "other");
	await h.queue.tick();
	await until(() => h.calls.length === 1);
	expect(h.calls[0]?.texts.slice(1)).toEqual(["今すぐ"]);
	expect(h.dialogue.get(live.id)?.status).toBe("running");
	expect(h.dialogue.get(runs[0]?.id ?? "")?.status).toBe("queued");
	h.calls[0]?.resolve("はい");
	await until(() => h.dialogue.get(live.id)?.status === "completed");
	await h.queue.tick();
	await until(() => h.calls.length === 2);
	h.calls[1]?.resolve("おはようございます");
	await until(() => h.dialogue.get(runs[0]?.id ?? "")?.status === "completed");
	expect(scheduler.listOccurrences(schedule.id).items[0]?.jobState).toBe(
		"completed",
	);
	await h.queue.close(100);
});

test("waitForTerminal honours abort and its own deadline without cancelling the run", async () => {
	const h = setup();
	const run = await submit(h.dialogue, "wait");
	const started = Date.now();
	const waited = await h.dialogue.waitForTerminal(run.id, {
		timeoutMs: 40,
		pollMs: 10,
	});
	expect(waited?.status).toBe("queued");
	expect(Date.now() - started).toBeLessThan(500);
	const controller = new AbortController();
	controller.abort();
	expect(
		(await h.dialogue.waitForTerminal(run.id, { signal: controller.signal }))
			?.status,
	).toBe("queued");
});

test("rejected answer adoption fails both the run and its queue job", async () => {
	const h = setup(
		{},
		{
			requestFor: () => "request",
			executeRequest: async () => ({
				requestId: "request",
				attemptId: "attempt",
				value: "revoked answer",
			}),
			acceptInTransaction: () => false,
		},
	);
	try {
		const run = await submit(h.dialogue, "question");
		await h.queue.tick();
		await until(
			() => !["queued", "running"].includes(h.queue.get(run.jobId!)!.state),
		);
		expect(h.dialogue.get(run.id)?.status).toBe("failed");
		expect(h.dialogue.get(run.id)?.error).toBe("permission_revoked");
		expect(h.queue.get(run.jobId!)?.state).toBe("failed");
		expect(h.queue.get(run.jobId!)?.errorCode).toBe("permission_revoked");
		expect(h.conversation.get("main").messages.map((m) => m.text)).toEqual([
			"question",
		]);
	} finally {
		await h.queue.close(100);
	}
});

test("only adopted, confident motion labels a running or completed answer; cancelled judgments are rejected", async () => {
	const h = setup();
	h.queue.start();
	const run = await submit(h.dialogue, "良い知らせ");
	await until(() => h.calls.length === 1);
	const decision = {
		id: crypto.randomUUID(),
		source: "laya" as const,
		motion: "joyful" as const,
		tone: "natural" as const,
		confidence: 0.2,
		motionConfidence: 0.9,
		toneConfidence: 0.2,
		latencyMs: 10,
	};
	for (const delivery of [
		{ ...decision, source: "fallback" as const },
		{ ...decision, motionConfidence: 0.2 },
	]) {
		expect(
			await h.store.write((db) =>
				h.dialogue.recordAnswerDeliveryInTransaction(db, run.id, delivery),
			),
		).toBe(false);
	}
	expect(
		await h.store.write((db) =>
			h.dialogue.recordAnswerDeliveryInTransaction(db, run.id, decision),
		),
	).toBe(true);
	h.calls[0]?.resolve("よかったですね。");
	await until(() => h.dialogue.get(run.id)?.status === "completed");
	expect(h.conversation.get("main").messages.at(-1)).toMatchObject({
		text: "よかったですね。",
		avatarMotion: "joyful",
	});
	const cancelled = await submit(h.dialogue, "取消");
	await until(() => h.calls.length === 2);
	await h.dialogue.cancel(cancelled.id);
	expect(
		await h.store.write((db) =>
			h.dialogue.recordAnswerDeliveryInTransaction(db, cancelled.id, decision),
		),
	).toBe(false);
	await h.queue.close(100);
});
